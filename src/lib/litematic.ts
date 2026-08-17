// Litematica (.litematic) schematic parser for the Qomicex launcher.
//
// A .litematic = a single GZIP-compressed NBT stream (root compound named
// "Schematic"). Parsing:
//   1. `NbtFile.read(bytes)` (deepslate) auto-detects the gzip header and
//      decompresses it (pako).
//   2. Extract Metadata + Regions.
//   3. Decode each region's bit-packed `BlockStates` long array into palette
//      indices (algorithm ported from EndingCredits/litematic-viewer and
//      verified byte-for-byte against a real v6 file: 0 out-of-range indices,
//      non-air count == metadata TotalBlocks).
//
// Version notes:
//   - v6 stores BlockStates as TAG_Long_Array, bit-packed with
//     nbits = ceil(log2(paletteSize)) bits per entry.
//   - v5 stores BlockStateArray as TAG_Byte_Array / int array, raw per-block
//     palette indices (1/2/4 bytes per entry).
//   - Multiple regions are supported (rendered offset by each region's Position).

import { NbtFile, type NbtCompound, type NbtTag } from 'deepslate'

export interface Vec3 {
  x: number
  y: number
  z: number
}

export interface PaletteEntry {
  /** Full block name, e.g. "minecraft:stone_bricks". */
  name: string
  properties: Record<string, string>
}

/** A block entity (tile entity). `x/y/z` are region-local (0-based) coords.
 *  `nbt` carries the block-specific data deepslate's special renderers need
 *  (chest contents, sign text, banner pattern, ...). */
export interface RegionBlockEntity {
  x: number
  y: number
  z: number
  nbt: NbtCompound
}

export interface SchematicRegion {
  name: string
  /** Absolute dimensions (abs of raw Size). */
  size: Vec3
  /** Raw Position from the NBT (may be a max-corner for negative-size regions). */
  position: Vec3
  /** True min-corner of the region = componentwise min(position, position + rawSize).
   *  Litematica stores Size with sign that encodes whether Position is the
   *  min or max corner; blocks are indexed from this min corner. */
  origin: Vec3
  palette: PaletteEntry[]
  /** Palette indices, flat with index = y*(w*d) + z*w + x (matches decode order). */
  blocks: Uint32Array
  blockCount: number
  /** Block entities (chests/signs/banners/...) with their NBT, keyed by local pos. */
  blockEntities: RegionBlockEntity[]
}

export interface SchematicMaterials {
  /** Full block name without properties. */
  name: string
  count: number
}

export interface LitematicFile {
  version: number
  metadata: {
    name: string
    author: string
    description: string
    size: Vec3
    totalBlocks: number
    totalVolume: number
    regionCount: number
    timeCreated: number | null
    timeModified: number | null
  }
  regions: SchematicRegion[]
  /** Aggregated material counts across regions (name → count), sorted desc. */
  materials: SchematicMaterials[]
  /** All distinct block names in the palette (for asset extraction). */
  paletteNames: string[]
}

function abs(v: number): number {
  return Math.abs(v)
}

function intOf(compound: NbtCompound | undefined, key: string): number {
  if (!compound) return 0
  const tag = compound.get(key)
  if (!tag) return 0
  const n = (tag as { getAsNumber?: () => number }).getAsNumber?.()
  return typeof n === 'number' && Number.isFinite(n) ? n : 0
}

function strOf(compound: NbtCompound | undefined, key: string): string {
  if (!compound) return ''
  const tag = compound.get(key)
  if (!tag) return ''
  const v = (tag as { getAsString?: () => string }).getAsString?.()
  return typeof v === 'string' ? v : ''
}

function longOf(compound: NbtCompound | undefined, key: string): number | null {
  if (!compound) return null
  const tag = compound.get(key)
  if (!tag) return null
  const n = (tag as { getAsNumber?: () => number }).getAsNumber?.()
  return typeof n === 'number' && Number.isFinite(n) ? n : null
}

function vec3Of(compound: NbtCompound | undefined): Vec3 {
  const sub = compound?.getCompound('Size') ?? undefined
  return { x: abs(intOf(sub, 'x')), y: abs(intOf(sub, 'y')), z: abs(intOf(sub, 'z')) }
}

function pos3Of(compound: NbtCompound | undefined): Vec3 {
  const sub = compound?.getCompound('Position') ?? undefined
  return { x: intOf(sub, 'x'), y: intOf(sub, 'y'), z: intOf(sub, 'z') }
}

/** Raw (signed) Size; Litematica keeps the sign so the caller can recover the
 *  region's true min-corner. */
