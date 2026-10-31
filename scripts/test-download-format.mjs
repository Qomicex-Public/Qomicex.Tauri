#!/usr/bin/env node
// Copyright (C) 2026 Qomicex Launcher Contributors
// SPDX-License-Identifier: GPL-3.0-or-later

// src/lib/download-format.ts 的速度回归测试（issue #199）。
//
// 沿用 test-dependency-install-plan.mjs 的模式：用仓库自带的 tsc 编译**真实源码**
// 到临时目录再断言，不引入新依赖，也不抄一份逻辑自证。
//
// 守的回归（对应 issue #199 根因）：REST 进度接口曾不序列化 speed，前端把
// undefined 求和得到 NaN，`NaN <= 0` 为 false，格式化输出 "NaN B/s" 刷屏。
// normalizeSpeed 必须把 NaN / ±Infinity / 负数 / 非数值全部拦成 0，
// formatSpeed 对这些输入必须返回空字符串（界面显示 "—" 占位）而不是拼出单位。

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const source = join(root, 'src', 'lib', 'download-format.ts')
const tsc = join(root, 'node_modules', 'typescript', 'bin', 'tsc')

const outDir = mkdtempSync(join(tmpdir(), 'qmx-dl-format-'))
let checks = 0

/** 断言 helper：失败时打印可读的 expected/actual，而不是只抛一个 assert 栈。 */
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
    [
      tsc,
      source,
      '--outDir',
      outDir,
      '--module',
      'commonjs',
      '--target',
      'es2020',
      '--skipLibCheck',
    ],
    { stdio: 'inherit' },
  )
  const require = createRequire(import.meta.url)
  const { formatSpeed, normalizeSpeed } = require(join(outDir, 'download-format.js'))

  // ---- 1. 脏输入全部归 0（NaN 不得穿透到任何消费方）----
  const dirty = [NaN, Infinity, -Infinity, -1, undefined, null, '1024', {}, true]
  for (const v of dirty) {
    check(`normalizeSpeed(${String(v)}) 归 0`, normalizeSpeed(v), 0)
    check(`formatSpeed(${String(v)}) 为空串`, formatSpeed(v), '')
  }

  // ---- 2. 正常值原样通过 / 按现有阈值格式化 ----
  check('normalizeSpeed(1024) 原样', normalizeSpeed(1024), 1024)
  check('normalizeSpeed(0) 归 0', normalizeSpeed(0), 0)
  check('1024 → KB/s', formatSpeed(1024), '1 KB/s')
  check('1 MiB → MB/s', formatSpeed(1_048_576), '1.0 MB/s')
  check('1 GiB → GB/s', formatSpeed(1_073_741_824), '1.0 GB/s')
  check('512 → B/s', formatSpeed(512), '512 B/s')
  check('0 → 空串（非正值不显示）', formatSpeed(0), '')

  console.log(`\n✓ download-format: ${checks} 项断言通过`)
} finally {
  rmSync(outDir, { recursive: true, force: true })
}
