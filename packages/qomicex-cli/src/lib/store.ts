// 商店 API 客户端（只读参考契约，不改 store 接口）。
// API base: https://plugins.qomicex.top/api/v1（可用 QOMICEX_STORE_API 覆盖，本地测试指向 wrangler dev）
import { sleep } from './io.ts'

export const DEFAULT_API_BASE = 'https://plugins.qomicex.top/api/v1'

export class StoreApiError extends Error {
  status: number
  code?: string
  constructor(status: number, message: string, code?: string) {
    super(message)
    this.status = status
    this.code = code
  }
}

export interface StoreDeviceCode {
  deviceCode: string
  userCode: string
  verificationUri: string
  verificationUriComplete: string
  expiresIn: number
  interval: number
}

export interface DeviceLoginResult {
  accessToken: string
  refreshToken: string
  user: { id: string; username: string; role?: string; developerLevel?: string }
}

export interface DevKeyResult {
  keyId: string
  cert: unknown
}

async function request<T>(base: string, path: string, init?: RequestInit, token?: string): Promise<T> {
  const headers = new Headers(init?.headers)
  if (token) headers.set('Authorization', `Bearer ${token}`)
  let res: Response
  try {
    res = await fetch(`${base}${path}`, { ...init, headers })
  } catch {
    throw new StoreApiError(0, `无法连接商店 ${base}${path}（网络错误）`)
  }
  const text = await res.text()
  let body: unknown = null
  try {
    body = text ? JSON.parse(text) : null
  } catch {
    body = text
  }
  if (!res.ok) {
    const errBody = body as { code?: string; message?: string; error?: string } | null
    throw new StoreApiError(res.status, errBody?.message ?? errBody?.error ?? `HTTP ${res.status}`, errBody?.code)
  }
  return body as T
}

/** 发起设备流登录（RFC 8628）。 */
export async function requestDeviceCode(base: string): Promise<StoreDeviceCode> {
  return request<StoreDeviceCode>(base, '/auth/device/code', { method: 'POST' })
}

/** 轮询设备流换取访问令牌。 */
export async function pollDeviceLogin(
  base: string,
  code: StoreDeviceCode,
  onTick?: (tried: number) => void,
): Promise<DeviceLoginResult> {
  const deadline = Date.now() + code.expiresIn * 1000
  let tried = 0
  for (;;) {
    if (Date.now() > deadline) throw new StoreApiError(0, '设备授权超时，请重新发起 qomicex publish')
    await sleep(code.interval * 1000)
    tried++
    onTick?.(tried)
    const r = await request<{ status: string; user?: DeviceLoginResult['user'] } & Partial<DeviceLoginResult>>(
      base,
      '/auth/device/token',
      { method: 'POST', body: JSON.stringify({ deviceCode: code.deviceCode }), headers: { 'Content-Type': 'application/json' } },
    )
    if (r.status === 'ok' && r.accessToken) {
      return { accessToken: r.accessToken, refreshToken: r.refreshToken ?? '', user: r.user ?? { id: '', username: '?' } }
    }
    if (r.status !== 'pending') throw new StoreApiError(0, `设备授权失败: ${JSON.stringify(r)}`)
  }
}

/** 我名下/我参与的插件（store 用 slug 查询，上传用行 id）。 */
export async function fetchMinePlugins(base: string, token: string): Promise<{ id: string; slug: string; name: string }[]> {
  const r = await request<{ items: { id: string; slug: string; name: string }[] }>(base, '/plugins/mine', {}, token)
  return r.items ?? []
}

export interface CreatePluginInput {
  slug: string
  name: string
  description?: string
  category?: 'tool' | 'launcher' | 'theme' | 'integration'
  tags?: string[]
  orgId?: string
}

/** 新建插件（store 返回 201 {plugin:{id}}），slug 占用抛 409。 */
export async function createPlugin(base: string, token: string, input: CreatePluginInput): Promise<{ id: string }> {
  const r = await request<{ plugin?: { id?: string } } & { id?: string }>(base, '/plugins', {
    method: 'POST',
    body: JSON.stringify({
      slug: input.slug,
      name: input.name,
      description: input.description ?? '',
      category: input.category ?? 'tool',
      tags: input.tags ?? [],
      ...(input.orgId ? { orgId: input.orgId } : {}),
    }),
    headers: { 'Content-Type': 'application/json' },
  }, token)
  return { id: r.plugin?.id ?? r.id ?? '' }
}

/** 注册/替换开发者签名公钥，返回 keyId + 商店根钥签发的证书。 */
export async function registerDevKey(base: string, token: string, publicKey: string): Promise<DevKeyResult> {
  const r = await request<DevKeyResult>(base, '/developer/keys', {
    method: 'POST',
    body: JSON.stringify({ publicKey }),
    headers: { 'Content-Type': 'application/json' },
  }, token)
  if (!r.keyId || !r.cert) throw new StoreApiError(0, '注册签名公钥响应缺少 keyId/cert')
  return r
}

/** 上传插件版本（multipart file + 可选 changelog）。 */
export async function uploadVersion(
  base: string,
  token: string,
  pluginId: string,
  fileBytes: Uint8Array,
  changelog?: string,
): Promise<unknown> {
  const form = new FormData()
  form.append('file', new Blob([fileBytes as BlobPart], { type: 'application/zip' }), 'plugin.qplugin')
  if (changelog) form.append('changelog', changelog)
  return request<unknown>(base, `/plugins/${encodeURIComponent(pluginId)}/versions`, { method: 'POST', body: form }, token)
}
