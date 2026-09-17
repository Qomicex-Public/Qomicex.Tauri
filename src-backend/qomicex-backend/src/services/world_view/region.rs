use std::collections::HashMap;
use std::fs::File;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};

use flate2::read::{GzDecoder, ZlibDecoder};

use super::nbt::{self, Tag};

pub fn region_path(region_dir: &Path, cx: i32, cz: i32) -> PathBuf {
    region_dir.join(format!("r.{}.{}.mca", cx >> 5, cz >> 5))
}

/// Read exactly `buf.len()` bytes at `offset` without moving the file cursor.
///
/// Positional reads (`pread`) matter here: `seek` + `read` needs `&mut File`,
/// which would force every concurrent chunk read through the same handle to
/// take turns. Positional reads take `&File`, so the worker threads in
/// `load_chunks_parallel` can read one region file at the same time.
#[cfg(windows)]
fn read_exact_at(file: &File, mut buf: &mut [u8], mut offset: u64) -> std::io::Result<()> {
    use std::os::windows::fs::FileExt;
    while !buf.is_empty() {
        match file.seek_read(buf, offset) {
            Ok(0) => {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::UnexpectedEof,
                    "short region read",
                ))
            }
            Ok(n) => {
                buf = &mut buf[n..];
                offset += n as u64;
            }
            Err(e) if e.kind() == std::io::ErrorKind::Interrupted => {}
            Err(e) => return Err(e),
        }
    }
    Ok(())
}

#[cfg(unix)]
fn read_exact_at(file: &File, mut buf: &mut [u8], mut offset: u64) -> std::io::Result<()> {
    use std::os::unix::fs::FileExt;
    while !buf.is_empty() {
        match file.read_at(buf, offset) {
            Ok(0) => {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::UnexpectedEof,
                    "short region read",
                ))
            }
            Ok(n) => {
                buf = &mut buf[n..];
                offset += n as u64;
            }
            Err(e) if e.kind() == std::io::ErrorKind::Interrupted => {}
            Err(e) => return Err(e),
        }
    }
    Ok(())
}

/// One region file with its 8 KiB location header parsed once at open time.
///
/// Rendering a z=0 tile touches 324 chunks. Reopening the file and re-reading
/// its 8192-byte header for each of them is pure overhead: the header is
/// identical for every chunk in the file and only 1024 entries wide.
pub struct RegionFile {
    file: File,
    /// Sector offset of each chunk, indexed `lx + lz * 32`. Zero means absent.
    offsets: [u32; 1024],
}

impl RegionFile {
    pub fn open(path: &Path) -> Option<Self> {
        let mut file = File::open(path).ok()?;
        let mut header = [0u8; 8192];
        file.read_exact(&mut header).ok()?;
        let mut offsets = [0u32; 1024];
        for (i, off) in offsets.iter_mut().enumerate() {
            let b = &header[i * 4..i * 4 + 4];
            *off = ((b[0] as u32) << 16) | ((b[1] as u32) << 8) | (b[2] as u32);
        }
        Some(RegionFile { file, offsets })
    }

    /// Decompressed chunk NBT bytes, or None if the chunk is not present.
    pub fn read_chunk(&self, cx: i32, cz: i32) -> Result<Option<Vec<u8>>, String> {
        let lx = (cx & 31) as usize;
        let lz = (cz & 31) as usize;
        let offset = self.offsets[lx + lz * 32] as u64 * 4096;
        if offset == 0 {
            return Ok(None);
        }
        // Each chunk is prefixed with a 4-byte big-endian length and a 1-byte
        // compression id.
        let mut len_buf = [0u8; 5];
        if read_exact_at(&self.file, &mut len_buf, offset).is_err() {
            return Ok(None);
        }
        let len = u32::from_be_bytes([len_buf[0], len_buf[1], len_buf[2], len_buf[3]]) as usize;
        if len <= 1 {
            return Ok(None);
        }
        let comp = len_buf[4];
        let mut raw = vec![0u8; len - 1];
        if read_exact_at(&self.file, &mut raw, offset + 5).is_err() {
            return Ok(None);
        }
        match comp {
            1 => {
                let mut out = Vec::new();
                GzDecoder::new(&raw[..])
                    .read_to_end(&mut out)
                    .map_err(|e| e.to_string())?;
                Ok(Some(out))
            }
            2 => {
                let mut out = Vec::new();
                ZlibDecoder::new(&raw[..])
                    .read_to_end(&mut out)
                    .map_err(|e| e.to_string())?;
                Ok(Some(out))
            }
            3 => Ok(Some(raw)),
            4 => Ok(Some(decompress_lz4(&raw)?)),
            other => Err(format!("unknown region compression {}", other)),
        }
    }
}

