import { useState, useEffect } from 'react'
import { tryGetCachedAvatar, fetchAndCacheAvatar } from '../api/skin.ts'
import type { Account } from '../types/index.ts'
import { cn } from '../lib/utils.ts'

export function AccountAvatar({ account, className, textClassName }: {
  account: Pick<Account, 'name' | 'uuid' | 'loginMethod' | 'serverUrl'>
  className?: string
  textClassName?: string
}) {
  const [imgUrl, setImgUrl] = useState<string | null>(() => tryGetCachedAvatar(account.uuid))
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    if (tryGetCachedAvatar(account.uuid)) return
    fetchAndCacheAvatar(account.uuid, account.loginMethod, account.serverUrl).then(setImgUrl)
  }, [account.uuid, account.loginMethod, account.serverUrl])

  if (failed || !imgUrl) {
    return (
      <div className={cn('flex items-center justify-center rounded-full bg-gradient-to-br from-primary/20 to-primary/5 font-bold text-primary ring-1 ring-primary/20', className)}>
        <span className={textClassName}>{account.name.charAt(0).toUpperCase()}</span>
      </div>
    )
  }

  return (
    <img
      src={imgUrl}
      alt={account.name}
      className={cn('rounded-full object-cover [image-rendering:pixelated]', className)}
      onError={() => setFailed(true)}
    />
  )
}
