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

/**
 * pre-release 首段（`.` 分隔的第一段）的「类型名 + 序数」：`beta32` / `release1` /
 * `alpha20260823`；legacy `alpha260719.build3` 的首段即 `alpha260719`，
 * 点号 legacy（`alpha.build3`）的首段是 `alpha`。
 *
 * **不能带前导 `-`**：调用方喂进来的是已 `slice(dash + 1)` 去掉 `-` 的串，
 * 带 `-` 会恒不匹配（旧实现正是如此，见 `trainOf` 内的注释）。
 * 与后端 `services/update_channel.rs::parse_type_segment` 逐条对齐：
 * - `/i`：后端先 `to_ascii_lowercase`，因此 `Beta1` / `ALPHA1` 同样识别
 *   （`m[1].toLowerCase()` 依赖这个 flag，不能去掉）；
 * - 类型名后**为空或紧跟数字**即可，不要求数字延续到段尾：后端
 *   `first_number_run` 吃得下的 `beta32foo` / `beta1-hotfix` /
 *   git-describe 形态 `beta12-3-gabcdef` 在这里同样是 beta；
 * - 类型名后是其它字符（`beta-x` / `betamax` / `rc1`）→ unknown，与后端一致。
 */
const TYPE_SEGMENT_RE = /^(alpha|beta|release)(?:\d|$)/i

/**
 * 版本号 → 所属列车。与后端 `train_of`（进而 `parse_train_version`）逐条对齐。
 *
 * - `0.1.0-release1.0` → `release`
 * - `0.1.0-beta31.0` → `beta`
 * - `0.1.0-alpha20260823.0`（含 legacy `alpha260719.build3`）→ `alpha`
 * - `0.1.0`（无后缀）→ `dev`：本地构建，不属于任何已发布列车
 * - 核心段非数字或为空（`1.0.x` / `''` / 连核心段都没有的 `-rc1`）→ `unknown`：
 *   后端 `parse_train_version` 同样解析失败，前端不能把它们当 dev（否则会把
 *   "未知构建"降级显示成"开发构建"）
 * - 其它 pre-release 后缀（如 `0.1.0-rc2`）→ `unknown`
 * - 大写前缀 `V1.0.0-beta1.0` → `unknown`：后端 `strip_v` 只剥小写 `v`，核心段
 *   `V1.0.0` 非数字而解析失败（前端必须与后端同结论，见下）
 */
export function trainOf(version: string): UpdateTrain {
  // `v+`：与后端 `strip_v`（`trim_start_matches('v')`）逐条对齐 —— 连续前缀全剥，
  // 但**只剥小写 `v`**，所以这里不能带 `/i`。带 `/i` 会把 `V1.0.0-beta1.0` 剥成
  // `1.0.0-beta1.0` 判成 beta，而后端因核心段 `V1.0.0` 非数字判成 Unknown —— 同一个
  // 版本两侧通道不一致，更新检查与徽章会显示互相矛盾的结论。
  // （注意与 `TYPE_SEGMENT_RE` 的 `/i` 区分：那个对应后端 `parse_type_segment` 会先
  //  `to_ascii_lowercase`，所以必须保留。）
  const v = (version || '').trim().replace(/^v+/, '')
  if (v === '') return 'unknown'
  const dash = v.indexOf('-')
  const core = dash === -1 ? v : v.slice(0, dash)
  // 核心段必须全为数字（容忍 `1..2` 的空段）且至少有一段数字——对应后端
  // `core_is_numeric` + `nums.next()?`：`1.0.x`、`-rc1` 在后端是 Unknown。
  const coreSegs = core.split('.')
  if (!coreSegs.every(s => s === '' || /^\d+$/.test(s))) return 'unknown'
  if (!coreSegs.some(s => s !== '')) return 'unknown'
  if (dash === -1) return 'dev'
  // 回归防护：旧代码是 `/-(alpha|beta|release)(\d+)/i` 匹配 `v.slice(dash + 1)`，
  // 而 slice 已把 `-` 剥掉 → 正则永远匹配不上 → release/beta/alpha 全部落入
  // 'unknown'。症状：设置页徽章显示"未知构建"；`resolveChannel` 返回 undefined，
  // 使 App.tsx 后台检查与 Settings.tsx 手动检查都静默返回"已是最新"；
  // announcements.ts 的通道过滤同样失效（不带 channel 请求 → 拿到全部公告）。
  const m = v
    .slice(dash + 1)
    .split('.')[0]
    .match(TYPE_SEGMENT_RE)
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

/**
 * 通道字符串（后端 `Train::as_str()` / `UpdatePlan.channel` 的口径：
 * `release` | `beta` | `alpha` | `dev`）→ 徽章用的 i18n key。
 *
 * 无法识别时返回 `undefined`，由调用方回落到原始字符串——不猜。这样更新弹窗
 * 文案里的通道名与设置页「关于」徽章同为本地化标签（测试版/稳定版/开发版），
 * 而不是把后端原始 key（`beta`）直接插进中文句子。
 */
export function channelLabelKey(channel: string | undefined): string | undefined {
  return channel === 'release' || channel === 'beta' || channel === 'alpha' || channel === 'dev'
    ? trainLabelKey(channel)
    : undefined
}

/**
 * 设置页通道选择器的值 → 后端 `Train`（`plan.channel`）的口径。
 *
 * 两套命名是历史遗留：选择器与 localStorage 沿用发布侧的 `stable`，而 `Train`
 * （`trainOf` / `channelLabelKey` / 后端 `Train::as_str()`）一律用 `release`。
 * 二者必须归一后再比较，否则「提示所属通道 === 当前选择」永远不成立。
 * 无法识别的值原样返回——宁可比较不相等（少显示一条提示），也不要猜。
 */
export function channelTrainOf(channel: string): string {
  return channel === 'stable' ? 'release' : channel
}

/**
 * 已下载待安装的包是否仍属于**当前有效通道**（ADR-081：跨列车不得自动安装）。
 *
 * 用户可能在更新包下载完成后又去设置里切了通道；那份包已不属于当前想要的列车，
 * 无人值守地装上它就是一次静默的跨列车更新——而通道切换本应由用户显式决定。
 *
 * 返回 `true` = 允许（含两种情况：记录没带通道的旧版记录、当前构建无有效通道
 * 如 dev 构建）。这两种情况都**无法判定**，按「不拦」处理——否则老记录会永远
 * 装不上、dev 构建也永远用不了自动安装。
 */
export function stagedChannelMatchesCurrent(
  stagedChannel: string | undefined,
  version: string,
): boolean {
  if (!stagedChannel) return true
  const current = resolveChannel(version)
  if (!current) return true
  return channelTrainOf(current) === stagedChannel
}
