// 下载中心「按资源类型分组」的归一化、分组推导、顺序配置与折叠状态持久化。
//
// 集中放在这里的原因：分类别名（`shaderpack` / `shaderpacks` / `shader`…）散落在各
// 发起点，页面若各自实现一遍必然漂移。所有分类判断只走本模块。
//
// 注意：`DownloadTask.resourceKind` 是**可选**字段——旧任务（已持久化在
// localStorage 的 `qomicex-download-tasks` 里）没有它。缺失时按 `type` 回退，
// 仍然判不出的（`file` / `batch` / `resource`）进「其他」组，**绝不默认成 mod**。
import type { DownloadTask, DownloadResourceKind } from '../types/index.ts'
import { Gamepad2, Package, Puzzle, Image, Sparkles, Database, Save, Coffee, Box } from 'lucide-react'

/** 分组键 = 资源细分类别 + 三个非资源组（游戏安装/Java 运行时/无法归类）。 */
export type DownloadGroupKey = DownloadResourceKind | 'game' | 'java' | 'other'

/**
 * 分类别名归一化。
 *
 * 接受大小写差异与复数形式（后端目录名是 `mods` / `resourcepacks` /
 * `shaderpacks` / `datapacks` / `saves`，资源中心的 URL 参数是 `mod` /
 * `resourcepack` / `shader` / `datapack`，拖拽分类返回 `shaderpack`）。
 *
 * 无法识别时返回 `undefined` —— 调用方必须把「认不出」与「模组」区分开，
 * 不能兜底成 `mod`。
 */
export function normalizeResourceKind(raw?: string | null): DownloadResourceKind | undefined {
  // `typeof` 守卫是必需的，不能只靠 TS 签名：任务来自 localStorage
  // (`qomicex-download-tasks`) 与插件调用方，运行期可能是任意 JSON ——
  // 对象/数字/布尔值都会让 `.trim()` 抛异常并整页崩溃（ErrorBoundary 兜住
  // 后下载中心整页白掉）。非字符串一律按「认不出」处理。
  if (typeof raw !== 'string') return undefined
  // 去掉分隔符差异：`resource-pack` / `resource_pack` / `resourcepack` 等价。
  const key = raw.trim().toLowerCase().replace(/[\s_-]+/g, '')
  if (!key) return undefined

  switch (key) {
    case 'mod':
    case 'mods':
    case 'modification':
      return 'mod'
    case 'modpack':
    case 'modpacks':
    case 'mrpack':
    case 'qmodpack':
      return 'modpack'
    case 'resourcepack':
    case 'resourcepacks':
    case 'texturepack':
    case 'texturepacks':
      return 'resourcepack'
    case 'shader':
    case 'shaders':
    case 'shaderpack':
    case 'shaderpacks':
      return 'shader'
    case 'datapack':
    case 'datapacks':
      return 'datapack'
    case 'save':
    case 'saves':
      return 'save'
    default:
      return undefined
  }
}

/** 渲染顺序：游戏与整合包（重）在前，资源类居中，Java 与兜底组在后。 */
export const DOWNLOAD_GROUP_ORDER: readonly DownloadGroupKey[] = [
  'game',
  'modpack',
  'mod',
  'resourcepack',
  'shader',
  'datapack',
  'save',
  'java',
  'other',
] as const

export interface DownloadGroupConfig {
  /** 分组名 i18n key（`downloads.groups.*`）。 */
  labelKey: string
  icon: typeof Box
}

/**
 * 分组图标与文案配置。图标沿用下载中心原有的 lucide 取值（`TYPE_ICON`），
 * 保证同一概念在卡片与分组头上同形。
 */
