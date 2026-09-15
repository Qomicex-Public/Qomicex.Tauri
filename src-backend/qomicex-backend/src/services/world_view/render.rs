use std::collections::HashMap;
use std::path::Path;

use super::palette::Palette;
use super::region;

pub const TILE_SIZE: usize = 256;
const EMPTY: i32 = i32::MIN;

/// A block reference, either a legacy numeric id+meta or a 1.13+ namespaced
/// block name. Both resolve through `Palette`.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub enum BlockRef {
    Legacy(u16, u16),
    Named(String),
}

impl BlockRef {
    pub fn is_air(&self) -> bool {
        match self {
            BlockRef::Legacy(id, _) => *id == 0,
            BlockRef::Named(name) => is_air_name(name),
        }
    }
}

/// Air block ids used by 1.13+ chunks.
#[inline]
pub fn is_air_name(name: &str) -> bool {
    name == "minecraft:air" || name == "minecraft:cave_air" || name == "minecraft:void_air"
}

/// A borrowed block reference, used on hot paths to avoid allocating a
/// `String` for every block inspected while scanning a column.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BlockRefRef<'a> {
    Legacy(u16, u16),
    Named(&'a str),
}

impl<'a> BlockRefRef<'a> {
    #[inline]
    pub fn is_air(&self) -> bool {
        match self {
            BlockRefRef::Legacy(id, _) => *id == 0,
            BlockRefRef::Named(name) => is_air_name(name),
        }
    }

    /// Take ownership, allocating only for the named variant.
    pub fn to_owned_ref(self) -> BlockRef {
        match self {
            BlockRefRef::Legacy(id, meta) => BlockRef::Legacy(id, meta),
            BlockRefRef::Named(name) => BlockRef::Named(name.to_string()),
        }
    }
}

/// A fully parsed chunk. Supports both the legacy (1.12-) and flattened
/// (1.13+) section layouts.
pub struct ChunkData {
    pub sections: Vec<region::Section>,
    /// Per section, the highest local y (0..16) that holds a non-air block,
    /// or `None` when the section is entirely air. Computed once at load time
    /// so column scans can skip empty sections immediately.
    ///
    /// This matters a lot for 1.13+ chunks: a 1.20 overworld chunk has 24
    /// sections spanning y=-64..320, of which ~15 are empty air.
    section_top: Vec<Option<u8>>,
}

impl ChunkData {
    pub fn new(sections: Vec<region::Section>) -> Self {
        let section_top = sections.iter().map(section_highest_non_air).collect();
        ChunkData {
            sections,
            section_top,
        }
    }

    /// Top-most non-air block at (x,z) with block-y <= ymax.
    ///
    /// Hot path: no allocation until a block is actually found. Callers that
    /// need an owned `BlockRef` pay for exactly one allocation per column
    /// instead of one per inspected block.
    pub fn top_block_ref(&self, x: usize, z: usize, ymax: i32) -> Option<(BlockRefRef<'_>, i32)> {
        for (s, top) in self.sections.iter().zip(self.section_top.iter()) {
            let base = s.y * 16;
            if base > ymax {
                continue;
            }
            // Skip sections with nothing in them (the common case above ground).
            let Some(top_local) = *top else { continue };
            let start = (top_local as i32).min(15);
            for y in (0..=start).rev() {
                let by = base + y;
                if by > ymax {
                    continue;
                }
                let b = match s.block_ref(x, y as usize, z) {
                    Some(b) => b,
                    None => continue,
                };
                if !b.is_air() {
                    return Some((b, by));
                }
            }
        }
        None
    }

    /// Owning convenience wrapper around [`top_block_ref`].
    pub fn top_block(&self, x: usize, z: usize, ymax: i32) -> Option<(BlockRef, i32)> {
        self.top_block_ref(x, z, ymax)
            .map(|(b, y)| (b.to_owned_ref(), y))
    }

    /// Highest non-air block at (x,z) below ymax that is not fully transparent.
    pub fn top_visible(&self, x: usize, z: usize, ymax: i32) -> Option<(BlockRef, i32)> {
        self.top_block(x, z, ymax)
    }
}