/// lz4-java `LZ4BlockInputStream` stream, the format Minecraft 1.20.5+ writes
/// when `region-file-compression=lz4`. Note this is *not* the LZ4 frame format:
/// the stream is a sequence of blocks, each with an 8-byte ASCII `LZ4Block`
/// magic, a token byte, and three little-endian i32 fields (compressed length,
/// original length, xxhash checksum). The token's high nibble is the method:
/// `0x10` raw, `0x20` LZ4.
///
/// Reference: Amulet-Core PR #283 (the fix for Amulet issue #1027), which is
/// the same header layout the Minecraft client reads.
const LZ4_MAGIC: &[u8; 8] = b"LZ4Block";
const LZ4_HEADER_LEN: usize = 8 + 1 + 4 + 4 + 4;

fn decompress_lz4(data: &[u8]) -> Result<Vec<u8>, String> {
    let mut out = Vec::new();
    let mut pos = 0usize;
    while pos < data.len() {
        if pos + LZ4_HEADER_LEN > data.len() {
            return Err("lz4: truncated block header".into());
        }
        let header = &data[pos..pos + LZ4_HEADER_LEN];
        if &header[..8] != LZ4_MAGIC {
            return Err("lz4: bad block magic".into());
        }
        let token = header[8];
        let compressed_len = i32::from_le_bytes([header[9], header[10], header[11], header[12]]);
        let original_len = i32::from_le_bytes([header[13], header[14], header[15], header[16]]);
        pos += LZ4_HEADER_LEN;
        if compressed_len < 0 || original_len < 0 {
            return Err("lz4: negative block length".into());
        }
        let (compressed_len, original_len) = (compressed_len as usize, original_len as usize);
        if pos + compressed_len > data.len() {
            return Err("lz4: truncated block body".into());
        }
        let body = &data[pos..pos + compressed_len];
        pos += compressed_len;

        match token & 0xF0 {
            0x10 => {
                if compressed_len != original_len {
                    return Err("lz4: raw block length mismatch".into());
                }
                out.extend_from_slice(body);
            }
            0x20 => {
                let block = lz4_flex::block::decompress(body, original_len)
                    .map_err(|e| format!("lz4: {}", e))?;
                out.extend_from_slice(&block);
            }
            other => return Err(format!("lz4: unknown compression method {:#x}", other)),
        }
    }
    Ok(out)
}

/// Open region handles, keyed by `.mca` path.
///
/// Cached for the process lifetime, so a chunk generated by the game while the
/// viewer is running stays invisible until the cache is cleared.
/// `clear_region_cache` is called on world switch and cache invalidation.
fn region_file_cache() -> &'static Mutex<HashMap<PathBuf, Arc<RegionFile>>> {
    static CACHE: OnceLock<Mutex<HashMap<PathBuf, Arc<RegionFile>>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Drop every cached region handle. Call when the underlying files may have
/// changed (world switch, explicit cache invalidation).
pub fn clear_region_cache() {
    region_file_cache().lock().unwrap().clear();
}

fn get_region_file(path: &Path) -> Option<Arc<RegionFile>> {
    // Look up under the lock, open outside it. Opening reads 8 KiB and the
    // eight worker threads in `load_chunks_parallel` would otherwise queue
    // behind each other for the first access to every region file.
    if let Some(rf) = region_file_cache().lock().unwrap().get(path) {
        return Some(rf.clone());
    }
    let rf = Arc::new(RegionFile::open(path)?);
    // Another thread may have opened the same file meanwhile; keep one.
    let mut cache = region_file_cache().lock().unwrap();
    let entry = cache
        .entry(path.to_path_buf())
        .or_insert_with(|| rf.clone());
    Some(entry.clone())
}

