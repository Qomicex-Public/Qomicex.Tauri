import { get, post } from './client.ts'

/** `/mcmod/lookup` 响应：中文名 + mcmod.cn 词条 id（任一可能为 null）。 */
export interface McmodLookupResult {
  cnName: string | null
  /** mcmod.cn `/class/{id}` 的词条 id；未收录 / 无 id 时为 null。 */
  mcmodId: number | null
}

/**
 * 查询单条 mcmod 词条（中文名 + 词条 id）。
 * 网络失败与「未收录」都返回全 null：调用方一律按「没查到」处理，不区分。
 */
export async function lookupChineseEntry(name: string): Promise<McmodLookupResult> {
  try {
    const res = await get<{ cnName: string | null; mcmodId?: number | null }>(
      `/mcmod/lookup?name=${encodeURIComponent(name)}`
    )
    return {
      cnName: res.cnName ?? null,
      // 后端新增字段；旧后端不带该字段时按「无 id」处理（不渲染跳转入口）。
      mcmodId: typeof res.mcmodId === 'number' && res.mcmodId > 0 ? res.mcmodId : null,
    }
  } catch { return { cnName: null, mcmodId: null } }
}

export async function lookupChineseName(name: string): Promise<string | null> {
  return (await lookupChineseEntry(name)).cnName
}

export async function batchLookupChineseNames(names: string[]): Promise<Record<string, string | null>> {
  if (names.length === 0) return {}
  try {
    return await post<Record<string, string | null>>('/mcmod/batch', names)
  } catch { return {} }
}
