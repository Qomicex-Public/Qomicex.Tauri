// Copyright (C) 2026 Qomicex Launcher Contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { getL4HostBridge, getL4NodeBridge, isL4Window } from './l4-registry.ts'

type AnyWindow = Window & {
  __pluginRegistry?: PluginRegistryApi
  __pluginExports?: Record<string, Record<string, unknown>>
}

interface PluginRegistryApi {
  register: (pluginId: string, method: string, fn: (...args: unknown[]) => unknown) => void
  unregister: (pluginId: string) => void
  has: (pluginId: string, method?: string) => boolean
  call: (pluginId: string, method: string, args: unknown[]) => Promise<unknown>
  /** 由宿主 window 调用的底层注册（主窗口 registry 或 iframe 本地） */
  _registerLocal: (pluginId: string, method: string, fn: (...args: unknown[]) => unknown) => void
  _callLocal: (pluginId: string, method: string, args: unknown[]) => Promise<unknown>
  /**
   * 只在本窗口范围内派发（iframe 内插件优先，其次本地导出），不向 l4 / 其他窗口转发。
   * l4 注册表桥用它执行主窗口转来的调用，避免「代理再代理」的回环。
   */
  _callWithinWindow: (pluginId: string, method: string, args: unknown[]) => Promise<unknown>
}

const win = window as AnyWindow

/**
 * 全局插件注册表。主窗口持有唯一真实注册表：
 * - register: 插件在当前 window 本地保存 fn，并向主窗口上报"已注册 method"
 * - call: 调用方请求主窗口中转，主窗口把调用转回被依赖插件所在 window 执行
 *
 * 主窗口和 iframe 都注入同一套逻辑；iframe 侧 register 时 fn 留在本地，
 * 通过 postMessage 通知主窗口登记。call 时经主窗口按插件 id 路由到目标 window。
 */
/**
 * 判断来源 window 是否已随文档销毁。iframe 被重新加载后，旧文档的 window 仍在注册表
 * 里（`closed === true`），向它 postMessage 不会报错也不会有人接收 —— 调用会永久挂起。
 * 只有跨域访问会抛，按「可用」处理，避免误杀正常跨域来源。
 */
function isDetachedSource(sourceWin: Window): boolean {
  try {
    return sourceWin.closed === true
  } catch {
    return false
  }
}

/**
 * l4 独立窗口判定：它是自己的 `window.top`，但注册必须报到主窗口，否则方法只留在
 * 本窗口的导出表里，主窗口 `callPlugin` 查不到（issue #260 第二处缺口）。
 */
const l4Window = isL4Window()

/**
 * 窗口内 iframe 调用的兜底超时。
 *
 * 比 l4 桥的 30s 短：l4 桥外面还有自己的超时，这里先到点，才能把 message 监听器
 * 清掉；否则 iframe 不回复时监听器会永久挂在这个 window 上，多次超时不断累积。
 */
const IN_WINDOW_CALL_TIMEOUT_MS = 20_000

