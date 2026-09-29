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

/** Tauri 壳 `run_updater` 写下的「更新完成交接文件」内容（读后即删）。 */
export interface UpdateNotice {
  /** 更新目标版本（与当前运行版本一致才应展示，见 App.tsx 版本守卫） */
  version: string
  /** 更新前版本 */
  previousVersion: string
  /** 该版本 changelog（markdown 原文） */
  changelog: string
  /** 写入时间（unix 秒） */
  updatedAt: number
}

/**
 * 读取并消费「本次启动是刚更新完的」交接文件（`take_pending_update_notice`，
 * 读后即删，只提示一次）。
 *
 * 非 Tauri 环境（浏览器 dev）/任何失败 → null：更新提示是尽力而为的附加
 * 体验，不能影响启动。调用方还须校验 `notice.version` 与当前运行版本一致
 * （更新实际未落地时不弹窗）。
 */
export async function takeUpdateNotice(dataDir: string): Promise<UpdateNotice | null> {
  if (!dataDir) return null
  try {
    const { invoke } = await import('@tauri-apps/api/core')
    return await invoke<UpdateNotice | null>('take_pending_update_notice', { dataDir })
  } catch {
    return null
  }
}
