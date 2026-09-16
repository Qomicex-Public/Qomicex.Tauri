use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};

use flate2::read::{GzDecoder, ZlibDecoder};

use super::nbt::{self, Tag};

pub fn region_path(region_dir: &Path, cx: i32, cz: i32) -> PathBuf {
    region_dir.join(format!("r.{}.{}.mca", cx >> 5, cz >> 5))
}

/// Returns decompressed chunk NBT bytes, or None if the chunk is not present.
pub fn read_chunk_nbt(region_dir: &Path, cx: i32, cz: i32) -> Result<Option<Vec<u8>>, String> {
    let path = region_path(region_dir, cx, cz);
    let mut f = match File::open(&path) {
        Ok(f) => f,
        Err(_) => return Ok(None),
    };
    let mut header = [0u8; 8192];
    if f.read_exact(&mut header).is_err() {
        return Ok(None);
    }
    let lx = (cx & 31) as usize;
    let lz = (cz & 31) as usize;
    let idx = (lx + lz * 32) * 4;
    let offset =
        ((header[idx] as usize) << 16 | (header[idx + 1] as usize) << 8 | header[idx + 2] as usize)
            * 4096;
    if offset == 0 {
        return Ok(None);
    }
    f.seek(SeekFrom::Start(offset as u64))
        .map_err(|e| e.to_string())?;
    let mut len_buf = [0u8; 5];
    if f.read_exact(&mut len_buf).is_err() {
        return Ok(None);
    }
    let len = u32::from_be_bytes([len_buf[0], len_buf[1], len_buf[2], len_buf[3]]) as usize;
    if len <= 1 {
        return Ok(None);
    }
    let comp = len_buf[4];
    let mut raw = vec![0u8; len - 1];
    if f.read_exact(&mut raw).is_err() {
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
        other => Err(format!("unknown region compression {}", other)),
    }
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
        let Some(data) = &bs.data else {
            // Single-entry palette: everything is palette[0].
            return Some(0);
        };
        let bits = bs.bits as usize;
        if bits == 0 {
            return Some(0);
        }
        let mask = (1u64 << bits) - 1;
        let v = if bs.spans {
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

    loop {
        let t = r.u8()?;
        if t == 0 {
            break;
        }
        let name = r.string()?;
        match (name.as_str(), t) {
            ("Y", 1) => y = r.u8()? as i8 as i32,
            ("Y", 3) => y = r.i32()?,
            ("block_states", 10) => block_states = Some(parse_block_states(r)?),
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
    })
}

fn parse_block_states(r: &mut nbt::Reader) -> Result<BlockStates, String> {
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

    // Bits per entry follows the wiki's rules for the flattened format.
    Ok(BlockStates::from_parts(palette, data))
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
    use nbt::Reader;

    let mut r = Reader::new(chunk_nbt);
    let root_type = r.u8()?;
    if root_type != 10 {
        return Err("chunk root is not a compound".into());
    }
    let _root_name = r.string()?;

    let mut out: Vec<Section> = Vec::new();
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
            parse_level(&mut r, &mut out)?;
        } else {
            r.skip(t, 0)?;
        }
    }

    if !saw_level {
        return Err("chunk has no Level tag".into());
    }
    out.sort_by(|a, b| b.y.cmp(&a.y));
    Ok(out)
}

fn parse_level(r: &mut nbt::Reader, out: &mut Vec<Section>) -> Result<(), String> {
    loop {
        let t = r.u8()?;
        if t == 0 {
            break;
        }
        let name = r.string()?;
        if name == "Sections" && t == 9 {
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
        } else {
            r.skip(t, 0)?;
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
    })
}