/// Returns decompressed chunk NBT bytes, or None if the chunk is not present.
pub fn read_chunk_nbt(region_dir: &Path, cx: i32, cz: i32) -> Result<Option<Vec<u8>>, String> {
    let path = region_path(region_dir, cx, cz);
    let Some(rf) = get_region_file(&path) else {
        return Ok(None);
    };
    rf.read_chunk(cx, cz)
}

pub struct Section {
    pub y: i32,
    pub blocks16: Option<Vec<u8>>,
    pub blocks: Option<Vec<u8>>,
    pub data16: Option<Vec<u8>>,
    pub data: Option<Vec<u8>>,
    pub add: Option<Vec<u8>>,
    /// 1.13+ flattened format: palette entry index per block, 4..16 bits each.
    pub block_states: Option<BlockStates>,
    /// 1.18+ per-section biome palette (namespaced names) and packed indices.
    pub biomes: Option<BlockStates>,
}

/// Chunk-level biome storage for the 1.7–1.17 formats.
///
/// 1.7.10–1.14 store one biome per column (256 entries); 1.15–1.17 store one
/// per 4×4×4 cell (1024 entries). 1.7.10 writes a `ByteArray`, 1.9+ an
/// `IntArray`; the byte form of the 1024 grid packs four big-endian ints per
/// 16 bytes, which is what `from_bytes` decodes.
#[derive(Debug, Clone)]
pub enum LegacyBiomes {
    /// 256 biome ids, indexed `z * 16 + x`.
    Columns(Vec<u8>),
    /// 1024 biome ids, indexed `(y >> 2) * 16 + (z >> 2) * 4 + (x >> 2)`.
    Grid(Vec<u16>),
}

impl LegacyBiomes {
    /// Biome id for a column at local `(x, z)` and absolute block-Y `y`.
    pub fn biome_id(&self, x: usize, z: usize, y: i32) -> u16 {
        match self {
            LegacyBiomes::Columns(cols) => {
                cols.get((z & 15) * 16 + (x & 15)).copied().unwrap_or(0) as u16
            }
            LegacyBiomes::Grid(grid) => {
                // The grid covers y 0..255; clamp so 1.18-style heights still
                // resolve to the nearest available cell.
                let gy = (y.clamp(0, 255) as usize) >> 2;
                let idx = gy * 16 + ((z >> 2) & 3) * 4 + ((x >> 2) & 3);
                grid.get(idx).copied().unwrap_or(0)
            }
        }
    }

    /// Build from a chunk's `Biomes` tag payload: 256 bytes are per-column
    /// ids, 1024 ints (or 4096 bytes) are the 4×4×4 grid.
    pub fn from_bytes(bytes: &[u8]) -> Option<LegacyBiomes> {
        match bytes.len() {
            256 => Some(LegacyBiomes::Columns(bytes.to_vec())),
            // 1024 ints written as raw big-endian bytes.
            4096 => {
                let mut v = Vec::with_capacity(1024);
                for c in bytes.chunks_exact(4) {
                    let id = u32::from_be_bytes([c[0], c[1], c[2], c[3]]);
                    v.push(id.min(u16::MAX as u32) as u16);
                }
                Some(LegacyBiomes::Grid(v))
            }
            _ => None,
        }
    }

    /// Build from a chunk's `Biomes` `IntArray`.
    pub fn from_ints(ints: &[i32]) -> Option<LegacyBiomes> {
        match ints.len() {
            256 => Some(LegacyBiomes::Columns(
                ints.iter().map(|&v| v.clamp(0, 255) as u8).collect(),
            )),
            1024 => Some(LegacyBiomes::Grid(
                ints.iter()
                    .map(|&v| v.clamp(0, u16::MAX as i32) as u16)
                    .collect(),
            )),
            _ => None,
        }
    }
}

/// 1.13+ `block_states`: a palette plus bit-packed indices.
///
/// Two on-disk layouts produce this: 1.13–1.17 keep `Palette`/`BlockStates`
/// as sibling tags under `Level.Sections[]`, 1.18+ nest both inside a
/// `block_states` compound at the chunk root.
pub struct BlockStates {
    pub palette: Vec<String>,
    pub data: Option<Vec<u64>>,
    /// Bits per entry, derived from palette length (per the wiki).
    pub bits: u32,
    /// 1.13–1.15 pack entries contiguously across long boundaries; 1.16+
    /// pad each long instead. The layouts only differ when `bits` does not
    /// divide 64 (bits 5, 6, 7), where the array length tells them apart.
    pub spans: bool,
}

