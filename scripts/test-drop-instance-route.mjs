#!/usr/bin/env node
// Copyright (C) 2026 Qomicex Launcher Contributors
// SPDX-License-Identifier: GPL-3.0-or-later

// src/lib/drop-routing.ts 的回归测试（issue #326）。
//
// 锁的是「拖入资源时优先选中当前实例」的判定边界：只有 `/instances/:id` 才算
// 当前实例，其他页面必须回退到固定实例；非法百分号编码不能抛异常打断拖放。
//
// 做法与 test-deep-link-parse.mjs 一致：用仓库自带的 tsc 把真实源码编译到临时
// 目录再断言，不引入测试框架。
//
// 运行：pnpm run test:drop-instance-route

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const source = join(root, 'src', 'lib', 'drop-routing.ts')
const tsc = join(root, 'node_modules', 'typescript', 'bin', 'tsc')

const outDir = mkdtempSync(join(tmpdir(), 'qmx-drop-route-'))
let checks = 0

function check(name, actual, expected) {
  assert.deepEqual(
    actual,
    expected,
    `${name}\n  期望: ${JSON.stringify(expected)}\n  实际: ${JSON.stringify(actual)}`,
  )
  checks += 1
}

try {
  execFileSync(
    process.execPath,
    [tsc, source, '--outDir', outDir, '--module', 'commonjs', '--target', 'es2020', '--skipLibCheck'],
    { stdio: 'inherit' },
  )
  const require = createRequire(import.meta.url)
  const { instanceIdFromPath, orderInstancesByPreferred } = require(join(outDir, 'drop-routing.js'))

  // ---- 命中当前实例 ----
  check('实例详情页', instanceIdFromPath('/instances/gtnh'), 'gtnh')
  check('结尾斜杠', instanceIdFromPath('/instances/gtnh/'), 'gtnh')
  check('带查询串', instanceIdFromPath('/instances/gtnh?tab=mods'), 'gtnh')
  check('百分号编码', instanceIdFromPath('/instances/a%20b'), 'a b')

  // ---- 其他页面必须回退（null）----
  check('根路径', instanceIdFromPath('/'), null)
  check('实例列表', instanceIdFromPath('/instances'), null)
  check('实例列表斜杠', instanceIdFromPath('/instances/'), null)
  check('资源中心', instanceIdFromPath('/resource-center/abc'), null)
  check('空串', instanceIdFromPath(''), null)
  check('非法编码', instanceIdFromPath('/instances/%E0%A4%A'), null)

  // ---- 置顶排序（拖放对话框预选）----
  const list = [{ id: 'a' }, { id: 'b' }, { id: 'c' }]
  check('当前实例置顶', orderInstancesByPreferred(list, 'b').map((i) => i.id), ['b', 'a', 'c'])
  check('首选在首位保持不变', orderInstancesByPreferred(list, 'a').map((i) => i.id), ['a', 'b', 'c'])
  check('未知实例保持原序', orderInstancesByPreferred(list, 'missing'), list)
  check('无首选保持原序', orderInstancesByPreferred(list, null), list)
  // 重复 ID：只置顶第一个命中，其余同 ID 条目保留原序。
  const dupes = [{ id: 'a' }, { id: 'b' }, { id: 'b' }, { id: 'c' }]
  check('重复 ID 不丢条目', orderInstancesByPreferred(dupes, 'b'), [
    { id: 'b' },
    { id: 'a' },
    { id: 'b' },
    { id: 'c' },
  ])

  console.log(`drop-instance-route: ${checks} checks passed`)
} finally {
  rmSync(outDir, { recursive: true, force: true })
}
