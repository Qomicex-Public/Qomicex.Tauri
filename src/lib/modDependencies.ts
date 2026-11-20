// Copyright (C) 2026 Qomicex Launcher Contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import type { ModDependency, ModMetadata } from '../types/index.ts'

/**
 * 模组依赖缺失检测（issue #165）。
 *
 * 数据来源：后端 `/instance/{id}/files/mods/metadata` 返回的 `modId` + `providesIds`
 * + `dependencies`，由 core `qomicex-core-rust` 在解析 jar 内 `fabric.mod.json` /
 * `META-INF/mods.toml` 时填充。
 *
 * 判定口径（严格模式，已与产品确认）：
 * - **只有启用中的模组才算「已提供」**。`.disabled` 的模组不参与运行时加载，
 *   因此不能算满足依赖——若算满足，就会掩盖真实的启动失败原因。
 * - **`providesIds`（嵌套 Jar-in-Jar 子模块）也算「已提供」**：容器 jar 顶层只声明
 *   自身 id，`fabric-api` 这类 jar 通过 `META-INF/jars/` 提供数十个子模块 id
 *   （`fabric-lifecycle-events-v1` 等）。漏掉它们会把整片 Fabric 生态误报成缺失依赖。
 * - 只检测「强制依赖」：fabric 的 `depends`、forge/neoforge 的 `mandatory=true` /
 *   `type="required"`。可选依赖（`recommends` / `suggests` / `mandatory=false`）在
 *   后端解析阶段就已排除，缺失它们不影响启动。
 * - **只标启用中的模组**：模组自身被禁用时它根本不会加载，给它挂警告是噪音。
 *
 * 明确不做的判定：
 * - **不校验版本约束**。`versionRange` 是 Maven/自定义谓词（如 `[1.20.1,1.21)`），
 *   前端没有可靠语义去判定本地版本是否落入区间；强行判断会产生误报。
 *   本函数只回答「这个 mod id 在不在」，版本区间仅作为提示文本展示给用户。
 *
 * 信雅互联（Sinytra Connector，issue #363）：
 * - Connector 让 Forge/NeoForge 实例能加载 Fabric jar，这类 jar 的依赖是 Fabric 侧
 *   的 `fabric` / `fabric-api` / `fabric-*-v1`；
 * - Forgified Fabric API（FFAPI）是 Connector 侧的 Fabric API 实现，主 id 为
 *   `fabric_api`，所有子模块把上游 id 的 `-` 换成 `_`
 *   （`fabric-transfer-api-v1` → `fabric_transfer_api_v1`），官方文档：
 *   https://github.com/Sinytra/Connector/blob/9287e9f/docs/developers.mdx
 * - 因此**仅在实例里存在启用中的 Connector、且加载器为 Forge/NeoForge 时**，把
 *   `fabric` / `fabric-*` 依赖按 FFAPI 的命名归一后再匹配，并且只接受 FFAPI 自己
 *   提供的 id（嵌套子模块）；普通 Fabric 实例不受影响，避免掩盖真实缺失。
 */

/**
 * 加载器 / 平台自身提供的 mod id：这些条目在模组元数据里普遍被声明为强制依赖，
 * 但它们的「提供方」是加载器而非某个 jar，恒被满足，因此必须排除，否则每个
 * Forge/Fabric 模组都会被标成「缺失依赖」。
 *
 * ⚠️ 只放**加载器自身**的 id。判断标准是「该 id 是否由加载器在运行时恒提供」，
 * 有权威依据（加载器自己的元数据文件）才收录：
 * - `minecraft` / `java`：游戏与 JVM，加载器内置（Fabric `MinecraftGameProvider`
 *   返回 `minecraft`）；
 * - `fabricloader`：Fabric Loader 自身 `fabric.mod.json` 的 `id`
 *   （https://github.com/FabricMC/fabric-loader/blob/master/src/main/resources/fabric.mod.json）；
 * - `quilt_loader`：Quilt Loader 自身 `quilt.mod.json` 的 `id`；它另通过 `provides`
 *   声明 `fabricloader`（https://github.com/QuiltMC/quilt-loader/blob/master/src/main/resources/quilt.mod.json）；
 * - `forge` / `neoforge`：各自加载器的 mod id；
 * - `javafml` / `lowcodefml` / `modlauncher`：随 Forge 系加载器一同提供的语言/加载组件。
 *
 * 🚫 **不要把「模组 / API 的 id」放进来**（PR #177 评审指出后修正）：
 * - `fabric` 是 **1.19.2 之前旧版 Fabric API 的 mod id**（1.19.2 起改为 `fabric-api`，
 *   见 https://wiki.fabricmc.net/tutorial:setup）。把它当平台 id 会让「装了依赖旧版
 *   Fabric API 的模组、但没装该 API」这一真实的启动失败原因被静默吞掉。
 * - `quilt` 同理不是加载器 id（Quilt Loader 自身是 `quilt_loader`）。
 * 这类 id 应当正常走「已启用模组的 modId / providesIds」匹配——装了就能匹配上，
 * 没装就该报缺失，这正是本功能的目的。
 */
