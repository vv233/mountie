//! rclone integration: manages the bundled `rclone rcd` sidecar and drives it
//! through its Remote Control (RC) HTTP API. All cloud/protocol work (config,
//! mounting, transfers) is delegated to rclone — this module is the thin, typed
//! bridge the GUI talks to.

use std::collections::VecDeque;
use std::fs;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_autostart::ManagerExt;
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

/// Loopback address + a non-default port to reduce clashes with a user's own
/// `rclone rcd`. Bound to 127.0.0.1 only, so it is not reachable off-host.
const RC_HOST: &str = "127.0.0.1";
const RC_PORT: u16 = 45719;

/// How many recent log lines to keep for the diagnostics panel.
const LOG_CAP: usize = 500;

/// Shared state: how to reach the RC daemon, a handle to the child, a recent-log
/// ring buffer, and a flag so the supervisor knows an exit was intentional.
pub struct RcloneState {
    pub base_url: String,
    pub user: String,
    pub pass: String,
    pub http: reqwest::Client,
    pub child: Mutex<Option<CommandChild>>,
    pub logs: Mutex<VecDeque<String>>,
    pub shutting_down: AtomicBool,
}

impl RcloneState {
    fn new() -> Self {
        // Loopback-only, but still use a cryptographically-random per-launch
        // credential so other local processes can't drive our daemon.
        let mut buf = [0u8; 24];
        getrandom::getrandom(&mut buf).expect("getrandom failed");
        let pass = buf.iter().map(|b| format!("{b:02x}")).collect::<String>();
        RcloneState {
            base_url: format!("http://{RC_HOST}:{RC_PORT}"),
            user: "mountie".to_string(),
            pass,
            http: reqwest::Client::new(),
            child: Mutex::new(None),
            logs: Mutex::new(VecDeque::with_capacity(LOG_CAP)),
            shutting_down: AtomicBool::new(false),
        }
    }
}

/// Append a line to the log ring buffer (and stdout for dev).
fn push_log(app: &AppHandle, line: String) {
    println!("{line}");
    if let Some(state) = app.try_state::<RcloneState>() {
        let mut logs = state.logs.lock().unwrap();
        if logs.len() >= LOG_CAP {
            logs.pop_front();
        }
        logs.push_back(line);
    }
}

/// Start the rclone supervisor: keeps a `rclone rcd` running, restarting it if
/// it exits unexpectedly, and restoring mounts each time it comes up.
pub fn start(app: &AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move { supervise(app).await });
}

async fn supervise(app: AppHandle) {
    loop {
        let (user, pass) = {
            let s = app.state::<RcloneState>();
            (s.user.clone(), s.pass.clone())
        };

        let spawned = app.shell().sidecar("rclone").and_then(|cmd| {
            cmd.args([
                "rcd",
                "--rc-addr",
                &format!("{RC_HOST}:{RC_PORT}"),
                "--rc-user",
                &user,
                "--rc-pass",
                &pass,
                "--log-level",
                "NOTICE",
            ])
            .spawn()
        });

        let (mut rx, child) = match spawned {
            Ok(v) => v,
            Err(e) => {
                push_log(&app, format!("failed to start rclone: {e}"));
                if app.state::<RcloneState>().shutting_down.load(Ordering::SeqCst) {
                    return;
                }
                tokio::time::sleep(Duration::from_secs(2)).await;
                continue;
            }
        };
        *app.state::<RcloneState>().child.lock().unwrap() = Some(child);

        // Once ready, tell the UI and restore whatever was mounted before.
        {
            let app2 = app.clone();
            tauri::async_runtime::spawn(async move {
                let st = app2.state::<RcloneState>();
                if wait_until_ready(&st).await.is_ok() {
                    let _ = app2.emit("engine", "up");
                    restore_mounts(&app2).await;
                }
            });
        }

        // Drain output until the process exits.
        while let Some(event) = rx.recv().await {
            match event {
                CommandEvent::Stdout(b) | CommandEvent::Stderr(b) => {
                    let text = String::from_utf8_lossy(&b);
                    let line = text.trim_end();
                    if !line.trim().is_empty() {
                        push_log(&app, format!("[rclone] {line}"));
                    }
                }
                CommandEvent::Terminated(_) => break,
                _ => {}
            }
        }

        if app.state::<RcloneState>().shutting_down.load(Ordering::SeqCst) {
            return;
        }
        let _ = app.emit("engine", "down");
        push_log(&app, "rclone exited unexpectedly; restarting…".to_string());
        tokio::time::sleep(Duration::from_secs(1)).await;
    }
}