/// Highest local y (0..16) containing a non-air block, or `None` if the
/// section is entirely air.
fn section_highest_non_air(s: &region::Section) -> Option<u8> {
    for y in (0..16usize).rev() {
        for z in 0..16usize {
            for x in 0..16usize {
                let is_air = match s.block_ref(x, y, z) {
                    Some(b) => b.is_air(),
                    None => true,
                };
                if !is_air {
                    return Some(y as u8);
                }
            }
        }
    }
    None
}

pub fn load_chunk(region_dir: &Path, cx: i32, cz: i32) -> Result<Option<ChunkData>, String> {
    match region::read_chunk_nbt(region_dir, cx, cz)? {
        Some(nbt_bytes) => {
            // 1.13+ chunks keep sections at the root; older ones nest them
            // under `Level`. Detect by peeking at the section parser output.
            let sections = match region::parse_sections_fast(&nbt_bytes) {
                Ok(s) if !s.is_empty() => s,
                _ => region::parse_sections_modern(&nbt_bytes)?,
            };
            Ok(Some(ChunkData::new(sections)))
        }
        None => Ok(None),
    }
}

/// Blocks whose texture is grey in the palette and must be multiplied by a
/// biome colour before rendering.
///
/// The JourneyMap palette stores the *untinted* texture colour for these, so
/// without this they render as flat grey — which is what made grass and
/// tall grass look black-and-white while stone and dirt looked fine.
///
/// Membership follows the vanilla tint categories (`grass` and `foliage`);
/// see the block tinting tables on wiki.bedrock.dev/blocks/block-tinting.
/// Flowers, crops and mushrooms are deliberately excluded — they have their
/// own colours and must not be tinted green.
pub fn is_foliage(name: &str) -> bool {
    let base = name.split('[').next().unwrap_or(name);
    // Strip any namespace, not just "minecraft:" — modded ids like
    // "BiomesOPlenty:foliage" must classify the same way.
    let short = base.split(':').next_back().unwrap_or(base);
    let lower = short.to_ascii_lowercase();

    // --- vanilla `grass` tint category ---
    if matches!(
        lower.as_str(),
        "grass"
            | "grass_block"
            | "tallgrass"
            | "short_grass"
            | "tall_grass"
            | "fern"
            | "large_fern"
            | "reeds"
            | "sugar_cane"
            | "double_plant"
            | "grass_path"
            | "wildflowers"
    ) {
        return true;
    }

    // --- vanilla `foliage` tint category ---
    if lower == "leaves" || lower == "leaves2" || lower == "vine" || lower == "vines" {
        return true;
    }
    if lower.ends_with("_leaves") || lower.ends_with("leaves") {
        return true;
    }
    if lower.ends_with("_vine") || lower.ends_with("_vines") {
        return true;
    }

    // --- modded ground cover that behaves like grass/foliage ---
    // BiomesOPlenty:foliage, Botania grass, Thaumcraft magical leaves, etc.
    if matches!(lower.as_str(), "foliage" | "bush" | "shrub") {
        return true;
    }
    if lower.ends_with("_foliage") || lower.contains("tallgrass") {
        return true;
    }
    if lower.ends_with("_grass") && !lower.contains("nether") && !lower.contains("warped") {
        return true;
    }

    false
}

/// Multiply an untinted (grey) texture colour by a temperate biome green.
pub fn apply_foliage_tint(c: [u8; 3]) -> [u8; 3] {
    // Standard Minecraft plains grass colour.
    const BIOME: [f32; 3] = [0x79 as f32, 0xc0 as f32, 0x5a as f32];
    [
        (c[0] as f32 / 255.0 * BIOME[0]).min(255.0) as u8,
        (c[1] as f32 / 255.0 * BIOME[1]).min(255.0) as u8,
        (c[2] as f32 / 255.0 * BIOME[2]).min(255.0) as u8,
    ]
}

/// Directional relief shading, in the spirit of VoxelMap's `applyHeight()`.
/// Light comes from the north-west, so slopes rising toward NW are lit.
/// `h` is a square height buffer of width `w` with a 1-block margin already applied.
fn hillshade_at(h: &[i32], w: usize, idx: usize) -> f32 {
    let hc = h[idx];
    if hc == EMPTY {
        return 1.0;
    }
    let pick = |i: usize| -> i32 {
        let v = h[i];
        if v == EMPTY {
            hc
        } else {
            v
        }
    };
    // central differences; margin guarantees idx-1/idx+1/idx±w are in bounds
    let dx = (pick(idx + 1) - pick(idx - 1)) as f32 * 0.5;
    let dz = (pick(idx + w) - pick(idx - w)) as f32 * 0.5;

    // slope term: light from NW -> +dx (rising east) and +dz (rising south) are lit
    let slope = (dx + dz) * 0.18;

    // elevation term: subtle large-scale relief relative to sea level (y=64)
    let elev = hc - 64;
    let elev_term = (elev as f32).signum() * ((elev.abs() as f32) / 8.0 + 1.0).log10() / 5.0;

    (1.0 + slope + elev_term).clamp(0.45, 1.55)
}

