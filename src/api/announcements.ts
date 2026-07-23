// src/api/announcements.ts
import { APP_INFO } from '../constants/credits.ts'
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

/** 从 APP_INFO.version 提取渠道标识 */
function resolveChannel(): string | undefined {
  const v = APP_INFO.version.toLowerCase()
  if (v.includes('release')) return 'release'
  if (v.includes('beta')) return 'beta'
  if (v.includes('alpha')) return 'alpha'
  return undefined // dev → 不带 channel，服务端返回所有
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
