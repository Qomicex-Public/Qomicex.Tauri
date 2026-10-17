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

let initialized = false

/**
 * 用 Tauri 事件实现注册表总线：主窗口按 label 定向发送，l4 窗口统一发往 `main`。
 * 事件名带 `plugin-l4-registry-` 前缀，与 API 桥的 `plugin-l4-api-*` 区分。
 */
function tauriBus(): RegistryBus {
  return {
    send: (event, payload, target) => {
      void emitTo(target, event, payload).catch((e) => {
        // 目标窗口已关闭：调用方那边由超时兜底，这里只记一条，避免未处理的 rejection
        console.warn('[plugin] l4 注册表事件发送失败', event, target, e)
      })
    },
    on: (event, handler) => {
      let disposed = false
      let unlisten: (() => void) | null = null
      void listen(event, (e) => handler(e.payload)).then((fn) => {
        // listen 是异步的：解析完成前就 dispose 时，立刻退订，避免泄漏监听
        if (disposed) fn()
        else unlisten = fn
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
}

type HostRegistry = {
  has?: (pluginId: string, method?: string) => boolean
  _callWithinWindow?: (pluginId: string, method: string, args: unknown[]) => Promise<unknown>
}

export function initL4Bridge() {
  if (initialized || !isTauri()) return
  initialized = true
  const l4Label = (pluginId: string) => `plugin-webview-${pluginId}`

  // 伪 source：handleApiCall 经 source.postMessage 回传，这里转成发往对应 l4 窗口的事件
  const fakeSource = (pluginId: string) => ({
    postMessage: (msg: Record<string, unknown>) => {
      void emitTo(l4Label(pluginId), 'plugin-l4-api-response', msg)
    },
  })

  void listen('plugin-l4-api-call', (e) => {
    const { pluginId, id, method, args } = e.payload as { pluginId: string; id: string; method: string; args: unknown[] }
    handleApiCall(id, method, args, pluginId, fakeSource(pluginId) as unknown as Window)
  })
  void listen('plugin-l4-api-abort', (e) => {
    abortStream((e.payload as { id: string }).id)
  })

  // 主窗口注册表：l4 窗口登记的方法 → 转发到该窗口执行。
  // _callWithinWindow 只在本窗口派发，避免「主窗口 → l4 → 主窗口」回环。
  const registry = (window as unknown as { __pluginRegistry?: HostRegistry }).__pluginRegistry
  setL4HostBridge(createL4HostBridge(tauriBus(), (pluginId, method, args) => {
    if (!registry?._callWithinWindow) return Promise.reject(new Error('Plugin registry not initialized'))
    return registry._callWithinWindow(pluginId, method, args)
  }))
}