/// Poll `core/pid` until the daemon responds (or give up after ~6s).
async fn wait_until_ready(state: &RcloneState) -> Result<(), String> {
    for _ in 0..30 {
        if rc_call(state, "core/pid", json!({})).await.is_ok() {
            return Ok(());
        }
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
    Err("rclone RC daemon did not become ready in time".to_string())
}

/// Recent log lines for the diagnostics panel.
#[tauri::command]
pub async fn get_logs(state: State<'_, RcloneState>) -> Result<Vec<String>, String> {
    Ok(state.logs.lock().unwrap().iter().cloned().collect())
}

/// Kill the sidecar and stop the supervisor. Called on app exit.
pub fn stop(state: &RcloneState) {
    state.shutting_down.store(true, Ordering::SeqCst);
    if let Some(child) = state.child.lock().unwrap().take() {
        let _ = child.kill();
    }
}

/// Low-level POST to an RC endpoint with Basic auth. Returns parsed JSON on 2xx,
/// otherwise the error message rclone reported.
async fn rc_call(state: &RcloneState, path: &str, body: Value) -> Result<Value, String> {
    let url = format!("{}/{}", state.base_url, path);
    let resp = state
        .http
        .post(&url)
        .basic_auth(&state.user, Some(&state.pass))
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("rclone request failed: {e}"))?;

    let status = resp.status();
    let value: Value = resp
        .json()
        .await
        .map_err(|e| format!("invalid response from rclone: {e}"))?;

    if status.is_success() {
        Ok(value)
    } else {
        let msg = value
            .get("error")
            .and_then(|v| v.as_str())
            .unwrap_or("unknown rclone error");
        Err(msg.to_string())
    }
}

// ---------------------------------------------------------------------------
// Types exchanged with the frontend / persisted to disk
// ---------------------------------------------------------------------------

#[derive(Serialize)]
pub struct RemoteInfo {
    pub name: String,
    #[serde(rename = "type")]
    pub kind: String,
}

#[derive(Serialize)]
pub struct MountInfo {
    pub fs: String,
    pub mount_point: String,
}

/// A remembered mount, restored on the next launch.
#[derive(Serialize, Deserialize, Clone)]
pub struct MountEntry {
    pub remote: String,
    pub drive: String,
    pub preset: String,
    /// Advanced VFS overrides, if the user tuned them; restored verbatim.
    #[serde(default)]
    pub custom: Option<VfsOptions>,
}

/// Performance presets that translate one click into a coherent set of VFS/mount
/// options. This is the core value-add over raw rclone: users never touch flags.
fn preset_options(preset: &str, volume_name: &str) -> (Value, Value) {
    let vfs = match preset {
        // Max throughput / smoothest reads — full local cache, big chunks + readahead.
        "fast" => json!({
            "CacheMode": "full",
            "ChunkSize": "128M",
            "ChunkSizeLimit": "off",
            "ReadAhead": "128M",
            "DirCacheTime": "5m0s"
        }),
        // Lowest memory/disk footprint — no read caching.
        "lowmem" => json!({
            "CacheMode": "off",
            "DirCacheTime": "30s"
        }),
        // Sensible default.
        _ => json!({
            "CacheMode": "writes",
            "ChunkSize": "64M",
            "DirCacheTime": "1m0s"
        }),
    };

    // Present as a network drive (RaiDrive-style) with a friendly volume label.
    let mount = json!({
        "VolumeName": volume_name,
        "NetworkMode": true
    });

    (vfs, mount)
}

/// User-tuned VFS options coming from the mount form's advanced panel.
#[derive(Deserialize, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct VfsOptions {
    pub cache_mode: String,
    pub chunk_size: String,
    pub read_ahead: String,
    pub dir_cache_time: String,
}

