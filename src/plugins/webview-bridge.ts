// Copyright (C) 2026 Qomicex Launcher Contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { listen, emitTo } from '@tauri-apps/api/event'
import { handleApiCall, abortStream } from './sandbox.ts'
import { createL4HostBridge } from './l4-registry-bridge.ts'
import type { RegistryBus } from './l4-registry-bridge.ts'
import { setL4HostBridge } from './l4-registry.ts'

/**
 * l4 主窗口侧桥：接收插件独立 WebView 窗口转发的 `__plugin_api_call`（经 Tauri
 * 事件 `plugin-l4-api-call`），在主窗口执行真实桥（权限校验 + executePluginMethod），
 * 再把 `__plugin_api_response` 经事件回传。消息体复用 sandbox.ts 的 postMessage
 * 协议（{type,id,method,args} / {type,id,result,error}），仅传输层换成跨窗口事件。
 *
 * 同一个通道还承载插件注册表桥（见 l4-registry-bridge.ts）：l4 插件的
 * `registerMethod` 登记在主窗口，主窗口 `callPlugin` 也能打到 l4 窗口里执行。
 *
 * 为什么不用 window.opener postMessage：Tauri 子 WebviewWindow 由 IPC
 * `create_webview_window` 创建（非 window.open），opener 为 null，跨窗口可靠的
 * 通道是 `emitTo`/`listen` 事件系统（core:event 默认允许）。
 */
const isTauri = () => typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window

/** 初始化 Promise：全部监听器装好后 resolve，创建 l4 窗口前必须 await。 */
let initPromise: Promise<void> | null = null

/**
 * 初始化 l4 桥（幂等）。
 *
 * 返回 Promise 是必要的：`listen()` 是异步的，窗口若在监听器装好前就创建，插件前端
 * 抢先发出的 register / call 事件没有接收方会被直接丢弃 —— 主窗口永远不知道插件提供
 * 了哪些方法，调用方只会看到「未提供方法」或超时。
 */
export function initL4Bridge(): Promise<void> {
  if (initPromise) return initPromise
  if (!isTauri()) {
    initPromise = Promise.resolve()
    return initPromise
  }

  /** 所有 `listen()` 的解析 Promise：初始化完成 = 它们全部就绪。 */
  const pendingListeners: Promise<unknown>[] = []

  const l4Label = (pluginId: string) => `plugin-webview-${pluginId}`

  // 伪 source：handleApiCall 经 source.postMessage 回传，这里转成发往对应 l4 窗口的事件
  const fakeSource = (pluginId: string) => ({
    postMessage: (msg: Record<string, unknown>) => {
      void emitTo(l4Label(pluginId), 'plugin-l4-api-response', msg).catch(() => { /* 窗口已关闭 */ })
    },
  })

  const registryBus: RegistryBus = {
    send: (event, payload, target) => {
      void emitTo(target, event, payload).catch((e) => {
        // 目标窗口已关闭：调用方那边由超时兜底，这里记一条，避免未处理的 rejection
        console.warn('[plugin] l4 注册表事件发送失败', event, target, e)
      })
    },
    on: (event, handler) => {
      let disposed = false
      let unlisten: (() => void) | null = null
      const ready = listen(event, (e) => handler(e.payload))
      pendingListeners.push(ready)
      ready.then((fn) => {
        // listen 是异步的：解析完成前就退订时立刻解绑，避免监听器泄漏
        if (disposed) fn()
        else unlisten = fn
      }).catch((e) => {
        console.warn('[plugin] l4 注册表事件监听失败', event, e)
      })
      return () => {
        disposed = true
        if (unlisten) {
          unlisten()
          unlisten = null
        }
      }
    },
  }

  pendingListeners.push(
    listen('plugin-l4-api-call', (e) => {
      const { pluginId, id, method, args } = e.payload as { pluginId: string; id: string; method: string; args: unknown[] }
      handleApiCall(id, method, args, pluginId, fakeSource(pluginId) as unknown as Window)
    }),
    listen('plugin-l4-api-abort', (e) => {
      abortStream((e.payload as { id: string }).id)
    }),
  )

  // 构造即同步订阅全部注册表事件（把各自的 listen() 塞进 pendingListeners）
  const hostBridge = createL4HostBridge(registryBus, (pluginId, method, args) => {
    const registry = (window as unknown as {
      __pluginRegistry?: { _callWithinWindow: (p: string, m: string, a: unknown[]) => Promise<unknown> }
    }).__pluginRegistry
    // _callWithinWindow 只在本窗口派发（防「主窗口 → l4 → 主窗口」回环），
    // 目标在另一个 l4 窗口时会继续查 l4 桥
    if (!registry?._callWithinWindow) return Promise.reject(new Error('Plugin registry not initialized'))
    return registry._callWithinWindow(pluginId, method, args)
  })

  initPromise = Promise.all(pendingListeners.map((p) => p.catch(() => {}))).then(() => {
    setL4HostBridge(hostBridge)
  })

  return initPromise
}
