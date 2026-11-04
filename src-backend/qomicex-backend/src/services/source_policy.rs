// Copyright (C) 2026 Qomicex Launcher Contributors
// SPDX-License-Identifier: GPL-3.0-or-later

//! 下载源策略：**偏好只决定优先级顺序，两侧互为兜底**。
//!
//! 设置项不再选择「具体某个源」，而是表达偏好：
//! - `official`：官方源先，失败回退镜像；
//! - `mirror`：镜像先，失败回退官方。
//!
//! 自动模式按资源类型分别决定优先级：
//! - 模组文件：国内（UTC+8）镜像优先、境外官方优先（镜像本来只为国内链路准备）；
//! - 原版文件：一律官方优先——实测高并发下 Mojang 官方 CDN 比 BMCLAPI 更稳，
//!   BMCLAPI 只作兜底。
//!
//! 所有调用方都必须通过本模块拿顺序，避免「这里按设置、那里按请求参数」再次分裂。

use crate::services::file_mirror;
use crate::settings::{is_china_timezone, load_settings};

/// 原版文件（jar / libraries / assets / 加载器安装器）的主选来源。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum VanillaSource {
    Official,
    Bmclapi,
}

/// 一次操作解析出的下载源计划。**按批次解析一次**：策略读设置文件，
/// 不要在每个文件上下载时重复读盘。
#[derive(Clone, Copy, Debug)]
pub struct SourcePlan {
    /// 模组文件是否镜像优先（false = 官方优先，镜像兜底）。
    pub mirror_first_for_mods: bool,
    /// 原版文件的主选来源。
    pub vanilla: VanillaSource,
}

impl SourcePlan {
    /// 由原始输入解析计划（纯函数，便于测试）。
    ///
    /// - 自动：模组按地域（国内镜像优先、境外官方优先），原版恒官方优先；
    /// - 手动：两类资源各按自己的偏好，偏好只决定顺序，另一侧仍兜底。
    pub fn resolve(auto: bool, vanilla_mirror: bool, mod_mirror: bool, china: bool) -> Self {
        let (mirror_first_for_mods, vanilla) = if auto {
            (china, VanillaSource::Official)
        } else {
            (
                mod_mirror,
                if vanilla_mirror {
                    VanillaSource::Bmclapi
                } else {
                    VanillaSource::Official
                },
            )
        };
        Self {
            mirror_first_for_mods,
            vanilla,
        }
    }

    pub fn load() -> Self {
        let s = load_settings();
        Self::resolve(
            s.auto_select_source.unwrap_or(true),
            s.vanilla_source_preference.eq_ignore_ascii_case("mirror"),
            s.mod_source_preference.eq_ignore_ascii_case("mirror"),
            is_china_timezone(),
        )
    }

    /// 供核心库（`GameCoreBuilder::use_download_mirror`）使用的原版源编号：
    /// 0 = 官方，1 = BMCLAPI。
    pub fn vanilla_mirror_id(&self) -> i32 {
        match self.vanilla {
            VanillaSource::Official => 0,
            VanillaSource::Bmclapi => 1,
        }
    }

    /// 原版镜像是否当前可用（供日志/诊断）。
    pub fn vanity_debug(&self) -> String {
        format!(
            "vanilla={:?} mod_mirror_first={}",
            self.vanilla, self.mirror_first_for_mods
        )
    }
}

impl Default for SourcePlan {
    fn default() -> Self {
        Self::load()
    }
}

/// 该 URL 的候选顺序（首项主选，其余兜底）。仅对模组文件 CDN 生效。
///
/// 镜像侧固定为 MCIM → QML → 官方；镜像整体不可用（健康探针失败）时退回官方单源。
pub fn mod_file_candidates(url: &str, plan: &SourcePlan) -> Vec<String> {
    file_mirror::candidates(url, plan.mirror_first_for_mods)
}

/// 模组文件的主选 URL。
pub fn mod_primary(url: &str, plan: &SourcePlan) -> String {
    file_mirror::primary(url, plan.mirror_first_for_mods)
}

/// 模组文件的兜底 URL（已排除主选）。
pub fn mod_fallbacks(url: &str, plan: &SourcePlan) -> Vec<String> {
    file_mirror::fallbacks(url, plan.mirror_first_for_mods)
}

/// 原版文件的兜底 URL（与主选相反的一侧）。
///
/// 只覆盖路径 1:1 可互换的域名（libraries / resources / forge / neoforge maven）；
/// 客户端 jar 与版本清单在 BMCLAPI 上是另一套路径，无法纯 URL 改写，保持单源。
///
/// 兜底方向由 URL 自身决定，与 `plan` 的偏好无关：同一次安装里安装器 URL 可能是
/// 镜像形态，而版本 JSON 里的库地址恒为官方形态，按偏好推方向会让其中一半没有兜底。
pub fn vanilla_fallback_urls(url: &str) -> Vec<String> {
    file_mirror::vanilla_fallback(url)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn auto_prefers_official_vanilla_and_mirror_mods_in_china() {
        let p = SourcePlan::resolve(true, false, false, true);
        assert_eq!(p.vanilla, VanillaSource::Official, "自动模式原版恒官方优先");
        assert!(p.mirror_first_for_mods, "国内自动模式模组镜像优先");
        let p = SourcePlan::resolve(true, true, true, false);
        assert_eq!(p.vanilla, VanillaSource::Official);
        assert!(!p.mirror_first_for_mods, "境外自动模式模组官方优先");
    }

    #[test]
    fn manual_preferences_are_independent_per_resource_type() {
        // 原版镜像优先、模组官方优先
        let p = SourcePlan::resolve(false, true, false, true);
        assert_eq!(p.vanilla, VanillaSource::Bmclapi);
        assert!(!p.mirror_first_for_mods);

        // 原版官方优先、模组镜像优先
        let p = SourcePlan::resolve(false, false, true, false);
        assert_eq!(p.vanilla, VanillaSource::Official);
        assert!(p.mirror_first_for_mods);
    }

    #[test]
    fn vanilla_mirror_id_maps_official_to_zero() {
        let plan = SourcePlan {
            mirror_first_for_mods: false,
            vanilla: VanillaSource::Official,
        };
        assert_eq!(plan.vanilla_mirror_id(), 0);
        let plan = SourcePlan {
            mirror_first_for_mods: true,
            vanilla: VanillaSource::Bmclapi,
        };
        assert_eq!(plan.vanilla_mirror_id(), 1);
    }
}
