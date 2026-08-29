import { API_BASE, setApiBase } from './client.ts'

/**
 * 传输层选择：
 * - Tauri 内：端到端探测（fetch 协议 URL 的 /ping 断言 pong）成功后把 API_BASE
 *   切到 qomicex:// 协议地址。Windows origin 形态是 http://qomicex.localhost，
 *   其余平台 qomicex://localhost；两种候选都试，首个通过者胜出。
 *   端到端而非仅 invoke：协议转发器→管道→后端整链路可用才算数。
 * - 纯浏览器/IPC 不可用：保持 HTTP :5000（Playwright 调试、CI 脚本依赖此路径）。
 */
const PROBE_TIMEOUT_MS = 2_000

let transportResolved = false

function ipcBaseCandidates(): string[] {
  return navigator.userAgent.includes('Windows')
    ? ['http://qomicex.localhost/api', 'qomicex://localhost/api']
    : ['qomicex://localhost/api', 'http://qomicex.localhost/api']
}

async function probeIpcBase(base: string): Promise<boolean> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS)
  try {
    const res = await fetch(`${base}/ping`, { signal: controller.signal })
    return res.ok && (await res.text()) === 'pong'
  } catch {
    return false
  } finally {
    clearTimeout(timer)
  }
}

/** 幂等：已解析直接返回；未解析时逐候选端到端尝试。由健康轮询每轮调用以重试。 */
export async function initApiTransport(): Promise<void> {
  if (!('__TAURI_INTERNALS__' in window) || transportResolved) return
  for (const base of ipcBaseCandidates()) {
    if (await probeIpcBase(base)) {
      transportResolved = true
      ;(globalThis as Record<string, unknown>).__QOMICEX_IPC__ = true
      setApiBase(base)
      console.log('[ipc] transport switched to pipe:', API_BASE)
      return
    }
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

/** SSE 行解析器：喂原始 chunk，按空行切分 data: 事件；flush 在流结束时吐出残留尾行 */
export function createSseParser(onData: (data: string) => void): { feed: (text: string) => void; flush: () => void } {
  let buffer = ''
  const emitLine = (line: string) => {
    const l = line.trim()
    if (l.startsWith('data:')) onData(l.slice(5).trim())
  }
  return {
    feed: text => {
      buffer += text
      let idx: number
      while ((idx = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, idx)
        buffer = buffer.slice(idx + 1)
        emitLine(line)
      }
    },
    flush: () => {
      if (buffer.trim()) {
        const rest = buffer
        buffer = ''
        emitLine(rest)
      }
    },
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
  h?: string[]
  d?: string
}

// 管道直连后端 axum 路由（挂在 /api 下），而调用方传的是与 HTTP 模式一致的
// 相对路径（如 '/progress/stream'）——必须补上 API_BASE 的路径前缀，
// 否则后端 404，SSE 消费者（下载进度/游戏日志/插件流）与 multipart 上传全部静默失效。
function ipcApiPath(path: string): string {
  return new URL(API_BASE).pathname.replace(/\/$/, '') + path
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
          path: ipcApiPath(path),
          headers: opts?.headers ?? {},
          body: opts?.body ? Array.from(new TextEncoder().encode(opts.body)) : undefined,
        },
        onEvent: channel,
      }).catch(reject)
    })
  })()
  return { done, close: () => closeFn?.() }
}

/**
 * multipart 文件上传（统一入口）。
 *
 * 背景：WebView2 的 custom protocol（http://qomicex.localhost）对
 * `multipart/form-data` Content-Type 的请求会丢弃 body（实测：后端收到空文件，
 * 报 "invalid Zip archive: Could not find EOCD"；而 JSON/octet-stream body 完整）。
 * 因此 IPC 模式下不能走 fetch + FormData，改为构造 multipart 字节经
 * `ipc_stream` 命令（invoke 通道，不经过 custom protocol fetch）发送。
 * HTTP 模式（纯浏览器/CI）保持原生 FormData。
 *
 * 返回与 fetch 对齐的 Response 对象，调用方用 res.ok / res.json() 消费。
 */
export async function uploadFile(path: string, file: File, fieldName = 'file'): Promise<Response> {
  if (!isIpcMode()) {
    const fd = new FormData()
    fd.append(fieldName, file)
    return fetch(`${API_BASE}${path}`, { method: 'POST', body: fd })
  }

  const boundary = `----qomicex-ipc-${Math.random().toString(36).slice(2)}`
  const encoder = new TextEncoder()
  const fileBytes = new Uint8Array(await file.arrayBuffer())
  const head = encoder.encode(
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="${fieldName}"; filename="${file.name}"\r\n` +
    `Content-Type: ${file.type || 'application/octet-stream'}\r\n\r\n`,
  )
  const tail = encoder.encode(`\r\n--${boundary}--\r\n`)
  const body = new Uint8Array(head.length + fileBytes.length + tail.length)
  body.set(head, 0)
  body.set(fileBytes, head.length)
  body.set(tail, head.length + fileBytes.length)

  const { invoke, Channel } = await import('@tauri-apps/api/core')
  const id = Math.random().toString(36).slice(2)
  const chunks: string[] = []
  let status = 0
  let respHeaders: Record<string, string> = {}
  await new Promise<void>((resolve, reject) => {
    let dead = false
    const channel = new Channel<string>()
    channel.onmessage = msg => {
      if (dead) return
      let e: StreamEvent
      try { e = JSON.parse(msg) as StreamEvent } catch { return }
      if (e.t === 'head') {
        status = e.status ?? 0
        for (const h of e.h ?? []) {
          const idx = h.indexOf(':')
          if (idx > 0) respHeaders[h.slice(0, idx).trim().toLowerCase()] = h.slice(idx + 1).trim()
        }
        if (status < 200 || status >= 300) {
          dead = true
          invoke('ipc_stream_abort', { id }).catch(() => {})
          // 收集错误响应 body 后返回（与浏览器 fetch 语义一致），供调用方读 code/message
          // （不能直接 reject：上传签名失败需读取错误 body 决定是否弹确认框）
        }
      } else if (e.t === 'chunk') {
        if (!dead) chunks.push(e.d ?? '')
      } else if (e.t === 'error') {
        dead = true
        reject(new Error(e.d || 'stream failed'))
      } else if (e.t === 'end') {
        resolve()
      }
    }
    invoke('ipc_stream', {
      id,
      req: {
        method: 'POST',
        path: ipcApiPath(path),
        headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
        body: Array.from(body),
      },
      onEvent: channel,
    }).catch(reject)
  })
  const text = chunks.join('')
  return new Response(text, { status, headers: respHeaders })
}
