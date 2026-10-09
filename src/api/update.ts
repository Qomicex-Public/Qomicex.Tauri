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

/**
 * Qomicex.Updater 落盘的「这次更新没成」交接（`{dataDir}/updates/last-update-error.json`）。
 *
 * 存在理由（issue #201）：updater 是 detached 进程，它失败退出时旧启动器早已退出，
 * 屏幕上不会留下任何痕迹——用户的描述是「点了更新，既没重启也没更新完成」。
 * 由新进程读出来告诉他到底卡在哪一步，比让他自己猜强。
 */
export interface UpdateError {
  /**
   * 机器可读码，UI 按它取多语言文案：
   * `ELEVATION_DENIED`（授权被取消/不可用）| `UPDATE_INSTALL_FAILED`（覆盖失败）|
   * `UPDATE_WAIT_TIMEOUT`（旧进程没退出）。
   */
  code: string
  /** 技术细节（OS 报错原文，可能含路径与引号），只做次要展示 */
  message: string
  /** 安装策略：dir | appimage | app | system */
  strategy: string
  /** 本次要更新到的版本（由包文件名反推，可能是空串） */
  version: string
  /** 写入时间（unix 秒），仅诊断用 */
  occurredAt: number
}

/**
 * 读取并消费「更新失败」交接（`take_pending_update_error`，读后即删，只提示一次）。
 *
 * 与 `takeUpdateNotice` 的两点差别：
 * - **不做版本守卫**：失败交接讲的正是「版本没前进」，拿当前版本比对会把它自己过滤掉；
 * - 与「更新完成」交接各有独立的 claim 锁，两条提示不会互相挡住。
 *
 * 非 Tauri 环境（浏览器 dev）/任何失败 → null：附加体验，不影响启动。
 */
