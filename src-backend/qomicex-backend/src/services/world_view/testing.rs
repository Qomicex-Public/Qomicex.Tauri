//! 集成测试夹具：暴露内部 API 供 `ported_tests` 调用。
//!
//! 与上游 world-viewer 的 `lib.rs::testing` 模块保持一致，只是把 `crate::`
//! 换成了 `super::`。仅编译进测试目标。

pub use super::palette::Palette;
pub use super::render::{BlockRef, ChunkData};
pub use super::world::{resolve_ymax, DimensionInfo, World, YMAX_FULL};

use std::path::{Path, PathBuf};

/// 该方块是否属于原版 `grass`/`foliage` 染色类别（需要乘生物群系绿色）。
pub fn is_foliage(name: &str) -> bool {
    super::render::is_foliage(name)
}

/// 给未染色的灰度纹理色乘上温带生物群系绿。
pub fn apply_foliage_tint(c: [u8; 3]) -> [u8; 3] {
    super::render::apply_foliage_tint(c)
}

pub fn open_world(save_dir: &Path) -> Result<World, String> {
    super::world::open_world(save_dir, None)
}

pub fn load_chunk(region_dir: &Path, cx: i32, cz: i32) -> Result<Option<ChunkData>, String> {
    super::render::load_chunk(region_dir, cx, cz)
}

/// 解压后的区块 NBT 原始字节（管线第 1 阶段）。
pub fn read_chunk_nbt(region_dir: &Path, cx: i32, cz: i32) -> Result<Option<Vec<u8>>, String> {
    super::region::read_chunk_nbt(region_dir, cx, cz)
}

/// 完整 NBT 解析（管线第 2 阶段）。
pub fn parse_nbt(data: &[u8]) -> Result<(), String> {
    super::nbt::parse(data).map(|_| ())
}

/// 通用（整树）section 解析器，用来校验定向解析器。
pub fn parse_sections_generic(data: &[u8]) -> Result<Vec<super::region::Section>, String> {
    super::region::parse_sections(data)
}

/// 生产路径使用的定向 section 解析器。
pub fn parse_sections_fast(data: &[u8]) -> Result<Vec<super::region::Section>, String> {
    super::region::parse_sections_fast(data)
}

/// 从实例根加载全部受支持模组的路径点。
pub fn load_waypoints(instance_root: &Path, save_name: &str) -> Vec<super::palette::Waypoint> {
    super::palette::load_waypoints(instance_root, save_name)
}

/// 渲染单个 256x256 瓦片（与 HTTP 端点同一条管线）。
pub fn render_tile(
    palette: &Palette,
    region_dir: &Path,
    dim: i32,
    zoom: i32,
    tile_x: i32,
    tile_row: i32,
    ymax: i32,
) -> Result<Vec<u8>, String> {
    let mut cache = super::render::TileCache::new(palette.clone(), 512);
    super::render::render_tile(&mut cache, region_dir, dim, zoom, tile_x, tile_row, ymax)
        .map(|(png, _has_data)| png)
}

/// 同上，但一并返回「该瓦片是否覆盖已生成区块」的标记。
pub fn render_tile_with_data_flag(
    palette: &Palette,
    region_dir: &Path,
    dim: i32,
    zoom: i32,
    tile_x: i32,
    tile_row: i32,
    ymax: i32,
) -> Result<(Vec<u8>, bool), String> {
    let mut cache = super::render::TileCache::new(palette.clone(), 512);
    super::render::render_tile(&mut cache, region_dir, dim, zoom, tile_x, tile_row, ymax)
}

/// 用一个**共享**的区块缓存渲染瓦片：验证跨维度的缓存隔离。
///
/// 上游的缓存键是 `(cx, cz)`，不含维度，因此先渲染主世界再请求下界会拿到主世界
/// 的地形。这个入口把缓存暴露给测试，以便复现/回归该场景。
pub fn render_tile_shared_cache(
    cache: &mut super::render::TileCache,
    region_dir: &Path,
    dim: i32,
    zoom: i32,
    tile_x: i32,
    tile_row: i32,
    ymax: i32,
) -> Result<Vec<u8>, String> {
    super::render::render_tile(cache, region_dir, dim, zoom, tile_x, tile_row, ymax)
        .map(|(png, _has_data)| png)
}

/// 新建一个可跨多次调用复用的区块缓存。
///
/// 容量与生产一致（`CACHE_CAPACITY`）：容量不足会触发淘汰，而淘汰顺序依赖
/// `HashMap` 迭代顺序（不确定），会让跨维度对比测试出现与缓存键无关的抖动。
pub fn new_cache(palette: &Palette) -> super::render::TileCache {
    super::render::TileCache::new(palette.clone(), 4096)
}

#[allow(dead_code)]
pub fn path_buf(s: &str) -> PathBuf {
    PathBuf::from(s)
}
