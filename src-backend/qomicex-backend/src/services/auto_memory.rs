// Copyright (C) 2026 Qomicex Launcher Contributors
// SPDX-License-Identifier: GPL-3.0-or-later

//! 实例自动内存推荐（issue #319）。
//!
//! 大型整合包此前固定拿 4096 MiB，400 mods 的包几乎无法游玩。这里按模组数
//! 估算堆需求，并受系统内存封顶：整合包用**总内存**的 70% 封顶（可用内存常被
//! 启动器/后台程序压低，会让大包分不到足够堆），普通实例仍用**可用内存**的
//! 70% 封顶，避免与其它程序争抢。

use std::path::Path;

use crate::services::instance::GameInstance;
use crate::services::instance_config;

const BASE_MEMORY_MB: i32 = 1536;
const PER_MOD_MB: i32 = 12;
const MODPACK_EXTRA_MB: i32 = 512;
const MIN_MEMORY_MB: i32 = 2048;
const FLOOR_MEMORY_MB: i32 = 1024;
const STEP_MB: i32 = 256;
const CAP_RATIO: f64 = 0.7;

/// 推荐最大堆内存（MiB）。
///
/// `available_mb` / `total_mb` 为系统内存；`mod_count` 统计 mods 目录下的
/// jar（含 `.disabled`）。结果按 256 MiB 取整，且不超过封顶值。
pub fn recommend_memory_mb(
    available_mb: f64,
    total_mb: f64,
    mod_count: usize,
    is_modpack: bool,
) -> i32 {
    let per_mod = i32::try_from(mod_count)
        .unwrap_or(i32::MAX)
        .saturating_mul(PER_MOD_MB);
    let desired = BASE_MEMORY_MB
        .saturating_add(per_mod)
        .saturating_add(if is_modpack { MODPACK_EXTRA_MB } else { 0 });

    let cap_source = if is_modpack { total_mb } else { available_mb };
    let cap = ((cap_source * CAP_RATIO).floor() as i64)
        .clamp(FLOOR_MEMORY_MB as i64, i32::MAX as i64) as i32;

    let capped = desired.max(MIN_MEMORY_MB).min(cap);
    let rounded = ((capped + STEP_MB / 2) / STEP_MB) * STEP_MB;
    let step_cap = (cap / STEP_MB) * STEP_MB;
    rounded.min(step_cap).max(FLOOR_MEMORY_MB)
}

/// 实例是否为整合包（有非空 `modpackName`）。
pub fn is_modpack(instance: &GameInstance) -> bool {
    instance
        .modpack_name
        .as_deref()
        .is_some_and(|name| !name.trim().is_empty())
}

/// 内存模式是否为自动。缺失/null 视为 auto（旧实例首次启动即用新算法）。
pub fn is_auto_mode(instance: &GameInstance) -> bool {
    !matches!(instance.memory_mode.as_deref(), Some("custom"))
}

/// 实例 mods 目录。版本隔离时在 `versions/{name}/mods`，否则在游戏根目录。
pub fn mods_dir(instance: &GameInstance) -> Option<std::path::PathBuf> {
    let isolated = instance
        .version_isolation
        .unwrap_or_else(crate::settings::get_global_version_isolation);
    let base = if isolated {
        instance_config::version_dir(&instance.game_dir, &instance.name)?
    } else {
        let dir = instance
            .resolved_game_dir
            .as_deref()
            .unwrap_or(&instance.game_dir);
        instance_config::resolve_game_root(dir)
    };
    Some(base.join("mods"))
}

/// 统计 mods 目录下的模组文件数（`.jar` 与 `.jar.disabled`）。
pub fn count_mods(instance: &GameInstance) -> usize {
    let Some(dir) = mods_dir(instance) else {
        return 0;
    };
    count_mod_files(&dir)
}

fn count_mod_files(dir: &Path) -> usize {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return 0;
    };
    entries
        .filter_map(Result::ok)
        .filter(|entry| {
            entry
                .file_type()
                .map(|file_type| file_type.is_file())
                .unwrap_or(false)
        })
        .filter(|entry| {
            Path::new(&entry.file_name())
                .extension()
                .is_some_and(|ext| {
                    ext.eq_ignore_ascii_case("jar") || ext.eq_ignore_ascii_case("disabled")
                })
        })
        .count()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn vanilla_uses_available_memory_cap() {
        assert_eq!(recommend_memory_mb(8192.0, 16384.0, 0, false), 2048);
    }

    #[test]
    fn large_modpack_uses_total_memory_cap() {
        // 1536 + 400*12 + 512 = 6848，总内存 16 GiB 的 70% 不构成限制。
        assert_eq!(recommend_memory_mb(2048.0, 16384.0, 400, true), 6912);
    }

    #[test]
    fn modpack_is_capped_by_total_memory() {
        // 8 GiB 的 70% = 5734，按 256 向下取整为 5632。
        assert_eq!(recommend_memory_mb(1024.0, 8192.0, 400, true), 5632);
    }

    #[test]
    fn tiny_machine_keeps_floor() {
        assert_eq!(recommend_memory_mb(512.0, 1024.0, 0, false), 1024);
    }

    #[test]
    fn non_modpack_ignores_total_memory() {
        // 可用内存 2 GiB 时即使总内存很大，普通实例也只按可用内存封顶。
        assert_eq!(recommend_memory_mb(2048.0, 32768.0, 0, false), 1280);
    }

    fn temp_instance(name: &str, isolated: bool) -> GameInstance {
        let game_dir = std::env::temp_dir().join(format!("qomicex-mem-{}", uuid::Uuid::new_v4()));
        let mut inst = GameInstance::default();
        inst.name = name.to_string();
        inst.game_dir = game_dir.to_string_lossy().into_owned();
        inst.version_isolation = Some(isolated);
        inst
    }

    fn touch(path: &std::path::Path) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, b"jar").unwrap();
    }

    #[test]
    fn count_mods_handles_isolated_and_shared_layouts() {
        let isolated = temp_instance("Pack", true);
        let mods = mods_dir(&isolated).unwrap();
        touch(&mods.join("a.jar"));
        touch(&mods.join("b.jar.disabled"));
        touch(&mods.join("readme.txt"));
        assert_eq!(count_mods(&isolated), 2);

        let shared = temp_instance("Vanilla", false);
        let mods = mods_dir(&shared).unwrap();
        touch(&mods.join("c.jar"));
        assert_eq!(count_mods(&shared), 1);

        let _ = std::fs::remove_dir_all(&isolated.game_dir);
        let _ = std::fs::remove_dir_all(&shared.game_dir);
    }
}
