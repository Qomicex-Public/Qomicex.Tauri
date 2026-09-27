export let API_BASE = 'http://127.0.0.1:5000/api'

/** IPC 探测成功后由 initApiTransport 调用；ESM live binding 对全部导入方生效 */
export function setApiBase(base: string) {
  API_BASE = base
}

/** 全局请求超时：任何请求 15s 无响应即中断，避免"一直加载"（如慢速外部 ping）。 */
const REQUEST_TIMEOUT_MS = 15_000

/** 后端统一错误响应结构 */
export interface ApiErrorResponse {
  code: string
  message: string
  detail?: string | null
  traceId: string
  timestamp: string
  status: number
}

/**
 * 错误码翻译钩子：i18n 初始化时注册，按当前语言把后端错误码映射为本地化消息。
 * 返回 null 表示未命中（调用方回退后端 message）。
 */
export type ApiErrorTranslator = (e: ApiError) => string | null

let apiErrorTranslator: ApiErrorTranslator | null = null

export function setApiErrorTranslator(fn: ApiErrorTranslator | null) {
  apiErrorTranslator = fn
}

/** 前端可抛出的结构化 API 错误 */
export class ApiError extends Error {
  readonly code: string
  readonly status: number
  readonly detail: string | null
  readonly traceId: string
  readonly timestamp: string

  constructor(response: ApiErrorResponse) {
    super(response.message)
    this.name = 'ApiError'
    this.code = response.code
    this.status = response.status
    this.detail = response.detail ?? null
    this.traceId = response.traceId
    this.timestamp = response.timestamp
  }

  /** 用户可看的完整描述（优先走 i18n 错误码翻译，未命中回退后端消息） */
  get displayMessage(): string {
    const translated = apiErrorTranslator?.(this)
    if (translated) return translated
    return this.detail ? `${this.message}（${this.detail}）` : this.message
  }
}

/** 请求可选项：`timeoutMs` 覆盖全局 15s 超时（大文件/整合包导入等长耗时请求）。 */
export interface RequestOptions extends RequestInit {
  timeoutMs?: number
}


async function request<T>(path: string, options?: RequestOptions): Promise<T> {
  const debug = window.__DEBUG__
  const start = performance.now()
  const method = options?.method ?? 'GET'

  if (debug?.simulateApiErrors && Math.random() < 0.3) {
    const fakeError: ApiErrorResponse = {
      code: 'DEBUG_SIMULATED',
      message: `[调试模拟] 请求失败: ${method} ${path}`,
      detail: null,
      traceId: 'debug-trace-id',
      timestamp: new Date().toISOString(),
      status: 500,
    }
    throw new ApiError(fakeError)
  }

  const url = debug?.disableCaching
    ? `${API_BASE}${path}${path.includes('?') ? '&' : '?'}_t=${Date.now()}`
    : `${API_BASE}${path}`

  const callerSignal = options?.signal
  // 超时优先级：显式 timeoutMs > 调用方自带 signal（视为调用方全权管理取消，
  // 不再叠全局 15s——否则 parse-modpack-by-path 这类自带 60s 窗口的请求会被
  // 砍到 15s）> 全局 15s。signal 与超时都桥接到同一个 controller，避免
  // fetch 只认一个 signal 导致另一方被静默忽略。
  // 手动桥接而不用 AbortSignal.any()：后者在旧版 WKWebView / WebView 上不一定可用。
  const timeoutMs = options?.timeoutMs ?? (callerSignal ? undefined : REQUEST_TIMEOUT_MS)
  const controller = new AbortController()
  let detachCaller: (() => void) | undefined
  if (callerSignal) {
    if (callerSignal.aborted) controller.abort()
    else {
      const onCallerAbort = () => controller.abort()
      callerSignal.addEventListener('abort', onCallerAbort, { once: true })
      detachCaller = () => callerSignal.removeEventListener('abort', onCallerAbort)
    }
  }
  const timeoutId =
    timeoutMs === undefined ? undefined : setTimeout(() => controller.abort(), timeoutMs)
  // timeoutMs / signal 只是客户侧控制参数，不属于 fetch RequestInit：剥掉后统一用
  // 上面合成的 controller.signal，避免调用方的 signal 把内部超时信号覆盖掉。
  const init: RequestInit = { ...options }
  delete (init as { timeoutMs?: number }).timeoutMs
  delete init.signal
  let res: Response
  try {
    res = await fetch(url, {
      headers: { 'Content-Type': 'application/json', ...options?.headers },
      signal: controller.signal,
      ...init,
    })
  } catch (e) {
    // 调用方主动 abort：保持既有语义原样抛出，不能误报成请求超时。
    if (callerSignal?.aborted) throw e
    if (controller.signal.aborted) {
      console.error(`[API] ${method} ${path} => 请求超时 (${timeoutMs ?? REQUEST_TIMEOUT_MS}ms)`)
      throw new ApiError({
        code: 'REQUEST_TIMEOUT',
        message: `请求超时（${timeoutMs ? timeoutMs / 1000 : '?'}s）`,
        detail: path,
        traceId: '',
        timestamp: new Date().toISOString(),
        status: 0,
      })
    }
    throw e
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId)
    detachCaller?.()
  }
  const duration = Math.round(performance.now() - start)

  if (debug?.networkLogging) {
    console.log(`[API] ${method} ${path} => ${res.status} in ${duration}ms`)
  }

  if (!res.ok) {
    let parsed: ApiErrorResponse | null = null
    try {
      const json = await res.json()
      if (json && typeof json.code === 'string' && typeof json.message === 'string') {
        parsed = json as ApiErrorResponse
      }
    } catch {
      // 非 JSON 响应体（HTML 错误页 / 空体）是预期情况：下面按通用 HTTP 状态处理，
      // 不需要知道 body 内容，静默回退即可。
    }
    if (parsed) {
      console.error(`[API] ${method} ${path} => ${res.status} [${parsed.code}] ${parsed.message}${parsed.detail ? ` (${parsed.detail})` : ''}`)
      throw new ApiError(parsed)
    }
    console.error(`[API] ${method} ${path} => ${res.status} UNKNOWN_ERROR`)
    throw new ApiError({
      code: 'UNKNOWN_ERROR', message: `请求失败 (${res.status})`,
      detail: null, traceId: '', timestamp: new Date().toISOString(), status: res.status,
    })
  }
  if (res.status === 204) return undefined as T
  const text = await res.text()
  if (!text) return undefined as T
  return JSON.parse(text) as T
}

export function get<T>(path: string, options?: RequestInit): Promise<T> {
  return request<T>(path, options)
}

export function post<T>(path: string, body?: unknown, options?: RequestOptions): Promise<T> {
  return request<T>(path, {
    method: 'POST',
    body: body ? JSON.stringify(body) : undefined,
    ...options,
  })
}

export function put<T>(path: string, body?: unknown): Promise<T> {
  return request<T>(path, {
    method: 'PUT',
    body: body ? JSON.stringify(body) : undefined,
  })
}

export function del<T = void>(path: string, body?: unknown): Promise<T> {
  return request<T>(path, {
    method: 'DELETE',
    body: body ? JSON.stringify(body) : undefined,
  })
}

export default { get, post, put, del }
