//! rclone integration: manages the bundled `rclone rcd` sidecar and drives it
//! through its Remote Control (RC) HTTP API. All cloud/protocol work (config,
//! mounting, transfers) is delegated to rclone — this module is the thin, typed
//! bridge the GUI talks to.

use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Manager, State};
use tauri_plugin_autostart::ManagerExt;
use tauri_plugin_shell::process::CommandChild;
use tauri_plugin_shell::ShellExt;

/// Loopback address + a non-default port to reduce clashes with a user's own
/// `rclone rcd`. Bound to 127.0.0.1 only, so it is not reachable off-host.
const RC_HOST: &str = "127.0.0.1";
const RC_PORT: u16 = 45719;

/// Shared state: how to reach the RC daemon and a handle to kill it on exit.
pub struct RcloneState {
    pub base_url: String,
    pub user: String,
    pub pass: String,
    pub http: reqwest::Client,
    pub child: Mutex<Option<CommandChild>>,
}

impl RcloneState {
    fn new() -> Self {
        // Localhost-only, but still generate a per-launch credential so other
        // local processes can't trivially drive our daemon.
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let pass = format!("{:x}{:x}", nanos, std::process::id());
        RcloneState {
            base_url: format!("http://{RC_HOST}:{RC_PORT}"),
            user: "mountie".to_string(),
            pass,
            http: reqwest::Client::new(),
            child: Mutex::new(None),
        }
    }
}

/// Spawn the rclone rcd sidecar and wait until its RC API answers.
pub async fn start(app: &AppHandle) -> Result<(), String> {
    let state = app.state::<RcloneState>();

    let sidecar = app
        .shell()
        .sidecar("rclone")
        .map_err(|e| format!("failed to locate bundled rclone: {e}"))?
        .args([
            "rcd",
            "--rc-addr",
            &format!("{RC_HOST}:{RC_PORT}"),
            "--rc-user",
            &state.user,
            "--rc-pass",
            &state.pass,
            "--log-level",
            "NOTICE",
        ]);

    let (mut rx, child) = sidecar
        .spawn()
        .map_err(|e| format!("failed to start rclone: {e}"))?;

    *state.child.lock().unwrap() = Some(child);

    // Drain rclone's stdout/stderr so the pipe never blocks the child.
    tauri::async_runtime::spawn(async move {
        use tauri_plugin_shell::process::CommandEvent;
        while let Some(event) = rx.recv().await {
            if let CommandEvent::Stderr(line) | CommandEvent::Stdout(line) = event {
                let text = String::from_utf8_lossy(&line);
                if !text.trim().is_empty() {
                    println!("[rclone] {}", text.trim_end());
                }
            }
        }
    });

    wait_until_ready(&state).await
}

/// Poll `core/pid` until the daemon responds (or give up after ~6s).
async fn wait_until_ready(state: &RcloneState) -> Result<(), String> {
    for _ in 0..30 {
        if rc_call(state, "core/pid", json!({})).await.is_ok() {
            return Ok(());
        }
        tokio::time::sleep(std::time::Duration::from_millis(200)).await;
    }
    Err("rclone RC daemon did not become ready in time".to_string())
}

/// Kill the sidecar. Called on app exit so no orphaned rclone lingers.
pub fn stop(state: &RcloneState) {
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
#[derive(Deserialize)]
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

/// Turn rclone's raw mount error into a human-friendly, actionable message.
fn friendly_mount_error(raw: &str) -> String {
    let low = raw.to_lowercase();
    if low.contains("winfsp") {
        format!("挂载失败:未检测到 WinFsp,请先安装它再挂载。(原始错误:{raw})")
    } else if low.contains("not empty") || low.contains("already") || low.contains("in use") {
        format!("挂载失败:该盘符可能已被占用,换一个盘符试试。(原始错误:{raw})")
    } else if low.contains("connection refused")
        || low.contains("no such host")
        || low.contains("dial ")
        || low.contains("timeout")
        || low.contains("i/o timeout")
    {
        format!("挂载失败:无法连接远程,请检查地址与网络。(原始错误:{raw})")
    } else if low.contains("401") || low.contains("403") || low.contains("auth") {
        format!("挂载失败:认证被拒,请检查用户名/密码。(原始错误:{raw})")
    } else {
        format!("挂载失败:{raw}")
    }
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
        let _ = do_mount(&state, &e.remote, &e.drive, &e.preset, None).await;
    }
}

// ---------------------------------------------------------------------------
// Core mount logic, shared by the command and the startup restore
// ---------------------------------------------------------------------------

/// Validate a drive letter and return it uppercased without a trailing colon.
fn normalize_drive(drive: &str) -> Result<String, String> {
    let letter = drive.trim().trim_end_matches(':').to_uppercase();
    if letter.len() != 1 || !letter.chars().next().unwrap().is_ascii_alphabetic() {
        return Err(format!("无效的盘符:{drive}"));
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
    .await
    .map_err(|e| friendly_mount_error(&e))?;
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
) -> Result<u64, String> {
    let endpoint = if operation == "sync" {
        "sync/sync"
    } else {
        "sync/copy"
    };
    let resp = rc_call(
        &state,
        endpoint,
        json!({ "srcFs": src, "dstFs": dst, "_async": true }),
    )
    .await?;
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
