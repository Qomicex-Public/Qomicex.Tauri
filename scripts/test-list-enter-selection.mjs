#!/usr/bin/env node
// Copyright (C) 2026 Qomicex Launcher Contributors
// SPDX-License-Identifier: GPL-3.0-or-later

// src/hooks/listDiff.ts 的差分回归（不含动画播放本身）：
//  1. 追加分页只动画新增项，不从列表顶部重播（issue #355 的原始回归）
//  2. 头/中/尾插入都能算出 enter，且已有项产生 move（FLIP 让位）
//  3. 整组替换（分组/分类切换）不再逐项播 70 条动画
// 播放层决策（尾部追加跳过 FLIP）由 isTailAppend 锁定；头/中插入返回 false。
// 做法与 test-deep-link-parse.mjs 一致：用仓库自带 tsc 编译真实源码到临时目录再断言。
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
const source = join(root, 'src', 'hooks', 'listDiff.ts')
const tsc = join(root, 'node_modules', 'typescript', 'bin', 'tsc')

const outDir = mkdtempSync(join(tmpdir(), 'qmx-list-diff-'))
let checks = 0

function check(name, actual, expected) {
  assert.deepEqual(
    actual,
    expected,
    `${name}\n  期望: ${JSON.stringify(expected)}\n  实际: ${JSON.stringify(actual)}`,
  )
  checks += 1
}

const item = (key, top, left = 0) => ({ key, top, left })
const keys = (list) => list.map((k) => (typeof k === 'string' ? k : k.key))

try {
  execFileSync(
    process.execPath,
    [tsc, source, '--outDir', outDir, '--module', 'commonjs', '--target', 'es2020', '--skipLibCheck'],
    { stdio: 'inherit' },
  )
  const require = createRequire(import.meta.url)
  const { computeListDiff, isTailAppend } = require(join(outDir, 'listDiff.js'))

  // 首屏：prev 为空 → 全部按新增处理（调用方再截断到 35）
  const first = computeListDiff([], [item('a', 0), item('b', 100)])
  check('首屏全部新增', first.enter, ['a', 'b'])
  check('首屏无退场', first.exit, [])
  check('首屏不判定为替换', first.replace, false)

  // 追加分页：只新增底部两项，旧项位置不变 → 不重播、不移动（issue #355）
  const appended = computeListDiff(
    [item('a', 0), item('b', 100)],
    [item('a', 0), item('b', 100), item('c', 200), item('d', 300)],
  )
  check('追加只动画新增项', appended.enter, ['c', 'd'])
  check('追加不重播旧项', appended.move, [])
  check('追加无退场', appended.exit, [])

  // 头部插入：新项 enter，已有项整体下移 → 每个旧项都要 FLIP
  const head = computeListDiff(
    [item('a', 100), item('b', 200)],
    [item('x', 0), item('a', 200), item('b', 300)],
  )
  check('头部插入产生新项', head.enter, ['x'])
  check('头部插入让旧项下移', keys(head.move), ['a', 'b'])
  check('头部插入的位移量', head.move.map((m) => m.dy), [-100, -100])

  // 中间插入：只有插入点之后的项移动
  const middle = computeListDiff(
    [item('a', 0), item('b', 100), item('c', 200)],
    [item('a', 0), item('x', 100), item('b', 200), item('c', 300)],
  )
  check('中间插入产生新项', middle.enter, ['x'])
  check('中间插入只移动受影响项', keys(middle.move), ['b', 'c'])

  // 尾部插入：旧项不动
  const tail = computeListDiff(
    [item('a', 0)],
    [item('a', 0), item('z', 100)],
  )
  check('尾部插入只有新项', tail.enter, ['z'])
  check('尾部插入不移动旧项', tail.move, [])

  // 删除中间项：该项退场，后面的项上移
  const remove = computeListDiff(
    [item('a', 0), item('b', 100), item('c', 200)],
    [item('a', 0), item('c', 100)],
  )
  check('删除产生退场', remove.exit, ['b'])
  check('删除后后续项上移', keys(remove.move), ['c'])
  check('删除后位移量', remove.move[0].dy, 100)

  // 整组替换（分组切换）：新旧 key 无交集 → 不逐项播
  const replace = computeListDiff(
    [item('a', 0), item('b', 100), item('c', 200), item('d', 300)],
    [item('x', 0), item('y', 100), item('z', 200)],
  )
  check('整组替换判定', replace.replace, true)
  check('整组替换仍有 enter 列表', replace.enter, ['x', 'y', 'z'])

  // 交集 40%（2/5）高于阈值 0.35 → 仍按逐项处理
  const partial = computeListDiff(
    [item('a', 0), item('b', 100), item('c', 200), item('d', 300), item('e', 400)],
    [item('a', 0), item('b', 100), item('x', 200)],
  )
  check('交集 40% 不判定替换', partial.replace, false)

  // 亚像素抖动不产生移动
  const jitter = computeListDiff(
    [item('a', 100.2)],
    [item('a', 100.0)],
  )
  check('0.2px 抖动不移动', jitter.move, [])

  // 搜索/筛选：只是子集消失，没有新 key → 不能判定为整组替换（否则剩余项会重播淡入）
  const filtered = computeListDiff(
    [item('a', 0), item('b', 100), item('c', 200), item('d', 300), item('e', 400)],
    [item('a', 0), item('b', 100)],
  )
  check('搜索过滤不判定替换', filtered.replace, false)
  check('搜索过滤只产生退场', filtered.enter, [])
  check('搜索过滤的退场项', filtered.exit, ['c', 'd', 'e'])

  // 尾部追加判定：只有「旧序列是新序列前缀」才算追加，头/中插入必须继续跑 FLIP
  check('尾部追加判定', isTailAppend(['a', 'b'], ['a', 'b', 'c']), true)
  check('头部插入不算追加', isTailAppend(['a', 'b'], ['x', 'a', 'b']), false)
  check('中间插入不算追加', isTailAppend(['a', 'b'], ['a', 'x', 'b']), false)
  check('数量不变不算追加', isTailAppend(['a', 'b'], ['a', 'b']), false)

  // 写入快照后位置稳定：第二次相同输入不产生任何动作
  const stable = computeListDiff([item('a', 10)], [item('a', 10)])
  check('位置不变无动作', [stable.enter.length, stable.exit.length, stable.move.length], [0, 0, 0])

  console.log(`test-list-enter-selection: ${checks} checks passed`)
} finally {
  rmSync(outDir, { recursive: true, force: true })
}