function rawSizeOf(compound: NbtCompound | undefined): Vec3 {
  const sub = compound?.getCompound('Size') ?? undefined
  return { x: intOf(sub, 'x'), y: intOf(sub, 'y'), z: intOf(sub, 'z') }
}

function absVec3(v: Vec3): Vec3 {
  return { x: Math.abs(v.x), y: Math.abs(v.y), z: Math.abs(v.z) }
}

function parsePalette(list: NbtTag | undefined): PaletteEntry[] {
  const entries: PaletteEntry[] = []
  if (!list) return entries
  const getItems = (list as { getItems?: () => NbtTag[] }).getItems
  if (typeof getItems !== 'function') return entries
  for (const item of getItems.call(list)) {
    const comp = item as NbtCompound
    const name = strOf(comp, 'Name')
    const props: Record<string, string> = {}
    const propComp = comp?.getCompound('Properties') ?? undefined
    if (propComp) {
      for (const key of (propComp as unknown as { keys(): IterableIterator<string> }).keys()) {
        props[key] = strOf(propComp, key)
      }
    }
    entries.push(name ? { name, properties: props } : { name: 'minecraft:air', properties: {} })
  }
  return entries
}

/** Parse a region's TileEntities list. Positions are region-local (0-based).
 *  Each item keeps its full NBT compound so deepslate's special renderers can
 *  draw chests/signs/banners/etc. */
function parseBlockEntities(region: NbtCompound): RegionBlockEntity[] {
  const out: RegionBlockEntity[] = []
  const listTag = region.getList('TileEntities', 10) // TAG_Compound(10)
  const getItems = (listTag as unknown as { getItems?: () => NbtTag[] })?.getItems
  if (typeof getItems !== 'function') return out
  for (const item of getItems.call(listTag)) {
    const comp = item as NbtCompound
    const x = intOf(comp, 'x')
    const y = intOf(comp, 'y')
    const z = intOf(comp, 'z')
    out.push({ x, y, z, nbt: comp })
  }
  return out
}

/**
 * Faithful port of EndingCredits/litematic-viewer's `processNBTRegionData`.
 * Treats each 64-bit long as its [hi, lo] 32-bit words (deepslate's
 * NbtLongPair order) and walks the bit stream 32 bits at a time.
 */
function decodeBlocks(
  pairs: Array<[number, number]>,
  nbits: number,
  width: number,
  height: number,
  depth: number,
): Uint32Array {
  const mask = (1 << nbits) - 1
  const yShift = width * depth
  const zShift = width
  const total = width * height * depth
  const blocks = new Uint32Array(total)
  const regionData = pairs
  for (let x = 0; x < width; x++) {
    for (let y = 0; y < height; y++) {
      for (let z = 0; z < depth; z++) {
        const index = y * yShift + z * zShift + x
        const startOffset = index * nbits
        const startArrIndex = startOffset >>> 5
        const endArrIndex = ((index + 1) * nbits - 1) >>> 5
        const startBitOffset = startOffset & 0x1f
        const halfInd = startArrIndex >>> 1
        let blockStart: number
        let blockEnd: number
        if ((startArrIndex & 0x1) === 0) {
          blockStart = regionData[halfInd]?.[1] ?? 0
          blockEnd = regionData[halfInd]?.[0] ?? 0
        } else {
          blockStart = regionData[halfInd]?.[0] ?? 0
          blockEnd = halfInd + 1 < regionData.length ? (regionData[halfInd + 1][1] ?? 0) : 0
        }
        let val: number
        if (startArrIndex === endArrIndex) {
          val = (blockStart >>> startBitOffset) & mask
        } else {
          const endOffset = 32 - startBitOffset
          val = ((blockStart >>> startBitOffset) & mask) | ((blockEnd << endOffset) & mask)
        }
        // Store keyed by the SAME cell index buildStructure reads
        // (y*w*d + z*w + x), so decoding and rendering share one ordering.
        blocks[index] = val & mask
      }
    }
  }
  return blocks
}