/// Surface buffer for a whole tile: color + height per block, with a 1-block
/// margin so hillshading can compare against neighbouring chunks (no seams).
pub struct Surface {
    pub blocks: usize,
    pub side: usize,
    pub color: Vec<[u8; 3]>,
    pub height: Vec<i32>,
}

impl Surface {
    fn new(blocks: usize) -> Self {
        let side = blocks + 2;
        Surface {
            blocks,
            side,
            color: vec![[0u8, 0, 0]; side * side],
            height: vec![EMPTY; side * side],
        }
    }

    #[inline]
    fn idx(&self, x: i32, z: i32) -> usize {
        ((z + 1) as usize) * self.side + (x + 1) as usize
    }

    /// Fill the surface from chunks covering `chunks_per_tile`, including a
    /// 1-chunk margin on every side so edge pixels shade correctly.
    /// Chunks are read/parsed in parallel, then written in a deterministic
    /// order so the result does not depend on thread scheduling.
    ///
    /// `dim` must be part of the cache key: chunk coordinates are per-dimension,
    /// so keying on `(cx, cz)` alone makes the first-rendered dimension's terrain
    /// serve every other dimension (a save's overworld chunks reappear as the
    /// nether). The upstream tool had this bug — its `render_tile` took `_dim`
    /// and ignored it.
    pub fn fill(
        &mut self,
        cache: &mut TileCache,
        region_dir: &Path,
        dim: i32,
        chunk_x0: i32,
        chunk_z0: i32,
        chunks_per_tile: i32,
        ymax: i32,
        tint: bool,
    ) {
        let lim = self.blocks as i32;

        // 1. work out which chunks are not cached yet
        let mut coords: Vec<ChunkKey> = Vec::new();
        for cz in -1..=chunks_per_tile {
            for cx in -1..=chunks_per_tile {
                let key = (dim, chunk_x0 + cx, chunk_z0 + cz);
                if !cache.chunks.contains_key(&key) {
                    coords.push(key);
                }
            }
        }

        // 2. read + parse the missing ones in parallel
        if !coords.is_empty() {
            let loaded = load_chunks_parallel(region_dir, &coords);
            for (key, data) in loaded {
                cache.insert_loaded(key, data);
            }
        }

        // 3. copy the visible surface out of the cache (single-threaded, ordered)
        for cz in -1..=chunks_per_tile {
            for cx in -1..=chunks_per_tile {
                let ox = cx * 16;
                let oz = cz * 16;
                let mut hits: Vec<(i32, i32, BlockRef, i32)> = Vec::new();
                if let Some(Some(chunk)) = cache.chunks.get(&(dim, chunk_x0 + cx, chunk_z0 + cz)) {
                    for lz in 0..16i32 {
                        for lx in 0..16i32 {
                            let gx = ox + lx;
                            let gz = oz + lz;
                            if gx < -1 || gz < -1 || gx > lim || gz > lim {
                                continue;
                            }
                            if let Some((block, y)) =
                                chunk.top_visible(lx as usize, lz as usize, ymax)
                            {
                                hits.push((gx, gz, block, y));
                            }
                        }
                    }
                }
                for (gx, gz, block, y) in hits {
                    let (rgb, _src, name) = cache.palette.color_ref(&block);
                    let mut c = rgb;
                    if tint {
                        if is_foliage(&name) {
                            c = apply_foliage_tint(c);
                        }
                    }
                    let i = self.idx(gx, gz);
                    self.color[i] = c;
                    self.height[i] = y;
                }
            }
        }
    }

