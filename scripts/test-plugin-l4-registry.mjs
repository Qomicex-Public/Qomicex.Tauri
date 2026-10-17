#!/usr/bin/env node
// Copyright (C) 2026 Qomicex Launcher Contributors
// SPDX-License-Identifier: GPL-3.0-or-later

// src/plugins/l4-registry-bridge.ts 的回归测试（issue #260）。
//
// 为什么需要它：l4 插件的前端跑在独立 WebviewWindow 里，那个窗口自己就是
// `window.top`，注册表会把它当 host，方法只登记进该窗口的 __pluginSources。主窗口
// `callPlugin` 于是永远报「未提供方法」—— 和 iframe 宿主不挂载是同一类静默失效，
// 只是换了个窗口边界。这个桥用 Tauri 事件在两者之间补上登记与转发，逻辑纯函数化后
// 可以脱离 Tauri 运行时验证。
//
// 做法沿用 test-plugin-theme-sync.mjs：用仓库自带 tsc 编译**真实源码**再断言
// （l4-registry-bridge.ts 无运行时 import）。
//
// 运行：pnpm run test:plugin-l4-registry

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const source = join(root, 'src', 'plugins', 'l4-registry-bridge.ts')
const tsc = join(root, 'node_modules', 'typescript', 'bin', 'tsc')

const outDir = mkdtempSync(join(tmpdir(), 'qmx-l4-registry-'))
let checks = 0

function check(name, actual, expected) {
  assert.deepEqual(
    actual,
    expected,
    `${name}\n  期望: ${JSON.stringify(expected)}\n  实际: ${JSON.stringify(actual)}`,
  )
  checks += 1
}

/**
 * 内存总线：模拟 Tauri 事件系统。`send` 按 target 定向投递，异步派发（与真实事件
 * 一致，调用方不能假设同步完成）。
 */
function createMemoryBus() {
  const listeners = new Map() // `${target}::${event}` → Set<handler>
  const sent = []
  return {
    sent,
    forWindow(label) {
      return {
        send: (event, payload, target) => {
          sent.push({ from: label, event, target, payload })
          queueMicrotask(() => {
            const set = listeners.get(`${target}::${event}`)
            if (!set) return
            for (const h of [...set]) h(payload)
          })
        },
        on: (event, handler) => {
          const key = `${label}::${event}`
          const set = listeners.get(key) ?? new Set()
          set.add(handler)
          listeners.set(key, set)
          return () => {
            set.delete(handler)
            if (set.size === 0) listeners.delete(key)
          }
        },
      }
    },
  }
}

const flush = () => new Promise((r) => setTimeout(r, 0))

