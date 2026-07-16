//! rclone integration: manages the bundled `rclone rcd` sidecar and drives it
//! through its Remote Control (RC) HTTP API. All cloud/protocol work (config,
//! mounting, transfers) is delegated to rclone — this module is the thin, typed
//! bridge the GUI talks to.

use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Serialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Manager, State};
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
            user: "openraidrive".to_string(),
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
        .sidecar("binaries/rclone")
        .map_err(|e| format!("failed to locate bundled rclone: {e}"))?
        .args([
            "rcd",
            "--rc-addr",
            &format!("{RC_HOST}:{RC_PORT}"),
            "--rc-user",
            &state.user,
            "--rc-pass",
            &state.pass,
            // Persist config next to rclone's own default location so remotes
            // survive restarts and interoperate with a CLI rclone if present.
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
// Types exchanged with the frontend
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
pub async fn delete_remote(state: State<'_, RcloneState>, name: String) -> Result<(), String> {
    rc_call(&state, "config/delete", json!({ "name": name })).await?;
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

/// Mount `remote` at a Windows drive letter (e.g. "X") using a performance preset.
#[tauri::command]
pub async fn mount_remote(
    state: State<'_, RcloneState>,
    remote: String,
    drive: String,
    preset: String,
) -> Result<(), String> {
    // Normalise the drive letter to the "X:" form WinFsp expects.
    let letter = drive.trim().trim_end_matches(':').to_uppercase();
    if letter.len() != 1 || !letter.chars().next().unwrap().is_ascii_alphabetic() {
        return Err(format!("invalid drive letter: {drive}"));
    }
    let mount_point = format!("{letter}:");
    let (vfs_opt, mount_opt) = preset_options(&preset, &remote);

    rc_call(
        &state,
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

#[tauri::command]
pub async fn unmount(state: State<'_, RcloneState>, mount_point: String) -> Result<(), String> {
    rc_call(&state, "mount/unmount", json!({ "mountPoint": mount_point }))
        .await?;
    Ok(())
}

/// Live transfer stats (bytes, speed, transfers) — used by the status bar and,
/// later, the transfer panel.
#[tauri::command]
pub async fn core_stats(state: State<'_, RcloneState>) -> Result<Value, String> {
    rc_call(&state, "core/stats", json!({})).await
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

/// Register state during app setup.
pub fn init_state(app: &AppHandle) {
    app.manage(RcloneState::new());
}
