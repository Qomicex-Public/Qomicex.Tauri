use std::path::Path;

/// Resolve PCL modpack icon from a version directory.
/// Checks `{version_dir}/PCL/Logo.png` first, then `Icon.png`.
/// Returns a base64 data URI on success.
pub fn resolve_pcl_icon(version_dir: &Path) -> Option<String> {
    let pcl_dir = version_dir.join("PCL");
    let logo = pcl_dir.join("Logo.png");
    let icon = pcl_dir.join("Icon.png");
    let path = if logo.is_file() {
        Some(logo)
    } else if icon.is_file() {
        Some(icon)
    } else {
        None
    };
    path.and_then(|p| std::fs::read(&p).ok().map(|bytes| (p, bytes)))
        .and_then(|(p, bytes)| {
            if bytes.is_empty() {
                return None;
            }
            let mime = if let Some(ext) = p.extension().and_then(|e| e.to_str()) {
                match ext.to_lowercase().as_str() {
                    "jpg" | "jpeg" => "image/jpeg",
                    "webp" => "image/webp",
                    "gif" => "image/gif",
                    _ => "image/png",
                }
            } else {
                "image/png"
            };
            Some(format!("data:{mime};base64,{}", base64_encode(&bytes)))
        })
}

fn base64_encode(input: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(input.len().div_ceil(3) * 4);
    let mut i = 0;
    while i + 3 <= input.len() {
        let n = ((input[i] as u32) << 16) | ((input[i + 1] as u32) << 8) | (input[i + 2] as u32);
        out.push(TABLE[(n >> 18) as usize & 63] as char);
        out.push(TABLE[(n >> 12) as usize & 63] as char);
        out.push(TABLE[(n >> 6) as usize & 63] as char);
        out.push(TABLE[n as usize & 63] as char);
        i += 3;
    }
    let rem = input.len() - i;
    if rem == 1 {
        let n = (input[i] as u32) << 16;
        out.push(TABLE[(n >> 18) as usize & 63] as char);
        out.push(TABLE[(n >> 12) as usize & 63] as char);
        out.push('=');
        out.push('=');
    } else if rem == 2 {
        let n = ((input[i] as u32) << 16) | ((input[i + 1] as u32) << 8);
        out.push(TABLE[(n >> 18) as usize & 63] as char);
        out.push(TABLE[(n >> 12) as usize & 63] as char);
        out.push(TABLE[(n >> 6) as usize & 63] as char);
        out.push('=');
    }
    out
}