try {
  execFileSync(
    process.execPath,
    [tsc, source, '--outDir', outDir, '--module', 'commonjs', '--target', 'es2020', '--skipLibCheck'],
    { stdio: 'inherit' },
  )
  const require = createRequire(import.meta.url)
  const { createL4HostBridge, createL4NodeBridge, l4WindowLabel, L4_REGISTRY_EVENTS } = require(
    join(outDir, 'l4-registry-bridge.js'),
  )

  const PLUGIN = 'top.qomicex.l4demo'
  const label = l4WindowLabel(PLUGIN)

  // ---- 窗口 label 约定：与 plugin-loader 创建的窗口一致 ----
  check('l4 窗口 label 约定', label, `plugin-webview-${PLUGIN}`)

  // ---- 场景 1：l4 注册方法 → 主窗口调用成功往返 ----
  {
    const bus = createMemoryBus()
    const main = bus.forWindow('main')
    const node = bus.forWindow(label)

    const host = createL4HostBridge(main, async () => { throw new Error('不该走 iframe 路径') })
    const l4 = createL4NodeBridge(node, async (pluginId, method, args) => `${pluginId}.${method}(${args.join(',')})`)

    check('注册前 host.has 为 false', host.has(PLUGIN), false)
    l4.register(PLUGIN, 'greet')
    await flush()
    check('注册后 host.has 为 true', host.has(PLUGIN), true)

    const result = await host.call(PLUGIN, 'greet', ['a', 'b'])
    check('主窗口调用 l4 方法返回结果', result, `${PLUGIN}.greet(a,b)`)

    // 定向投递给该 l4 窗口，而不是广播
    const callEvent = bus.sent.find((m) => m.event === L4_REGISTRY_EVENTS.call)
    check('调用事件定向到对应 l4 窗口', callEvent.target, label)

    host.dispose()
    l4.dispose()
  }

  // ---- 场景 2：l4 插件反向调用第三方插件（经主窗口代调用）----
  {
    const bus = createMemoryBus()
    const main = bus.forWindow('main')
    const node = bus.forWindow(label)
    const proxied = []

    const host = createL4HostBridge(main, async (pluginId, method, args) => {
      proxied.push({ pluginId, method, args })
      return `proxied:${pluginId}:${method}`
    })
    const l4 = createL4NodeBridge(node, async () => { throw new Error('不该走本地') })

    const result = await l4.callRemote('top.qomicex.markdown', 'renderMarkdown', ['# hi'], PLUGIN)
    check('l4 反向调用拿到主窗口结果', result, 'proxied:top.qomicex.markdown:renderMarkdown')
    check('主窗口收到代调用目标', proxied[0].pluginId, 'top.qomicex.markdown')
    check('主窗口收到代调用参数', proxied[0].args, ['# hi'])

    host.dispose()
    l4.dispose()
  }

  // ---- 场景 3：方法内部抛错 → 错误信息跨窗口回传，不变成「无响应」----
  {
    const bus = createMemoryBus()
    const main = bus.forWindow('main')
    const node = bus.forWindow(label)

    const host = createL4HostBridge(main, async () => {})
    const l4 = createL4NodeBridge(node, async () => { throw new Error('插件内部炸了') })

    l4.register(PLUGIN, 'boom')
    await flush()
    let caught = null
    try {
      await host.call(PLUGIN, 'boom', [])
    } catch (e) {
      caught = e.message
    }
    check('l4 方法抛错被回传为 reject', caught, '插件内部炸了')

    host.dispose()
    l4.dispose()
  }

  // ---- 场景 3b：方法**同步**抛错（不是 async）→ 同样必须回执，不能等超时 ----
  {
    const bus = createMemoryBus()
    const main = bus.forWindow('main')
    const node = bus.forWindow(label)

    const host = createL4HostBridge(main, async () => {}, { timeoutMs: 50 })
    const l4 = createL4NodeBridge(node, () => { throw new Error('同步抛出') }, { timeoutMs: 50 })

    l4.register(PLUGIN, 'syncBoom')
    await flush()
    let caught = null
    try {
      await host.call(PLUGIN, 'syncBoom', [])
    } catch (e) {
      caught = e.message
    }
    check('同步抛错被回传为 reject（而非超时）', caught, '同步抛出')

    host.dispose()
    l4.dispose()
  }

  // ---- 场景 3c：代调用目标同步抛错 → l4 侧收到 reject，不能挂起 ----
  {
    const bus = createMemoryBus()
    const main = bus.forWindow('main')
    const node = bus.forWindow(label)

    const host = createL4HostBridge(main, () => { throw new Error('代调用同步炸了') }, { timeoutMs: 50 })
    const l4 = createL4NodeBridge(node, async () => {}, { timeoutMs: 50 })

    let caught = null
    try {
      await l4.callRemote('some.plugin', 'x', [], PLUGIN)
    } catch (e) {
      caught = e.message
    }
    check('代调用同步抛错回传为 reject（而非超时）', caught, '代调用同步炸了')

    host.dispose()
    l4.dispose()
  }

  // ---- 场景 4：未注册的方法与未登记的插件，错误文案与本地注册表一致 ----
  {
    const bus = createMemoryBus()
    const main = bus.forWindow('main')
    const node = bus.forWindow(label)
    const host = createL4HostBridge(main, async () => {})
    const l4 = createL4NodeBridge(node, async () => {})

    let unknownPlugin = null
    try {
      await host.call(PLUGIN, 'nope', [])
    } catch (e) {
      unknownPlugin = e.message
    }
    check('未登记的 l4 插件报「未提供方法」', unknownPlugin, `插件 ${PLUGIN} 未提供方法 nope`)

    l4.register(PLUGIN, 'other')
    await flush()
    let unknownMethod = null
    try {
      await host.call(PLUGIN, 'nope', [])
    } catch (e) {
      unknownMethod = e.message
    }
    check('已登记插件但方法不匹配时同样明确报错', unknownMethod, `插件 ${PLUGIN} 未提供方法 nope`)

    host.dispose()
    l4.dispose()
  }

  // ---- 场景 5：l4 窗口被直接关闭（无回执）→ 超时 reject，不永久挂起 ----
  {
    const bus = createMemoryBus()
    const main = bus.forWindow('main')
    const node = bus.forWindow(label)
    const host = createL4HostBridge(main, async () => {}, { timeoutMs: 60 })
    const l4 = createL4NodeBridge(node, async () => {})

    l4.register(PLUGIN, 'hang')
    await flush()
    l4.dispose() // 模拟窗口消失：不再接收/回执

    let timedOut = null
    try {
      await host.call(PLUGIN, 'hang', [])
    } catch (e) {
      timedOut = e.message
    }
    check('无回执时超时报错而非挂起', timedOut, `插件 ${PLUGIN} 的方法 hang 调用超时（独立窗口无响应）`)

    host.dispose()
  }

  // ---- 场景 6：同一插件重复注册（前端热更新/重载）不叠加，调用仍只发一次 ----
  {
    const bus = createMemoryBus()
    const main = bus.forWindow('main')
    const node = bus.forWindow(label)
    const host = createL4HostBridge(main, async () => {})
    const l4 = createL4NodeBridge(node, async () => 'ok')

    l4.register(PLUGIN, 'greet')
    l4.register(PLUGIN, 'greet')
    await flush()
    const before = bus.sent.filter((m) => m.event === L4_REGISTRY_EVENTS.call).length
    await host.call(PLUGIN, 'greet', [])
    const after = bus.sent.filter((m) => m.event === L4_REGISTRY_EVENTS.call).length
    check('重复注册后一次调用只发一条事件', after - before, 1)

    l4.unregister(PLUGIN)
    await flush()
    check('注销后 host.has 为 false', host.has(PLUGIN), false)

    host.dispose()
    l4.dispose()
  }

  // ---- 场景 7：dispose 后不再处理事件，挂起的调用被 reject（插件禁用/窗口关闭）----
  {
    const bus = createMemoryBus()
    const main = bus.forWindow('main')
    const node = bus.forWindow(label)
    const host = createL4HostBridge(main, async () => {}, { timeoutMs: 60 })
    const l4 = createL4NodeBridge(node, async () => {})

    l4.register(PLUGIN, 'greet')
    await flush()
    const pending = host.call(PLUGIN, 'greet', [])
    host.dispose()
    let disposeError = null
    try {
      await pending
    } catch (e) {
      disposeError = e.message
    }
    check('dispose 让在途调用立即失败', disposeError, 'l4 注册表桥已销毁')

    l4.dispose()
  }

  console.log(`\n[test-plugin-l4-registry] OK — ${checks} 项断言通过`)
} catch (err) {
  console.error(`\n[test-plugin-l4-registry] FAILED\n${err?.message ?? err}`)
  process.exitCode = 1
} finally {
  rmSync(outDir, { recursive: true, force: true })
}
