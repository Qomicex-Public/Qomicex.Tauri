import { get } from './client.ts'

export async function lookupChineseName(name: string): Promise<string | null> {
  try {
    const res = await get<{ cn_name: string | null }>(`/mcmod/lookup?name=${encodeURIComponent(name)}`)
    return res.cn_name
  } catch { return null }
}

export async function batchLookupChineseNames(names: string[]): Promise<Record<string, string | null>> {
  if (names.length === 0) return {}
  try {
    return await fetch('/api/mcmod/batch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(names),
    }).then(r => r.json())
  } catch { return {} }
}
