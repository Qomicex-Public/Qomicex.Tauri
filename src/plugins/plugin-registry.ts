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
    return Promise.resolve(fn(...args))
  }

  const registry: PluginRegistryApi = {
    register: (pluginId, method, fn) => {
      registerLocal(pluginId, method, fn)
      if (isHost) {
        // 主窗口：直接登记即可
      } else {
        // iframe：通知主窗口登记，主窗口在 __pluginSources 记录方法来源 window
        hostWindow.parent.postMessage(
          { type: '__plugin_registry_register', pluginId, method },
          '*'
        )
      }
    },

    unregister: (pluginId) => {
      delete localExports[pluginId]
      if (!isHost) {
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
        return callLocal(pluginId, method, args)
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
  }

  return registry
}

// 主窗口：安装真实注册表 + 消息路由
if (window === window.top) {
  if (!(win as any).__pluginSources) (win as any).__pluginSources = {}

  const host = createRegistry(win, true)
  win.__pluginRegistry = host

  window.addEventListener('message', (e) => {
    const msg = e.data
    if (!msg?.type) return
    const sources = (win as any).__pluginSources as Record<string, Record<string, Window>>

    if (msg.type === '__plugin_registry_register') {
      if (!sources[msg.pluginId]) sources[msg.pluginId] = {}
      sources[msg.pluginId][msg.method] = e.source as Window
    } else if (msg.type === '__plugin_registry_unregister') {
      delete sources[msg.pluginId]
    } else if (msg.type === '__plugin_registry_call') {
      const { callId, pluginId, method, args } = msg
      const sourceMethods = sources[pluginId]
      const sourceWin = sourceMethods ? (sourceMethods[method] as Window | undefined) : undefined
      if (sourceWin && sourceWin !== window) {
        // 目标在 iframe：转发到 iframe 执行
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
        host._callLocal(pluginId, method, args).then(
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
