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
// 数据来源（都不执行任何被检查的文件内容）：
//   A) src/**/*.{ts,tsx} 里 `t('...')` / `t("...")` 的字面量 key（含跨行写法）；
//      跳过模板字符串与拼接出来的动态 key。
//   B) qomicex-tauri-i18n/src/<lang>/<namespace>.ts 的对象字面量，按 token 扫描出
//      叶子路径（键名即文件名，与 <lang>/index.ts 的组装方式一致）。
// 逐语言比对，任一 key 在任一语言缺失即 FAIL（退出码 1）。
//
// 不 eval 语言文件：词条文件随 i18n 子模块进来，用 `new Function`/`eval` 解析等于
// 谁改一条翻译就能在开发者/CI 机器上执行任意代码（评审意见）。
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

/** 注释替换成空格（保留换行，行号不漂）；字符串里的 `//` 不算注释。 */
function stripComments(src) {
  let out = ''
  let i = 0
  while (i < src.length) {
    const c = src[i]
    if (c === '"' || c === "'" || c === '`') {
      let j = i + 1
      out += c
      while (j < src.length && src[j] !== c) {
        if (src[j] === '\\') {
          out += src[j] + (src[j + 1] ?? '')
          j += 2
          continue
        }
        out += src[j]
        j++
      }
      out += src[j] ?? ''
      i = j + 1
      continue
    }
    if (c === '/' && src[i + 1] === '/') {
      while (i < src.length && src[i] !== '\n') {
        out += ' '
        i++
      }
      continue
    }
    if (c === '/' && src[i + 1] === '*') {
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) {
        out += src[i] === '\n' ? '\n' : ' '
        i++
      }
      out += '  '
      i += 2
      continue
    }
    out += c
    i++
  }
  return out
}

/** 极简 token 化：字符串字面量、标识符（当 key 文本）、以及 { } : 标点。 */
function tokenize(src) {
  const tokens = []
  let i = 0
  while (i < src.length) {
    const c = src[i]
    if (c === '"' || c === "'" || c === '`') {
      let j = i + 1
      let v = ''
      while (j < src.length && src[j] !== c) {
        if (src[j] === '\\') {
          v += src[j + 1] ?? ''
          j += 2
          continue
        }
        v += src[j]
        j++
      }
      tokens.push({ t: 'key', v })
      i = j + 1
      continue
    }
    if (c === '{' || c === '}' || c === ':') {
      tokens.push({ t: c })
      i++
      continue
    }
    if (/[A-Za-z0-9_$]/.test(c)) {
      let j = i
      while (j < src.length && /[A-Za-z0-9_$]/.test(src[j])) j++
      tokens.push({ t: 'key', v: src.slice(i, j) })
      i = j
      continue
    }
    i++
  }
  return tokens
}

/** 从对象字面量抽取叶子路径（`a: { b: 'x' }` → `a.b`）；非对象值不算命名空间。 */
function collectLeafPaths(src, namespace, out) {
  const tokens = tokenize(src)
  const scope = []
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i]
    if (tok.t === '}') {
      scope.pop()
      continue
    }
    if (tok.t === 'key' && tokens[i + 1]?.t === ':') {
      if (tokens[i + 2]?.t === '{') {
        scope.push(tok.v)
      } else {
        out.add([namespace, ...scope, tok.v].join('.'))
      }
      i++ // 跳过 ':'
    }
  }
}

function readLocale(lang) {
  const dir = join(I18N_DIR, lang)
  if (!existsSync(dir)) return null
  const keys = new Set()
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.ts') || name === 'index.ts') continue
    const ns = name.slice(0, -3)
    const src = stripComments(readFileSync(join(dir, name), 'utf8'))
      .replace(/export\s+default/, '')
      .replace(/\bas\s+const\b/g, '')
    collectLeafPaths(src, ns, keys)
  }
  return keys
}

/** 收集 `t('literal')` 的 key 与首个出现位置（整文件扫描，支持跨行实参）。 */
function collectUsedKeys() {
  const used = new Map()
  const files = walk(SRC).filter((p) => /\.(ts|tsx)$/.test(p) && !p.endsWith('.d.ts'))
  for (const file of files) {
    const text = stripComments(readFileSync(file, 'utf8'))
    for (const m of text.matchAll(/\bt\(\s*(['"])([^'"]+)\1/g)) {
      const key = m[2]
      if (!KEY_RE.test(key)) continue
      if (!used.has(key)) {
        const line = text.slice(0, m.index).split('\n').length
        used.set(key, `${relative(ROOT, file)}:${line}`)
      }
    }
  }
  return used
}

const used = collectUsedKeys()
const locales = new Map()
for (const lang of LANGS) {
  const keys = readLocale(lang)
  if (!keys) {
    console.error(`[test-i18n-keys] 缺少语言目录：${lang}`)
    process.exit(1)
  }
  locales.set(lang, keys)
}

const missing = []
for (const [key, where] of used) {
  for (const [lang, keys] of locales) {
    if (!keys.has(key)) missing.push({ key, lang, where })
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
