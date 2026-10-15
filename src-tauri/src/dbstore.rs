use std::fs;
use std::path::{Path, PathBuf};

/// 数据目录解析（PRD §2.5、§7.1）。
///
/// 绿色版没有安装目录的概念，"程序在哪，数据就在哪" 才是用户预期的行为：
/// 把 exe 连同 data/ 一起拷到 U 盘，换台电脑插上就能接着用。
///
/// 但 exe 可能被放在 Program Files 或其它只读位置，这时要回退到
/// %APPDATA%。回退后必须在设置里显示真实路径 —— 否则用户拷了文件夹
/// 却发现数据没跟过去，会以为程序坏了。
pub struct DataDir {
    path: PathBuf,
    /// true 表示用的是 exe 同级的可写位置（绿色版模式）
    portable: bool,
}

impl DataDir {
    pub fn resolve() -> Self {
        if let Some(exe_dir) = current_exe_dir() {
            let candidate = exe_dir.join("data");
            if ensure_writable(&candidate) {
                return Self {
                    path: candidate,
                    portable: true,
                };
            }
        }

        let fallback = app_data_dir().join("data");
        let _ = ensure_writable(&fallback);
        Self {
            path: fallback,
            portable: false,
        }
    }

    pub fn db_file(&self) -> PathBuf {
        self.path.join("memodeck.db")
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn is_portable(&self) -> bool {
        self.portable
    }

    /// 给界面显示的一句话说明
    pub fn describe(&self) -> String {
        if self.portable {
            format!("绿色版 · {}", self.path.display())
        } else {
            format!("用户目录 · {}", self.path.display())
        }
    }
}

fn current_exe_dir() -> Option<PathBuf> {
    std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(Path::to_path_buf))
}

fn app_data_dir() -> PathBuf {
    if let Ok(dir) = std::env::var("APPDATA") {
        return PathBuf::from(dir).join("MemoDeck");
    }
    if let Some(home) = dirs_home() {
        return home.join(".memodeck");
    }
    PathBuf::from(".")
}

fn dirs_home() -> Option<PathBuf> {
    std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .ok()
        .map(PathBuf::from)
}

fn ensure_writable(dir: &Path) -> bool {
    if fs::create_dir_all(dir).is_err() {
        return false;
    }
    // 建目录成功不代表能写 —— 只读挂载点上也可能建出来
    let probe = dir.join(".write-test");
    match fs::write(&probe, b"ok") {
        Ok(_) => {
            let _ = fs::remove_file(&probe);
            true
        }
        Err(_) => false,
    }
}

/// 读数据库。首次运行时文件不存在，返回 None，由前端建新库。
#[tauri::command]
pub fn load_db(data_dir: tauri::State<'_, DataDir>) -> Result<Option<Vec<u8>>, String> {
    let path = data_dir.db_file();
    if !path.exists() {
        return Ok(None);
    }
    fs::read(&path).map_err(|e| format!("读取数据库失败 ({}): {e}", path.display()))
}

/// 写数据库。
///
/// 先写临时文件再原子改名：直接覆盖的话，写到一半断电会留下损坏的库，
/// 而用户没有任何手段恢复。改名在同一个卷上是原子的。
#[tauri::command]
pub fn save_db(bytes: Vec<u8>, data_dir: tauri::State<'_, DataDir>) -> Result<(), String> {
    let path = data_dir.db_file();
    let tmp = path.with_extension("db.tmp");

    fs::write(&tmp, &bytes).map_err(|e| format!("写入临时文件失败: {e}"))?;
    fs::rename(&tmp, &path).map_err(|e| {
        let _ = fs::remove_file(&tmp);
        format!("提交数据库失败: {e}")
    })
}

/// 界面里显示数据位置用
#[tauri::command]
pub fn data_location(data_dir: tauri::State<'_, DataDir>) -> DataDirInfo {
    DataDirInfo {
        path: data_dir.path().display().to_string(),
        portable: data_dir.is_portable(),
        description: data_dir.describe(),
    }
}

#[derive(serde::Serialize)]
pub struct DataDirInfo {
    pub path: String,
    pub portable: bool,
    pub description: String,
}
