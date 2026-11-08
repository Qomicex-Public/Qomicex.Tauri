#!/usr/bin/env node
// Copyright (C) 2026 Qomicex Launcher Contributors
// SPDX-License-Identifier: GPL-3.0-or-later

// 图标目录一致性护栏（issue #300）。
//
// 为什么需要它：图标表在启动器里（BuiltinIcons.tsx），消费方在 plugin-ui 与
// qomicex-cli 两个包里，靠 `scripts/gen-icon-catalog.mjs` 生成产物保持同步。
// 一旦有人改了表却没重新生成，插件侧 `<Icon>` 会渲染 null、CLI 的 lint 也会
// 放过表外图标 —— 两边都静默，等到用户截图才发现。
//
// 本测试做三件事：
//   1. 产物是否最新（等价于 gen-icon-catalog.mjs --check）
//   2. 每个图标都有可静态导入的单图标模块，且导出名与表一致
//   3. plugin-ui 的 <Glyph> 不依赖 catalog（否则静态导入也会拖进整表）
//
// 运行：pnpm run test:icon-catalog

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const builtinSrc = readFileSync(join(root, 'src', 'components', 'BuiltinIcons.tsx'), 'utf8')
const glyphDir = join(root, 'packages', 'plugin-ui', 'src', 'icons', 'glyphs')
const glyphComponent = readFileSync(join(root, 'packages', 'plugin-ui', 'src', 'components', 'Glyph.tsx'), 'utf8')
const uiIndex = readFileSync(join(root, 'packages', 'plugin-ui', 'src', 'index.ts'), 'utf8')
const cliCatalog = readFileSync(join(root, 'packages', 'qomicex-cli', 'src', 'lib', 'icon-catalog.ts'), 'utf8')

let checks = 0
function check(name, actual, expected) {
  assert.deepEqual(
    actual,
    expected,
    `${name}\n  期望: ${JSON.stringify(expected)}\n  实际: ${JSON.stringify(actual)}`,
  )
  checks += 1
}

/** BuiltinIcons.tsx 里的图标类名。 */
function sourceIconNames() {
  const names = new Set()
  for (const m of builtinSrc.matchAll(/\{\s*cls:\s*'([^']+)',\s*icon:\s*fa[A-Za-z0-9]+\s*\}/g)) names.add(m[1])
  return names
}

const sourceNames = sourceIconNames()
check('BuiltinIcons.tsx 解析不到图标（格式变了？）', sourceNames.size > 200, true)

// ---- 1. 产物必须是最新的 ----
{
  let upToDate = true
  try {
    execFileSync(process.execPath, [join(root, 'scripts', 'gen-icon-catalog.mjs'), '--check'], {
      stdio: 'pipe',
      cwd: root,
    })
  } catch {
    upToDate = false
  }
  check('图标产物与 BuiltinIcons.tsx 不同步（请运行 node scripts/gen-icon-catalog.mjs）', upToDate, true)
}

// ---- 2. 每个图标都有单图标模块 ----
{
  assert.ok(existsSync(glyphDir), `单图标目录不存在: ${glyphDir}`)
  const files = new Set(readdirSync(glyphDir))
  const expectedFiles = sourceNames.size + 1 // + index.ts
  check('单图标模块数量与图标表不一致', files.size, expectedFiles)

  // 抽查几个关键图标：文件在、导出的字形是三元组且 path 非空
  for (const cls of ['fa-solid fa-server', 'fa-solid fa-play', 'fa-solid fa-folder-open']) {
    const bare = cls.replace(/^fa-(?:solid|brands)\s+fa-/, '')
    const file = join(glyphDir, `${bare}.ts`)
    assert.ok(existsSync(file), `缺少单图标模块: ${bare}.ts（对应 ${cls}）`)
    const content = readFileSync(file, 'utf8')
    assert.match(content, /Icon: IconGlyph = \[\d+, \d+, "/, `${bare}.ts 的字形格式不对`)
    checks += 1
  }
}

// ---- 3. <Glyph> 不得依赖 catalog（保证静态导入 tree-shake 得动）----
{
  const importsCatalog = /from\s+['"]\.\.\/icons\/catalog\.js['"]/.test(glyphComponent) &&
    /import\s*\{\s*resolveIconGlyph/.test(glyphComponent)
  check('<Glyph> 依赖了 catalog，静态导入会拖入整张图标表', importsCatalog, false)
  check('<Glyph> 应只以 type-only 方式引用 IconGlyph',
    /import type \{[^}]*IconGlyph[^}]*\} from '\.\.\/icons\/catalog\.js'/.test(glyphComponent), true)
}

// ---- 4. 主入口不得导出完整 catalog（否则任何 import 都会拖入 160KB）----
{
  const exportsCatalog = /export\s*\{[^}]*\bICON_CATALOG\b/.test(uiIndex)
  check('plugin-ui 主入口导出了 ICON_CATALOG（会让所有消费方背包内全部图标）', exportsCatalog, false)
  check('主入口应导出 ICON_NAMES', /export\s*\{[^}]*\bICON_NAMES\b/.test(uiIndex), true)
}

// ---- 5. CLI 名字表与源一致 ----
{
  const cliNames = new Set()
  for (const m of cliCatalog.matchAll(/^\s{2}"(fa-(?:solid|brands) fa-[a-z0-9-]+)",$/gm)) cliNames.add(m[1])
  const missing = [...sourceNames].filter((n) => !cliNames.has(n))
  const extra = [...cliNames].filter((n) => !sourceNames.has(n))
  check('CLI 图标名字表缺条目', missing, [])
  check('CLI 图标名字表多出条目', extra, [])
}

console.log(`\n[test-icon-catalog] OK — ${checks} 项断言通过（${sourceNames.size} 个内置图标）`)