    /// Apply hillshading in place.
    pub fn shade(&mut self) {
        let w = self.side;
        for z in 0..self.blocks {
            for x in 0..self.blocks {
                let i = self.idx(x as i32, z as i32);
                if self.height[i] == EMPTY {
                    continue;
                }
                let s = hillshade_at(&self.height, w, i);
                let c = self.color[i];
                self.color[i] = [
                    ((c[0] as f32 * s).min(255.0)) as u8,
                    ((c[1] as f32 * s).min(255.0)) as u8,
                    ((c[2] as f32 * s).min(255.0)) as u8,
                ];
            }
        }
    }

    /// Downsample the shaded surface into a TILE_SIZE RGBA image.
    pub fn to_rgba(&self) -> Vec<u8> {
        let mut img = vec![0u8; TILE_SIZE * TILE_SIZE * 4];
        let scale = TILE_SIZE / self.blocks;
        for z in 0..self.blocks {
            for x in 0..self.blocks {
                let c = self.color[self.idx(x as i32, z as i32)];
                if c == [0, 0, 0] {
                    continue;
                }
                let px0 = x * scale;
                let py0 = z * scale;
                for py in py0..(py0 + scale).min(TILE_SIZE) {
                    for px in px0..(px0 + scale).min(TILE_SIZE) {
                        let idx = (py * TILE_SIZE + px) * 4;
                        img[idx] = c[0];
                        img[idx + 1] = c[1];
                        img[idx + 2] = c[2];
                        img[idx + 3] = 255;
                    }
                }
            }
        }
        img
    }
}

/// Render one tile (TILE_SIZE x TILE_SIZE) with relief shading.
/// Returns (png_bytes, has_any_data). `has_any_data == false` means the tile
/// covers no generated chunks at all, which the frontend renders differently
/// from a tile that simply has not loaded yet.
pub fn render_tile(
    cache: &mut TileCache,
    region_dir: &Path,
    dim: i32,
    zoom: i32,
    tile_x: i32,
    tile_row: i32,
    ymax: i32,
) -> Result<(Vec<u8>, bool), String> {
    if !(0..=4).contains(&zoom) {
        return Err(format!("zoom {} out of range 0..=4", zoom));
    }
    // z=0 -> 16 chunks/tile (1 px per block), z=4 -> 1 chunk/tile (16 px per block)
    let chunks_per_tile = 16i32 >> zoom;
    let blocks = (chunks_per_tile * 16) as usize;
    let chunk_x0 = tile_x * chunks_per_tile;
    let chunk_z0 = tile_row * chunks_per_tile;

    let mut surface = Surface::new(blocks);
    surface.fill(
        cache,
        region_dir,
        dim,
        chunk_x0,
        chunk_z0,
        chunks_per_tile,
        ymax,
        true,
    );
    // Only the tile's own area counts. The surface carries a 1-block margin
    // for hillshading, and those margin pixels are not rendered, so including
    // them would report "has data" for a tile that renders fully transparent.
    let has_data = (0..blocks as i32)
        .any(|z| (0..blocks as i32).any(|x| surface.height[surface.idx(x, z)] != EMPTY));
    surface.shade();
    Ok((
        encode_png(&surface.to_rgba(), TILE_SIZE as u32, TILE_SIZE as u32),
        has_data,
    ))
}

pub fn encode_png(rgba: &[u8], w: u32, h: u32) -> Vec<u8> {
    let mut out = Vec::new();
    {
        let mut encoder = png::Encoder::new(&mut out, w, h);
        encoder.set_color(png::ColorType::Rgba);
        encoder.set_depth(png::BitDepth::Eight);
        let mut writer = encoder.write_header().expect("png header");
        writer.write_image_data(rgba).expect("png data");
    }
    out
}

/// 区块缓存键：`(维度, 区块 x, 区块 z)`。
///
/// 维度必须参与——区块坐标是按维度各自编号的，只用 `(cx, cz)` 会让先渲染的
/// 维度把地形「借」给其它维度（主世界的区块会出现在下界地图上）。
pub type ChunkKey = (i32, i32, i32);

