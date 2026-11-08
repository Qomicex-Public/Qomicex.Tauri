#!/usr/bin/env node
// Copyright (C) 2026 Qomicex Launcher Contributors
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * 内置图标目录生成器（issue #300：插件生态图标治理）。
 *
 * 单一事实源 = src/components/BuiltinIcons.tsx 的 entries 表。从它生成三份产物：
 *
 *   1. packages/plugin-ui/src/icons/catalog.ts
 *      完整目录（cls → 尺寸 + SVG path）。给 `<Icon name={动态字符串}>` 用，
 *      也是 `ICON_NAMES`/`hasIcon` 的数据源。**整张表约 160KB，会全量进包**，
 *      只适合需要按名字查图的场景（图标选择器、主题映射）。
 *
 *   2. packages/plugin-ui/src/icons/glyphs/*.ts（每图标一个模块）
 *      静态可分析的单图标入口，形如：
 *        import { ServerIcon } from '@qomicex/plugin-ui/icons/server'
 *      打包器能 tree-shake —— 一个插件只用 20 个图标就只进 20 份 path。
 *
 *   3. packages/qomicex-cli/src/lib/icon-catalog.ts
 *      仅类名清单，供 `qomicex lint` 在发布前拦截表外图标（CLI 不背包体量）。
 *
 * 为什么需要生成而不是各自手写：表在启动器里演进，消费方在另外两个包里，
 * 手抄必然漂移（本次 issue 的成因）。
 *
 * 用法：
 *   node scripts/gen-icon-catalog.mjs           # 重新生成
 *   node scripts/gen-icon-catalog.mjs --check   # 只校验是否最新（CI 用）
 */
import { readFileSync, writeFileSync, existsSync, rmSync, mkdirSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SOURCE = join(root, 'src', 'components', 'BuiltinIcons.tsx')
const UI_SRC = join(root, 'packages', 'plugin-ui', 'src')
const OUT_CATALOG = join(UI_SRC, 'icons', 'catalog.ts')
const OUT_NAMES = join(UI_SRC, 'icons', 'names.ts')
const OUT_GLYPHS = join(UI_SRC, 'icons', 'glyphs')
const OUT_INDEX = join(UI_SRC, 'icons', 'index.ts')
const OUT_CLI = join(root, 'packages', 'qomicex-cli', 'src', 'lib', 'icon-catalog.ts')

const checkMode = process.argv.includes('--check')

// --- 1. 解析 BuiltinIcons.tsx 的 entries 表 ---
const src = readFileSync(SOURCE, 'utf8')
const entries = []
for (const m of src.matchAll(/\{\s*cls:\s*'([^']+)',\s*icon:\s*(fa[A-Za-z0-9]+)\s*\}/g)) {
  entries.push({ cls: m[1], varName: m[2] })
}
if (entries.length === 0) {
  console.error('✗ 解析不到 BuiltinIcons.tsx 的 entries 表（格式变了？）')
  process.exit(1)
}

// --- 2. 用 FA 包解析出 SVG path ---
const solid = await import('@fortawesome/free-solid-svg-icons')
const brands = await import('@fortawesome/free-brands-svg-icons')

const icons = []
const unresolved = []
for (const { cls, varName } of entries) {
  const def = solid[varName] ?? brands[varName]
  if (!def) {
    unresolved.push(`${cls} → ${varName}`)
    continue
  }
  // FA IconDefinition.icon = [width, height, ligatures[], unicode, svgPathData]
  const raw = def.icon[4]
  icons.push({ cls, width: def.icon[0], height: def.icon[1], path: Array.isArray(raw) ? raw.join(' ') : raw })
}
if (unresolved.length > 0) {
  console.error('✗ 以下条目无法从 FA 包解析：\n  ' + unresolved.join('\n  '))
  process.exit(1)
}
icons.sort((a, b) => (a.cls < b.cls ? -1 : a.cls > b.cls ? 1 : 0))

/** `fa-solid fa-folder-open` → `folderOpen`（导出名用 <FolderOpenIcon>）。 */
function exportName(cls) {
  const bare = cls.replace(/^fa-(?:solid|brands)\s+fa-/, '')
  const pascal = bare.split('-').map(s => s.charAt(0).toUpperCase() + s.slice(1)).join('')
  return pascal
}
/** 每个图标一个稳定文件名（供 `@qomicex/plugin-ui/icons/<file>` 导入）。 */
function fileName(cls) {
  const brand = cls.startsWith('fa-brands ')
  const bare = cls.replace(/^fa-(?:solid|brands)\s+fa-/, '')
  return (brand ? 'brand-' : '') + bare
}

const BANNER = `// Copyright (C) 2026 Qomicex Launcher Contributors
// SPDX-License-Identifier: GPL-3.0-or-later
//
// ⚠️ 自动生成，请勿手改。改图标请编辑 src/components/BuiltinIcons.tsx
//    然后运行：node scripts/gen-icon-catalog.mjs
//    产物与源不一致时 CI 会失败（--check 模式）。
`

// 导出名去重（fa-solid fa-box 与 fa-brands fa-box 之类不会撞，但仍需防御）
const usedNames = new Map()
for (const icon of icons) {
  let name = exportName(icon.cls)
  if (usedNames.has(name)) name = `${name}Brand`
  usedNames.set(name, icon.cls)
  icon.exportName = name
  icon.fileName = fileName(icon.cls)
}

// --- 3. 生成产物 ---
let stale = false
let written = 0
function emit(file, content) {
  const normalized = content.replace(/\r\n/g, '\n')
  const existing = existsSync(file) ? readFileSync(file, 'utf8') : null
  if (existing !== null && existing.replace(/\r\n/g, '\n') === normalized) return
  if (checkMode) {
    stale = true
    console.error(`✗ 产物过期: ${file.replace(root, '.')}`)
    return
  }
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, normalized)
  written += 1
}