function createRegistry(hostWindow: AnyWindow, isHost: boolean): PluginRegistryApi {
  // 本地持有的导出：pluginId -> method -> fn（仅存在 fn 所在的 window）
  const localExports: Record<string, Record<string, (...args: unknown[]) => unknown>> = {}

  function registerLocal(pluginId: string, method: string, fn: (...args: unknown[]) => unknown) {
    if (!localExports[pluginId]) localExports[pluginId] = {}
    localExports[pluginId][method] = fn
  }

  function callLocal(pluginId: string, method: string, args: unknown[]): Promise<unknown> {
    const methods = localExports[pluginId]
    if (!methods || !Object.prototype.hasOwnProperty.call(methods, method)) {
      return Promise.reject(new Error(`插件 ${pluginId} 未提供方法 ${method}`))
    }
    const fn = methods[method]
    if (typeof fn !== 'function')
      return Promise.reject(new Error(`插件 ${pluginId} 未提供方法 ${method}`))
    // 方法同步抛错必须转成 reject：调用链上游有经 postMessage 等待回执的一侧，
    // 异常若同步冒出，回执永远不会发出，调用方会一直挂着（#260）。
    try {
      return Promise.resolve(fn(...args))
    } catch (e) {
      return Promise.reject(e instanceof Error ? e : new Error(String(e)))
    }
  }

  const registry: PluginRegistryApi = {
    register: (pluginId, method, fn) => {
      registerLocal(pluginId, method, fn)
      if (l4Window) {
        // l4 独立窗口本身就是 window.top（isHost=true），注册会只留在本地导出表里；
        // 必须额外报给主窗口，否则主窗口 callPlugin 查不到（issue #260）。
        getL4NodeBridge()?.register(pluginId, method)
      } else if (!isHost) {
        // iframe：通知主窗口登记，主窗口在 __pluginSources 记录方法来源 window
        hostWindow.parent.postMessage(
          { type: '__plugin_registry_register', pluginId, method },
          '*'
        )
      }
    },

    unregister: (pluginId) => {
      delete localExports[pluginId]
      if (l4Window) {
        getL4NodeBridge()?.unregister(pluginId)
      } else if (!isHost) {
        hostWindow.parent.postMessage({ type: '__plugin_registry_unregister', pluginId }, '*')
      } else {
        delete (win as any).__pluginSources?.[pluginId]
      }
    },

    has: (pluginId, method) => {
      if (isHost) {
        const src = (win as any).__pluginSources?.[pluginId]
        if (src) return method ? true : Object.keys(src).length > 0
        return !!localExports[pluginId]
      }
      return !!localExports[pluginId]
    },

    call: async (pluginId, method, args) => {
      if (isHost) {
        const sources = (win as any).__pluginSources as Record<string, Record<string, Window>> | undefined
        const sourceWin = sources?.[pluginId]?.[method] as Window | undefined
        if (sourceWin && sourceWin !== window) {
          // 目标插件在 iframe 中：转发到该 iframe 本地执行
          return new Promise((resolve, reject) => {
            // 来源 window 所属文档已销毁（iframe 被重新加载，如宿主搬动降级重建）：
            // postMessage 不报错但无人接收，等待会永久挂起，必须当场失败。
            if (isDetachedSource(sourceWin)) {
              reject(new Error(`插件 ${pluginId} 的界面已重新加载，方法 ${method} 暂不可用`))
              return
            }
            const callId = Math.random().toString(36).slice(2)
            const handler = (e: MessageEvent) => {
              if (e.data?.type === '__plugin_registry_result' && e.data.callId === callId) {
                window.removeEventListener('message', handler)
                if (e.data.error) reject(new Error(e.data.error))
                else resolve(e.data.result)
              }
            }
            window.addEventListener('message', handler)
            sourceWin.postMessage(
              { type: '__plugin_registry_call', callId, method, args },
              '*'
            )
          })
        }
        // 目标插件在 l4 独立窗口：它的注册登记在 l4 注册表桥上，不在 __pluginSources 里
        const l4 = getL4HostBridge()
        if (l4?.has(pluginId)) return l4.call(pluginId, method, args)
        return callLocal(pluginId, method, args)
      }
      // l4 独立窗口：本窗口看不到主窗口的注册表，调第三方插件必须经主窗口代调用
      const node = l4Window ? getL4NodeBridge() : null
      if (node) {
        if (localExports[pluginId]) return callLocal(pluginId, method, args)
        // selfPluginId 用本窗口自身的插件 id：主窗口据此把回执发回本窗口
        return node.callRemote(pluginId, method, args)
      }
      // iframe 内调用：转发到主窗口路由
      return new Promise((resolve, reject) => {
        const callId = Math.random().toString(36).slice(2)
        const handler = (e: MessageEvent) => {
          if (e.data?.type === '__plugin_registry_result' && e.data.callId === callId) {
            window.removeEventListener('message', handler)
            if (e.data.error) reject(new Error(e.data.error))
            else resolve(e.data.result)
          }
        }
        window.addEventListener('message', handler)
        hostWindow.parent.postMessage(
          { type: '__plugin_registry_call', callId, pluginId, method, args },
          '*'
        )
      })
    },

    _registerLocal: registerLocal,
    _callLocal: callLocal,
    _callWithinWindow: (pluginId, method, args) => {
      // 主窗口中转来的调用：先在本窗口（iframe / 本地导出）派发；目标若在另一个 l4
      // 窗口，则交给 l4 桥转发（否则跨 l4 窗口互相调用会被误报「未提供方法」）。
      const sourceWin = (win as any).__pluginSources?.[pluginId]?.[method] as Window | undefined
      if (sourceWin && sourceWin === window) return callLocal(pluginId, method, args)
      if (!sourceWin) {
        const l4 = getL4HostBridge()
        if (l4?.has(pluginId)) return l4.call(pluginId, method, args)
        return callLocal(pluginId, method, args)
      }
      if (isDetachedSource(sourceWin)) {
        return Promise.reject(new Error(`插件 ${pluginId} 的界面已重新加载，方法 ${method} 暂不可用`))
      }
      return new Promise((resolve, reject) => {
        const callId = Math.random().toString(36).slice(2)
        // iframe 不回复时（被重建/冻结）必须自行清理，否则 outer 超时后这个
        // message 监听器会永久留在这里，多次超时后不断累积。
        const timer = setTimeout(() => {
          window.removeEventListener('message', handler)
          reject(new Error(`插件 ${pluginId} 的方法 ${method} 调用超时`))
        }, IN_WINDOW_CALL_TIMEOUT_MS)
        const handler = (e: MessageEvent) => {
          if (e.data?.type === '__plugin_registry_result' && e.data.callId === callId) {
            clearTimeout(timer)
            window.removeEventListener('message', handler)
            if (e.data.error) reject(new Error(e.data.error))
            else resolve(e.data.result)
          }
        }
        window.addEventListener('message', handler)
        sourceWin.postMessage({ type: '__plugin_registry_call', callId, method, args }, '*')
      })
    },
  }

  return registry
}

