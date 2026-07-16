mod rclone;

use tauri::{Manager, RunEvent};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_shell::init())
        .setup(|app| {
            rclone::init_state(app.handle());
            let handle = app.handle().clone();
            // Start the rclone daemon in the background so the window shows
            // immediately; the frontend polls `rclone_ready` before acting.
            tauri::async_runtime::spawn(async move {
                if let Err(e) = rclone::start(&handle).await {
                    eprintln!("failed to start rclone: {e}");
                }
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            rclone::rclone_ready,
            rclone::list_remotes,
            rclone::create_remote,
            rclone::delete_remote,
            rclone::list_mounts,
            rclone::mount_remote,
            rclone::unmount,
            rclone::core_stats,
            rclone::winfsp_installed,
        ])
        .build(tauri::generate_context!())
        .expect("error while building Mountie")
        .run(|app_handle, event| {
            // Ensure the rclone sidecar is killed when the app exits.
            if let RunEvent::Exit = event {
                if let Some(state) = app_handle.try_state::<rclone::RcloneState>() {
                    rclone::stop(&state);
                }
            }
        });
}