impl BlockStates {
    /// Derive `bits` and the packing layout from a palette and its long array.
    pub fn from_parts(palette: Vec<String>, data: Option<Vec<u64>>) -> Self {
        let bits = match palette.len() {
            0 | 1 => 0,
            n if n <= 16 => 4,
            n if n <= 32 => 5,
            n if n <= 64 => 6,
            n if n <= 128 => 7,
            n if n <= 256 => 8,
            _ => 9,
        };
        // 4096 block positions per section. When `bits` divides 64 the two
        // layouts coincide, so this only has to decide bits 5..7.
        let spans = match (bits, data.as_ref().map(|d| d.len())) {
            (0, _) | (_, None) => false,
            (b, Some(len)) => {
                let per_long = 64 / b as usize;
                let padded = 4096usize.div_ceil(per_long);
                let contiguous = (4096 * b as usize).div_ceil(64);
                len == contiguous && len != padded
            }
        };
        BlockStates {
            palette,
            data,
            bits,
            spans,
        }
    }

    /// Biome data (1.18+): 64 entries per section, no minimum bit width, and
    /// always padded to long boundaries — the spanning layout predates biomes.
    pub fn from_biome_parts(palette: Vec<String>, data: Option<Vec<u64>>) -> Self {
        let bits = match palette.len() {
            0 | 1 => 0,
            n => usize::BITS - (n - 1).leading_zeros(),
        };
        BlockStates {
            palette,
            data,
            bits,
            spans: false,
        }
    }

    /// Decode entry `i` of the packed array.
    #[inline]
    pub fn index_at(&self, i: usize) -> Option<usize> {
        let Some(data) = &self.data else {
            // Single-entry palette: everything is palette[0].
            return Some(0);
        };
        let bits = self.bits as usize;
        if bits == 0 {
            return Some(0);
        }
        let mask = (1u64 << bits) - 1;
        let v = if self.spans {
            // 1.13–1.15: entries are packed contiguously, so one may straddle
            // a long boundary. Take the low bits here and the high bits there.
            let bit = i * bits;
            let long_idx = bit / 64;
            if long_idx >= data.len() {
                return None;
            }
            let offset = bit % 64;
            let lo = data[long_idx] >> offset;
            let hi = if offset + bits > 64 {
                data.get(long_idx + 1).copied().unwrap_or(0) << (64 - offset)
            } else {
                0
            };
            (lo | hi) & mask
        } else {
            // 1.16+: each entry is padded to start at a long boundary.
            let per_long = 64 / bits;
            let long_idx = i / per_long;
            if long_idx >= data.len() {
                return None;
            }
            let offset = (i % per_long) * bits;
            (data[long_idx] >> offset) & mask
        };
        Some(v as usize)
    }
}

impl Section {
    /// Returns (block_id, meta) for local coords 0..15.
    pub fn block(&self, x: usize, y: usize, z: usize) -> (u16, u16) {
        let i = (y * 16 + z) * 16 + x;
        if let Some(b) = &self.blocks16 {
            if i * 2 + 1 >= b.len() {
                return (0, 0);
            }
            let id = ((b[i * 2] as u16) << 8) | b[i * 2 + 1] as u16;
            let meta = match &self.data16 {
                Some(d) if i * 2 + 1 < d.len() => ((d[i * 2] as u16) << 8) | d[i * 2 + 1] as u16,
                _ => 0,
            };
            return (id, meta);
        }
        if let Some(b) = &self.blocks {
            if i >= b.len() {
                return (0, 0);
            }
            let mut id = b[i] as u16;
            if let Some(add) = &self.add {
                if i / 2 < add.len() {
                    let nib = add[i / 2];
                    let v = if i % 2 == 0 { nib & 0x0F } else { nib >> 4 };
                    id |= (v as u16) << 8;
                }
            }
            let meta = match &self.data {
                Some(d) if i / 2 < d.len() => {
                    let nib = d[i / 2];
                    if i % 2 == 0 {
                        (nib & 0x0F) as u16
                    } else {
                        (nib >> 4) as u16
                    }
                }
                _ => 0,
            };
            return (id, meta);
        }
        (0, 0)
    }

