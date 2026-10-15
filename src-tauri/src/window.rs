use tauri::window::EffectState;
use tauri::{AppHandle, Manager, PhysicalPosition, PhysicalSize, WebviewWindow};

pub const FLOATING: &str = "floating";
pub const MAIN: &str = "main";

/// 全局快捷键唤起/隐藏悬浮窗（PRD F2.4）
pub const DEFAULT_HOTKEY: &str = "Ctrl+Shift+Space";

/// 悬浮窗贴靠屏幕右上角时留的边距
const EDGE_MARGIN: i32 = 12;

/// 两种形态的尺寸（逻辑像素；Rust 侧传的是物理像素，Tauri 会按缩放换算）
const FLOATING_EXPANDED_HEIGHT: u32 = 480;
const FLOATING_COLLAPSED_HEIGHT: u32 = 64;

/// 判定"是不是展开态"的高度阈值，取两者中间值，两侧留出容错
fn is_expanded(height: u32) -> bool {
    height > (FLOATING_EXPANDED_HEIGHT + FLOATING_COLLAPSED_HEIGHT) / 2
}

/// 切换悬浮窗的展开/收起态，或在隐藏时把它唤回来（PRD F2.1、F2.3）
pub fn toggle_floating(app: &AppHandle) {
    let Some(win) = app.get_webview_window(FLOATING) else {
        return;
    };

    match win.is_visible() {
        Ok(false) => {
            let _ = win.show();
            let _ = win.unminimize();
            let _ = win.set_focus();
        }
        Ok(true) => {
            let Ok(current) = win.outer_size() else { return };

            if is_expanded(current.height) {
                let _ = win.set_size(PhysicalSize::new(current.width, FLOATING_COLLAPSED_HEIGHT));
                let _ = win.set_always_on_top(false);
            } else {
                let _ = win.set_size(PhysicalSize::new(current.width, FLOATING_EXPANDED_HEIGHT));
                dock_to_corner(&win);
            }
        }
        Err(_) => {}
    }
}

/// 贴到所在屏幕的右上角，避开任务栏
fn dock_to_corner(win: &WebviewWindow) {
    let Ok(Some(monitor)) = win.current_monitor() else {
        return;
    };
    let Ok(current) = win.outer_size() else { return };

    let monitor_pos = monitor.position();
    let monitor_size = monitor.size();

    let x = monitor_pos.x + monitor_size.width as i32 - current.width as i32 - EDGE_MARGIN;
    let y = monitor_pos.y + EDGE_MARGIN;

    let _ = win.set_position(PhysicalPosition::new(x, y));
}

/// 应用 Windows 11 原生 Mica 材质（PRD F9.6）。
///
/// 非 Windows 平台编译为空函数 —— 这个项目只发 Windows，
/// 但留着 cfg 分支是为了让 `cargo check` 在别的系统上也能过。
pub fn apply_mica(win: &WebviewWindow, dark: bool) {
    #[cfg(target_os = "windows")]
    {
        use tauri::window::{EffectsBuilder, Effect};

        let effect = if dark { Effect::MicaAlt } else { Effect::Mica };
        let state = if dark {
            EffectState::Active
        } else {
            EffectState::Inactive
        };

        // 失败不是致命问题：材质只是锦上添花，没有它窗口照样能用
        let _ = win.set_effects(EffectsBuilder::new().effect(effect).state(state).build());
    }

    #[cfg(not(target_os = "windows"))]
    {
        let _ = (win, dark);
    }
}

/// 单实例回调：第二次启动时把已有窗口唤到前台，
/// 而不是开第二个进程同时写同一个库文件（PRD F2.15、风险 R5）
pub fn focus_existing(app: &AppHandle) {
    for label in [MAIN, FLOATING] {
        if let Some(win) = app.get_webview_window(label) {
            let _ = win.show();
            let _ = win.unminimize();
            let _ = win.set_focus();
        }
    }
}
