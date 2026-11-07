use base64::{engine::general_purpose::STANDARD, Engine as _};
use std::fs;
use std::path::Path;
use tauri::Emitter;

/// 把前端传来的 base64 字节写入指定路径（保存 PDF / TXT）。
#[tauri::command(rename_all = "camelCase")]
fn write_file_b64(path: String, data: String) -> Result<(), String> {
    let bytes = STANDARD
        .decode(data.as_bytes())
        .map_err(|e| format!("数据解码失败: {e}"))?;
    if let Some(parent) = Path::new(&path).parent() {
        fs::create_dir_all(parent).map_err(|e| format!("创建目录失败: {e}"))?;
    }
    fs::write(&path, bytes).map_err(|e| format!("写入文件失败: {e}"))?;
    Ok(())
}

/// 读取磁盘文件并以 base64 返回（文件关联 / 单实例启动时打开 PDF）。
#[tauri::command(rename_all = "camelCase")]
fn read_file_b64(path: String) -> Result<String, String> {
    let bytes = fs::read(&path).map_err(|e| format!("读取文件失败: {e}"))?;
    Ok(STANDARD.encode(bytes))
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            let pdfs: Vec<String> = argv
                .iter()
                .filter(|a| a.to_lowercase().ends_with(".pdf"))
                .cloned()
                .collect();
            if !pdfs.is_empty() {
                let _ = app.emit("open-files", pdfs);
            }
        }))
        .invoke_handler(tauri::generate_handler![write_file_b64, read_file_b64])
        .run(tauri::generate_context!())
        .expect("error while running PDF Studio");
}
