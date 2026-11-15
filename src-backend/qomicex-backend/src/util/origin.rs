// Copyright (C) 2026 Qomicex Launcher Contributors
// SPDX-License-Identifier: GPL-3.0-or-later

//! 请求来源校验。
//!
//! 后端监听 `127.0.0.1` 且 CORS 放行任意来源，只靠这一点挡不住任意网页发起的
//! 跨站请求；跨站请求必带 `Origin`，应用内请求只来自本机地址与 Tauri 自定义协议。
//! 会写用户文件（任意路径写盘、删暂存区）的端点必须先用它筛掉外来来源。

/// 浏览器同源来源白名单。
pub fn is_local_origin(origin: &str) -> bool {
    let o = origin.trim().to_ascii_lowercase();
    o == "http://localhost"
        || o.starts_with("http://localhost:")
        || o == "http://127.0.0.1"
        || o.starts_with("http://127.0.0.1:")
        || o.starts_with("tauri://")
        || o.starts_with("http://tauri.localhost")
        || o.starts_with("https://tauri.localhost")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_app_and_local_origins() {
        for ok in [
            "http://localhost:1420",
            "http://127.0.0.1:5000",
            "tauri://localhost",
            "http://tauri.localhost",
            "https://tauri.localhost",
        ] {
            assert!(is_local_origin(ok), "{ok} 应放行");
        }
    }

    #[test]
    fn rejects_foreign_origins() {
        for bad in [
            "https://evil.example",
            "http://localhost.evil.example",
            "http://127.0.0.1.evil.example",
            "null",
        ] {
            assert!(!is_local_origin(bad), "{bad} 应拒绝");
        }
    }
}
