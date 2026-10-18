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
    pub fn load() -> Self {
        let s = load_settings();
        let auto = s.auto_select_source.unwrap_or(true);
        let mirror_pref = s.source_preference.eq_ignore_ascii_case("mirror");
        let china = is_china_timezone();

        let (mirror_first_for_mods, vanilla) = if auto {
            // 自动：模组按地域，原版恒官方优先。
            (china, VanillaSource::Official)
        } else if mirror_pref {
            // 手动「镜像源优先」：模组与原版都先走镜像（BMCLAPI 对原版而言就是镜像）。
            (true, VanillaSource::Bmclapi)
        } else {
            (false, VanillaSource::Official)
        };

        Self {
            mirror_first_for_mods,
            vanilla,
        }
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
/// 只覆盖路径 1:1 可互换的域名（libraries / resources）；客户端 jar 与版本清单
/// 在 BMCLAPI 上是另一套路径，无法纯 URL 改写，保持单源。
pub fn vanilla_fallback_urls(url: &str, plan: &SourcePlan) -> Vec<String> {
    file_mirror::vanilla_fallback(url, plan.vanilla)
}

#[cfg(test)]
mod tests {
    use super::*;

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
