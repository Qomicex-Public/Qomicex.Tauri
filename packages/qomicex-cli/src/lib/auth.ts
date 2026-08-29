// 商店认证会话持久化：~/.qomicex/auth.json（跨项目复用登录态，0600）。
// access token 15 分钟 / refresh token 30 天（store /auth/refresh 旋转式），
// 因此持久化 refreshToken，publish 时经 /auth/refresh 续期后复用。
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export interface AuthRecord {
  apiBase: string
  accessToken: string
  refreshToken: string
  user: { id: string; username: string }
  updatedAt: string
}

export function authDir(): string {
  return join(homedir(), '.qomicex')
}

export function authFilePath(): string {
  return join(authDir(), 'auth.json')
}

/** 读取持久化会话；不存在/损坏/缺 refreshToken 时返回 null。 */
export function loadAuth(): AuthRecord | null {
  const p = authFilePath()
  if (!existsSync(p)) return null
  try {
    const raw = JSON.parse(readFileSync(p, 'utf8')) as Partial<AuthRecord>
    if (typeof raw.refreshToken !== 'string' || !raw.refreshToken) return null
    return raw as AuthRecord
  } catch {
    return null
  }
}

export function saveAuth(record: AuthRecord): void {
  const dir = authDir()
  mkdirSync(dir, { recursive: true })
  writeFileSync(authFilePath(), JSON.stringify(record, null, 2) + '\n', { mode: 0o600 })
}

/** 清除持久化会话；存在且已删除返回 true。 */
export function clearAuth(): boolean {
  const p = authFilePath()
  if (!existsSync(p)) return false
  rmSync(p)
  return true
}