export async function takeUpdateError(dataDir: string): Promise<UpdateError | null> {
  if (!dataDir) return null
  try {
    const { invoke } = await import('@tauri-apps/api/core')
    return await invoke<UpdateError | null>('take_pending_update_error', { dataDir })
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// 自动更新：静默下载 → 待安装 → 下次启动自动装完
// ---------------------------------------------------------------------------

/**
 * 已下载完成、等待安装的更新记录（`{dataDir}/updates/update-auto-install.json`）。
 *
 * 与上面的 `UpdateNotice` 方向相反：那个是更新**完成后**的交接，这个是更新
 * **开始前**的交接。落盘在壳侧（不在 localStorage）的原因见
 * `src-tauri/src/updater.rs` 的模块注释——核心是「下次打开自动装完」必须跨进程
 * 存活，且必须与更新包同目录，避免 dataDir 变更后记录与包错配。
 */
export interface PendingUpdateInstall {
  /** 目标版本（无 v 前缀 semver） */
  version: string
  /** 已下载的更新包绝对路径 */
  packagePath: string
  /** minisign 签名原文 */
  signature: string
  /** 该版本 changelog（markdown 原文） */
  changelog: string
  /** 已尝试安装次数（壳侧在 spawn updater 前递增） */
  attempts: number
  /**
   * 该包所属发布列车（release | beta | alpha）。缺失 = 旧版记录没带通道。
   *
   * 用途：跨列车不得自动安装（ADR-085）——用户在下载完成后可能又切了通道，
   * 此时这份包已不属于当前列车，静默装上就是一次跨列车更新。
   */
  channel?: string
}

/** 自动更新状态（只读查询，供前端决定是否需要走自动下载流程）。 */
export interface AutoInstallState {
  /** 是否已有下载完成、等待安装的记录（对应 `pending` 存在） */
  hasPending: boolean
  /** 因重试超限作废的版本：该版本不再自动安装，回退弹窗 */
  abandonedVersion?: string
  /**
   * 待安装记录本身（只读 peek，不推进壳侧重试计数）。
   *
   * 用途：本次启动决定**不立刻安装**（有实例在跑，推迟到下次）时，把已下好的
   * 更新提示恢复出来——否则那个包在本会话里完全不可见。
   */
  pending?: PendingUpdateInstall
}

/**
 * `take_pending_update_install` 的结果状态：
 * - `ready`：可安装（`install` 必存在）
 * - `installed`：当前运行版本已是目标版本（记录已清，**不得**重复安装）
 * - `missing`：更新包已不在（记录作废，可重新下载；不算失败重试）
 * - `abandoned`：重试超限已作废（回退弹窗）
 * - `unpersisted`：尝试计数写不进盘 → 壳侧拒绝无人值守安装（回退弹窗，保留手动入口）
 * - `none`：无记录
 */
export interface AutoInstallTake {
  status: 'ready' | 'installed' | 'missing' | 'abandoned' | 'unpersisted' | 'none'
  version?: string
  install?: PendingUpdateInstall
}

/** 空 dataDir（设置尚未加载完）→ 视为无待安装记录。 */
const EMPTY_AUTO_STATE: AutoInstallState = { hasPending: false }

/**
 * 只读查询自动更新状态（是否有待安装记录 / 哪个版本已作废）。
 *
 * **IPC 失败必须抛出，不能吞成 EMPTY_AUTO_STATE**：调用方
 * `resolveAutoInstallPlan` 用「查询失败 → 回退更新对话框」兜底，把失败伪装成
 * 「没有待安装记录」会让它以为可以安全走自动下载（随后 autoStart 静默失败），
 * 于是既没有对话框也没有 Toast——用户什么也看不到。抛出才能触发那条回退分支。
 *
 * 只有空 dataDir（设置未加载完，此时连 updates 目录都拼不出来）按无记录处理。
 */
export async function fetchAutoInstallState(dataDir: string): Promise<AutoInstallState> {
  if (!dataDir) return EMPTY_AUTO_STATE
  const { invoke } = await import('@tauri-apps/api/core')
  return await invoke<AutoInstallState>('update_auto_install_state', { dataDir })
}

/**
 * 自动下载完成后落「待安装」记录。
 *
 * 抛错由调用方决定如何处理：写不进去只意味着丢掉「下次启动自动装完」这一附加
 * 能力，本次会话内仍可直接安装，因此调用方只记 warn、不弹错。
 */
export async function stagePendingInstall(
  dataDir: string,
  install: Omit<PendingUpdateInstall, 'attempts'>,
): Promise<void> {
  const { invoke } = await import('@tauri-apps/api/core')
  await invoke('stage_pending_update_install', {
    dataDir,
    packagePath: install.packagePath,
    signature: install.signature,
    version: install.version,
    changelog: install.changelog,
    channel: install.channel,
  })
}

/**
 * 消费待安装记录（读后按结果写回：递增尝试数 / 清记录 / 记作废版本）。
 *
 * **IPC 失败必须抛出**（与 `fetchAutoInstallState` 同理）：调用方
 * `installStagedOnLaunch` 只在 `ready` 时装，把失败伪装成 `none` 会让它以为
 * 「没有待安装记录」而静默返回——用户既看不到更新对话框，也没有任何提示，更新
 * 就此永久卡住。抛出后由调用方明确区分「无记录」与「读不出来」：后者记 warn 并
 * 让后台检查（`resolveAutoInstallPlan`）走它自己的回退分支。
 *
 * 只有空 dataDir（设置尚未加载完，连 updates 目录都拼不出来）按 `none` 处理。
 */
export async function takePendingInstall(dataDir: string): Promise<AutoInstallTake> {
  if (!dataDir) return { status: 'none' }
  const { invoke } = await import('@tauri-apps/api/core')
  const res = await invoke<AutoInstallTake>('take_pending_update_install', { dataDir })
  return res ?? { status: 'none' }
}

/** 清除待安装记录与作废标记（用户选择稍后 / 手动安装后 / 已作废提示过后）。 */
export async function clearPendingInstall(dataDir: string): Promise<void> {
  if (!dataDir) return
  try {
    const { invoke } = await import('@tauri-apps/api/core')
    await invoke('clear_pending_update_install', { dataDir })
  } catch {
    // 尽力而为
  }
}
