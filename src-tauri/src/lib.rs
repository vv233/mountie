mod rclone;

use tauri::menu::{MenuBuilder, MenuItem, MenuItemBuilder};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager, RunEvent, WindowEvent};
use tauri_plugin_autostart::MacosLauncher;
use tauri_plugin_opener::OpenerExt;

/// Bring the main window to the foreground (from tray or when re-launched).
fn show_main(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}

/// Labels for the native tray menu. The frontend mirrors its language into the
/// backend (see `set_lang`) so this matches the rest of the UI.
fn tray_label(lang: &str, key: &str) -> String {
    match (lang, key) {
        ("en", "show") => "Show Mountie",
        ("en", "quit") => "Quit",
        ("en", "none") => "No drives mounted",
        (_, "show") => "显示 Mountie",
        (_, "quit") => "退出",
        (_, "none") => "未挂载任何盘符",
        _ => "",
    }
    .to_string()
}

fn build_tray_menu(app: &AppHandle, lang: &str, mounts: &[rclone::MountInfo]) -> tauri::Result<()> {
    // Menu items must outlive the builder, so collect them first.
    let mut entries: Vec<MenuItem<tauri::Wry>> = Vec::new();
    if mounts.is_empty() {
        entries.push(
            MenuItemBuilder::with_id("none", tray_label(lang, "none"))
                .enabled(false)
                .build(app)?,
        );
    } else {
        for m in mounts {
            let label = format!("{}  ·  {}", m.mount_point, m.fs.trim_end_matches(':'));
            entries.push(
                MenuItemBuilder::with_id(format!("open:{}", m.mount_point), label).build(app)?,
            );
        }
    }
    let show = MenuItemBuilder::with_id("show", tray_label(lang, "show")).build(app)?;
    let quit = MenuItemBuilder::with_id("quit", tray_label(lang, "quit")).build(app)?;

    let mut builder = MenuBuilder::new(app);
    for item in &entries {
        builder = builder.item(item);
    }
    let menu = builder.separator().item(&show).item(&quit).build()?;

    if let Some(tray) = app.tray_by_id("tray") {
        tray.set_menu(Some(menu))?;
    }
    Ok(())
}

/// Rebuild the tray menu so it lists the currently mounted drives.
pub async fn refresh_tray(app: &AppHandle) {
    let mounts = rclone::current_mounts(app).await;
    let lang = {
        let state = app.state::<rclone::RcloneState>();
        let l = state.lang.lock().unwrap().clone();
        l
    };
    if let Err(e) = build_tray_menu(app, &lang, &mounts) {
        eprintln!("tray refresh failed: {e}");
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_autostart::init(
            MacosLauncher::LaunchAgent,
            None,
        ))
        .setup(|app| {
            rclone::init_state(app.handle());

            // System tray: quick access, and it keeps the app alive when the
            // window is closed so mounted drives stay available in the background.
            // The menu is rebuilt with the live mount list by `refresh_tray`.
            let show_item = MenuItemBuilder::with_id("show", tray_label("zh", "show")).build(app)?;
            let quit_item = MenuItemBuilder::with_id("quit", tray_label("zh", "quit")).build(app)?;
            let menu = MenuBuilder::new(app)
                .items(&[&show_item, &quit_item])
                .build()?;
            TrayIconBuilder::with_id("tray")
                .icon(app.default_window_icon().unwrap().clone())
                .tooltip("Mountie")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| {
                    let id = event.id().as_ref().to_string();
                    if let Some(mount_point) = id.strip_prefix("open:") {
                        // Open the mounted drive in the file manager.
                        let _ = app
                            .opener()
                            .open_path(format!("{mount_point}\\"), None::<&str>);
                    } else if id == "show" {
                        show_main(app);
                    } else if id == "quit" {
                        app.exit(0);
                    }
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

            // Start the rclone supervisor: it keeps the daemon running (restarting
            // on crashes) and restores previously-mounted drives when it comes up.
            rclone::start(app.handle());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            rclone::rclone_ready,
            rclone::list_remotes,
            rclone::create_remote,
            rclone::test_remote,
            rclone::get_remote_config,
            rclone::update_remote,
            rclone::delete_remote,
            rclone::list_mounts,
            rclone::mount_remote,
            rclone::unmount,
            rclone::core_stats,
            rclone::remote_about,
            rclone::get_logs,
            rclone::start_transfer,
            rclone::transfer_status,
            rclone::stop_transfer,
            rclone::list_dir,
            rclone::oauth_authorize,
            rclone::free_drive_letters,
            rclone::winfsp_installed,
            rclone::get_autostart,
            rclone::set_autostart,
            rclone::set_lang,
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
