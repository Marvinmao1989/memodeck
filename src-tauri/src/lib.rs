mod dbstore;
mod tray;
mod window;

use tauri::Manager;

use dbstore::DataDir;
use window::{FLOATING, MAIN};

/// MemoDeck —— Windows 桌面悬浮备忘录。
///
/// 设计上的两个关键点（详见 docs/PRD.md）：
///   1. 免安装绿色版：单 exe，数据默认存在 exe 同级的 data/ 目录
///   2. 托盘常驻：悬浮窗关掉不等于退出，否则提醒会失效（PRD F6.5）
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // 单实例必须在最前面注册，否则第二次启动会先把窗口建出来再被销毁
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            window::focus_existing(app);
        }))
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, _shortcut, event| {
                    // 只在按下时切换，长按不会连发（PRD F2.4）
                    if event.state() == tauri_plugin_global_shortcut::ShortcutState::Pressed {
                        window::toggle_floating(app);
                    }
                })
                .build(),
        )
        .plugin(tauri_plugin_notification::init())
        .manage(DataDir::resolve())
        .setup(|app| {
            // 两个窗口共用同一个 index.html，靠 label 区分（见 src/App.tsx）
            if let Some(floating) = app.get_webview_window(FLOATING) {
                window::apply_mica(&floating, false);
            }

            // 主窗口默认最小化：用户开机时不想被一个 980px 的窗口糊脸
            if let Some(main) = app.get_webview_window(MAIN) {
                let _ = main.minimize();
            }

            tray::build_tray(app.handle())?;

            Ok(())
        })
        .on_window_event(|window, event| {
            // 关闭悬浮窗只是隐藏，不是退出 —— 托盘要继续提供提醒
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                if window.label() == FLOATING {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            dbstore::load_db,
            dbstore::save_db,
            dbstore::data_location,
        ])
        .run(tauri::generate_context!())
        .expect("启动 MemoDeck 失败");
}
