import { useState, useEffect } from 'react'
import { tryGetCachedAvatar, fetchAndCacheAvatar } from '../api/skin.ts'
import type { Account } from '../types/index.ts'
import { cn } from '../lib/utils.ts'

export function AccountAvatar({ account, className }: {
  account: Pick<Account, 'name' | 'uuid' | 'loginMethod' | 'serverUrl'>
  className?: string
}) {
  const [imgUrl, setImgUrl] = useState<string | null>(() => tryGetCachedAvatar(account.uuid))
  const [loading, setLoading] = useState(!imgUrl)

  useEffect(() => {
    const cached = tryGetCachedAvatar(account.uuid)
    if (cached) { setImgUrl(cached); setLoading(false); return }
    setLoading(true)
    fetchAndCacheAvatar(account.uuid, account.loginMethod, account.serverUrl)
      .then(setImgUrl)
      .catch(() => setImgUrl(null))
      .finally(() => setLoading(false))
  }, [account.uuid, account.loginMethod, account.serverUrl])

  if (loading) {
    return (
      <div className={cn('flex items-center justify-center rounded-full bg-muted', className)}>
        <div className="h-1/2 w-1/2 animate-pulse rounded-full bg-muted-foreground/20" />
      </div>
    )
  }

  if (!imgUrl) {
    return (
      <div className={cn('rounded-full bg-muted', className)} />
    )
  }

  return (
    <img
      src={imgUrl}
      alt={account.name}
      className={cn('rounded-full object-cover [image-rendering:pixelated]', className)}
    />
  )
}