// 3a. 完整目录（运行期按名字查）
const catalogBody = icons
  .map(i => `  ${JSON.stringify(i.cls)}: [${i.width}, ${i.height}, ${JSON.stringify(i.path)}],`)
  .join('\n')

emit(OUT_CATALOG, `${BANNER}
/** 一个图标的绘制数据：viewBox 宽高 + SVG path（currentColor 填充）。 */
export type IconGlyph = readonly [width: number, height: number, path: string]

/**
 * 启动器内置图标目录：Font Awesome 类名 → 绘制数据。
 *
 * ⚠️ 整张表约 160KB。**只在需要按名字查图时用它**（图标选择器、主题映射、
 * \`getIconSvg\`）。普通插件请从 \`@qomicex/plugin-ui/icons/<file>\` 静态导入单图标，
 * 打包器才能 tree-shake。
 */
export const ICON_CATALOG: Record<string, IconGlyph> = {
${catalogBody}
}

/** 查一个类名的绘制数据；未登记返回 null。 */
export function resolveIconGlyph(name: string): IconGlyph | null {
  return ICON_CATALOG[name] ?? null
}
`)

// 3b. 仅名字（轻量，icon 选择器/校验用）
emit(OUT_NAMES, `${BANNER}
/** 全部合法图标类名（按字典序）。约 285 条字符串，不含 path。 */
export const ICON_NAMES: readonly string[] = [
${icons.map(i => `  ${JSON.stringify(i.cls)},`).join('\n')}
]

/** 名字集合，便于 O(1) 判定。 */
export const ICON_NAME_SET: ReadonlySet<string> = new Set(ICON_NAMES)

/** 判断类名是否合法（等价于 \`<Icon name>\` 能否渲染出图形）。 */
export function hasIcon(name: string): boolean {
  return ICON_NAME_SET.has(name)
}
`)

// 3c. 每图标一个模块（tree-shake 友好）
for (const icon of icons) {
  emit(
    join(OUT_GLYPHS, `${icon.fileName}.ts`),
    `${BANNER}
import type { IconGlyph } from '../catalog.js'

/** \`${icon.cls}\` — 从 \`@qomicex/plugin-ui/icons/${icon.fileName}\` 导入。 */
export const ${icon.exportName}Icon: IconGlyph = [${icon.width}, ${icon.height}, ${JSON.stringify(icon.path)}]
`,
  )
}

// 3d. glyphs barrel（也可整体导入，但会失去 tree-shaking 收益）
emit(
  join(OUT_GLYPHS, 'index.ts'),
  `${BANNER}
// 每图标一个模块的汇总入口。逐个静态导入才 tree-shake 得动：
//   import { ServerIcon } from '@qomicex/plugin-ui/icons/server'
// 从 barrel 导入会把全部图标拖进包，等价于直接用 ICON_CATALOG。
${icons.map(i => `export { ${i.exportName}Icon } from './${i.fileName}.js'`).join('\n')}
`,
)

// 3e. icons 子路径入口
emit(OUT_INDEX, `${BANNER}
export { ICON_CATALOG, resolveIconGlyph } from './catalog.js'
export type { IconGlyph } from './catalog.js'
export { ICON_NAMES, ICON_NAME_SET } from './names.js'
`)

// 3f. CLI 只需名字
emit(OUT_CLI, `${BANNER}
/**
 * 启动器内置图标类名的合法集合（issue #300）。
 *
 * 与启动器 \`src/components/BuiltinIcons.tsx\` 严格一致。只含类名不含 SVG path，
 * 因为 CLI 只需要判断「这个名字启动器认不认」。
 */
export const ICON_NAMES: ReadonlySet<string> = new Set([
${icons.map(i => `  ${JSON.stringify(i.cls)},`).join('\n')}
])

/** 全部合法图标类名数组（按字典序，供提示用）。 */
export const ICON_NAME_LIST: string[] = [...ICON_NAMES].sort()
`)

// 3g. 清理已删除图标的陈旧模块
if (!checkMode && existsSync(OUT_GLYPHS)) {
  const expected = new Set(icons.map(i => `${i.fileName}.ts`).concat('index.ts'))
  for (const file of readdirSync(OUT_GLYPHS)) {
    if (!expected.has(file)) {
      rmSync(join(OUT_GLYPHS, file))
      console.log(`  - 清理陈旧图标模块 ${file}`)
    }
  }
}

if (checkMode) {
  if (stale) {
    console.error('\n图标目录与 BuiltinIcons.tsx 不一致，请运行 node scripts/gen-icon-catalog.mjs')
    process.exit(1)
  }
  console.log(`✔ 图标目录最新（${icons.length} 个图标）`)
} else {
  console.log(`✔ 图标目录已更新：${icons.length} 个图标（${written} 个文件变更）`)
}
