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
 */

/**
 * 加载器 / 平台自身提供的 mod id：这些条目在模组元数据里普遍被声明为强制依赖，
 * 但它们的「提供方」是加载器而非某个 jar，恒被满足，因此必须排除，否则每个
 * Forge/Fabric 模组都会被标成「缺失依赖」。
 */
const PLATFORM_PROVIDED_IDS: ReadonlySet<string> = new Set([
  'minecraft',
  'java',
  'forge',
  'neoforge',
  'fabricloader',
  'fabric-loader',
  'fabric',
  'quilt_loader',
  'quiltloader',
  'quilt',
  'javafml',
  'lowcodefml',
  'modlauncher',
])

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
  mods: ModMetadata[]
): Map<string, ModDependency[]> {
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

  const isSatisfied = (depId: string): boolean => {
    const id = depId.trim().toLowerCase()
    if (!id) return true // 空 id 视为无效声明，不报（后端已过滤，防御性保留）
    if (PLATFORM_PROVIDED_IDS.has(id)) return true
    if (providedIds.has(id)) return true
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
  const range = dep.versionRange?.trim()
  return range ? `${dep.modId} (${range})` : dep.modId
}
