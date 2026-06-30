import { type ClassValue, clsx } from "clsx"
import { twMerge } from "tailwind-merge"
import type { Account } from '../types/index.ts'

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

let _convertFileSrc: ((path: string) => string) | undefined
export async function resolveBgUrl(path: string): Promise<string> {
  if (!path || path.startsWith('data:') || path.includes('://')) return path
  if (_convertFileSrc) return _convertFileSrc(path)
  try {
    const mod = await import('@tauri-apps/api/core')
    _convertFileSrc = mod.convertFileSrc
    return mod.convertFileSrc(path)
  } catch {
    return 'file:///' + path.replace(/\\/g, '/').replace(/^\/+/, '')
  }
}

export function getAvatarUrl(account: Pick<Account, 'uuid' | 'loginMethod' | 'serverUrl'>): string {
  if (account.loginMethod === 'Yggdrasil' && account.serverUrl) {
    const base = account.serverUrl.replace(/\/api\/yggdrasil\/?$/, '').replace(/\/+$/, '')
    return `${base}/avatar/${account.uuid}.png`
  }
  return `https://crafatar.com/avatars/${account.uuid}?overlay`
}
