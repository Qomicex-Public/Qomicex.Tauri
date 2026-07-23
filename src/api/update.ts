import { get } from './client.ts'

export interface UpdateCheckResult {
  hasUpdate: boolean
  version?: string
  type?: 'release' | 'beta' | 'alpha'
  required: boolean
  title?: string
  changelog?: string
  downloadUrl?: string
}

const CHANNEL_TYPES: Record<string, string[]> = {
  stable: ['release'],
  beta: ['release', 'beta'],
  alpha: ['release', 'beta', 'alpha'],
}

export async function checkUpdate(channel: string): Promise<UpdateCheckResult> {
  const result = await get<UpdateCheckResult>(`/update/check?current=${__APP_VERSION__}&channel=${channel}`)
  if (!result.hasUpdate || !result.type) return result

  const accepted = CHANNEL_TYPES[channel] ?? CHANNEL_TYPES.stable
  if (!accepted.includes(result.type)) {
    return { hasUpdate: false, required: false }
  }

  return result
}
