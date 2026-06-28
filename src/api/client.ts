const API_BASE = '/api'

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
  const res = await fetch(`${API_BASE}${path}`, {
    headers: { 'Content-Type': 'application/json', ...options?.headers },
    ...options,
  })
  if (!res.ok) {
    let parsed: ApiErrorResponse | null = null
    try {
      const json = await res.json()
      if (json && typeof json.code === 'string' && typeof json.message === 'string') {
        parsed = json as ApiErrorResponse
      }
    } catch { /* 无法解析 JSON，走 fallback */ }

    if (parsed) {
      throw new ApiError(parsed)
    }
    // 兜底：非标准错误响应
    throw new ApiError({
      code: 'UNKNOWN_ERROR',
      message: `请求失败 (${res.status})`,
      detail: null,
      traceId: '',
      timestamp: new Date().toISOString(),
      status: res.status,
    })
  }
  // 204 No Content
  if (res.status === 204) return undefined as T
  return res.json()
}

export function get<T>(path: string): Promise<T> {
  return request<T>(path)
}

export function post<T>(path: string, body?: unknown): Promise<T> {
  return request<T>(path, {
    method: 'POST',
    body: body ? JSON.stringify(body) : undefined,
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
