import { listen, emitTo } from '@tauri-apps/api/event'
import { handleApiCall, abortStream } from './sandbox.ts'

/**
 * l4 主窗口侧桥：接收插件独立 WebView 窗口转发的 `__plugin_api_call`（经 Tauri
 * 事件 `plugin-l4-api-call`），在主窗口执行真实桥（权限校验 + executePluginMethod），
 * 再把 `__plugin_api_response` 经事件回传。消息体复用 sandbox.ts 的 postMessage
 * 协议（{type,id,method,args} / {type,id,result,error}），仅传输层换成跨窗口事件。
 *
 * 为什么不用 window.opener postMessage：Tauri 子 WebviewWindow 由 IPC
 * `create_webview_window` 创建（非 window.open），opener 为 null，跨窗口可靠的
 * 通道是 `emitTo`/`listen` 事件系统（core:event 默认允许）。
 */
const isTauri = () => typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window

let initialized = false

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
}
