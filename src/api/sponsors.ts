// src/api/sponsors.ts
import { get } from './client.ts'

export interface Sponsor {
  name: string
  avatar: string
  amount: string
  plan: string
}

/** 获取赞助者鸣谢列表（后端代理爱发电，按累计金额降序）。 */
export function fetchSponsors(): Promise<Sponsor[]> {
  return get<Sponsor[]>('/client/sponsors').then((data) =>
    Array.isArray(data) ? data : [],
  )
}
