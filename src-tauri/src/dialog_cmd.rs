use rfd::FileDialog;
use serde::Deserialize;
use std::path::PathBuf;
use tauri::Window;

#[derive(Deserialize)]
pub struct PickDialogOptions {
    title: Option<String>,
    directory: Option<bool>,
    #[allow(dead_code)]
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