/// Build a vfsOpt object from explicit user values. "0"/empty size fields are
/// omitted so rclone keeps its own default for them.
fn vfs_from_custom(c: &VfsOptions) -> Value {
    let mut m = serde_json::Map::new();
    m.insert("CacheMode".into(), json!(c.cache_mode));
    if !c.chunk_size.is_empty() && c.chunk_size != "0" {
        m.insert("ChunkSize".into(), json!(c.chunk_size));
    }
    if !c.read_ahead.is_empty() && c.read_ahead != "0" {
        m.insert("ReadAhead".into(), json!(c.read_ahead));
    }
    if !c.dir_cache_time.is_empty() {
        m.insert("DirCacheTime".into(), json!(c.dir_cache_time));
    }
    Value::Object(m)
}

// ---------------------------------------------------------------------------
// Persistence — remember mounts across restarts (app config dir / mounts.json)
// ---------------------------------------------------------------------------

fn store_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("cannot resolve config dir: {e}"))?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("mounts.json"))
}

fn load_entries(app: &AppHandle) -> Vec<MountEntry> {
    store_path(app)
        .ok()
        .and_then(|p| fs::read_to_string(p).ok())
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn save_entries(app: &AppHandle, entries: &[MountEntry]) {
    if let Ok(p) = store_path(app) {
        if let Ok(s) = serde_json::to_string_pretty(entries) {
            let _ = fs::write(p, s);
        }
    }
}

/// Re-mount everything that was mounted last time. Best-effort: failures (e.g. a
/// deleted remote) are ignored so a single bad entry can't block startup.
pub async fn restore_mounts(app: &AppHandle) {
    let state = app.state::<RcloneState>();
    for e in load_entries(app) {
        let _ = do_mount(&state, &e.remote, &e.drive, &e.preset, e.custom.as_ref()).await;
    }
}

// ---------------------------------------------------------------------------
// Core mount logic, shared by the command and the startup restore
// ---------------------------------------------------------------------------

/// Validate a drive letter and return it uppercased without a trailing colon.
fn normalize_drive(drive: &str) -> Result<String, String> {
    let letter = drive.trim().trim_end_matches(':').to_uppercase();
    if letter.len() != 1 || !letter.chars().next().unwrap().is_ascii_alphabetic() {
        return Err(format!("invalid drive letter: {drive}"));
    }
    Ok(letter)
}

async fn do_mount(
    state: &RcloneState,
    remote: &str,
    letter: &str,
    preset: &str,
    custom: Option<&VfsOptions>,
) -> Result<(), String> {
    let mount_point = format!("{letter}:");
    let (default_vfs, mount_opt) = preset_options(preset, remote);
    let vfs_opt = match custom {
        Some(c) => vfs_from_custom(c),
        None => default_vfs,
    };
    rc_call(
        state,
        "mount/mount",
        json!({
            "fs": format!("{remote}:"),
            "mountPoint": mount_point,
            "vfsOpt": vfs_opt,
            "mountOpt": mount_opt
        }),
    )
    .await?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Tauri commands (the GUI's API surface)
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn rclone_ready(state: State<'_, RcloneState>) -> Result<bool, String> {
    Ok(rc_call(&state, "core/pid", json!({})).await.is_ok())
}

/// List configured remotes together with their backend type.
#[tauri::command]
pub async fn list_remotes(state: State<'_, RcloneState>) -> Result<Vec<RemoteInfo>, String> {
    let dump = rc_call(&state, "config/dump", json!({})).await?;
    let mut remotes = Vec::new();
    if let Some(map) = dump.as_object() {
        for (name, cfg) in map {
            let kind = cfg
                .get("type")
                .and_then(|v| v.as_str())
                .unwrap_or("unknown")
                .to_string();
            remotes.push(RemoteInfo {
                name: name.clone(),
                kind,
            });
        }
    }
    remotes.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    Ok(remotes)
}

/// Create (or overwrite) a remote. `params` is the backend-specific config map,
/// e.g. `{ "url": "...", "user": "...", "pass": "..." }` for WebDAV.
#[tauri::command]
pub async fn create_remote(
    state: State<'_, RcloneState>,
    name: String,
    kind: String,
    params: Value,
) -> Result<(), String> {
    rc_call(
        &state,
        "config/create",
        json!({
            "name": name,
            "type": kind,
            "parameters": params,
            // Non-interactive: never block waiting for OAuth/questions.
            "opt": { "nonInteractive": true, "obscure": true }
        }),
    )
    .await?;
    Ok(())
}

/// Test a candidate remote config without persisting it: create a throwaway
/// remote, list its root, then delete it. Returns the number of top-level
/// entries on success, or a friendly error on failure.
#[tauri::command]
pub async fn test_remote(
    state: State<'_, RcloneState>,
    kind: String,
    params: Value,
) -> Result<u32, String> {
    const TEMP: &str = "__mountie_conntest";

    // Create the throwaway remote (obscures any password just like the real one).
    rc_call(
        &state,
        "config/create",
        json!({
            "name": TEMP,
            "type": kind,
            "parameters": params,
            "opt": { "nonInteractive": true, "obscure": true }
        }),
    )
    .await?;

    // Try listing the root — proves connectivity + auth.
    let listing = rc_call(
        &state,
        "operations/list",
        json!({ "fs": format!("{TEMP}:"), "remote": "" }),
    )
    .await;

    // Always clean up the throwaway remote.
    let _ = rc_call(&state, "config/delete", json!({ "name": TEMP })).await;

    listing.map(|v| {
        v.get("list")
            .and_then(|l| l.as_array())
            .map(|a| a.len() as u32)
            .unwrap_or(0)
    })
}

/// Fetch a remote's stored config (used to pre-fill the edit form). Passwords
/// come back obscured — the UI leaves those fields blank.
#[tauri::command]
pub async fn get_remote_config(
    state: State<'_, RcloneState>,
    name: String,
) -> Result<Value, String> {
    rc_call(&state, "config/get", json!({ "name": name })).await
}

/// Update an existing remote's parameters. Only the given keys change; others
/// are kept, so leaving a password blank preserves the existing one.
#[tauri::command]
pub async fn update_remote(
    state: State<'_, RcloneState>,
    name: String,
    params: Value,
) -> Result<(), String> {
    rc_call(
        &state,
        "config/update",
        json!({
            "name": name,
            "parameters": params,
            "opt": { "nonInteractive": true, "obscure": true }
        }),
    )
    .await?;
    Ok(())
}

#[tauri::command]
pub async fn delete_remote(
    app: AppHandle,
    state: State<'_, RcloneState>,
    name: String,
) -> Result<(), String> {
    rc_call(&state, "config/delete", json!({ "name": name })).await?;
    // Drop any remembered mount for this remote so it isn't restored later.
    let mut entries = load_entries(&app);
    entries.retain(|e| e.remote != name);
    save_entries(&app, &entries);
    Ok(())
}

/// Currently active mounts.
#[tauri::command]
pub async fn list_mounts(state: State<'_, RcloneState>) -> Result<Vec<MountInfo>, String> {
    let resp = rc_call(&state, "mount/listmounts", json!({})).await?;
    let mut mounts = Vec::new();
    if let Some(arr) = resp.get("mountPoints").and_then(|v| v.as_array()) {
        for m in arr {
            mounts.push(MountInfo {
                fs: m.get("Fs").and_then(|v| v.as_str()).unwrap_or("").to_string(),
                mount_point: m
                    .get("MountPoint")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string(),
            });
        }
    }
    Ok(mounts)
}

/// Mount `remote` at a Windows drive letter using a performance preset, and
/// remember it so it is restored on the next launch.
#[tauri::command]
pub async fn mount_remote(
    app: AppHandle,
    state: State<'_, RcloneState>,
    remote: String,
    drive: String,
    preset: String,
    custom: Option<VfsOptions>,
) -> Result<(), String> {
    let letter = normalize_drive(&drive)?;
    do_mount(&state, &remote, &letter, &preset, custom.as_ref()).await?;

    let mut entries = load_entries(&app);
    // One mount per remote and per drive letter.
    entries.retain(|e| e.drive != letter && e.remote != remote);
    entries.push(MountEntry {
        remote,
        drive: letter,
        preset,
        custom,
    });
    save_entries(&app, &entries);
    Ok(())
}

#[tauri::command]
pub async fn unmount(
    app: AppHandle,
    state: State<'_, RcloneState>,
    mount_point: String,
) -> Result<(), String> {
    rc_call(&state, "mount/unmount", json!({ "mountPoint": mount_point })).await?;
    let letter = mount_point.trim().trim_end_matches(':').to_uppercase();
    let mut entries = load_entries(&app);
    entries.retain(|e| e.drive != letter);
    save_entries(&app, &entries);
    Ok(())
}

/// Live transfer stats (bytes, speed, transfers) — used by the status bar.
#[tauri::command]
pub async fn core_stats(state: State<'_, RcloneState>) -> Result<Value, String> {
    rc_call(&state, "core/stats", json!({})).await
}

/// Storage quota for a remote. Not every backend supports this — callers should
/// treat an error (or missing fields) as "unknown" and simply show nothing.
#[derive(Serialize)]
pub struct AboutInfo {
    pub total: Option<u64>,
    pub used: Option<u64>,
    pub free: Option<u64>,
}

#[tauri::command]
pub async fn remote_about(
    state: State<'_, RcloneState>,
    remote: String,
) -> Result<AboutInfo, String> {
    let v = rc_call(&state, "operations/about", json!({ "fs": format!("{remote}:") })).await?;
    Ok(AboutInfo {
        total: v.get("total").and_then(|x| x.as_u64()),
        used: v.get("used").and_then(|x| x.as_u64()),
        free: v.get("free").and_then(|x| x.as_u64()),
    })
}

// ---------------------------------------------------------------------------
// Direct transfer / sync — the "fast" path that bypasses the mount layer and
// lets rclone saturate the connection with its own concurrency.
// ---------------------------------------------------------------------------

#[derive(Serialize)]
pub struct TransferStatus {
    pub finished: bool,
    pub success: bool,
    pub error: String,
    pub bytes: u64,
    pub total_bytes: u64,
    pub speed: f64,
    pub eta: Option<f64>,
    /// Per-file progress objects, passed straight through to the UI.
    pub transferring: Value,
}

/// Start an async copy or sync. `src`/`dst` are rclone fs strings — a remote
/// (`remote:path`) or a local path. Returns the job id to poll.
///
/// - `copy`: add/update files in dst; never deletes.
/// - `sync`: make dst identical to src (deletes extra files in dst).
#[tauri::command]
pub async fn start_transfer(
    state: State<'_, RcloneState>,
    src: String,
    dst: String,
    operation: String,
    turbo: Option<bool>,
    bwlimit: Option<String>,
) -> Result<u64, String> {
    let endpoint = if operation == "sync" {
        "sync/sync"
    } else {
        "sync/copy"
    };
    let mut config = serde_json::Map::new();
    if turbo.unwrap_or(true) {
        // Auto large-file mode: rclone splits any file at/above the cutoff into
        // parallel streams (small files are untouched), and runs more transfers
        // concurrently. This is per-file automatic — no user action needed.
        config.insert("MultiThreadStreams".into(), json!(8));
        config.insert("MultiThreadCutoff".into(), json!("100Mi"));
        config.insert("Transfers".into(), json!(8));
    }
    if let Some(bw) = bwlimit {
        let bw = bw.trim();
        if !bw.is_empty() {
            config.insert("BwLimit".into(), json!(bw));
        }
    }
    let mut body = json!({ "srcFs": src, "dstFs": dst, "_async": true });
    if !config.is_empty() {
        body["_config"] = Value::Object(config);
    }
    let resp = rc_call(&state, endpoint, body).await?;
    resp.get("jobid")
        .and_then(|v| v.as_u64())
        .ok_or_else(|| "rclone did not return a job id".to_string())
}

/// Combined job state + live stats for one transfer job.
#[tauri::command]
pub async fn transfer_status(
    state: State<'_, RcloneState>,
    jobid: u64,
) -> Result<TransferStatus, String> {
    let job = rc_call(&state, "job/status", json!({ "jobid": jobid })).await?;
    let finished = job.get("finished").and_then(|v| v.as_bool()).unwrap_or(false);
    let success = job.get("success").and_then(|v| v.as_bool()).unwrap_or(false);
    let error = job
        .get("error")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();

    // rclone tags each async job's stats under the group "job/<id>".
    let stats = rc_call(&state, "core/stats", json!({ "group": format!("job/{jobid}") }))
        .await
        .unwrap_or_else(|_| json!({}));

    Ok(TransferStatus {
        finished,
        success,
        error,
        bytes: stats.get("bytes").and_then(|v| v.as_u64()).unwrap_or(0),
        total_bytes: stats.get("totalBytes").and_then(|v| v.as_u64()).unwrap_or(0),
        speed: stats.get("speed").and_then(|v| v.as_f64()).unwrap_or(0.0),
        eta: stats.get("eta").and_then(|v| v.as_f64()),
        transferring: stats.get("transferring").cloned().unwrap_or_else(|| json!([])),
    })
}

/// Cancel a running transfer.
#[tauri::command]
pub async fn stop_transfer(state: State<'_, RcloneState>, jobid: u64) -> Result<(), String> {
    rc_call(&state, "job/stop", json!({ "jobid": jobid })).await?;
    Ok(())
}

/// List the sub-directories of `path` on `fs` (e.g. fs="remote:", path="backup").
/// Used by the transfer panel's folder browser.
#[tauri::command]
pub async fn list_dir(
    state: State<'_, RcloneState>,
    fs: String,
    path: String,
) -> Result<Vec<String>, String> {
    let resp = rc_call(
        &state,
        "operations/list",
        json!({ "fs": fs, "remote": path, "opt": { "dirsOnly": true, "noModTime": true } }),
    )
    .await?;
    let mut dirs = Vec::new();
    if let Some(arr) = resp.get("list").and_then(|v| v.as_array()) {
        for e in arr {
            if e.get("IsDir").and_then(|v| v.as_bool()).unwrap_or(false) {
                if let Some(name) = e.get("Name").and_then(|v| v.as_str()) {
                    dirs.push(name.to_string());
                }
            }
        }
    }
    dirs.sort_by(|a, b| a.to_lowercase().cmp(&b.to_lowercase()));
    Ok(dirs)
}

/// Run rclone's OAuth authorization for a backend (e.g. "drive", "onedrive").
///
/// Spawns `rclone authorize <kind>`, which opens the system browser to the
/// provider's consent page and captures the redirect on 127.0.0.1:53682. The
/// user authorizes in their own browser; on success rclone prints a token
/// between "Paste the following…" and "End paste", which we return so the
/// caller can create the remote with `{ "token": <token> }`.
#[tauri::command]
pub async fn oauth_authorize(app: AppHandle, kind: String) -> Result<String, String> {
    use std::time::{Duration, Instant};
    use tauri_plugin_shell::process::CommandEvent;

    let (mut rx, child) = app
        .shell()
        .sidecar("rclone")
        .map_err(|e| format!("failed to locate bundled rclone: {e}"))?
        .args(["authorize", &kind])
        .spawn()
        .map_err(|e| format!("failed to start authorization: {e}"))?;

    let deadline = Instant::now() + Duration::from_secs(180);
    let mut token = String::new();
    let mut capturing = false;

    loop {
        if Instant::now() >= deadline {
            let _ = child.kill();
            return Err("OAUTH_TIMEOUT".to_string());
        }
        match tokio::time::timeout(Duration::from_secs(2), rx.recv()).await {
            Ok(Some(event)) => {
                let bytes = match event {
                    CommandEvent::Stdout(b) | CommandEvent::Stderr(b) => b,
                    CommandEvent::Terminated(_) => {
                        return if token.is_empty() {
                            Err("OAUTH_NO_CRED".to_string())
                        } else {
                            Ok(token.trim().to_string())
                        };
                    }
                    _ => continue,
                };
                let text = String::from_utf8_lossy(&bytes);
                for raw in text.lines() {
                    let line = raw.trim();
                    if line.contains("Paste the following") {
                        capturing = true;
                    } else if line.contains("End paste") {
                        let _ = child.kill();
                        return Ok(token.trim().to_string());
                    } else if capturing && !line.is_empty() {
                        token.push_str(line);
                    }
                }
            }
            Ok(None) => {
                return if token.is_empty() {
                    Err("OAUTH_NO_CRED".to_string())
                } else {
                    Ok(token.trim().to_string())
                };
            }
            Err(_) => { /* no output within 2s; loop to re-check the deadline */ }
        }
    }
}

/// Best-effort check for WinFsp, which rclone needs to mount on Windows.
#[tauri::command]
pub fn winfsp_installed() -> bool {
    #[cfg(target_os = "windows")]
    {
        std::path::Path::new(r"C:\Program Files (x86)\WinFsp\bin").exists()
            || std::path::Path::new(r"C:\Program Files\WinFsp\bin").exists()
    }
    #[cfg(not(target_os = "windows"))]
    {
        true
    }
}

/// Whether Mountie is set to launch at login.
#[tauri::command]
pub fn get_autostart(app: AppHandle) -> Result<bool, String> {
    app.autolaunch().is_enabled().map_err(|e| e.to_string())
}

/// Enable/disable launch at login.
#[tauri::command]
pub fn set_autostart(app: AppHandle, enabled: bool) -> Result<(), String> {
    let manager = app.autolaunch();
    if enabled {
        manager.enable().map_err(|e| e.to_string())
    } else {
        manager.disable().map_err(|e| e.to_string())
    }
}

/// Register state during app setup.
pub fn init_state(app: &AppHandle) {
    app.manage(RcloneState::new());
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalize_drive_accepts_letters() {
        assert_eq!(normalize_drive("x").unwrap(), "X");
        assert_eq!(normalize_drive("Z:").unwrap(), "Z");
        assert_eq!(normalize_drive("  m  ").unwrap(), "M");
    }

    #[test]
    fn normalize_drive_rejects_invalid() {
        assert!(normalize_drive("").is_err());
        assert!(normalize_drive("ab").is_err());
        assert!(normalize_drive("1").is_err());
        assert!(normalize_drive(":").is_err());
    }

    #[test]
    fn presets_map_to_expected_cache_modes() {
        assert_eq!(preset_options("fast", "r").0["CacheMode"], json!("full"));
        assert_eq!(preset_options("balanced", "r").0["CacheMode"], json!("writes"));
        assert_eq!(preset_options("lowmem", "r").0["CacheMode"], json!("off"));
        // Unknown preset falls back to the balanced default.
        assert_eq!(preset_options("???", "r").0["CacheMode"], json!("writes"));
    }

    #[test]
    fn presets_present_a_network_drive() {
        let (_, mount) = preset_options("fast", "myremote");
        assert_eq!(mount["VolumeName"], json!("myremote"));
        assert_eq!(mount["NetworkMode"], json!(true));
    }

    #[test]
    fn vfs_from_custom_omits_zero_and_empty_sizes() {
        let c = VfsOptions {
            cache_mode: "full".into(),
            chunk_size: "0".into(),
            read_ahead: "".into(),
            dir_cache_time: "5m0s".into(),
        };
        let v = vfs_from_custom(&c);
        assert_eq!(v["CacheMode"], json!("full"));
        assert!(v.get("ChunkSize").is_none());
        assert!(v.get("ReadAhead").is_none());
        assert_eq!(v["DirCacheTime"], json!("5m0s"));
    }

    #[test]
    fn vfs_from_custom_keeps_real_sizes() {
        let c = VfsOptions {
            cache_mode: "writes".into(),
            chunk_size: "64M".into(),
            read_ahead: "128M".into(),
            dir_cache_time: "1m".into(),
        };
        let v = vfs_from_custom(&c);
        assert_eq!(v["ChunkSize"], json!("64M"));
        assert_eq!(v["ReadAhead"], json!("128M"));
    }
}
