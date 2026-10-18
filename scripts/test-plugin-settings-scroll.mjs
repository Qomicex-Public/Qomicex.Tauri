#!/usr/bin/env node
// Copyright (C) 2026 Qomicex Launcher Contributors
// SPDX-License-Identifier: GPL-3.0-or-later

// src/plugins/plugin-css.ts 注入插件 iframe 的基础样式（回归护栏）。
//
// 为什么需要它：`html`（根元素）的 overflow 是 visible 时，按 CSS Overflow 的传播规则
// body 的 overflow 会传播给视口。因此 `body{overflow:hidden}` 会让整个插件文档对用户
// 不可滚动 —— 内容高于视口的部分被直接裁掉（长设置页看不见也改不了）。但 `overflow:hidden`
// 仍是**可程序化滚动**的：`window.scrollTo()` 有效、`scrollHeight > clientHeight`，所以
// 只看 DOM 尺寸或程序化滚动会误判为「能滚」，这个回归没有任何报错。
//
// 同时必须保留 body / #root 的 height:100%：插件内部大量依赖 `height:100%` 的布局
// （flex 列 + 内部滚动区），改成 min-height 会让这些插件的百分比高度退化成 auto。
//
// 做法沿用 test-plugin-theme-sync.mjs：用仓库自带 tsc 编译**真实源码**再断言。
//
// 运行：pnpm run test:plugin-settings-scroll

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const source = join(root, 'src', 'plugins', 'plugin-css.ts')
const tsc = join(root, 'node_modules', 'typescript', 'bin', 'tsc')

const outDir = mkdtempSync(join(tmpdir(), 'qmx-settings-scroll-'))
let checks = 0

function check(name, actual, expected) {
  assert.deepEqual(
    actual,
    expected,
    `${name}\n  期望: ${JSON.stringify(expected)}\n  实际: ${JSON.stringify(actual)}`,
  )
  checks += 1
}

/** 取 CSS 文本里第一条 `selector{...}` 的声明块，返回 {decl, prop} 映射。 */
function declarationsOf(css, selector) {
  const rule = new RegExp(`(?:^|[\\n\\s])${selector}\\{([^}]*)\\}`).exec(css)
  assert.ok(rule, `未在 pluginCss 中找到 ${selector} 规则`)
  const decl = {}
  for (const part of rule[1].split(';')) {
    const text = part.trim()
    if (!text) continue
    const at = text.indexOf(':')
    assert.ok(at > 0, `${selector} 中解析不出声明: ${text}`)
    decl[text.slice(0, at).trim()] = text.slice(at + 1).trim()
  }
  return decl
}

const scrollable = (value) => value !== 'hidden' && value !== 'clip'

try {
  execFileSync(
    process.execPath,
    [tsc, source, '--outDir', outDir, '--module', 'commonjs', '--target', 'es2020', '--skipLibCheck'],
    { stdio: 'inherit' },
  )
  const require = createRequire(import.meta.url)
  const { pluginCss } = require(join(outDir, 'plugin-css.js'))

  const body = declarationsOf(pluginCss, 'body')
  const rootRule = declarationsOf(pluginCss, '#root')

  // ---- 核心断言：body 必须允许用户滚动（overflow:hidden 会传播给视口）----
  const vertical = body['overflow-y'] ?? body.overflow
  const horizontal = body['overflow-x'] ?? body.overflow
  check('body 有 overflow 声明', typeof vertical, 'string')
  check('body 纵向可滚动', scrollable(vertical), true)
  check('body 横向不裁掉内容', scrollable(horizontal), true)

  // ---- 兼容断言：保留确定高度，否则插件内部 height:100% 布局会退化 ----
  check('body 保留 height:100%', body.height, '100%')
  check('#root 保留 height:100%', rootRule.height, '100%')

  console.log(`\n[test-plugin-settings-scroll] OK — ${checks} 项断言通过`)
} catch (err) {
  console.error(`\n[test-plugin-settings-scroll] FAILED\n${err?.message ?? err}`)
  process.exitCode = 1
} finally {
  rmSync(outDir, { recursive: true, force: true })
}
