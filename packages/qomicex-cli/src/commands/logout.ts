// qomicex logout — 清除本地持久化的商店登录会话。
import { clearAuth } from '../lib/auth.ts'
import { info, warn } from '../lib/io.ts'

export async function logoutCommand(): Promise<void> {
  const removed = clearAuth()
  if (removed) info('✔ 已登出（本地会话已清除）')
  else warn('没有已保存的登录会话')
}