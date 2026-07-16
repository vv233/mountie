mod rclone;

use tauri::menu::{MenuBuilder, MenuItemBuilder};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager, RunEvent, WindowEvent};
use tauri_plugin_autostart::MacosLauncher;

/// Bring the main window to the foreground (from tray or when re-launched).
fn show_main(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_autostart::init(
            MacosLauncher::LaunchAgent,
            None,
        ))
        .setup(|app| {
            rclone::init_state(app.handle());

            // System tray: quick access, and it keeps the app alive when the
            // window is closed so mounted drives stay available in the background.
            let show_item = MenuItemBuilder::with_id("show", "显示 Mountie").build(app)?;
            let quit_item = MenuItemBuilder::with_id("quit", "退出").build(app)?;
            let menu = MenuBuilder::new(app)
                .items(&[&show_item, &quit_item])
                .build()?;
            TrayIconBuilder::with_id("tray")
                .icon(app.default_window_icon().unwrap().clone())
                .tooltip("Mountie")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id().as_ref() {
                    "show" => show_main(app),
                    "quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        show_main(tray.app_handle());
                    }
                })
                .build(app)?;

            // Closing the window hides to tray instead of quitting.
            if let Some(window) = app.get_webview_window("main") {
                let w = window.clone();
                window.on_window_event(move |event| {
                    if let WindowEvent::CloseRequested { api, .. } = event {
                        api.prevent_close();
                        let _ = w.hide();
                    }
                });
            }

            // Start rclone in the background, then restore previously-mounted
            // drives so the app picks up where it left off.
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                match rclone::start(&handle).await {
                    Ok(()) => rclone::restore_mounts(&handle).await,
                    Err(e) => eprintln!("failed to start rclone: {e}"),
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
            rclone::start_transfer,
            rclone::transfer_status,
            rclone::stop_transfer,
            rclone::winfsp_installed,
            rclone::get_autostart,
            rclone::set_autostart,
        ])
        .build(tauri::generate_context!())
        .expect("error while building Mountie")
        .run(|app_handle, event| {
            // Ensure the rclone sidecar is killed when the app truly exits.
            if let RunEvent::Exit = event {
                if let Some(state) = app_handle.try_state::<rclone::RcloneState>() {
                    rclone::stop(&state);
                }
            }
        });
}