    /// Palette entry index for 1.13+ sections, or None for legacy formats.
    pub fn palette_index(&self, x: usize, y: usize, z: usize) -> Option<usize> {
        let bs = self.block_states.as_ref()?;
        // 1.13+ block order is YZX
        let i = (y * 16 + z) * 16 + x;
        let idx = bs.index_at(i)?;
        // Out-of-range indices are corrupt; treat them as "no block".
        if idx >= bs.palette.len() {
            return None;
        }
        Some(idx)
    }

    /// Biome palette entry index for 1.18+ sections, at 4×4×4 cell granularity.
    pub fn biome_index(&self, x: usize, y: usize, z: usize) -> Option<usize> {
        let bs = self.biomes.as_ref()?;
        if bs.palette.is_empty() {
            return None;
        }
        let i = ((y >> 2) & 15) * 16 + ((z >> 2) & 15) * 4 + ((x >> 2) & 15);
        let idx = bs.index_at(i)?;
        if idx >= bs.palette.len() {
            return None;
        }
        Some(idx)
    }

    /// Namespaced biome name for 1.18+ sections.
    pub fn biome_name(&self, x: usize, y: usize, z: usize) -> Option<&str> {
        let idx = self.biome_index(x, y, z)?;
        self.biomes.as_ref()?.palette.get(idx).map(|s| s.as_str())
    }

    /// Block name for 1.13+ sections.
    pub fn block_name(&self, x: usize, y: usize, z: usize) -> Option<&str> {
        let idx = self.palette_index(x, y, z)?;
        let bs = self.block_states.as_ref()?;
        bs.palette.get(idx).map(|s| s.as_str())
    }

    /// Borrowed block reference for hot paths: no allocation.
    /// Returns the legacy id/meta pair, or the palette's block name.
    #[inline]
    pub fn block_ref(
        &self,
        x: usize,
        y: usize,
        z: usize,
    ) -> Option<super::render::BlockRefRef<'_>> {
        if let Some(bs) = &self.block_states {
            let idx = self.palette_index(x, y, z)?;
            let name = bs.palette.get(idx)?.as_str();
            return Some(super::render::BlockRefRef::Named(name));
        }
        let (id, meta) = self.block(x, y, z);
        Some(super::render::BlockRefRef::Legacy(id, meta))
    }
}

pub fn parse_sections(chunk_nbt: &[u8]) -> Result<Vec<Section>, String> {
    let (_, root) = nbt::parse(chunk_nbt)?;
    let level = root.get("Level").ok_or("chunk has no Level tag")?;
    let mut out = Vec::new();
    if let Some(list) = level.get("Sections").and_then(|t| t.as_list()) {
        for s in list {
            let y = s.get("Y").and_then(|t| t.as_i32()).unwrap_or(0);
            let get_bytes = |k: &str| -> Option<Vec<u8>> {
                s.get(k).and_then(|t| match t {
                    Tag::ByteArray(b) => Some(b.clone()),
                    _ => None,
                })
            };
            out.push(Section {
                y,
                blocks16: get_bytes("Blocks16"),
                blocks: get_bytes("Blocks"),
                data16: get_bytes("Data16"),
                data: get_bytes("Data"),
                add: get_bytes("Add"),
                block_states: legacy_block_states(s),
                biomes: None,
            });
        }
    }
    out.sort_by(|a, b| b.y.cmp(&a.y));
    Ok(out)
}

/// 1.13–1.17 sections keep `Palette` (list of compounds) and `BlockStates`
/// (long array) as sibling tags. `None` for other formats.
fn legacy_block_states(s: &Tag) -> Option<BlockStates> {
    let palette = s.get("Palette").and_then(|t| t.as_list())?;
    let names: Vec<String> = palette
        .iter()
        .map(|e| {
            e.get("Name")
                .and_then(|n| n.as_str())
                .unwrap_or_default()
                .to_string()
        })
        .collect();
    let data = s.get("BlockStates").and_then(|t| match t {
        Tag::LongArray(d) => Some(d.iter().map(|v| *v as u64).collect::<Vec<u64>>()),
        _ => None,
    });
    Some(BlockStates::from_parts(names, data))
}

