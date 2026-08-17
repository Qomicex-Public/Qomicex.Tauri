// Deepslate-based 3D schematic viewer (ported interaction from
// EndingCredits/litematic-viewer, adapted to deepslate 0.26 API).
//
// Responsibilities:
//  - Build a deepslate `Resources` object from the backend's per-palette
//    asset bundle (blockstates/models/texture atlas from the game jar).
//  - Render the parsed litematic with `StructureRenderer` (WebGL).
//  - Camera controls: drag to pan/move, wheel to zoom, WASD to fly.
//  - Layer slicing: rebuild the structure for a y-range (for layer-by-layer
//    building previews).

import {
  Structure,
  StructureRenderer,
  BlockDefinition,
  BlockModel,
  TextureAtlas,
  Identifier,
  type Resources,
  type BlockFlags,
} from 'deepslate'
import { mat4, vec3 } from 'gl-matrix'
import type { LitematicFile } from './litematic.ts'
import type { SchematicAssetsBundle } from '../types/index.ts'

/** Fallback block used for palette entries missing from the vanilla assets. */
const FALLBACK_BLOCK = 'minecraft:stone'

// ---------------------------------------------------------------------------
// Bundle → deepslate resources
// ---------------------------------------------------------------------------

function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

function textureToBlob(b64: string): Blob {
  return new Blob([b64ToBytes(b64).buffer as ArrayBuffer], { type: 'image/png' })
}

const SEMI_TRANSPARENT_KEYWORDS = [
  'glass', 'leaves', 'water', 'ice', 'portal', 'end_rod', 'candle', 'vine',
  'carpet', 'sapling', 'flower', 'tulip', 'orchid', 'dandelion', 'poppy',
  'allium', 'bluet', 'daisy', 'lily', 'mushroom', 'kelp', 'seagrass', 'coral',
  'chorus', 'scaffolding', 'lichen', 'fern', 'grass', 'bamboo', 'sugar_cane',
  'cocoa', 'berry', 'ladder', 'rail', 'torch', 'lamp', 'chain', 'bell',
  'lantern', 'nether_sprouts', 'warped_roots', 'crimson_roots', 'soul_lantern',
  'candle', 'bubble', 'suspicious_sand', 'suspicious_gravel',
]
const NON_SOLID_KEYWORDS = [
  'button', 'lever', 'pressure', 'door', 'trapdoor', 'fence_gate', 'fence',
  'wall', 'sign', 'banner', 'flower_pot', 'torch', 'rail', 'ladder', 'vine',
  'carpet', 'sapling', 'flower', 'grass', 'fern', 'tall', 'plant', 'stem',
  'mushroom', 'kelp', 'seagrass', 'coral', 'chorus', 'scaffolding', 'candle',
  'lantern', 'chain', 'bell', 'big_dripleaf', 'small_dripleaf', 'spore_blossom',
  'azalea', 'moss_carpet', 'lever', 'repeater', 'comparator', 'tripwire',
  // Non-full-cube solids: NOT opaque for occlusion, so a neighbour's face
  // facing them is NOT culled (e.g. the side of a full block next to a slab
  // must stay visible above the half-height slab).
  'slab', 'stairs', 'anvil', 'chest', 'cauldron', 'hopper', 'brewing_stand',
]

function computeFlags(name: string): BlockFlags {
  const low = name.split(':').pop() ?? name
  const semi = SEMI_TRANSPARENT_KEYWORDS.some((k) => low.includes(k))
  const nonSolid = NON_SOLID_KEYWORDS.some((k) => low.includes(k))
  const opaque = !semi && !nonSolid
  return {
    opaque,
    semi_transparent: semi,
    self_culling: opaque,
  }
}

/**
 * Build a texture atlas ourselves instead of `TextureAtlas.fromBlobs`.
 *
 * deepslate 0.26's `fromBlobs` computes the grid width with
 * `upperPowerOfTwo(Math.sqrt(count + 1))`, whose bit-hack truncates the float
 * and can under-size the atlas (e.g. 22 textures → 4×4=16 cells, 64px). That
 * pushes later textures beyond the canvas → wrong UVs → magenta / swapped
 * textures. We use an integer power-of-two SIDE that always fits every cell.
 */
