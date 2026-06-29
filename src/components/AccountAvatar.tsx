import { useState } from 'react'
import { getAvatarUrl as getSkinAvatarUrl } from '../api/skin.ts'
import type { Account } from '../types/index.ts'
import { cn } from '../lib/utils.ts'

export function AccountAvatar({ account, className, textClassName }: {
  account: Pick<Account, 'name' | 'uuid' | 'loginMethod' | 'serverUrl'>
  className?: string
  textClassName?: string
}) {
  const [failed, setFailed] = useState(false)
  const proxyUrl = getSkinAvatarUrl(account.uuid, account.loginMethod, account.serverUrl)

  if (failed) {
    return (
      <div className={cn('flex items-center justify-center rounded-full bg-gradient-to-br from-primary/20 to-primary/5 font-bold text-primary ring-1 ring-primary/20', className)}>
        <span className={textClassName}>{account.name.charAt(0).toUpperCase()}</span>
      </div>
    )
  }

  return (
    <img
      src={proxyUrl}
      alt={account.name}
      className={cn('rounded-full object-cover', className)}
      onError={() => setFailed(true)}
    />
  )
}
