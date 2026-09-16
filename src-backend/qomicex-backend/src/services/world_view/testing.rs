//! 集成测试夹具：暴露内部 API 供 `ported_tests` 调用。
//!
//! 与上游 world-viewer 的 `lib.rs::testing` 模块保持一致，只是把 `crate::`
//! 换成了 `super::`。仅编译进测试目标。

pub use super::biome::{apply_tint, tint_color, BiomeDef, TintKind};
pub use super::palette::Palette;
pub use super::region::{BlockStates, LegacyBiomes, RegionFile, Section};
pub use super::render::{BlockRef, ChunkData, RenderOpts, ScanOpts, TileCache};
pub use super::world::{resolve_ymax, DimensionInfo, World, YMAX_FULL};

use std::path::{Path, PathBuf};

/// 该方块属于哪一类生物群系染色（`grass`/`foliage`/`water`/`dry_foliage`）。
pub fn tint_kind(name: &str) -> TintKind {
    super::render::tint_kind(name)
}

/// 把调色板颜色按生物群系解析为最终颜色（灰色乘法 / 已着色比例缩放）。
pub fn resolve_color(c: [u8; 3], name: &str, biome: BiomeDef) -> [u8; 3] {
    super::render::resolve_color(c, name, biome)
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

/// 丢弃已缓存的 region 文件句柄（强制下次读取重新打开文件）。
pub fn clear_region_cache() {
    super::region::clear_region_cache()
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

/// 同上，并返回 1.7–1.17 的区块级 Biomes。
pub fn parse_sections_fast_full(
    data: &[u8],
) -> Result<(Vec<super::region::Section>, Option<LegacyBiomes>), String> {
    super::region::parse_sections_fast_full(data)
}

/// 从实例根加载全部受支持模组的路径点。
pub fn load_waypoints(instance_root: &Path, save_name: &str) -> Vec<super::palette::Waypoint> {
    super::palette::load_waypoints(instance_root, save_name)
}

/// 新建一个可跨多次调用复用的区块缓存。
pub fn new_tile_cache(palette: Palette, capacity: usize) -> TileCache {
    TileCache::new(palette, capacity)
}

/// 用给定缓存渲染瓦片（zoom 0），返回 (png, has_data)。
pub fn render_tile_in(
    cache: &super::render::TileCache,
    region_dir: &Path,
    dim: i32,
    tile_x: i32,
    tile_row: i32,
    ymax: i32,
) -> Result<(Vec<u8>, bool), String> {
    super::render::render_tile(
        cache,
        region_dir,
        dim,
        0,
        tile_x,
        tile_row,
        ymax,
        RenderOpts::default(),
    )
}

/// 带渲染开关的瓦片渲染（zoom 0），返回 PNG。
pub fn render_tile_with_opts(
    palette: &Palette,
    region_dir: &Path,
    dim: i32,
    tile_x: i32,
    tile_row: i32,
    ymax: i32,
    opts: RenderOpts,
) -> Result<Vec<u8>, String> {
    render_tile_full(palette, region_dir, dim, tile_x, tile_row, ymax, opts)
        .map(|(png, _has_data)| png)
}

/// 带渲染开关的瓦片渲染（zoom 0），返回 (png, has_data)。
pub fn render_tile_full(
    palette: &Palette,
    region_dir: &Path,
    dim: i32,
    tile_x: i32,
    tile_row: i32,
    ymax: i32,
    opts: RenderOpts,
) -> Result<(Vec<u8>, bool), String> {
    let cache = super::render::TileCache::new(palette.clone(), 512);
    super::render::render_tile(&cache, region_dir, dim, 0, tile_x, tile_row, ymax, opts)
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
    let cache = super::render::TileCache::new(palette.clone(), 512);
    super::render::render_tile(
        &cache,
        region_dir,
        dim,
        zoom,
        tile_x,
        tile_row,
        ymax,
        RenderOpts::default(),
    )
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
    let cache = super::render::TileCache::new(palette.clone(), 512);
    super::render::render_tile(
        &cache,
        region_dir,
        dim,
        zoom,
        tile_x,
        tile_row,
        ymax,
        RenderOpts::default(),
    )
}

/// 用一个**共享**的区块缓存渲染瓦片：验证跨维度的缓存隔离。
///
/// 上游的缓存键是 `(cx, cz)`，不含维度，因此先渲染主世界再请求下界会拿到主世界
/// 的地形。这个入口把缓存暴露给测试，以便复现/回归该场景。
pub fn render_tile_shared_cache(
    cache: &super::render::TileCache,
    region_dir: &Path,
    dim: i32,
    zoom: i32,
    tile_x: i32,
    tile_row: i32,
    ymax: i32,
) -> Result<Vec<u8>, String> {
    super::render::render_tile(
        cache,
        region_dir,
        dim,
        zoom,
        tile_x,
        tile_row,
        ymax,
        RenderOpts::default(),
    )
    .map(|(png, _has_data)| png)
}

/// 新建一个可跨多次调用复用的区块缓存（生产容量）。
///
/// 容量与生产一致（`CACHE_CAPACITY`）：容量不足会触发淘汰，而淘汰顺序依赖
/// `HashMap` 迭代顺序（不确定），会让跨维度对比测试出现与缓存键无关的抖动。
pub fn new_cache(palette: &Palette) -> super::render::TileCache {
    super::render::TileCache::new(palette.clone(), 8192)
}

#[allow(dead_code)]
pub fn path_buf(s: &str) -> PathBuf {
    PathBuf::from(s)
}

/// 别名表，供 ported_tests 的回归扫描（防止别名指向表中不存在的目标）。
pub fn legacy_aliases() -> &'static [(&'static str, &'static str)] {
    super::palette::legacy_aliases()
}
