export const API_BASE = 'http://localhost:5000/api'

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

  /** 用户可看的完整描述 */
  get displayMessage(): string {
    return this.detail ? `${this.message}（${this.detail}）` : this.message
  }
}

async function request<T>(path: string, options?: RequestInit): Promise<T> {
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

  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
  let res: Response
  try {
    res = await fetch(url, {
      headers: { 'Content-Type': 'application/json', ...options?.headers },
      signal: options?.signal ?? controller.signal,
      ...options,
    })
  } catch (e) {
    if (controller.signal.aborted) {
      console.error(`[API] ${method} ${path} => 请求超时 (${REQUEST_TIMEOUT_MS}ms)`)
      throw new ApiError({
        code: 'REQUEST_TIMEOUT',
        message: `请求超时（${REQUEST_TIMEOUT_MS / 1000}s）`,
        detail: path,
        traceId: '',
        timestamp: new Date().toISOString(),
        status: 0,
      })
    }
    throw e
  } finally {
    clearTimeout(timeoutId)
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
    } catch { }
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

export function get<T>(path: string): Promise<T> {
  return request<T>(path)
}

export function post<T>(path: string, body?: unknown, options?: RequestInit): Promise<T> {
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
