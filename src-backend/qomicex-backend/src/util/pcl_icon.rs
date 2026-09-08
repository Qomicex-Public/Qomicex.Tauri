use std::path::Path;

/// Resolve PCL modpack icon from a version directory.
/// Checks `{version_dir}/PCL/Logo.png`, `Icon.png`, then HMCL-style `icon.png`.
/// Returns a base64 data URI on success.
pub fn resolve_pcl_icon(version_dir: &Path) -> Option<String> {
    let pcl_dir = version_dir.join("PCL");
    let logo = pcl_dir.join("Logo.png");
    let icon = pcl_dir.join("Icon.png");
    let hmcl_icon = version_dir.join("icon.png");
    let path = if logo.is_file() {
        Some(logo)
    } else if icon.is_file() {
        Some(icon)
    } else if hmcl_icon.is_file() {
        Some(hmcl_icon)
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

/// Minimal standard base64 decode (data URI payloads; whitespace/padding tolerant).
pub fn base64_decode(input: &str) -> Option<Vec<u8>> {
    fn val(c: u8) -> Option<u32> {
        match c {
            b'A'..=b'Z' => Some((c - b'A') as u32),
            b'a'..=b'z' => Some((c - b'a') as u32 + 26),
            b'0'..=b'9' => Some((c - b'0') as u32 + 52),
            b'+' => Some(62),
            b'/' => Some(63),
            _ => None,
        }
    }
    let mut out = Vec::with_capacity(input.len() / 4 * 3);
    let mut acc: u32 = 0;
    let mut bits: u32 = 0;
    for &c in input.as_bytes() {
        if c.is_ascii_whitespace() || c == b'=' {
            continue;
        }
        acc = (acc << 6) | val(c)?;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((acc >> bits) as u8);
        }
    }
    Some(out)
}