/// Targeted section parser for 1.13+ chunks (`sections[].block_states`).
///
/// Sections live at the root (not under `Level`), `Y` may be negative, and the
/// palette is a list of compounds carrying a `Name` string.
pub fn parse_sections_modern(chunk_nbt: &[u8]) -> Result<Vec<Section>, String> {
    use nbt::Reader;

    let mut r = Reader::new(chunk_nbt);
    let root_type = r.u8()?;
    if root_type != 10 {
        return Err("chunk root is not a compound".into());
    }
    let _root_name = r.string()?;

    let mut out: Vec<Section> = Vec::new();
    loop {
        let t = r.u8()?;
        if t == 0 {
            break;
        }
        let name = r.string()?;
        if name == "sections" && t == 9 {
            let elem = r.u8()?;
            let count = r.i32()?;
            if count < 0 {
                return Err("negative section count".into());
            }
            for _ in 0..count {
                if elem == 10 {
                    out.push(parse_section_modern(&mut r)?);
                } else {
                    r.skip(elem, 1)?;
                }
            }
        } else {
            r.skip(t, 0)?;
        }
    }
    out.sort_by(|a, b| b.y.cmp(&a.y));
    Ok(out)
}

fn parse_section_modern(r: &mut nbt::Reader) -> Result<Section, String> {
    let mut y = 0i32;
    let mut block_states = None;
    let mut biomes = None;

    loop {
        let t = r.u8()?;
        if t == 0 {
            break;
        }
        let name = r.string()?;
        match (name.as_str(), t) {
            ("Y", 1) => y = r.u8()? as i8 as i32,
            ("Y", 3) => y = r.i32()?,
            ("block_states", 10) => block_states = Some(parse_packed(r, false)?),
            ("biomes", 10) => biomes = Some(parse_packed(r, true)?),
            _ => r.skip(t, 1)?,
        }
    }

    Ok(Section {
        y,
        blocks16: None,
        blocks: None,
        data16: None,
        data: None,
        add: None,
        block_states,
        biomes,
    })
}

/// Parse a `block_states`-shaped compound: a `palette` list plus a packed
/// `data` long array. `biome` switches to the biome packing rules (no minimum
/// bit width, always long-padded).
fn parse_packed(r: &mut nbt::Reader, biome: bool) -> Result<BlockStates, String> {
    let mut palette: Vec<String> = Vec::new();
    let mut data: Option<Vec<u64>> = None;

    loop {
        let t = r.u8()?;
        if t == 0 {
            break;
        }
        let name = r.string()?;
        match (name.as_str(), t) {
            ("palette", 9) => {
                let elem = r.u8()?;
                let count = r.i32()?;
                if count < 0 {
                    return Err("negative palette len".into());
                }
                for _ in 0..count {
                    if elem == 10 {
                        palette.push(parse_palette_entry(r)?);
                    } else if elem == 8 {
                        // Biome palettes are plain strings.
                        palette.push(r.string()?);
                    } else {
                        r.skip(elem, 2)?;
                        palette.push(String::new());
                    }
                }
            }
            ("data", 12) => {
                let n = r.i32()?;
                if n < 0 {
                    return Err("negative data len".into());
                }
                let mut v = Vec::with_capacity(n as usize);
                for _ in 0..n {
                    v.push(r.u64()?);
                }
                data = Some(v);
            }
            _ => r.skip(t, 1)?,
        }
    }

    Ok(if biome {
        BlockStates::from_biome_parts(palette, data)
    } else {
        BlockStates::from_parts(palette, data)
    })
}

/// Palette entries of a 1.13–1.17 `Palette` tag: a list of compounds whose
/// only interesting key is `Name`.
fn parse_legacy_palette(r: &mut nbt::Reader) -> Result<Vec<String>, String> {
    let elem = r.u8()?;
    let count = r.i32()?;
    if count < 0 {
        return Err("negative palette len".into());
    }
    let mut palette = Vec::with_capacity(count as usize);
    for _ in 0..count {
        if elem == 10 {
            palette.push(parse_palette_entry(r)?);
        } else {
            r.skip(elem, 2)?;
            palette.push(String::new());
        }
    }
    Ok(palette)
}