async function buildAtlas(blobs: Record<string, Blob>): Promise<TextureAtlas> {
  const count = Object.keys(blobs).length + 1
  let side = 1
  while (side * side < count) side *= 2
  const pixelSize = side * 16
  const canvas = document.createElement('canvas')
  canvas.width = pixelSize
  canvas.height = pixelSize
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('2D canvas unavailable')
  // Cell (0,0) = invalid/missing-texture marker (magenta + black), like deepslate.
  ctx.fillStyle = '#000000'
  ctx.fillRect(0, 0, 16, 16)
  ctx.fillStyle = '#ff00ff'
  ctx.fillRect(0, 0, 8, 8)
  ctx.fillRect(8, 8, 8, 8)
  const part = 1 / side
  const idMap: Record<string, [number, number, number, number]> = {}
  let index = 1
  for (const [id, blob] of Object.entries(blobs)) {
    const u = index % side
    const v = Math.floor(index / side)
    index += 1
    idMap[id] = [part * u, part * v, part * u + part, part * v + part]
    try {
      const img = await createImageBitmap(blob)
      ctx.drawImage(img, 0, 0, 16, 16, u * 16, v * 16, 16, 16)
    } catch { /* keep cell transparent; block falls back to invalid texture */ }
  }
  return new TextureAtlas(ctx.getImageData(0, 0, pixelSize, pixelSize), idMap)
}

/**
 * Build a deepslate Resources object from the backend asset bundle.
 */
export async function buildResources(bundle: SchematicAssetsBundle): Promise<Resources> {
  const blockDefinitions: Record<string, BlockDefinition> = {}
  for (const [id, json] of Object.entries(bundle.blockstates)) {
    try {
      blockDefinitions[id] = BlockDefinition.fromJson(json)
    } catch { /* skip malformed */ }
  }
  const blockModels: Record<string, BlockModel> = {}
  for (const [id, json] of Object.entries(bundle.models)) {
    try {
      blockModels[id] = BlockModel.fromJson(json)
    } catch { /* skip malformed */ }
  }
  const modelAccessor = {
    getBlockModel: (id: Identifier | string): BlockModel | null =>
      blockModels[id.toString()] ?? null,
  }
  for (const m of Object.values(blockModels)) m.flatten(modelAccessor)

  const blobs: Record<string, Blob> = {}
  for (const [id, b64] of Object.entries(bundle.textures)) {
    try {
      blobs[id] = textureToBlob(b64)
    } catch { /* skip corrupt */ }
  }
  const atlas = await buildAtlas(blobs)

  return {
    getBlockDefinition(id) {
      return blockDefinitions[id.toString()] ?? null
    },
    getBlockModel(id) {
      return blockModels[id.toString()] ?? null
    },
    getTextureAtlas() {
      return atlas.getTextureAtlas()
    },
    getTextureUV(id) {
      return atlas.getTextureUV(id)
    },
    getBlockFlags(id) {
      return computeFlags(id.toString())
    },
    getBlockProperties() {
      return null
    },
    getDefaultBlockProperties() {
      return null
    },
  }
}

// ---------------------------------------------------------------------------
// Structure building (multi-region, y-slicing, missing-block substitution)
// ---------------------------------------------------------------------------

export interface WorldBox {
  minX: number
  minY: number
  minZ: number
  width: number
  height: number
  depth: number
}

/** Union bounding box (world coords) of all regions. */
export function computeWorldBox(litematic: LitematicFile): WorldBox {
  let minX = Infinity
  let minY = Infinity
  let minZ = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  let maxZ = -Infinity
  for (const r of litematic.regions) {
    const o = r.origin
    minX = Math.min(minX, o.x)
    minY = Math.min(minY, o.y)
    minZ = Math.min(minZ, o.z)
    maxX = Math.max(maxX, o.x + r.size.x - 1)
    maxY = Math.max(maxY, o.y + r.size.y - 1)
    maxZ = Math.max(maxZ, o.z + r.size.z - 1)
  }
  if (litematic.regions.length === 0) {
    minX = minY = minZ = 0
    maxX = maxY = maxZ = 0
  }
  return {
    minX,
    minY,
    minZ,
    width: Math.max(1, maxX - minX + 1),
    height: Math.max(1, maxY - minY + 1),
    depth: Math.max(1, maxZ - minZ + 1),
  }
}

export interface BuildOptions {
  /** Inclusive y-range in *local* region coordinates (layer slicing). */
  yMin?: number
  yMax?: number
  /** Palette names absent from the bundle → substituted with FALLBACK_BLOCK. */
  missing: Set<string>
  /** Abort if total non-air cells exceed this (safety guard). */
  maxBlocks?: number
}

