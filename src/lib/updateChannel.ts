// src/lib/updateChannel.ts
//
// 启动器版本 → 发布通道（train）的唯一解析源。
//
// 背景见 `src-backend/qomicex-backend/src/services/update_channel.rs`：每条
// 通道是独立的发布列车，序数各自计数（`beta31.0` vs `release1.0` 的 31/1
// 不可比），因此"是否更新"必须按通道裁决，不能跨通道比版本号。
//
// 本模块同时消除 `src/api/announcements.ts` 里那套重复且同样错误的解析
// （它把任何含 `-` 的版本都算 beta，正式版 `-release5.0` 被误判为测试版）。

/** 发布列车。与后端 `Train` / 上游 `trainOf` 对齐。 */
export type UpdateTrain = 'release' | 'beta' | 'alpha' | 'dev' | 'unknown'

/** 设置页通道选择器的持久化键。 */
export const UPDATE_CHANNEL_KEY = 'update-channel'

const TRAIN_RE = /-(alpha|beta|release)(\d+)/i

/**
 * 版本号 → 所属列车。
 *
 * - `0.1.0-release1.0` → `release`
 * - `0.1.0-beta31.0` → `beta`
 * - `0.1.0-alpha20260823.0`（含 legacy `alpha260719.build3`）→ `alpha`
 * - `0.1.0`（无后缀）→ `dev`：本地构建，不属于任何已发布列车
 * - 其它（`-rc1` 等）→ `unknown`
 */
export function trainOf(version: string): UpdateTrain {
  const v = (version || '').trim().replace(/^v/i, '')
  const dash = v.indexOf('-')
  if (dash === -1) return 'dev'
  const m = v.slice(dash + 1).match(TRAIN_RE)
  if (!m) return 'unknown'
  const t = m[1].toLowerCase()
  return t === 'alpha' || t === 'beta' || t === 'release' ? t : 'unknown'
}

/** 是否为本地开发构建（不检查更新）。 */
export function isDevBuild(version: string): boolean {
  return trainOf(version) === 'dev'
}

/**
 * 读取用户显式选择的通道（localStorage）。
 *
 * 只在值合法时返回，避免历史脏数据（如 `nightly`）把请求带偏。
 */
function storedChannel(): string | undefined {
  try {
    const v = localStorage.getItem(UPDATE_CHANNEL_KEY)
    return v === 'stable' || v === 'beta' || v === 'alpha' ? v : undefined
  } catch {
    return undefined
  }
}

/**
 * 解析本次更新检查应使用的通道。
 *
 * 优先级：用户显式选择 > 已安装构建所属列车。
 * 返回 `undefined` = 不检查更新（开发构建/无法识别，且用户未显式选择）。
 *
 * 修复点：旧代码是 `localStorage.getItem('update-channel') || 'stable'`，
 * 默认硬编码稳定通道，导致 beta/alpha/开发构建一律按 stable 请求，全被
 * 推去 release。
 */
export function resolveChannel(version: string): string | undefined {
  const stored = storedChannel()
  if (stored) return stored
  const train = trainOf(version)
  return train === 'release' || train === 'beta' || train === 'alpha' ? train : undefined
}

/** 通道的 i18n key（设置页徽章 / 更新弹窗用）。 */
export function trainLabelKey(train: UpdateTrain): string {
  switch (train) {
    case 'release':
      return 'settings.about.stable'
    case 'beta':
      return 'settings.about.beta'
    case 'alpha':
      return 'settings.about.alpha'
    case 'dev':
      return 'settings.about.devBuild'
    case 'unknown':
      // 不能回落 stable：无法识别的 pre-release 后缀（如 `-rc1`）显示成
      // "稳定版"会与解析结果矛盾，并让用户误以为跑在稳定通道上。
      return 'settings.about.unknownBuild'
  }
}
