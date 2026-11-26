// Copyright (C) 2026 Qomicex Launcher Contributors
// SPDX-License-Identifier: GPL-3.0-or-later

//! 游戏窗口设置：全局/实例模式归一与启动参数生成。
//!
//! 小/中/大按屏幕比例在前端换算成具体像素（需要 WebView 的屏幕尺寸），
//! 后端只接收最终宽高，不重复实现屏幕探测。

/// 全局与实例共用的模式枚举（`None` 各有不同含义：全局=不指定，实例=跟随全局）。
pub const MODES: &[&str] = &[
    "default",
    "small",
    "medium",
    "large",
    "fullscreen",
    "custom",
];

pub fn is_known_mode(value: &str) -> bool {
    MODES.contains(&value)
}

/// 未知/脏值一律视为未设置，避免手改配置让启动参数落空。
pub fn normalize_mode(value: Option<&str>) -> Option<&str> {
    value.map(str::trim).filter(|v| is_known_mode(v))
}

/// 宽高只接受正整数；上限交给游戏自身（用户明确要求不限制范围）。
pub fn normalize_dimension(value: Option<i32>) -> Option<i32> {
    value.filter(|v| *v > 0)
}

/// 生成追加到版本参数之后的游戏参数。全屏优先；宽高必须成对出现。
pub fn extra_game_args(
    width: Option<i32>,
    height: Option<i32>,
    fullscreen: Option<bool>,
) -> Option<Vec<String>> {
    if fullscreen == Some(true) {
        return Some(vec!["--fullscreen".to_string()]);
    }
    let width = normalize_dimension(width)?;
    let height = normalize_dimension(height)?;
    Some(vec![
        "--width".to_string(),
        width.to_string(),
        "--height".to_string(),
        height.to_string(),
    ])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fullscreen_wins_over_dimensions() {
        assert_eq!(
            extra_game_args(Some(1280), Some(720), Some(true)),
            Some(vec!["--fullscreen".to_string()])
        );
    }

    #[test]
    fn only_positive_pairs_produce_args() {
        assert_eq!(extra_game_args(None, Some(720), None), None);
        assert_eq!(extra_game_args(Some(0), Some(720), None), None);
        assert_eq!(
            extra_game_args(Some(1280), Some(720), None),
            Some(vec![
                "--width".to_string(),
                "1280".to_string(),
                "--height".to_string(),
                "720".to_string()
            ])
        );
    }

    #[test]
    fn unknown_modes_and_dirty_dimensions_are_ignored() {
        assert_eq!(normalize_mode(Some("huge")), None);
        assert_eq!(normalize_mode(Some(" custom ")), Some("custom"));
        assert_eq!(normalize_dimension(Some(-1)), None);
        assert_eq!(normalize_dimension(Some(1920)), Some(1920));
    }
}