export function buildStructure(
  litematic: LitematicFile,
  bundle: SchematicAssetsBundle,
  box: WorldBox,
  opts: BuildOptions,
): Structure {
  const size: [number, number, number] = [box.width, box.height, box.depth]
  const structure = new Structure(size)
  const yMin = opts.yMin ?? 0
  const yMax = opts.yMax ?? Infinity
  let added = 0
  for (const region of litematic.regions) {
    const w = region.size.x
    const h = region.size.y
    const d = region.size.z
    const px = region.origin.x - box.minX
    const py = region.origin.y - box.minY
    const pz = region.origin.z - box.minZ
    for (let y = Math.max(0, yMin); y <= Math.min(h - 1, yMax); y++) {
      for (let z = 0; z < d; z++) {
        for (let x = 0; x < w; x++) {
          const idx = y * (w * d) + z * w + x
          const paletteIdx = region.blocks[idx]
          if (paletteIdx <= 0 || paletteIdx >= region.palette.length) continue
          let name = region.palette[paletteIdx].name
          const props = region.palette[paletteIdx].properties
          if (!bundle.blockstates[name]) name = FALLBACK_BLOCK
          if (name === 'minecraft:air') continue
          const wx = px + x
          const wy = py + y
          const wz = pz + z
          // Defensive bounds guard: skip cells outside the world box rather than
          // letting deepslate's addBlock throw and nuke the whole structure.
          if (wx < 0 || wy < 0 || wz < 0 || wx >= box.width || wy >= box.height || wz >= box.depth) continue
          structure.addBlock([wx, wy, wz], name, props)
          added++
          if (opts.maxBlocks && added > opts.maxBlocks) throw new Error('TOO_MANY_BLOCKS')
        }
      }
    }
  }
  return structure
}

// ---------------------------------------------------------------------------
// Viewer controller (camera + render loop)
// ---------------------------------------------------------------------------

export interface ViewerCallbacks {
  onFps?: (fps: number) => void
}

export class SchematicViewer {
  private readonly canvas: HTMLCanvasElement
  private readonly gl: WebGLRenderingContext
  private renderer: StructureRenderer | null = null
  private resources: Resources
  private readonly bundle: SchematicAssetsBundle
  private readonly litematic: LitematicFile
  private readonly box: WorldBox
  private readonly missing: Set<string>
  private cameraPos = vec3.create()
  private pitch = 0.8
  private yaw = 0.5
  private rafId = 0
  private disposed = false
  private pressedKeys = new Set<string>()

  constructor(canvas: HTMLCanvasElement, litematic: LitematicFile, bundle: SchematicAssetsBundle, resources: Resources) {
    this.canvas = canvas
    this.litematic = litematic
    this.bundle = bundle
    this.resources = resources
    this.box = computeWorldBox(litematic)
    this.missing = new Set(
      litematic.paletteNames.filter((n) => !bundle.blockstates[n]),
    )
    const gl = canvas.getContext('webgl', { antialias: true })
    if (!gl) throw new Error('WebGL 不可用')
    this.gl = gl
    vec3.set(this.cameraPos, -this.box.width / 2, -this.box.height / 2, -this.box.depth / 2)
    this.rebuild(0, Infinity, { silent: true })
    this.bindControls()
    this.loop()
  }

  private rebuild(yMin: number, yMax: number, opts: { silent?: boolean } = {}) {
    try {
      const structure = buildStructure(this.litematic, this.bundle, this.box, {
        yMin,
        yMax,
        missing: this.missing,
        maxBlocks: undefined,
      })
      if (this.renderer) {
        this.renderer.setStructure(structure)
        this.renderer.updateStructureBuffers()
      } else {
        this.renderer = new StructureRenderer(this.gl, structure, this.resources, { chunkSize: 8 })
        const rect = this.canvas.getBoundingClientRect()
        this.renderer.setViewport(0, 0, Math.max(1, rect.width), Math.max(1, rect.height))
      }
    } catch (e) {
      if (!opts.silent) throw e
    }
  }

  /** Re-slice the structure by local region y-range. */
  setYRange(min: number, max: number) {
    this.rebuild(min, max)
  }

  /**
   * Re-apply the viewport/projection after the canvas drawing buffer changes,
   * so the perspective aspect always matches the buffer (avoids stretching the
   * structure when the surrounding layout resizes the canvas).
   */
  resize() {
    if (!this.renderer) return
    this.renderer.setViewport(0, 0, Math.max(1, this.canvas.width), Math.max(1, this.canvas.height))
  }

  getBox() {
    return this.box
  }

  getMissingBlocks() {
    return Array.from(this.missing)
  }

  private loop = () => {
    if (this.disposed) return
    this.frameKeys()
    this.draw()
    this.rafId = requestAnimationFrame(this.loop)
  }

