import { API_BASE } from './client.ts'
import type { WorldInfo, WorldBlockInfo } from '../types/index.ts'

/**
 * 打开实例下的一个存档，后端返回世界元信息（维度 / 玩家 / 路径点 / 种子）。
 * `key` 参与瓦片 URL 与缓存键，后端会校验它与当前会话一致。
 */
export function openWorld(
  instanceId: string,
  name: string,
  key: string,
): Promise<{ key: string; info: WorldInfo }> {
  return postJson(`/instance/${instanceId}/world/open`, { name, key })
}

/** 关闭会话并释放后端的区块缓存。 */
export async function closeWorld(instanceId: string): Promise<void> {
  await fetch(`${API_BASE}/instance/${instanceId}/world/close`, { method: 'POST' })
}

async function postJson<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    let message = `请求失败 (${res.status})`
    let code = 'WORLD_REQUEST_FAILED'
    try {
      const json = await res.json()
      if (json && typeof json.message === 'string') {
        message = json.message
        code = typeof json.code === 'string' ? json.code : code
      }
    } catch { /* 非 JSON 响应，保留默认信息 */ }
    throw new WorldApiError(code, message, res.status)
  }
  return (await res.json()) as T
}

/** 世界预览接口的结构化错误（与 ApiError 同形，但走原生 fetch 以复用自定义头）。 */
export class WorldApiError extends Error {
  readonly code: string
  readonly status: number
  constructor(code: string, message: string, status: number) {
    super(message)
    this.name = 'WorldApiError'
    this.code = code
    this.status = status
  }
}

/**
 * 瓦片 URL 模板。`key` 段让浏览器缓存与前端缓存按存档隔离——否则切换存档后
 * 会继续复用上一个世界的地图。
 *
 * `maxY` 是该维度自身的高度天花板：1.20+ 主世界到 Y=319，固定用 255 判断
 * 「全高」会把顶部方块误判成需要过滤。
 */
export function tileUrlTemplate(
  instanceId: string,
  key: string,
  dim: number,
  ymax: number,
  maxY: number,
): string {
  const yPart = ymax >= maxY ? '4294967295' : String(ymax)
  return `${API_BASE}/instance/${instanceId}/world/tile/${key}/${dim}/{z}/{x}/{y}?ymax=${yPart}`
}

/**
 * 探测某个世界列最顶层的非空气方块（状态栏悬停显示 Y 与方块名）。
 *
 * 地图是二维平面，方块 Y 不在平面内，前端推不出来，只能问后端。
 */
export async function probeBlock(
  instanceId: string,
  key: string,
  dim: number,
  x: number,
  z: number,
  ymax: number,
  maxY: number,
): Promise<WorldBlockInfo> {
  const yPart = ymax >= maxY ? '4294967295' : String(ymax)
  const path =
    `/instance/${instanceId}/world/probe/${key}/${dim}/${x}/${z}?ymax=${yPart}`
  const res = await fetch(`${API_BASE}${path}`)
  if (!res.ok) throw new WorldApiError('WORLD_PROBE_FAILED', `探测失败 (${res.status})`, res.status)
  return (await res.json()) as WorldBlockInfo
}

/**
 * 存档路径 → 短且文件系统安全的键。
 * 与后端 `all_saves_smoke::tile_path_carries_a_world_key` 的镜像实现保持一致
 * （32 位回绕哈希 + base36），两端不能各自漂移。
 */
export function worldKeyOf(savePath: string): string {
  let h = 0
  for (let i = 0; i < savePath.length; i++) {
    h = (Math.imul(31, h) + savePath.charCodeAt(i)) | 0
  }
  return 'w' + (h >>> 0).toString(36)
}
