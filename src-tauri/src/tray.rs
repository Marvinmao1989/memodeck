use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, Runtime};

use crate::window::{self, MAIN};

/// 系统托盘常驻（PRD F2.12）
///
/// 托盘图标承担三件事：显示/隐藏悬浮窗、快速新建、以及**鼠标穿透模式下
/// 唯一的退出入口**（PRD R11 —— 穿透打开后窗口完全不响应鼠标，
/// 如果托盘图标也用同一套置顶逻辑，用户就再也关不掉了）。
pub fn build_tray<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<()> {
    let show = MenuItem::with_id(app, "show", "显示 / 隐藏悬浮窗", true, None::<&str>)?;
    let expand = MenuItem::with_id(app, "expand", "打开主窗口", true, None::<&str>)?;
    let sync = MenuItem::with_id(app, "sync", "立即同步", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "退出 MemoDeck", true, None::<&str>)?;

    let menu = Menu::with_items(
        app,
        &[
            &show,
            &PredefinedMenuItem::separator(app)?,
            &expand,
            &sync,
            &PredefinedMenuItem::separator(app)?,
            &quit,
        ],
    )?;

    TrayIconBuilder::with_id("main")
        .icon(app.default_window_icon().cloned().unwrap())
        .tooltip("MemoDeck")
        .menu(&menu)
        // 托盘要常驻，不随窗口关闭而消失
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "show" => window::toggle_floating(app),
            "expand" => {
                if let Some(win) = app.get_webview_window(MAIN) {
                    let _ = win.show();
                    let _ = win.set_focus();
                }
            }
            "sync" => {
                if let Some(win) = app.get_webview_window(FLOATING) {
                    // 前端监听这个事件后触发同步
                    let _ = win.emit_to(win.label(), "sync-requested", ());
                }
            }
            "quit" => {
                // 退出前必须让前端把内存里的数据库刷盘
                if let Some(win) = app.get_webview_window(FLOATING) {
                    let _ = win.emit_to(win.label(), "flush-requested", ());
                }
                app.exit(0);
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            // 左键单击切换悬浮窗显隐，不弹菜单 —— 菜单留给右键
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                window::toggle_floating(tray.app_handle());
            }
        })
        .build(app)?;

    Ok(())
}
