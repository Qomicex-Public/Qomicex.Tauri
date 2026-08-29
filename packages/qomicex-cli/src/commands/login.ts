// qomicex login — 设备流登录（RFC 8628）并持久化会话到 ~/.qomicex/auth.json，
// 供后续 publish 免重复登录（refresh token 30 天，旋转式续期）。
import { DEFAULT_API_BASE, requestDeviceCode, pollDeviceLogin } from '../lib/store.ts'
import { authFilePath, saveAuth } from '../lib/auth.ts'
import { info } from '../lib/io.ts'

export interface LoginOptions {
  api?: string
}

export async function loginCommand(opts: LoginOptions = {}): Promise<void> {
  const api = opts.api ?? process.env.QOMICEX_STORE_API ?? DEFAULT_API_BASE
  info('==> 设备流登录')
  info(`  商店: ${api}`)
  const code = await requestDeviceCode(api)
  info('  请在浏览器打开（或扫码）并登录确认：')
  info(`  ${code.verificationUriComplete}`)
  info(`  授权码: ${code.userCode}`)
  const login = await pollDeviceLogin(api, code)
  saveAuth({
    apiBase: api,
    accessToken: login.accessToken,
    refreshToken: login.refreshToken,
    user: { id: login.user.id, username: login.user.username },
    updatedAt: new Date().toISOString(),
  })
  info(`✔ 登录成功：${login.user.username}`)
  info(`  会话已保存到 ${authFilePath()}（30 天内 qomicex publish 免登录）`)
}