const PLATFORM_PROVIDED_IDS: ReadonlySet<string> = new Set([
  'minecraft',
  'java',
  'forge',
  'neoforge',
  'fabricloader',
  'fabric-loader',
  'quilt_loader',
  'quiltloader',
  'javafml',
  'lowcodefml',
  'modlauncher',
])

/**
 * 信雅互联（Sinytra Connector）的 FML mod id：新版用 `connector`，Forge 1.20.x 的
 * 1.x 版本用 `connectormod`（ConnectorUtil.CONNECTOR_MODID）。
 */
const CONNECTOR_MOD_IDS: ReadonlySet<string> = new Set(['connector', 'connectormod'])

/**
 * Connector 实例里 Fabric API 依赖在 FFAPI 侧的实际 id。
 *
 * FFAPI 主 id 是 `fabric_api`（下划线），子模块把上游 id 的 `-` 换成 `_`
 * （`fabric-transfer-api-v1` → `fabric_transfer_api_v1`）；旧模组还可能依赖
 * `fabric`（1.19.2 之前的 Fabric API id）。只映射 `fabric` / `fabric-` 前缀，
 * 且调用方只与 **FFAPI 自己提供的 id** 比较，避免把别的模组当成已提供。
 */
function connectorAliases(depId: string): string[] {
  if (depId === 'fabric') return ['fabric_api', 'fabric-api']
  if (depId.startsWith('fabric-')) return [depId.replace(/-/g, '_')]
  return []
}

/** 去掉 `.jar` / `.jar.disabled` / `.disabled` 后的文件名主干，转小写。 */
function fileStemLower(fileName: string): string {
  return fileName
    .replace(/\.disabled$/i, '')
    .replace(/\.jar$/i, '')
    .toLowerCase()
}

/**
 * 文件名兜底匹配：老模组（只有 `mcmod.info`）解析不出 mod id，此时代 jar 名判断
 * 依赖是否可能已被满足，避免「装了前置却报缺失」的误报。
 *
 * 只认**版本后缀**形态：`{dep}` 或 `{dep}-{version}` / `{dep}_{version}`，
 * 且 `{version}` 必须以数字开头（如 `flywheel-0.6.10`）。这是 CurseForge /
 * Modrinth 的命名约定（`<slug>-<version>.jar`）。
 *
 * 刻意不做的匹配（宁可漏报也不误报）：
 * - 子串包含：`create-addon-1.0` **不**提供 `create`；
 * - 纯后缀/中缀（`x-create`、`x-create-y`）：无法区分「别的模组」和「本模组」，
 *   判为满足会掩盖真实的缺失依赖。
 */
function fileNameMayProvide(stem: string, depIdLower: string): boolean {
  if (!stem || !depIdLower) return false
  if (stem === depIdLower) return true
  for (const sep of ['-', '_']) {
    const prefix = `${depIdLower}${sep}`
    if (stem.startsWith(prefix)) {
      // 余下部分必须以数字开头才算版本号；字母开头是模组名的一部分（如 create-addon）
      const rest = stem.slice(prefix.length)
      if (rest.length > 0 && rest.charCodeAt(0) >= 0x30 && rest.charCodeAt(0) <= 0x39) return true
    }
  }
  return false
}

/** 单个模组的依赖检测结果 */
export interface ModDependencyStatus {
  /** 缺失的强制依赖（按 modId 去重后，声明顺序保留） */
  missing: ModDependency[]
}

/**
 * 计算每个模组缺失的强制依赖。
 * @returns key = `mod.fileName`，value = 该模组的缺失项；**没有任何缺失的模组不会出现在返回的 Map 里**。
 */