// 主窗口：安装真实注册表 + 消息路由
if (window === window.top) {
  if (!(win as any).__pluginSources) (win as any).__pluginSources = Object.create(null)
  const host = createRegistry(win, true)
  win.__pluginRegistry = host

  window.addEventListener('message', (e) => {
    const msg = e.data
    if (!msg?.type) return
    const sources = (win as any).__pluginSources as Record<string, Record<string, Window>>

    if (msg.type === '__plugin_registry_register') {
      if (!sources[msg.pluginId]) sources[msg.pluginId] = Object.create(null)
      sources[msg.pluginId][msg.method] = e.source as Window
      // l4 窗口：插件 iframe 的注册只落在本窗口，必须同步报给主窗口，
      // 否则主窗口 callPlugin 该插件仍是「未提供方法」（#260）
      if (l4Window) getL4NodeBridge()?.register(msg.pluginId, msg.method)
    } else if (msg.type === '__plugin_registry_unregister') {
      delete sources[msg.pluginId]
      if (l4Window) getL4NodeBridge()?.unregister(msg.pluginId)
    } else if (msg.type === '__plugin_registry_call') {
      const { callId, pluginId, method, args } = msg
      const sourceMethods = sources[pluginId]
      const sourceWin = sourceMethods ? (sourceMethods[method] as Window | undefined) : undefined
      if (sourceWin && sourceWin !== window) {
        // 目标在 iframe：转发到 iframe 执行
        if (isDetachedSource(sourceWin)) {
          ;(e.source as Window).postMessage({
            type: '__plugin_registry_result',
            callId,
            error: `插件 ${pluginId} 的界面已重新加载，方法 ${method} 暂不可用`,
          }, '*')
          return
        }
        const handler = (r: MessageEvent) => {
          if (r.data?.type === '__plugin_registry_result' && r.data.callId === callId) {
            window.removeEventListener('message', handler)
            ;(e.source as Window).postMessage(
              { type: '__plugin_registry_result', callId, result: r.data.result, error: r.data.error },
              '*'
            )
          }
        }
        window.addEventListener('message', handler)
        sourceWin.postMessage({ type: '__plugin_registry_call', callId, method, args }, '*')
      } else {
        // 目标既不在本窗口的 iframe 里，也不在本窗口本地。
        // l4 独立窗口：插件 iframe 的 callPlugin 必须经主窗口代调用，本窗口看不到
        // 主窗口的注册表；不回执的话 iframe 侧的 Promise 会一直挂着（#260）。
        const l4Node = l4Window ? getL4NodeBridge() : null
        const call = l4Node
          ? l4Node.callRemote(pluginId, method, args)
          : (() => {
              // 主窗口：可能是 l4 窗口里的插件
              const l4 = getL4HostBridge()
              return l4?.has(pluginId) ? l4.call(pluginId, method, args) : host._callLocal(pluginId, method, args)
            })()
        call.then(
          (result) => (e.source as Window).postMessage({ type: '__plugin_registry_result', callId, result }, '*'),
          (err) => (e.source as Window).postMessage(
            { type: '__plugin_registry_result', callId, error: err instanceof Error ? err.message : String(err) },
            '*'
          )
        )
      }
    }
  })
}

// iframe：注入本地注册表，接收主窗口转发的调用请求
if (window !== window.top) {
  const frame = createRegistry(win, false)
  ;(win as any).__pluginRegistry = frame

  window.addEventListener('message', (e) => {
    const msg = e.data
    if (msg?.type === '__plugin_registry_call') {
      const { callId, method, args } = msg
      frame._callLocal((win as any).__PLUGIN_ID__ ?? '', method, args).then(
        (result) => window.parent.postMessage({ type: '__plugin_registry_result', callId, result }, '*'),
        (err) => window.parent.postMessage(
          { type: '__plugin_registry_result', callId, error: err instanceof Error ? err.message : String(err) },
          '*'
        )
      )
    }
  })
}

export default win.__pluginRegistry as PluginRegistryApi