function decodeRegionBlocks(region: NbtCompound): Uint32Array | null {
  const size = vec3Of(region)
  const w = size.x
  const h = size.y
  const d = size.z
  const total = w * h * d
  if (total <= 0) return null
  const paletteLen = parsePalette(region.get('BlockStatePalette')).length
  if (paletteLen <= 1) {
    // Single-entry palette: every cell is index 0.
    return new Uint32Array(total)
  }
  // v6: bit-packed long array.
  const longArr = region.getLongArray('BlockStates')
  const pairs = longArr.map((t) => (t as { getAsPair(): [number, number] }).getAsPair())
  if (pairs.length > 0) {
    const nbits = Math.max(1, Math.ceil(Math.log2(paletteLen)))
    return decodeBlocks(pairs, nbits, w, h, d)
  }
  // v5: raw BlockStateArray (byte/int/float? byte or int arrays).
  const arr = region.get('BlockStateArray')
  if (!arr) return null
  const items = (arr as { getItems?: () => Array<{ getAsNumber(): number }> }).getItems?.()
  if (!items || items.length === 0) return null
  if (items.length === total) {
    const out = new Uint32Array(total)
    for (let i = 0; i < total; i++) {
      const n = items[i].getAsNumber()
      out[i] = Number.isFinite(n) && n >= 0 ? n : 0
    }
    return out
  }
  if (items.length === total * 2) {
    // 2 bytes per block (short array)
    const out = new Uint32Array(total)
    for (let i = 0; i < total; i++) {
      const hi = items[i * 2].getAsNumber()
      const lo = items[i * 2 + 1].getAsNumber()
      const n = (hi << 8) | lo
      out[i] = Number.isFinite(n) && n >= 0 ? n : 0
    }
    return out
  }
  return null
}

/** Parse raw .litematic bytes into a usable structure. */
export function parseLitematic(bytes: ArrayBuffer): LitematicFile {
  const file = NbtFile.read(new Uint8Array(bytes))
  const root = file.root
  const version = intOf(root, 'Version')
  const meta = root.getCompound('Metadata') ?? undefined
  const metadata = {
    name: strOf(meta, 'Name') || 'Unnamed',
    author: strOf(meta, 'Author'),
    description: strOf(meta, 'Description'),
    size: vec3Of(meta),
    totalBlocks: intOf(meta, 'TotalBlocks'),
    totalVolume: intOf(meta, 'TotalVolume'),
    regionCount: intOf(meta, 'RegionCount'),
    timeCreated: longOf(meta, 'TimeCreated'),
    timeModified: longOf(meta, 'TimeModified'),
  }

  const regions: SchematicRegion[] = []
  const regionsComp = root.getCompound('Regions') ?? undefined
  if (regionsComp) {
    for (const name of (regionsComp as unknown as { keys(): IterableIterator<string> }).keys()) {
      const comp = regionsComp.getCompound(name) ?? undefined
      if (!comp) continue
      const rawSize = rawSizeOf(comp)
      const size = absVec3(rawSize)
      const position = pos3Of(comp)
      const origin: Vec3 = {
        x: Math.min(position.x, position.x + rawSize.x),
        y: Math.min(position.y, position.y + rawSize.y),
        z: Math.min(position.z, position.z + rawSize.z),
      }
      const palette = parsePalette(comp.get('BlockStatePalette'))
      const blocks = decodeRegionBlocks(comp)
      if (!blocks) continue
      let blockCount = 0
      const indexed = new Uint32Array(blocks.length)
      for (let i = 0; i < blocks.length; i++) {
        const idx = blocks[i]
        indexed[i] = idx
        if (idx > 0 && idx < palette.length) blockCount++
      }
      regions.push({
        name,
        size,
        position,
        origin,
        palette,
        blocks: indexed,
        blockCount,
        blockEntities: parseBlockEntities(comp),
      })
    }
  }

  // Aggregate materials across regions (count per block name).
  const counts = new Map<string, number>()
  for (const region of regions) {
    for (let i = 0; i < region.blocks.length; i++) {
      const idx = region.blocks[i]
      if (idx <= 0 || idx >= region.palette.length) continue
      const name = region.palette[idx].name
      counts.set(name, (counts.get(name) ?? 0) + 1)
    }
  }
  const materials = Array.from(counts.entries())
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count)

  const paletteNames = Array.from(
    new Set(regions.flatMap((r) => r.palette.map((p) => p.name).filter((n) => !n.endsWith(':air')))),
  )

  return {
    version,
    metadata,
    regions,
    materials,
    paletteNames,
  }
}

/** Aggregate region count / total blocks quickly (for UI badges). */
export function schematicStats(litematic: LitematicFile) {
  return {
    regions: litematic.regions.length,
    totalBlocks: litematic.metadata.totalBlocks > 0 ? litematic.metadata.totalBlocks : litematic.materials.reduce((s, m) => s + m.count, 0),
    dimensions: litematic.regions.map((r) => `${r.size.x}×${r.size.y}×${r.size.z}`).join(', '),
  }
}