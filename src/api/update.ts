import { get } from './client.ts'

/** 后端 /api/update/check 响应（含 required 强制更新标记） */
export interface UpdateCheckResult {
  hasUpdate: boolean
  version?: string
  type?: string
  required: boolean
  title?: string
  changelog?: string
  downloadUrl?: string
}

/** 查询指定版本是否有强制更新（走本地后端 /api/update/check，镜像 C# 逻辑） */
export function checkRequired(current: string, channel: string): Promise<UpdateCheckResult> {
  return get<UpdateCheckResult>(
    `/update/check?current=${encodeURIComponent(current)}&channel=${encodeURIComponent(channel)}`,
  )
}