  private draw() {
    const renderer = this.renderer
    if (!renderer) return
    const gl = this.gl
    gl.viewport(0, 0, this.canvas.width, this.canvas.height)
    gl.clearColor(0.08, 0.09, 0.12, 1)
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT)
    const view = mat4.create()
    mat4.rotateX(view, view, this.pitch)
    mat4.rotateY(view, view, this.yaw)
    mat4.translate(view, view, this.cameraPos)
    renderer.drawStructure(view)
    renderer.drawGrid(view)
  }

  private bindControls() {
    const canvas = this.canvas
    let leftPos: [number, number] | null = null
    let middlePos: [number, number] | null = null

    canvas.addEventListener('mousedown', (evt) => {
      if (evt.button === 0) {
        evt.preventDefault()
        leftPos = [evt.clientX, evt.clientY]
      } else if (evt.button === 1) {
        evt.preventDefault()
        middlePos = [evt.clientX, evt.clientY]
      }
    })
    canvas.addEventListener('contextmenu', (evt) => evt.preventDefault())
    canvas.addEventListener('mousemove', (evt) => {
      if (middlePos) {
        const dx = evt.clientX - middlePos[0]
        const dy = evt.clientY - middlePos[1]
        this.yaw += dx / 200
        this.pitch = Math.max(-Math.PI / 2, Math.min(Math.PI / 2, this.pitch + dy / 200))
        middlePos = [evt.clientX, evt.clientY]
      } else if (leftPos) {
        this.pan(evt.clientX - leftPos[0], evt.clientY - leftPos[1])
        leftPos = [evt.clientX, evt.clientY]
      }
    })
    const up = (evt: MouseEvent) => {
      if (evt.button === 0) leftPos = null
      else if (evt.button === 1) middlePos = null
    }
    canvas.addEventListener('mouseup', up)
    canvas.addEventListener('mouseleave', () => {
      leftPos = null
      middlePos = null
    })
    canvas.addEventListener('wheel', (evt) => {
      evt.preventDefault()
      this.move3d([0, 0, -evt.deltaY / 120])
    })

    const keyMoves: Record<string, [number, number, number]> = {
      KeyW: [0, 0, 0.4],
      KeyS: [0, 0, -0.4],
      KeyA: [0.4, 0, 0],
      KeyD: [-0.4, 0, 0],
      ArrowUp: [0, 0, 0.4],
      ArrowDown: [0, 0, -0.4],
      ArrowLeft: [0.4, 0, 0],
      ArrowRight: [-0.4, 0, 0],
      ShiftLeft: [0, 0.4, 0],
      Space: [0, -0.4, 0],
    }
    const onKeyDown = (evt: KeyboardEvent) => {
      if (evt.code in keyMoves) evt.preventDefault()
      this.pressedKeys.add(evt.code)
    }
    const onKeyUp = (evt: KeyboardEvent) => this.pressedKeys.delete(evt.code)
    const onBlur = () => this.pressedKeys.clear()
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('keyup', onKeyUp)
    window.addEventListener('blur', onBlur)

    this.disposers.push(() => {
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('keyup', onKeyUp)
      window.removeEventListener('blur', onBlur)
    })
  }

  private disposers: Array<() => void> = []

  private move3d(direction: [number, number, number]) {
    const offset = vec3.create()
    vec3.set(offset, direction[0], direction[1], direction[2])
    vec3.rotateX(offset, offset, [0, 0, 0], -this.pitch)
    vec3.rotateY(offset, offset, [0, 0, 0], -this.yaw)
    vec3.add(this.cameraPos, this.cameraPos, offset)
  }

  private pan(dx: number, dy: number) {
    const offset = vec3.create()
    vec3.set(offset, dx / 90, -dy / 90, 0)
    vec3.rotateX(offset, offset, [0, 0, 0], -this.pitch)
    vec3.rotateY(offset, offset, [0, 0, 0], -this.yaw)
    vec3.add(this.cameraPos, this.cameraPos, offset)
  }

  private frameKeys() {
    if (this.pressedKeys.size === 0) return
    const keyMoves: Record<string, [number, number, number]> = {
      KeyW: [0, 0, 0.4],
      KeyS: [0, 0, -0.4],
      KeyA: [0.4, 0, 0],
      KeyD: [-0.4, 0, 0],
      ArrowUp: [0, 0, 0.4],
      ArrowDown: [0, 0, -0.4],
      ArrowLeft: [0.4, 0, 0],
      ArrowRight: [-0.4, 0, 0],
      ShiftLeft: [0, 0.4, 0],
      Space: [0, -0.4, 0],
    }
    const direction = vec3.create()
    for (const key of this.pressedKeys) {
      const m = keyMoves[key]
      if (m) vec3.add(direction, direction, m)
    }
    this.move3d([direction[0], direction[1], direction[2]])
  }

  dispose() {
    this.disposed = true
    cancelAnimationFrame(this.rafId)
    for (const d of this.disposers) d()
    this.renderer = null
  }
}