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
  /** 候选版本所属发布列车（release | beta | alpha） */
  channel?: string
  /**
   * true = 跨通道更新（用户在设置里主动切换了通道）。
   * UI 必须把这种情况标注为"切换通道"，否则用户会误以为是普通版本升级。
   */
  channelSwitch?: boolean
  /**
   * hasUpdate=false 的原因（诊断用）：dev-build | up-to-date |
   * channel-mismatch | not-newer | no-version。
   */
  reason?: string
}

/**
 * 查询本机更新计划（os/arch/mode 由后端检测）。
 *
 * `channel` 不传时由后端回落到"已安装构建所属列车"——这正是修复的关键：
 * 旧前端硬编码 `|| 'stable'`，导致 beta/alpha/开发构建全被按稳定通道请求。
 * 204 → hasUpdate=false
 */
export async function fetchUpdatePlan(channel?: string): Promise<UpdatePlan> {
  const q = channel ? `?channel=${encodeURIComponent(channel)}` : ''
  const res = await get<UpdatePlan | undefined>(`/update/plan${q}`)
  return res ?? { hasUpdate: false }
}