/// Long array of a 1.13–1.17 `BlockStates` tag (TAG_Long_Array).
fn parse_legacy_block_states(r: &mut nbt::Reader) -> Result<Vec<u64>, String> {
    let n = r.i32()?;
    if n < 0 {
        return Err("negative BlockStates len".into());
    }
    let mut v = Vec::with_capacity(n as usize);
    for _ in 0..n {
        v.push(r.u64()?);
    }
    Ok(v)
}

fn parse_palette_entry(r: &mut nbt::Reader) -> Result<String, String> {
    let mut name = String::new();
    loop {
        let t = r.u8()?;
        if t == 0 {
            break;
        }
        let key = r.string()?;
        if key == "Name" && t == 8 {
            name = r.string()?;
        } else {
            r.skip(t, 2)?;
        }
    }
    Ok(name)
}

/// Targeted section parser: walks the NBT tree and materialises *only* the
/// block arrays, skipping entities, tile entities and every mod-specific tag.
///
/// A chunk's `Entities`/`TileEntities` lists dominate its parse cost (a single
/// GTNH chunk can hold 700+ tile entities), and none of it is rendered.
/// Measured on the reference save this cuts parse time by roughly 3x.
pub fn parse_sections_fast(chunk_nbt: &[u8]) -> Result<Vec<Section>, String> {
    parse_sections_fast_full(chunk_nbt).map(|(sections, _)| sections)
}

/// As [`parse_sections_fast`], but also returns the chunk-level `Biomes` of the
/// 1.7–1.17 formats (1.18+ carries biomes per section instead).
pub fn parse_sections_fast_full(
    chunk_nbt: &[u8],
) -> Result<(Vec<Section>, Option<LegacyBiomes>), String> {
    use nbt::Reader;

    let mut r = Reader::new(chunk_nbt);
    let root_type = r.u8()?;
    if root_type != 10 {
        return Err("chunk root is not a compound".into());
    }
    let _root_name = r.string()?;

    let mut out: Vec<Section> = Vec::new();
    let mut legacy_biomes = None;
    let mut saw_level = false;

    // ---- root compound ----
    loop {
        let t = r.u8()?;
        if t == 0 {
            break;
        }
        let name = r.string()?;
        if name == "Level" && t == 10 {
            saw_level = true;
            parse_level(&mut r, &mut out, &mut legacy_biomes)?;
        } else {
            r.skip(t, 0)?;
        }
    }

    if !saw_level {
        return Err("chunk has no Level tag".into());
    }
    out.sort_by(|a, b| b.y.cmp(&a.y));
    Ok((out, legacy_biomes))
}

fn parse_level(
    r: &mut nbt::Reader,
    out: &mut Vec<Section>,
    legacy_biomes: &mut Option<LegacyBiomes>,
) -> Result<(), String> {
    loop {
        let t = r.u8()?;
        if t == 0 {
            break;
        }
        let name = r.string()?;
        match (name.as_str(), t) {
            ("Sections", 9) => {
                let elem = r.u8()?;
                let count = r.i32()?;
                if count < 0 {
                    return Err("negative section count".into());
                }
                for _ in 0..count {
                    if elem == 10 {
                        out.push(parse_section(r)?);
                    } else {
                        r.skip(elem, 1)?;
                    }
                }
            }
            // 1.7.10 writes bytes, 1.9+ writes ints.
            ("Biomes", 7) => {
                let n = r.i32()?;
                if n < 0 {
                    return Err("negative Biomes len".into());
                }
                let bytes = r.bytes(n as usize)?;
                *legacy_biomes = LegacyBiomes::from_bytes(&bytes);
            }
            ("Biomes", 11) => {
                let n = r.i32()?;
                if n < 0 {
                    return Err("negative Biomes len".into());
                }
                let mut v = Vec::with_capacity(n as usize);
                for _ in 0..n {
                    v.push(r.i32()?);
                }
                *legacy_biomes = LegacyBiomes::from_ints(&v);
            }
            _ => r.skip(t, 0)?,
        }
    }
    Ok(())
}

