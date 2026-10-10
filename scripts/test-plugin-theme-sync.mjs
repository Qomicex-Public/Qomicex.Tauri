#!/usr/bin/env node
// src/plugins/plugin-css.ts 主题同步注册/注销配对的回归测试（issue #236）。
//
// 为什么需要它：`registerThemeSync(iframe)` 的返回值在 onload 回调 / React effect
// 这类调用点上极易被丢弃。丢弃后 iframe 永久留在模块级 `themeSyncTargets` 里 ——
// 每次插件启用/禁用都泄漏一个 iframe 及其整棵 DOM，主题变化还会向已卸载的 iframe
// postMessage（ADR-049 要求「插件激活的全局副作用必须与停用成对清理」）。
// 这类泄漏没有任何报错，UI 上也不会立刻显现，必须钉住。
//
// 做法沿用 test-deep-link-parse.mjs：用仓库自带 tsc 把**真实源码**编译到临时目录再断言
// （plugin-css.ts 无 import，可独立编译）。DOM 用最小 stub 顶替。
//
// 运行：pnpm run test:plugin-theme-sync

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

const outDir = mkdtempSync(join(tmpdir(), 'qmx-theme-sync-'))
let checks = 0

function check(name, actual, expected) {
  assert.deepEqual(
    actual,
    expected,
    `${name}\n  期望: ${JSON.stringify(expected)}\n  实际: ${JSON.stringify(actual)}`,
  )
  checks += 1
}

/** 最小 DOM stub：只覆盖 plugin-css.ts 用到的部分（classList / getComputedStyle / MutationObserver）。 */
function installDomStub() {
  const rootEl = {
    classList: {
      _s: new Set(),
      contains(c) {
        return this._s.has(c)
      },
      toggle(c, on) {
        if (on) this._s.add(c)
        else this._s.delete(c)
      },
    },
    style: { _p: {}, setProperty(k, v) { this._p[k] = v } },
  }
  globalThis.document = { documentElement: rootEl }
  globalThis.getComputedStyle = () => ({ getPropertyValue: () => '' })
  globalThis.MutationObserver = class {
    constructor(cb) {
      this.cb = cb
    }
    observe() {
      this.observing = true
    }
    disconnect() {
      this.observing = false
    }
  }
}

try {
  execFileSync(
    process.execPath,
    [tsc, source, '--outDir', outDir, '--module', 'commonjs', '--target', 'es2020', '--skipLibCheck'],
    { stdio: 'inherit' },
  )
  installDomStub()
  const require = createRequire(import.meta.url)
  const { registerThemeSync, unregisterThemeSync, themeSyncTargetCount } = require(
    join(outDir, 'plugin-css.js'),
  )

  /** 造一个带 contentWindow.postMessage 计数的最小 iframe。 */
  function fakeIframe() {
    const posted = []
    return {
      posted,
      contentWindow: {
        postMessage(msg) {
          posted.push(msg)
        },
      },
    }
  }

  // ---- 基线 ----
  check('初始无持有', themeSyncTargetCount(), 0)

  // ---- 注册后持有；注销后归还基线（#236 的核心断言）----
  const a = fakeIframe()
  const unsubA = registerThemeSync(a)
  check('注册后持有 1 个', themeSyncTargetCount(), 1)
  unsubA()
  check('注销后回到基线', themeSyncTargetCount(), 0)

  // ---- 启用 → 禁用 循环 N 次，持有数必须回到基线（泄漏的直接体现）----
  const N = 25
  for (let i = 0; i < N; i += 1) {
    const f = fakeIframe()
    const unsub = registerThemeSync(f)
    check(`第 ${i} 次注册后持有 1 个`, themeSyncTargetCount(), 1)
    unsub()
  }
  check(`${N} 次启用/禁用循环后持有数回到基线`, themeSyncTargetCount(), 0)

  // ---- unregisterThemeSync 幂等：重复注销不报错、不会误伤他人 ----
  const b = fakeIframe()
  const c = fakeIframe()
  registerThemeSync(b)
  registerThemeSync(c)
  check('两个 iframe 同时持有', themeSyncTargetCount(), 2)
  unregisterThemeSync(b)
  unregisterThemeSync(b) // 幂等
  check('重复注销后仍剩 1 个', themeSyncTargetCount(), 1)
  unregisterThemeSync(c)
  check('全部注销后回到基线', themeSyncTargetCount(), 0)

  // ---- 同一 iframe 重复注册不得叠加（否则一次注销只减 1，仍泄漏）----
  const d = fakeIframe()
  registerThemeSync(d)
  registerThemeSync(d)
  check('重复注册同一 iframe 只算一次', themeSyncTargetCount(), 1)
  unregisterThemeSync(d)
  check('一次注销即释放', themeSyncTargetCount(), 0)

  // ---- 已销毁的 iframe 不应再收到主题消息 ----
  const e = fakeIframe()
  registerThemeSync(e)
  e.posted.length = 0
  unregisterThemeSync(e)
  // 触发一次主题变化（改 classList 走 MutationObserver 的 push 路径不可用时，
  // 直接再注册一个以验证 push 不会送到已注销的 e）
  const f = fakeIframe()
  registerThemeSync(f)
  check('已注销的 iframe 不再收到主题消息', e.posted.length, 0)
  check('新注册的 iframe 收到主题消息', f.posted.length > 0, true)
  unregisterThemeSync(f)
  check('收尾回到基线', themeSyncTargetCount(), 0)

  console.log(`\n[test-plugin-theme-sync] OK — ${checks} 项断言通过`)
} catch (err) {
  console.error(`\n[test-plugin-theme-sync] FAILED\n${err?.message ?? err}`)
  process.exitCode = 1
} finally {
  rmSync(outDir, { recursive: true, force: true })
}
