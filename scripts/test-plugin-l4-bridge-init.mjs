#!/usr/bin/env node
// Copyright (C) 2026 Qomicex Launcher Contributors
// SPDX-License-Identifier: GPL-3.0-or-later

// src/plugins/l4-listener-install.ts 的回归（issue #260）。
//
// 为什么需要它：l4 桥初始化要求「全部监听器就绪才启用」。部分失败时若不回滚已成功
// 的监听器，调用方重置初始化状态重试后会叠加出两套，同一个 plugin-l4-api-call 被
// 处理两次 —— 写文件、发请求这类非幂等操作会产生重复副作用。这类缺陷只在异常路径
// 出现，人工测试几乎碰不到，必须钉住。
//
// 做法沿用 test-plugin-l4-registry.mjs：用仓库自带 tsc 编译真实源码再断言。
// 运行：pnpm run test:plugin-l4-bridge-init

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const source = join(root, 'src', 'plugins', 'l4-listener-install.ts')
const tsc = join(root, 'node_modules', 'typescript', 'bin', 'tsc')
const outDir = mkdtempSync(join(tmpdir(), 'qmx-l4-listener-'))
let checks = 0

function check(name, actual, expected) {
  assert.deepEqual(actual, expected, `${name}\n  期望: ${JSON.stringify(expected)}\n  实际: ${JSON.stringify(actual)}`)
  checks += 1
}

/** 可配置失败的 registrar：记录注册与解绑，便于断言回滚。 */
function createRegistrar(failOn = []) {
  const registered = []
  const unlistened = []
  return {
    registered,
    unlistened,
    active: () => registered.filter((r) => r.active),
    registrar: async (event, handler) => {
      if (failOn.includes(event)) throw new Error(`listen 失败: ${event}`)
      const entry = { event, handler, active: true }
      registered.push(entry)
      return () => {
        entry.active = false
        unlistened.push(event)
      }
    },
  }
}

const SUBS = [
  { event: 'plugin-l4-api-call', handler: () => {} },
  { event: 'plugin-l4-api-abort', handler: () => {} },
  { event: 'plugin-l4-registry-call', handler: () => {} },
]

try {
  execFileSync(
    process.execPath,
    [tsc, source, '--outDir', outDir, '--module', 'commonjs', '--target', 'es2020', '--skipLibCheck'],
    { stdio: 'inherit' },
  )
  const require = createRequire(import.meta.url)
  const exports = require(join(outDir, 'l4-listener-install.js'))
  check('导出 installListeners', typeof exports.installListeners, 'function')
  const { installListeners } = exports

  // ---- 全部成功：ok，全部保持活跃；unlisten 一次全部释放 ----
  {
    const r = createRegistrar()
    const result = await installListeners(r.registrar, SUBS)
    check('全部成功 ok=true', result.ok, true)
    check('全部成功时监听器都活跃', r.active().length, SUBS.length)
    result.unlisten()
    check('unlisten 后全部解绑', r.active().length, 0)
    check('unlisten 覆盖每个事件', r.unlistened.length, SUBS.length)
  }

  // ---- 部分失败：ok=false，且已成功的必须回滚（这是重试不重复注册的前提）----
  {
    const r = createRegistrar(['plugin-l4-api-abort'])
    const result = await installListeners(r.registrar, SUBS)
    check('部分失败 ok=false', result.ok, false)
    check('部分失败后不留活跃监听器', r.active().length, 0)
    check('失败时回滚了已成功的监听器', r.unlistened.length, SUBS.length - 1)
    check('失败时带出错误原因', result.error instanceof Error, true)
  }

  // ---- 失败后重试：新一套注册，且总活跃数等于一套（不叠加）----
  {
    const first = createRegistrar(['plugin-l4-registry-call'])
    const r1 = await installListeners(first.registrar, SUBS)
    check('首轮失败', r1.ok, false)
    const second = createRegistrar()
    const r2 = await installListeners(second.registrar, SUBS)
    check('重试成功', r2.ok, true)
    check('重试后只有一套活跃监听器', second.active().length, SUBS.length)
    check('首轮监听器已全部解绑', first.active().length, 0)
  }

  // ---- 空订阅：视为成功，unlisten 安全 ----
  {
    const r = createRegistrar()
    const result = await installListeners(r.registrar, [])
    check('空订阅 ok=true', result.ok, true)
    result.unlisten()
    check('空订阅 unlisten 不抛错', r.unlistened.length, 0)
  }

  console.log(`\n[test-plugin-l4-bridge-init] OK — ${checks} 项断言通过`)
} catch (err) {
  console.error(`\n[test-plugin-l4-bridge-init] FAILED\n${err?.message ?? err}`)
  process.exitCode = 1
} finally {
  rmSync(outDir, { recursive: true, force: true })
}
