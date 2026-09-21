// src/api/announcements.ts
import { APP_INFO } from '../constants/credits.ts'
import { trainOf } from '../lib/updateChannel.ts'
import { get } from './client.ts'

const API_PATH = '/client/announcements'
const DISMISS_KEY = 'dismissed-announcements'

export interface Announcement {
  id: string
  title: string
  content: string
  channel: string | null
  createdAt: string
}

/**
 * 公告通道过滤：复用 `src/lib/updateChannel.ts` 的唯一版本→列车解析。
 *
 * 旧实现是本地一套 `includes('release'|'beta'|'alpha')` 判定，与更新检测的
 * 通道口径可能不一致；且 dev 构建（裸 X.Y.Z）返回 undefined 让服务端返回
 * 全部公告，这里保持同样语义。
 */
function resolveChannel(): string | undefined {
  const train = trainOf(APP_INFO.version)
  return train === 'release' || train === 'beta' || train === 'alpha' ? train : undefined
}

/** 获取已关闭的公告 id 列表 */
function getDismissed(): string[] {
  try {
    const raw = localStorage.getItem(DISMISS_KEY)
    return raw ? JSON.parse(raw) : []
  } catch {
    return []
  }
}

/** 关闭一条公告 */
export function dismissAnnouncement(id: string): void {
  const dismissed = getDismissed()
  if (!dismissed.includes(id)) {
    dismissed.push(id)
    localStorage.setItem(DISMISS_KEY, JSON.stringify(dismissed))
  }
  // 同步更新缓存，移除已关闭的公告
  if (cache) {
    cache = cache.filter((a) => a.id !== id)
  }
}

// 模块级缓存（启动时加载一次，之后只读缓存）
let cache: Announcement[] | null = null

/** 获取公告列表（启动时请求一次，后续全部从缓存读取） */
export async function fetchAnnouncements(): Promise<Announcement[]> {
  if (cache) return cache

  try {
    const channel = resolveChannel()
    const path = channel
      ? `${API_PATH}?channel=${encodeURIComponent(channel)}`
      : API_PATH
    const data = await get<Announcement[]>(path)
    if (!Array.isArray(data)) return []
    const dismissed = new Set(getDismissed())
    cache = data.filter((a) => !dismissed.has(a.id))
    return cache
  } catch {
    return cache ?? []
  }
}
