// Copyright (C) 2026 Qomicex Launcher Contributors
// SPDX-License-Identifier: GPL-3.0-or-later

// `callBackend` 的特权路由守卫（纯函数，无 DOM/store 依赖，便于单测）。
//
// 为什么需要它：`callBackend` 是通用 HTTP 通道，只按 `network:fetch` 放行，
// 但后端部分路由有比「能发请求」更强的语义——`/plugins/process/{id}/spawn`
// 直接拉起任意命令、`/plugins/files/{id}/authorize` 直接授予任意路径读写权、
// `DELETE /plugins/{id}` 卸载插件。插件只要声明 network:fetch 就能绕过
// `process.spawn` / `writeText` / `uploadPlugin` 等方法各自的权限检查。
//
// 后端不做调用者鉴权（信任前端是唯一的权限执行点），所以这里是唯一的拦截
// 位置：**新增特权路由必须同步登记到 BACKEND_ROUTE_RULES**。

export interface BackendRouteRule {
  /** HTTP 方法（大写）；省略表示任意方法 */
  method?: string
  pattern: RegExp
  permission: string
}

export const BACKEND_ROUTE_RULES: readonly BackendRouteRule[] = [
  // 进程管理：spawn 直接拉起任意命令（任意方法都覆盖，list/logs 也在其下）
  { pattern: /^\/plugins\/process\//, permission: 'process:manage' },
  // 任意命令执行
  { method: 'POST', pattern: /^\/plugins\/shell\//, permission: 'shell:execute' },
  // 文件系统：authorize 会授予任意路径读写权，是 file_read/file_write 的
  // 唯一闸门——只登记 read/write 而漏掉 authorize 等于没有权限控制。
  {
    method: 'POST',
    pattern: /^\/plugins\/files\/[^/]+\/(authorize|read|write|delete|extract|list)$/,
    permission: 'filesystem:write',
  },
  // 插件安装 / 卸载 / 回滚 / 启停
  {
    method: 'POST',
    pattern: /^\/plugins\/(install|install-url|upload)$/,
    permission: 'plugin:install',
  },
  { method: 'DELETE', pattern: /^\/plugins\/[^/]+$/, permission: 'plugin:install' },
  { method: 'POST', pattern: /^\/plugins\/[^/]+\/rollback$/, permission: 'plugin:install' },
  { method: 'PUT', pattern: /^\/plugins\/[^/]+\/state$/, permission: 'plugin:install' },
]

/**
 * 把 callBackend 的端点参数规范成「与 fetch 实际请求一致」的 pathname。
 *
 * 必须走一次 URL 解析而不是直接字符串前缀匹配：`/plugins/../x`、`//host/p`、
 * 绝对 URL 等写法在 fetch 里会被解析成完全不同的路径，前缀匹配会被绕过。
 * 解析失败（非法 URL）时退回原始字符串——此时 fetch 也会失败，无风险。
 */
export function normalizeBackendPath(endpoint: string, base: string): string {
  try {
    const url = new URL(endpoint, base.endsWith('/') ? base : `${base}/`)
    const basePath = new URL(base).pathname.replace(/\/$/, '')
    const path = url.pathname
    return basePath && path.startsWith(basePath) ? path.slice(basePath.length) || '/' : path
  } catch {
    return endpoint.split('?')[0]?.split('#')[0] ?? endpoint
  }
}

/**
 * 推断 callBackend 实际会发出的 HTTP 方法——与 `plugin-api.ts` 的
 * `bridge.callBackend` 保持一致：显式 `_method` 优先，否则有 body → POST。
 */
export function resolveBackendMethod(data: unknown): string {
  const explicit =
    data && typeof data === 'object' ? (data as Record<string, unknown>)._method : undefined
  if (typeof explicit === 'string') return explicit.toUpperCase()
  return data ? 'POST' : 'GET'
}

/**
 * 校验 callBackend 目标路由所需的额外权限；返回 null 表示仅需 network:fetch。
 * @param endpoint 插件传入的端点（可含查询串、`..` 段、绝对 URL）
 * @param httpMethod 实际请求方法（见 `resolveBackendMethod`）
 * @param base 当前 API 基址（通常是 `API_BASE`）
 */
export function backendEndpointPermission(
  endpoint: string,
  httpMethod: string,
  base: string,
): string | null {
  const path = normalizeBackendPath(endpoint, base)
  const upper = httpMethod.toUpperCase()
  for (const rule of BACKEND_ROUTE_RULES) {
    if (rule.method && rule.method !== upper) continue
    if (rule.pattern.test(path)) return rule.permission
  }
  return null
}
