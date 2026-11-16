#!/usr/bin/env node
// Copyright (C) 2026 Qomicex Launcher Contributors
// SPDX-License-Identifier: GPL-3.0-or-later

// src/hooks/listEnterSelection.ts 的回归测试（issue #355）。
// 锁住「追加分页只动画新增项，不从列表顶部重播」这一判定，防止未来改动退化。
// 做法与 test-deep-link-parse.mjs 一致：用仓库自带 tsc 把真实源码编译到临时目录再断言。
//
// 运行：pnpm run test:list-enter-selection

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const source = join(root, 'src', 'hooks', 'listEnterSelection.ts')
const tsc = join(root, 'node_modules', 'typescript', 'bin', 'tsc')

const outDir = mkdtempSync(join(tmpdir(), 'qmx-list-enter-'))
let checks = 0

function check(name, actual, expected) {
  assert.deepEqual(
    actual,
    expected,
    `${name}\n  期望: ${JSON.stringify(expected)}\n  实际: ${JSON.stringify(actual)}`,
  )
  checks += 1
}

const el = (key) => ({ dataset: { key } })
const keys = (items) => items.map((i) => i.dataset.key)

try {
  execFileSync(
    process.execPath,
    [tsc, source, '--outDir', outDir, '--module', 'commonjs', '--target', 'es2020', '--skipLibCheck'],
    { stdio: 'inherit' },
  )
  const require = createRequire(import.meta.url)
  const { selectEnterItems } = require(join(outDir, 'listEnterSelection.js'))

  // 首屏：prev 为空 → 动画前 max 个（覆盖首屏），其余保持最终态
  const first = [el('a'), el('b'), el('c'), el('d')]
  check('首屏取前 max 个', keys(selectEnterItems(first, [], 3)), ['a', 'b', 'c'])

  // 追加分页：只新增底部两项 → 只动画这两项，顶部旧项不再重播（issue #355 核心）
  const before = [el('a'), el('b')]
  const appended = [el('a'), el('b'), el('c'), el('d')]
  check('追加只动画新增项', keys(selectEnterItems(appended, before, 35)), ['c', 'd'])

  // 整页替换：key 全变 → 动画新一批的前 max 个
  const replaced = [el('x'), el('y'), el('z')]
  check('整页替换动画新一批', keys(selectEnterItems(replaced, before, 2)), ['x', 'y'])

  // 纯删除 / 重排（无新增）：不重播任何入场动画
  check('纯删除不重播', keys(selectEnterItems([el('a')], before, 35)), [])
  check('重排不重播', keys(selectEnterItems([el('b'), el('a')], before, 35)), [])

  // 新增超过 max：仍只动画前 max 个（限动视口，避免大量 blur 卡片同时进 tween）
  const many = [el('a'), ...Array.from({ length: 40 }, (_, i) => el(`n${i}`))]
  check('新增超上限截断', keys(selectEnterItems(many, before, 35)).length, 35)

  // 无 data-key 的项不参与 diff（调用方契约：子元素必须带 data-key）
  const keyless = [{ dataset: {} }, el('a'), el('b')]
  check('忽略无 key 项', keys(selectEnterItems(keyless, [el('a')], 35)), ['b'])

  console.log(`test-list-enter-selection: ${checks} checks passed`)
} finally {
  rmSync(outDir, { recursive: true, force: true })
}