export function computeMissingDependencies(
  mods: ModMetadata[],
  loader?: string
): Map<string, ModDependency[]> {
  // Connector 只在 Forge/NeoForge 实例里运行；Fabric 等其他加载器维持原判定。
  const loaderKey = loader?.trim().toLowerCase() ?? ''
  const connectorLoader = loaderKey === 'forge' || loaderKey === 'neoforge'
  // ① 启用中的模组才有资格「提供」依赖（严格口径）
  const enabled = mods.filter((m) => m.active)

  /** 已声明的 mod id（含嵌套 jiJ 子模块 id），小写归一化后比较 */
  const providedIds = new Set<string>()
  for (const m of enabled) {
    const id = m.modId?.trim().toLowerCase()
    if (id) providedIds.add(id)
    // 嵌套 Jar-in-Jar 子模块：容器 jar（如 fabric-api）额外提供了这些 id
    for (const p of m.providesIds ?? []) {
      const pid = p?.trim().toLowerCase()
      if (pid) providedIds.add(pid)
    }
  }

  /**
   * 无 mod id 的启用模组：仅参与文件名兜底匹配。
   * 有 mod id 的模组不进这个集合——它的身份已经由 id 权威表达，
   * 再拿文件名匹配只会放大误报面。
   */
  const anonymousStems = enabled
    .filter((m) => !m.modId?.trim())
    .map((m) => fileStemLower(m.fileName))

  // Connector 只有在启用时才提供 FFAPI 侧的 Fabric 环境（禁用 = 不会加载）；
  // 且只有 Forge/NeoForge 实例会跑 Connector。
  const connectorPresent =
    connectorLoader && [...CONNECTOR_MOD_IDS].some((id) => providedIds.has(id))

  /**
   * FFAPI 实际提供的 id：只认 Connector 侧的 Fabric API 实现（主 id `fabric_api`，
   * 兼容旧写法 `fabric-api`）及其嵌套子模块。归一后的别名必须落在这一集合里，
   * 不能拿「任意模组提供的下划线 id」当已满足——否则一个无关的 `fabric-xxx`
   * 依赖会被别的模组的 `fabric_xxx` 掩盖。
   */
  const ffapiIds = new Set<string>()
  if (connectorPresent) {
    for (const m of enabled) {
      const id = m.modId?.trim().toLowerCase()
      if (id !== 'fabric_api' && id !== 'fabric-api') continue
      ffapiIds.add('fabric_api')
      ffapiIds.add('fabric-api')
      for (const p of m.providesIds ?? []) {
        const pid = p?.trim().toLowerCase()
        if (pid) ffapiIds.add(pid)
      }
    }
  }

  const isSatisfied = (depId: string): boolean => {
    const id = depId.trim().toLowerCase()
    if (!id) return true // 空 id 视为无效声明，不报（后端已过滤，防御性保留）
    if (PLATFORM_PROVIDED_IDS.has(id)) return true
    if (providedIds.has(id)) return true
    // Connector 实例：Fabric API 依赖按 FFAPI 的 `_` 命名再匹配一次，且只认 FFAPI 自己提供的 id。
    if (connectorPresent && connectorAliases(id).some((alias) => ffapiIds.has(alias))) return true
    return anonymousStems.some((stem) => fileNameMayProvide(stem, id))
  }

  const result = new Map<string, ModDependency[]>()
  for (const m of mods) {
    // ② 禁用中的模组不参与加载 → 不给它挂警告（噪音）
    if (!m.active) continue
    const deps = m.dependencies ?? []
    if (deps.length === 0) continue

    const missing: ModDependency[] = []
    const seen = new Set<string>()
    for (const dep of deps) {
      const key = dep.modId?.trim().toLowerCase()
      if (!key || seen.has(key)) continue
      if (isSatisfied(dep.modId)) continue
      seen.add(key)
      missing.push(dep)
    }
    if (missing.length > 0) result.set(m.fileName, missing)
  }
  return result
}

/** 把缺失依赖列表渲染成一行提示文本（Tooltip / 汇总用）。 */
export function formatMissingDependency(dep: ModDependency): string {
  const range = formatVersionConstraint(dep.versionRange ?? '')
  return range ? `${dep.modId} ${range}` : dep.modId
}

/**
 * 把版本区间转成可读文本（issue #373）。
 *
 * 原样拼 `epicfight ([20.13, ))` 会被读成「名字的一部分」。这里只翻译单区间：
 * 下界/上界/精确值 → `≥ x` / `≤ x` / `= x`；`[0,)` 是这些 addon 常见的
 * 「无实际约束」写法，直接不显示。复合表达式（`>=1.0 || <2.0`）原样返回，
 * 猜不准就不猜，避免丢掉真实版本约束。
 */
function formatVersionConstraint(raw: string): string {
  const range = raw.trim()
  if (!range || range === '*') return ''
  const parsed = parseVersionInterval(range)
  if (!parsed) return range
  const { lower, upper, lowerInclusive, upperInclusive } = parsed
  if (!lower && !upper) return ''
  if (lower && lower === upper) return `= ${lower}`
  // 0 起步 = 不限制版本
  if (/^0+(\.0+)*$/.test(lower) && !upper) return ''
  if (lower && !upper) return `${lowerInclusive ? '≥' : '>'} ${lower}`
  if (!lower && upper) return `${upperInclusive ? '≤' : '<'} ${upper}`
  return `${lowerInclusive ? '≥' : '>'} ${lower}, ${upperInclusive ? '≤' : '<'} ${upper}`
}

/** 解析 `[1.0,)` / `(,1.20.1]` / `[1.0]` 这类单区间；不合语法返回 null。 */
function parseVersionInterval(
  range: string,
): { lower: string; upper: string; lowerInclusive: boolean; upperInclusive: boolean } | null {
  const open = range[0]
  const close = range[range.length - 1]
  if ((open !== '[' && open !== '(') || (close !== ']' && close !== ')')) return null
  const parts = range.slice(1, -1).split(',')
  if (parts.length > 2) return null
  const lower = parts[0]?.trim() ?? ''
  const upper = (parts[1] ?? '').trim()
  // 单值 `[1.0]` 才是精确约束；`(1.0)` 之类按异形表达式处理
  if (parts.length === 1 && !(lower && open === '[' && close === ']')) return null
  return {
    lower,
    upper: parts.length === 1 ? lower : upper,
    lowerInclusive: open === '[',
    upperInclusive: close === ']',
  }
}
