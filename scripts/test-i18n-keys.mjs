#!/usr/bin/env node
// Copyright (C) 2026 Qomicex Launcher Contributors
// SPDX-License-Identifier: GPL-3.0-or-later

// 护栏：`t('字面量')` 的静态 key 必须在每个语言的资源里都有词条。
//
// 为什么需要它：t() 查不到键时原样返回键名（src/i18n/index.tsx），且只在
// `import.meta.env.DEV` 下 console.warn —— release 用户在按钮上直接看到
// `dialogs.common.cancel` 这种键名，而构建与 typecheck 都不会报错
// （t 的签名接受 `string & {}`，写错的字面量照样通过）。
//
// 数据来源：
//   A) src/**/*.{ts,tsx} 里 `t('...')` 的字面量 key（含 `t("...")`）；
//      跳过模板字符串与拼接出来的动态 key。
//   B) qomicex-tauri-i18n/src/<lang>/<namespace>.ts 的默认导出（键名即文件名，
//      与 qomicex-tauri-i18n/src/<lang>/index.ts 的组装方式一致）。
// 逐语言比对，任一 key 在任一语言缺失即 FAIL（退出码 1）。
//
// 用法：pnpm run test:i18n-keys

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const SRC = join(ROOT, 'src')
const I18N_DIR = join(ROOT, 'qomicex-tauri-i18n', 'src')
const LANGS = ['zh-CN', 'zh-TW', 'zh-HK', 'en-US', 'en-GB', 'ja-JP', 'ru-RU']
// key 是点分路径且首段是命名空间；单段 key 与 `t(someVar)` 不参与检查。
const KEY_RE = /^[A-Za-z][\w-]*(\.[\w-]+)+$/

if (!existsSync(I18N_DIR)) {
  console.error(
    `[test-i18n-keys] i18n 子模块未初始化：${relative(ROOT, I18N_DIR)}\n` +
      '  先跑 `git submodule update --init qomicex-tauri-i18n`。',
  )
  process.exit(1)
}

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) walk(path, out)
    else out.push(path)
  }
  return out
}

/** 读取 <lang>/<ns>.ts 的默认导出对象；行号用于报错定位。 */
function readLocale(lang) {
  const dir = join(I18N_DIR, lang)
  if (!existsSync(dir)) return null
  const tree = {}
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.ts') || name === 'index.ts') continue
    const ns = name.slice(0, -3)
    const text = readFileSync(join(dir, name), 'utf8')
    const body = text
      .replace(/^\s*\/\/.*$/gm, '')
      .replace(/export\s+default/, '')
      .replace(/\bas\s+const\b/g, '')
      .replace(/;\s*$/, '')
    try {
      tree[ns] = new Function(`return (${body})`)()
    } catch (e) {
      console.error(`[test-i18n-keys] 无法解析 ${lang}/${name}: ${e.message}`)
      process.exit(1)
    }
  }
  return tree
}

function hasKey(tree, key) {
  let node = tree
  for (const part of key.split('.')) {
    if (!node || typeof node !== 'object' || !(part in node)) return false
    node = node[part]
  }
  return typeof node === 'string'
}

/** 收集 `t('literal')` 的 key 与首个出现位置。 */
function collectUsedKeys() {
  const used = new Map()
  const files = walk(SRC).filter(
    (p) => /\.(ts|tsx)$/.test(p) && !p.endsWith('.d.ts'),
  )
  for (const file of files) {
    const text = readFileSync(file, 'utf8')
    const lines = text.split('\n')
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      // 跳过注释行，避免文档里的示例 key 被当成真实调用
      if (/^\s*(\/\/|\*)/.test(line)) continue
      for (const m of line.matchAll(/\bt\(\s*(['"])([^'"]+)\1/g)) {
        const key = m[2]
        if (!KEY_RE.test(key)) continue
        if (!used.has(key)) {
          used.set(key, `${relative(ROOT, file)}:${i + 1}`)
        }
      }
    }
  }
  return used
}

const used = collectUsedKeys()
const locales = new Map()
for (const lang of LANGS) {
  const tree = readLocale(lang)
  if (!tree) {
    console.error(`[test-i18n-keys] 缺少语言目录：${lang}`)
    process.exit(1)
  }
  locales.set(lang, tree)
}

const missing = []
for (const [key, where] of used) {
  for (const [lang, tree] of locales) {
    if (!hasKey(tree, key)) missing.push({ key, lang, where })
  }
}

if (missing.length > 0) {
  console.error(`[test-i18n-keys] ${missing.length} 处缺词条（界面会直接显示键名）：`)
  for (const { key, lang, where } of missing) {
    console.error(`  ${key}  [${lang}]  用于 ${where}`)
  }
  process.exit(1)
}

console.log(`[test-i18n-keys] OK：${used.size} 个静态 key 在 ${LANGS.length} 个语言里齐全`)
