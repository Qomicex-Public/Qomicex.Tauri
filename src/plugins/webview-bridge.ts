// Copyright (C) 2026 Qomicex Launcher Contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { listen, emitTo } from '@tauri-apps/api/event'
import { handleApiCall, abortStream } from './sandbox.ts'
import { createL4HostBridge, l4WindowLabel } from './l4-registry-bridge.ts'
import type { RegistryBus } from './l4-registry-bridge.ts'
import { installListeners } from './l4-listener-install.ts'
import type { ListenerRegistrar } from './l4-listener-install.ts'
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
export function initL4Bridge(registrar?: ListenerRegistrar): Promise<void> {
  if (initPromise) return initPromise
  if (!isTauri()) {
    initPromise = Promise.resolve()
    return initPromise
  }

  const registerListener: ListenerRegistrar = registrar
    ?? ((event, handler) => listen(event, handler))

  const l4Label = l4WindowLabel

  // 伪 source：handleApiCall 经 source.postMessage 回传，这里转成发往对应 l4 窗口的事件
  const fakeSource = (pluginId: string) => ({
    postMessage: (msg: Record<string, unknown>) => {
      void emitTo(l4Label(pluginId), 'plugin-l4-api-response', msg).catch(() => { /* 窗口已关闭 */ })
    },
  })

  // 注册表总线只做「发送 + 订阅意图登记」，真正的监听器安装与回滚统一走
  // installListeners（见 l4-listener-install.ts），确保部分失败时不会留下半套监听器。
  const subscriptions: Array<{ event: string; handler: (payload: unknown) => void }> = []
  const registryBus: RegistryBus = {
    send: (event, payload, target) => {
      void emitTo(target, event, payload).catch((e) => {
        // 目标窗口已关闭：调用方那边由超时兜底，这里记一条，避免未处理的 rejection
        console.warn('[plugin] l4 注册表事件发送失败', event, target, e)
      })
    },
    on: (event, handler) => {
      const entry = { event, handler }
      subscriptions.push(entry)
      return () => {
        const idx = subscriptions.indexOf(entry)
        if (idx >= 0) subscriptions.splice(idx, 1)
      }
    },
  }

  // 构造即同步订阅全部注册表事件（写入 subscriptions）
  const hostBridge = createL4HostBridge(registryBus, (pluginId, method, args) => {
    // 注册表要在**回调内部**读取：initL4Bridge 可能在 __pluginRegistry 安装之前执行，
    // 提前取一次会让之后所有代调用都返回「not initialized」。
    const registry = (window as unknown as {
      __pluginRegistry?: { _callWithinWindow: (p: string, m: string, a: unknown[]) => Promise<unknown> }
    }).__pluginRegistry
    // _callWithinWindow 只在本窗口派发（防「主窗口 → l4 → 主窗口」回环），
    // 目标在另一个 l4 窗口时会继续查 l4 桥
    if (!registry?._callWithinWindow) return Promise.reject(new Error('Plugin registry not initialized'))
    return registry._callWithinWindow(pluginId, method, args)
  })

  const apiSubscriptions: Array<{ event: string; handler: (payload: unknown) => void }> = [
    {
      event: 'plugin-l4-api-call',
      handler: (payload) => {
        const { pluginId, id, method, args } = payload as { pluginId: string; id: string; method: string; args: unknown[] }
        handleApiCall(id, method, args, pluginId, fakeSource(pluginId) as unknown as Window)
      },
    },
    {
      event: 'plugin-l4-api-abort',
      handler: (payload) => {
        abortStream((payload as { id: string }).id)
      },
    },
  ]

  initPromise = installListeners(registerListener, [...apiSubscriptions, ...subscriptions]).then((installed) => {
    if (!installed.ok) {
      // 监听器缺失时装配桥等于「永远收不到回执」：宁可让调用方走本地 registry
      // 快速失败，也不要静默等 30s 超时。installListeners 已回滚已成功的监听器，
      // 因此这里可以安全地清空初始化状态等待重试（不会叠加两套）。
      console.warn('[plugin] l4 桥监听器注册失败，本次不启用 l4 注册表桥', installed.error)
      hostBridge.dispose()
      initPromise = null
      return
    }
    setL4HostBridge(hostBridge)
  })

  return initPromise
}
