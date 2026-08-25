// 极简 ZIP 读写（无依赖）：node:zlib deflateRaw + 手写 CRC32/目录结构。
// 仅覆盖 .qplugin 需要的子集：无加密、无目录条目、UTF-8 文件名、deflate/存储。
import { deflateRawSync, inflateRawSync } from 'node:zlib'

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

export function crc32(data: Uint8Array): number {
  let crc = 0xffffffff
  for (let i = 0; i < data.length; i++) {
    crc = CRC_TABLE[(crc ^ data[i]!) & 0xff]! ^ (crc >>> 8)
  }
  return (crc ^ 0xffffffff) >>> 0
}

function u16(n: number): Uint8Array {
  return new Uint8Array([n & 0xff, (n >>> 8) & 0xff])
}

function u32(n: number): Uint8Array {
  return new Uint8Array([n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff])
}

function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((s, p) => s + p.length, 0)
  const out = new Uint8Array(total)
  let off = 0
  for (const p of parts) {
    out.set(p, off)
    off += p.length
  }
  return out
}

export interface ZipEntry {
  name: string
  data: Uint8Array
}

export function zipWrite(files: ZipEntry[]): Uint8Array {
  const locals: Uint8Array[] = []
  const central: Uint8Array[] = []
  let offset = 0
  const UTF8_FLAG = 0x0800

  for (const file of files) {
    const nameBytes = new TextEncoder().encode(file.name)
    const comp = deflateRawSync(file.data)
    const crc = crc32(file.data)
    const method = file.data.length === 0 ? 0 : 8

    locals.push(
      u32(0x04034b50),
      u16(20),              // version needed
      u16(UTF8_FLAG),       // flags
      u16(method),
      u16(0), u16(0),       // mod time/date
      u32(crc),
      u32(comp.length),
      u32(file.data.length),
      u16(nameBytes.length),
      u16(0),               // extra len
      nameBytes,
      method === 8 ? comp : file.data,
    )

    central.push(
      u32(0x02014b50),
      u16(0x0314),          // version made by (unix)
      u16(20),
      u16(UTF8_FLAG),
      u16(method),
      u16(0), u16(0),
      u32(crc),
      u32(comp.length),
      u32(file.data.length),
      u16(nameBytes.length),
      u16(0), u16(0),       // extra / comment len
      u16(0), u16(0),       // disk start / internal attrs
      u32(0),               // external attrs
      u32(offset),
      nameBytes,
    )
    offset += 30 + nameBytes.length + (method === 8 ? comp.length : file.data.length)
  }

  const cdBytes = concat(central)
  const cdOffset = offset
  const eocd = concat([
    u32(0x06054b50),
    u16(0), u16(0),
    u16(files.length), u16(files.length),
    u32(cdBytes.length),
    u32(cdOffset),
    u16(0),
  ])

  return concat([...locals, cdBytes, eocd])
}

interface CentralEntry {
  name: string
  method: number
  compSize: number
  size: number
  localOffset: number
}

function findEocd(bytes: Uint8Array): number {
  const maxBack = Math.min(bytes.length, 65557)
  for (let i = bytes.length - 22; i >= bytes.length - maxBack; i--) {
    if (bytes[i] === 0x50 && bytes[i + 1] === 0x4b && bytes[i + 2] === 0x05 && bytes[i + 3] === 0x06) {
      return i
    }
  }
  throw new Error('不是有效的 zip 包（缺少 EOCD）')
}

function readCentral(bytes: Uint8Array): CentralEntry[] {
  const eocd = findEocd(bytes)
  const count = bytes[eocd + 10]! | (bytes[eocd + 11]! << 8)
  const cdOffset = bytes[eocd + 16]! | (bytes[eocd + 17]! << 8) | (bytes[eocd + 18]! << 16) | (bytes[eocd + 19]! << 24)
  const entries: CentralEntry[] = []
  let p = cdOffset
  for (let i = 0; i < count; i++) {
    if (bytes[p] !== 0x50 || bytes[p + 1] !== 0x4b || bytes[p + 2] !== 0x01 || bytes[p + 3] !== 0x02) {
      throw new Error('zip 中央目录解析失败')
    }
    const method = bytes[p + 10]! | (bytes[p + 11]! << 8)
    const compSize = bytes[p + 20]! | (bytes[p + 21]! << 8) | (bytes[p + 22]! << 16) | (bytes[p + 23]! << 24)
    const size = bytes[p + 24]! | (bytes[p + 25]! << 8) | (bytes[p + 26]! << 16) | (bytes[p + 27]! << 24)
    const nameLen = bytes[p + 28]! | (bytes[p + 29]! << 8)
    const extraLen = bytes[p + 30]! | (bytes[p + 31]! << 8)
    const commentLen = bytes[p + 32]! | (bytes[p + 33]! << 8)
    const localOffset = bytes[p + 42]! | (bytes[p + 43]! << 8) | (bytes[p + 44]! << 16) | (bytes[p + 45]! << 24)
    const name = new TextDecoder().decode(bytes.subarray(p + 46, p + 46 + nameLen))
    entries.push({ name, method, compSize, size, localOffset })
    p += 46 + nameLen + extraLen + commentLen
  }
  return entries
}

export function zipRead(bytes: Uint8Array): Record<string, Uint8Array> {
  const out: Record<string, Uint8Array> = {}
  for (const e of readCentral(bytes)) {
    if (e.name.endsWith('/')) continue
    const p = e.localOffset
    const nameLen = bytes[p + 26]! | (bytes[p + 27]! << 8)
    const extraLen = bytes[p + 28]! | (bytes[p + 29]! << 8)
    const dataStart = p + 30 + nameLen + extraLen
    const raw = bytes.subarray(dataStart, dataStart + e.compSize)
    let data: Uint8Array
    if (e.method === 0) {
      data = raw
    } else if (e.method === 8) {
      data = inflateRawSync(raw)
    } else {
      throw new Error(`不支持的 zip 压缩方式: ${e.method} (${e.name})`)
    }
    out[e.name] = data
  }
  return out
}
