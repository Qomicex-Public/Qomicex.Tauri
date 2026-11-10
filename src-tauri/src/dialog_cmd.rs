// Copyright (C) 2026 Qomicex Launcher Contributors
// SPDX-License-Identifier: GPL-3.0-or-later

use rfd::FileDialog;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::time::Duration;
use tauri::async_runtime;
use tauri::Window;

#[derive(Deserialize)]
pub struct PickDialogOptions {
    title: Option<String>,
    directory: Option<bool>,
    multiple: Option<bool>,
    default_path: Option<String>,
    filters: Option<Vec<FilterDef>>,
}

#[derive(Deserialize)]
pub struct FilterDef {
    name: String,
    extensions: Vec<String>,
}

#[tauri::command]
pub fn pick_dialog(window: Window, options: PickDialogOptions) -> Option<String> {
    let _guard = async_runtime::handle().inner().enter();
    let mut dialog = FileDialog::new().set_parent(&window);

    if let Some(title) = &options.title {
        dialog = dialog.set_title(title);
    }
    if let Some(path) = &options.default_path {
        dialog = dialog.set_directory(&PathBuf::from(path));
    }
    if let Some(filters) = &options.filters {
        for f in filters {
            let exts: Vec<&str> = f.extensions.iter().map(|s| s.as_str()).collect();
            dialog = dialog.add_filter(&f.name, &exts);
        }
    }

    let result = if options.directory.unwrap_or(false) {
        dialog.pick_folder()
    } else if options.multiple.unwrap_or(false) {
        let files = dialog.pick_files();
        files.and_then(|v| v.into_iter().next())
    } else {
        dialog.pick_file()
    };

    result.map(|p| p.to_string_lossy().to_string())
}

/// 自定义主页组件文件上限；XML 解析层仍限制 256KB，这里给文本数据留出余量。
const MAX_WIDGET_FILE_BYTES: u64 = 1024 * 1024;
const MAX_WIDGET_BINARY_BYTES: u64 = 8 * 1024 * 1024;
const MAX_COMMAND_OUTPUT_BYTES: usize = 64 * 1024;

/// 只允许 `.qwidget` / `.xml`：导入导出走原生对话框选路径，但 IPC 仍可能被
/// 任意页面调用，扩展名白名单把可读写面收窄到组件文件。
fn is_widget_file(path: &PathBuf) -> bool {
    path.extension()
        .and_then(|ext| ext.to_str())
        .is_some_and(|ext| {
            let ext = ext.to_ascii_lowercase();
            ext == "qwidget" || ext == "xml"
        })
}

#[tauri::command]
pub fn read_widget_file(path: String) -> Result<String, String> {
    let path = PathBuf::from(path);
    if !is_widget_file(&path) {
        return Err("仅支持 .qwidget / .xml 文件".to_string());
    }
    let len = std::fs::metadata(&path)
        .map_err(|e| format!("读取组件文件失败: {e}"))?
        .len();
    if len > MAX_WIDGET_FILE_BYTES {
        return Err("组件文件超过 1MB".to_string());
    }
    std::fs::read_to_string(&path).map_err(|e| format!("读取组件文件失败: {e}"))
}

#[tauri::command]
pub fn write_widget_file(path: String, content: String) -> Result<(), String> {
    let path = PathBuf::from(path);
    if !is_widget_file(&path) {
        return Err("仅支持 .qwidget / .xml 文件".to_string());
    }
    if content.len() as u64 > MAX_WIDGET_FILE_BYTES {
        return Err("组件内容超过 1MB".to_string());
    }
    std::fs::write(&path, content).map_err(|e| format!("写入组件文件失败: {e}"))
}

#[derive(Serialize)]
pub struct WidgetBinaryFile {
    base64: String,
    size: u64,
}

/// 读取本地二进制数据（图片/音频/视频）。路径由组件 XML 声明，前端展示解析结果。
#[tauri::command]
pub fn read_widget_binary(path: String) -> Result<WidgetBinaryFile, String> {
    let path = PathBuf::from(path);
    let size = std::fs::metadata(&path)
        .map_err(|e| format!("读取文件失败: {e}"))?
        .len();
    if size > MAX_WIDGET_BINARY_BYTES {
        return Err("二进制文件超过 8MB".to_string());
    }
    let bytes = std::fs::read(&path).map_err(|e| format!("读取文件失败: {e}"))?;
    use base64::Engine;
    Ok(WidgetBinaryFile {
        base64: base64::engine::general_purpose::STANDARD.encode(bytes),
        size,
    })
}

#[derive(Serialize)]
pub struct WidgetCommandOutput {
    #[serde(rename = "exitCode")]
    exit_code: i32,
    stdout: String,
    stderr: String,
}

/// 执行自定义组件声明的命令。用户已确认自定义组件可运行命令；仍限制输出与超时。
#[tauri::command]
pub async fn run_widget_command(
    command: String,
    working_directory: Option<String>,
    timeout_ms: Option<u64>,
) -> Result<WidgetCommandOutput, String> {
    let timeout = Duration::from_millis(timeout_ms.unwrap_or(10_000).clamp(1_000, 60_000));
    let mut cmd = if cfg!(windows) {
        let mut cmd = tokio::process::Command::new("cmd");
        cmd.arg("/C").arg(&command);
        cmd
    } else {
        let mut cmd = tokio::process::Command::new("sh");
        cmd.arg("-c").arg(&command);
        cmd
    };
    if let Some(dir) = working_directory {
        if !dir.trim().is_empty() {
            cmd.current_dir(dir);
        }
    }
    cmd.kill_on_drop(true);
    match tokio::time::timeout(timeout, cmd.output()).await {
        Ok(Ok(output)) => {
            let stdout = String::from_utf8_lossy(&output.stdout);
            let stderr = String::from_utf8_lossy(&output.stderr);
            Ok(WidgetCommandOutput {
                exit_code: output.status.code().unwrap_or(-1),
                stdout: truncate_output(&stdout),
                stderr: truncate_output(&stderr),
            })
        }
        Ok(Err(error)) => Err(format!("命令执行失败: {error}")),
        Err(_) => Err("命令执行超时".to_string()),
    }
}

fn truncate_output(value: &str) -> String {
    if value.len() <= MAX_COMMAND_OUTPUT_BYTES {
        return value.to_string();
    }
    let mut end = MAX_COMMAND_OUTPUT_BYTES;
    while !value.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}…（输出已截断）", &value[..end])
}