/// Read and parse a batch of chunks across worker threads.
/// The OS page cache and per-file seeks make this IO-light, so a simple
/// chunked work split is enough; no new dependency needed.
fn load_chunks_parallel(
    region_dir: &Path,
    coords: &[ChunkKey],
) -> Vec<(ChunkKey, Option<ChunkData>)> {
    let threads = std::thread::available_parallelism()
        .map(|n| n.get())
        .unwrap_or(4)
        .min(8)
        .min(coords.len().max(1));
    if threads <= 1 || coords.len() < 4 {
        return coords
            .iter()
            .map(|&k| (k, load_chunk(region_dir, k.1, k.2).ok().flatten()))
            .collect();
    }

    let per = coords.len().div_ceil(threads);
    std::thread::scope(|scope| {
        let mut handles = Vec::new();
        for batch in coords.chunks(per) {
            handles.push(scope.spawn(move || {
                batch
                    .iter()
                    .map(|&k| (k, load_chunk(region_dir, k.1, k.2).ok().flatten()))
                    .collect::<Vec<_>>()
            }));
        }
        let mut out = Vec::with_capacity(coords.len());
        for h in handles {
            match h.join() {
                Ok(v) => out.extend(v),
                Err(_) => {}
            }
        }
        out
    })
}

pub struct TileCache {
    pub chunks: HashMap<ChunkKey, Option<ChunkData>>,
    pub palette: Palette,
    capacity: usize,
}

impl TileCache {
    pub fn new(palette: Palette, capacity: usize) -> Self {
        TileCache {
            chunks: HashMap::new(),
            palette,
            capacity,
        }
    }

    /// Insert an already-loaded chunk, evicting if over capacity.
    pub fn insert_loaded(&mut self, key: ChunkKey, data: Option<ChunkData>) {
        if !self.chunks.contains_key(&key) && self.chunks.len() >= self.capacity {
            let keys: Vec<ChunkKey> = self
                .chunks
                .keys()
                .take(self.capacity / 4)
                .cloned()
                .collect();
            for k in keys {
                self.chunks.remove(&k);
            }
        }
        self.chunks.insert(key, data);
    }

    pub fn invalidate(&mut self) {
        self.chunks.clear();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Flat terrain must stay unshaded.
    #[test]
    fn hillshade_flat_is_neutral() {
        let w = 5;
        let h = vec![64i32; w * w];
        let idx = 2 * w + 2;
        assert!((hillshade_at(&h, w, idx) - 1.0).abs() < 1e-6);
    }

    /// Light comes from the north-west, so slopes whose surface faces NW
    /// (i.e. terrain rising toward the SE) must be lit, and the opposite
    /// slope must be darkened. This is standard cartographic hillshading.
    #[test]
    fn hillshade_lights_nw_facing_slope_and_darkens_se_facing_slope() {
        let w = 5;
        let mut rises_to_se = vec![64i32; w * w]; // faces NW -> lit
        let mut rises_to_nw = vec![64i32; w * w]; // faces SE -> dark
        for z in 0..w {
            for x in 0..w {
                rises_to_se[z * w + x] = 64 + x as i32 + z as i32;
                rises_to_nw[z * w + x] = 64 + (4 - x) as i32 + (4 - z) as i32;
            }
        }
        let idx = 2 * w + 2;
        let lit = hillshade_at(&rises_to_se, w, idx);
        let dark = hillshade_at(&rises_to_nw, w, idx);
        assert!(lit > 1.0, "NW-facing slope should be lit, got {}", lit);
        assert!(dark < 1.0, "SE-facing slope should be dark, got {}", dark);
    }

    /// A cliff must produce a much stronger response than gentle terrain.
    #[test]
    fn hillshade_cliff_is_stronger_than_gentle_slope() {
        let w = 5;
        let mut gentle = vec![64i32; w * w];
        let mut cliff = vec![64i32; w * w];
        for z in 0..w {
            for x in 0..w {
                gentle[z * w + x] = 64 + x as i32;
                cliff[z * w + x] = 64 + if x >= 2 { 12 } else { 0 };
            }
        }
        let idx = 2 * w + 2;
        let g = (hillshade_at(&gentle, w, idx) - 1.0).abs();
        let c = (hillshade_at(&cliff, w, idx) - 1.0).abs();
        assert!(c > g * 2.0, "cliff {} should dwarf gentle {}", c, g);
    }

    /// Empty columns must not blow up the shading of their neighbours.
    #[test]
    fn hillshade_handles_empty_columns() {
        let w = 5;
        let mut h = vec![EMPTY; w * w];
        let idx = 2 * w + 2;
        h[idx] = 70;
        let s = hillshade_at(&h, w, idx);
        assert!(s.is_finite() && s > 0.0);
    }
}