fn parse_section(r: &mut nbt::Reader) -> Result<Section, String> {
    let mut y = 0i32;
    let mut blocks16 = None;
    let mut blocks = None;
    let mut data16 = None;
    let mut data = None;
    let mut add = None;
    // 1.13–1.17: `Palette` and `BlockStates` are siblings; whichever comes
    // first is buffered until both are known.
    let mut palette: Option<Vec<String>> = None;
    let mut long_data: Option<Vec<u64>> = None;
    let mut biomes = None;

    loop {
        let t = r.u8()?;
        if t == 0 {
            break;
        }
        let name = r.string()?;
        match (name.as_str(), t) {
            // MC 1.7.10 stores section Y as TAG_Byte; 1.13+ uses TAG_Int.
            ("Y", 1) => y = r.u8()? as i8 as i32,
            ("Y", 3) => y = r.i32()?,
            ("Palette", 9) => palette = Some(parse_legacy_palette(r)?),
            ("BlockStates", 12) => long_data = Some(parse_legacy_block_states(r)?),
            ("biomes", 10) => biomes = Some(parse_packed(r, true)?),
            ("Blocks16", 7) => {
                let n = r.i32()?;
                if n < 0 {
                    return Err("negative Blocks16".into());
                }
                blocks16 = Some(r.bytes(n as usize)?);
            }
            ("Blocks", 7) => {
                let n = r.i32()?;
                if n < 0 {
                    return Err("negative Blocks".into());
                }
                blocks = Some(r.bytes(n as usize)?);
            }
            ("Data16", 7) => {
                let n = r.i32()?;
                if n < 0 {
                    return Err("negative Data16".into());
                }
                data16 = Some(r.bytes(n as usize)?);
            }
            ("Data", 7) => {
                let n = r.i32()?;
                if n < 0 {
                    return Err("negative Data".into());
                }
                data = Some(r.bytes(n as usize)?);
            }
            ("Add", 7) => {
                let n = r.i32()?;
                if n < 0 {
                    return Err("negative Add".into());
                }
                add = Some(r.bytes(n as usize)?);
            }
            _ => r.skip(t, 1)?,
        }
    }

    let block_states = palette.map(|p| BlockStates::from_parts(p, long_data));

    Ok(Section {
        y,
        blocks16,
        blocks,
        data16,
        data,
        add,
        block_states,
        biomes,
    })
}

#[cfg(test)]
mod lz4_tests {
    use super::decompress_lz4;

    /// One lz4-java block: `LZ4Block` magic, token, then three little-endian
    /// i32s (compressed length, original length, checksum), then the body.
    fn block(method: u8, compressed: &[u8], original_len: usize) -> Vec<u8> {
        let mut b = Vec::new();
        b.extend_from_slice(b"LZ4Block");
        b.push(method);
        b.extend_from_slice(&(compressed.len() as i32).to_le_bytes());
        b.extend_from_slice(&(original_len as i32).to_le_bytes());
        b.extend_from_slice(&0i32.to_le_bytes());
        b.extend_from_slice(compressed);
        b
    }

    /// No local save uses compression type 4, so the stream is built here. A
    /// raw block followed by an LZ4 block is the shape Minecraft writes.
    #[test]
    fn decodes_raw_then_lz4_blocks() {
        let raw = b"hello raw block".to_vec();
        let payload = vec![7u8; 4096];
        let compressed = lz4_flex::block::compress(&payload);

        let mut stream = block(0x10, &raw, raw.len());
        stream.extend_from_slice(&block(0x20, &compressed, payload.len()));

        let out = decompress_lz4(&stream).expect("decode");
        let mut want = raw.clone();
        want.extend_from_slice(&payload);
        assert_eq!(out, want);
    }

    #[test]
    fn rejects_bad_magic_and_truncation() {
        assert!(decompress_lz4(b"not-an-lz4-stream").is_err());
        let good = block(0x10, b"abc", 3);
        assert!(decompress_lz4(&good[..10]).is_err());
    }

    /// The LZ4 frame magic (`0x184D2204`) is *not* what Minecraft writes; a
    /// stream starting with it must be rejected rather than misparsed.
    #[test]
    fn rejects_lz4_frame_magic() {
        let mut frame = vec![0x04, 0x22, 0x4d, 0x18];
        frame.extend_from_slice(&[0u8; 32]);
        assert!(decompress_lz4(&frame).is_err());
    }
}
