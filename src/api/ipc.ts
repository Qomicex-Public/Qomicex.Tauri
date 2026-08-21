import { API_BASE, setApiBase } from './client.ts'

/**
 * 传输层选择：
 * - Tauri 内：探测 ipc_ping 成功后把 API_BASE 切到 qomicex:// 协议 URL
 *   （Windows origin 形态是 http://qomicex.localhost，其余平台 qomicex://localhost）
 * - 纯浏览器/IPC 不可用：保持 HTTP :5000（Playwright 调试、CI 脚本依赖此路径）
 */
export async function initApiTransport(): Promise<void> {
  if (!('__TAURI_INTERNALS__' in window)) return
  try {
    const { invoke } = await import('@tauri-apps/api/core')
    if (!(await invoke<boolean>('ipc_ping'))) return
    ;(globalThis as Record<string, unknown>).__QOMICEX_IPC__ = true
    setApiBase(
      navigator.userAgent.includes('Windows')
        ? 'http://qomicex.localhost/api'
        : 'qomicex://localhost/api',
    )
    console.log('[ipc] transport switched to pipe:', API_BASE)
  } catch (e) {
    console.warn('[ipc] probe failed, falling back to http:', e)
  }
}

export function isIpcMode(): boolean {
  return Boolean((globalThis as Record<string, unknown>).__QOMICEX_IPC__)
}

// --- 流式通道 ---

/** 非 2xx 流响应的统一错误（与 fetch !res.ok 语义对齐） */
export class StreamStatusError extends Error {
  readonly status: number
  constructor(status: number) {
    super(`Stream failed: ${status}`)
    this.name = 'StreamStatusError'
    this.status = status
  }
}

export interface StreamHandle {
  done: Promise<void>
  close: () => void
}

export interface StreamOptions {
  method?: string
  headers?: Record<string, string>
  body?: string
  signal?: AbortSignal
}

/** SSE 行解析器：喂原始 chunk，按空行切分 data: 事件 */
export function createSseParser(onData: (data: string) => void): (text: string) => void {
  let buffer = ''
  return text => {
    buffer += text
    let idx: number
    while ((idx = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, idx).trim()
      buffer = buffer.slice(idx + 1)
      if (line.startsWith('data:')) onData(line.slice(5).trim())
    }
  }
}

/**
 * 打开流式请求。IPC 模式走 invoke+Channel；HTTP 模式走 fetch reader。
 * 统一消费文本 chunk（SSE 字节流原样透传，行解析交给调用方）。
 */
export function openStream(path: string, onChunk: (text: string) => void, opts?: StreamOptions): StreamHandle {
  if (!isIpcMode()) return httpStream(path, onChunk, opts)
  return ipcStream(path, onChunk, opts)
}

function httpStream(path: string, onChunk: (text: string) => void, opts?: StreamOptions): StreamHandle {
  const controller = new AbortController()
  if (opts?.signal) opts.signal.addEventListener('abort', () => controller.abort(), { once: true })
  const done = (async () => {
    const res = await fetch(`${API_BASE}${path}`, {
      method: opts?.method ?? 'GET',
      headers: { 'Content-Type': 'application/json', ...opts?.headers },
      body: opts?.body,
      signal: controller.signal,
    })
    if (!res.ok || !res.body) throw new StreamStatusError(res.status)
    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    for (;;) {
      const { done: finished, value } = await reader.read()
      if (finished) break
      onChunk(decoder.decode(value, { stream: true }))
    }
  })()
  return { done, close: () => controller.abort() }
}

interface StreamEvent {
  t: 'head' | 'chunk' | 'end' | 'error'
  status?: number
  d?: string
}

function ipcStream(path: string, onChunk: (text: string) => void, opts?: StreamOptions): StreamHandle {
  let closeFn: (() => void) | null = null
  const done = (async () => {
    const { invoke, Channel } = await import('@tauri-apps/api/core')
    const id = Math.random().toString(36).slice(2)
    await new Promise<void>((resolve, reject) => {
      let dead = false
      const channel = new Channel<string>()
      channel.onmessage = msg => {
        if (dead) return
        let e: StreamEvent
        try { e = JSON.parse(msg) as StreamEvent } catch { return }
        if (e.t === 'head') {
          // 统一契约：非 2xx 视为失败，停掉后端流任务并 reject（对齐 fetch !res.ok）
          const s = e.status ?? 0
          if (s < 200 || s >= 300) {
            dead = true
            invoke('ipc_stream_abort', { id }).catch(() => {})
            reject(new StreamStatusError(s))
          }
        }
        else if (e.t === 'chunk') onChunk(e.d ?? '')
        else if (e.t === 'error') {
          dead = true
          reject(new Error(e.d || 'stream failed'))
        }
        else if (e.t === 'end') resolve()
      }
      closeFn = () => {
        invoke('ipc_stream_abort', { id }).catch(() => {})
        resolve()
      }
      if (opts?.signal) {
        opts.signal.addEventListener('abort', () => closeFn?.(), { once: true })
      }
      invoke('ipc_stream', {
        id,
        req: {
          method: opts?.method,
          path,
          headers: opts?.headers ?? {},
          body: opts?.body ? Array.from(new TextEncoder().encode(opts.body)) : undefined,
        },
        onEvent: channel,
      }).catch(reject)
    })
  })()
  return { done, close: () => closeFn?.() }
}
