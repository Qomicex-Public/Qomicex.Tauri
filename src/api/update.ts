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

/** 后端 /api/update/plan 响应：一体化更新计划（无更新时 hasUpdate=false） */
export interface UpdatePlan {
  hasUpdate: boolean
  version?: string
  /** dir | appimage | app | system — Qomicex.Updater 安装策略 */
  strategy?: string
  /** 文件布局 zip 更新包 URL（已套代理竞速） */
  packageUrl?: string
  /** minisign 签名（armor 文本） */
  signature?: string
  changelog?: string
  required?: boolean
}

/** 查询指定版本是否有强制更新（走本地后端 /api/update/check，镜像 C# 逻辑） */
export function checkRequired(current: string, channel: string): Promise<UpdateCheckResult> {
  return get<UpdateCheckResult>(
    `/update/check?current=${encodeURIComponent(current)}&channel=${encodeURIComponent(channel)}`,
  )
}

/** 查询本机更新计划（os/arch/mode 由后端检测，前端零传参）。204 → hasUpdate=false */
export async function fetchUpdatePlan(): Promise<UpdatePlan> {
  const res = await get<UpdatePlan | undefined>('/update/plan')
  return res ?? { hasUpdate: false }
}