export const DOWNLOAD_GROUP_CONFIG: Record<DownloadGroupKey, DownloadGroupConfig> = {
  game: { labelKey: 'downloads.groups.game', icon: Gamepad2 },
  modpack: { labelKey: 'downloads.groups.modpack', icon: Package },
  mod: { labelKey: 'downloads.groups.mod', icon: Puzzle },
  resourcepack: { labelKey: 'downloads.groups.resourcepack', icon: Image },
  shader: { labelKey: 'downloads.groups.shader', icon: Sparkles },
  datapack: { labelKey: 'downloads.groups.datapack', icon: Database },
  save: { labelKey: 'downloads.groups.save', icon: Save },
  java: { labelKey: 'downloads.groups.java', icon: Coffee },
  other: { labelKey: 'downloads.groups.other', icon: Box },
}

/** 某个分组键是否合法（用于严格校验 localStorage 里的持久化状态）。 */
export function isDownloadGroupKey(value: unknown): value is DownloadGroupKey {
  return typeof value === 'string' && (DOWNLOAD_GROUP_ORDER as readonly string[]).includes(value)
}

/**
 * 任务 → 分组键。
 *
 * 1. 有 `resourceKind` 时以它为准（同样过一遍归一化，防脏数据）；
 * 2. 否则按 `type` 回退：`modpack` → 整合包，`game` / `repair` → 游戏，`java` → Java；
 * 3. 其余（`file` / `batch` / `resource` 以及更早的旧数据）→ 其他。
 */
export function getTaskGroup(task: Pick<DownloadTask, 'type' | 'resourceKind'>): DownloadGroupKey {
  const explicit = normalizeResourceKind(task.resourceKind)
  if (explicit) return explicit

  switch (task.type) {
    case 'modpack':
      return 'modpack'
    case 'game':
    case 'repair':
      return 'game'
    case 'java':
      return 'java'
    default:
      return 'other'
  }
}

export interface DownloadGroup {
  key: DownloadGroupKey
  labelKey: string
  icon: typeof Box
  tasks: DownloadTask[]
}

/**
 * 按固定顺序分组。空分组不产出（页面只在有任务时渲染分组头）。
 * 组内保持入参顺序 —— store 本身是「新任务在前」，这里不再重排。
 */
export function groupTasks(tasks: DownloadTask[]): DownloadGroup[] {
  const buckets = new Map<DownloadGroupKey, DownloadTask[]>()
  for (const task of tasks) {
    const key = getTaskGroup(task)
    const bucket = buckets.get(key)
    if (bucket) bucket.push(task)
    else buckets.set(key, [task])
  }

  return DOWNLOAD_GROUP_ORDER.filter((key) => buckets.has(key)).map((key) => ({
    key,
    labelKey: DOWNLOAD_GROUP_CONFIG[key].labelKey,
    icon: DOWNLOAD_GROUP_CONFIG[key].icon,
    tasks: buckets.get(key)!,
  }))
}

/** 折叠状态持久化键（与任务数据 `qomicex-download-tasks` 隔离）。 */
export const COLLAPSED_GROUPS_KEY = 'qomicex-download-groups-collapsed'

/**
 * 读取「已折叠的分组键」。默认全部展开——解析失败、类型不符、**含任何非法键**
 * 时都回退到空集合，宁可多展开也不要因为脏数据把分组藏起来。
 *
 * 校验是「全有或全无」而非逐项过滤：`["mod", "__proto__"]` 这类混合值说明这份
 * 持久化状态已不可信，此时只信任其中合法的那部分等于部分接受脏数据。契约见
 * `docs/junsi-dev-docs/6-UI/组件/下载中心UI规范.md`。
 */
export function readCollapsedGroups(): DownloadGroupKey[] {
  try {
    const raw = localStorage.getItem(COLLAPSED_GROUPS_KEY)
    if (!raw) return []
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    if (!parsed.every(isDownloadGroupKey)) return []
    return parsed
  } catch {
    return []
  }
}

/** 持久化「已折叠的分组键」。写入失败（隐私模式/配额）时静默忽略，不影响本次会话。 */
export function writeCollapsedGroups(keys: readonly DownloadGroupKey[]): void {
  try {
    localStorage.setItem(COLLAPSED_GROUPS_KEY, JSON.stringify(keys.filter(isDownloadGroupKey)))
  } catch {
    /* 无持久化能力：折叠仅在本次会话内生效 */
  }
}
