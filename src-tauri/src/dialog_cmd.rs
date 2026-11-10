// Copyright (C) 2026 Qomicex Launcher Contributors
// SPDX-License-Identifier: GPL-3.0-or-later

use rfd::FileDialog;
use serde::Deserialize;
use std::path::PathBuf;
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

/// 自定义主页组件文件上限（与前端 XML 校验的 64KB 留足余量）。
const MAX_WIDGET_FILE_BYTES: u64 = 256 * 1024;

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
        return Err("组件文件超过 256KB".to_string());
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
        return Err("组件内容超过 256KB".to_string());
    }
    std::fs::write(&path, content).map_err(|e| format!("写入组件文件失败: {e}"))
}
