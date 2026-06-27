import { type ClassValue, clsx } from "clsx"
import { twMerge } from "tailwind-merge"
import type { Account } from '../types/index.ts'

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

export function getAvatarUrl(account: Pick<Account, 'uuid' | 'loginMethod' | 'serverUrl'>): string {
  if (account.loginMethod === 'Yggdrasil' && account.serverUrl) {
    const base = account.serverUrl.replace(/\/api\/yggdrasil\/?$/, '').replace(/\/+$/, '')
    return `${base}/avatar/${account.uuid}.png`
  }
  return `https://crafatar.com/avatars/${account.uuid}?overlay`
}
