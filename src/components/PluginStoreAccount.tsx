import { useEffect, useRef, useState } from 'react'
import { Copy, LogOut, User } from 'lucide-react'
import { Button, Label, Separator, useMessageBox } from './ui'
import { useI18n } from '../i18n/index.tsx'
import { openUrl } from '@tauri-apps/plugin-opener'
import {
  fetchMyPlugins,
  fetchStoreMe,
  storeDeviceCode,
  storeDeviceToken,
  storeLogout,
  type StoreDeviceCode,
  type StoreUser,
} from '../api/pluginStore.ts'

interface MyPluginItem {
  slug?: string
  name?: string
  status?: string
  latestVersion?: string
  downloadsCount?: number
}

function roleLabelKey(role: string): string {
  if (role === 'admin') return 'settings.plugins.store.roleAdmin'
  if (role === 'developer') return 'settings.plugins.store.roleDeveloper'
  return 'settings.plugins.store.roleUser'
}

function levelLabelKey(level: string): string {
  if (level === 'organization') return 'settings.plugins.store.levelOrganization'
  if (level === 'official') return 'settings.plugins.store.levelOfficial'
  return 'settings.plugins.store.levelIndividual'
}

interface DeviceSession {
  code: StoreDeviceCode
  startedAt: number
}

export default function PluginStoreAccount() {
  const { t } = useI18n()
  const { notify } = useMessageBox()

  const [user, setUser] = useState<StoreUser | null>(null)
  const [loadingMe, setLoadingMe] = useState(true)
  const [device, setDevice] = useState<DeviceSession | null>(null)
  const [expired, setExpired] = useState(false)
  const [starting, setStarting] = useState(false)
  const [myPlugins, setMyPlugins] = useState<MyPluginItem[]>([])
  const [myLoading, setMyLoading] = useState(false)
  const pollRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const stoppedRef = useRef(false)

  function stopPolling() {
    stoppedRef.current = true
    if (pollRef.current) {
      clearTimeout(pollRef.current)
      pollRef.current = null
    }
  }

  async function loadMine() {
    setMyLoading(true)
    try {
      const res = await fetchMyPlugins() as unknown as { items?: MyPluginItem[] }
      setMyPlugins(res.items ?? [])
    } catch {
      setMyPlugins([])
    } finally {
      setMyLoading(false)
    }
  }

  async function refreshMe(alsoLoadMine: boolean) {
    setLoadingMe(true)
    try {
      const res = await fetchStoreMe()
      setUser(res.user)
      if (res.user && alsoLoadMine) void loadMine()
    } catch {
      setUser(null)
    } finally {
      setLoadingMe(false)
    }
  }

  useEffect(() => {
    void refreshMe(true)
    return stopPolling
  }, [])

  function beginPolling(session: DeviceSession) {
    stopPolling()
    stoppedRef.current = false
    // 单飞递归调度：上一请求完成（且未被停止）才排下一次，避免慢请求重叠；
    // stoppedRef 使停止后仍在途的回调失效，防止重复成功通知。
    const tick = async () => {
      if (stoppedRef.current) return
      if (Date.now() - session.startedAt > session.code.expiresIn * 1000) {
        stopPolling()
        setExpired(true)
        setDevice(null)
        return
      }
      try {
        const res = await storeDeviceToken(session.code.deviceCode)
        if (stoppedRef.current) return
        if (res.status === 'ok') {
          stopPolling()
          setDevice(null)
          notify(t('settings.plugins.store.loginSuccess'), 'success')
          await refreshMe(true)
          return
        }
      } catch {
        // 网络抖动等瞬时错误：继续轮询，直至过期
      }
      if (!stoppedRef.current) {
        pollRef.current = setTimeout(tick, Math.max(2, session.code.interval) * 1000)
      }
    }
    pollRef.current = setTimeout(tick, Math.max(2, session.code.interval) * 1000)
  }

  async function startDeviceLogin() {
    setStarting(true)
    setExpired(false)
    try {
      const code = await storeDeviceCode()
      const session: DeviceSession = { code, startedAt: Date.now() }
      setDevice(session)
      beginPolling(session)
    } catch (e) {
      notify(e instanceof Error ? e.message : String(e), 'error')
    } finally {
      setStarting(false)
    }
  }

  function cancelDeviceLogin() {
    stopPolling()
    setDevice(null)
  }

  async function copyUserCode(text: string) {
    try {
      await navigator.clipboard.writeText(text)
      notify(t('settings.plugins.store.deviceCopied'), 'success')
    } catch {
      notify(t('settings.plugins.store.deviceCopyFailed'), 'error')
    }
  }

  async function handleLogout() {
    try {
      await storeLogout()
    } catch {
      // 清理本地会话失败不阻断 UI
    }
    setUser(null)
    setMyPlugins([])
    notify(t('settings.plugins.store.loggedOut'), 'success')
  }

  if (loadingMe) {
    return <p className="py-10 text-center text-muted-foreground">{t('common.loading')}</p>
  }

  if (!user) {
    return (
      <div className="max-w-md space-y-4">
        <p className="text-sm text-muted-foreground">{t('settings.plugins.store.deviceLoginDesc')}</p>
        {!device ? (
          <div className="space-y-3">
            <Button onClick={() => void startDeviceLogin()} disabled={starting}>
              {starting ? t('common.loading') : t('settings.plugins.store.deviceStart')}
            </Button>
            {expired && (
              <p className="text-sm text-destructive">{t('settings.plugins.store.deviceExpired')}</p>
            )}
          </div>
        ) : (
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label>{t('settings.plugins.store.deviceCodeLabel')}</Label>
              <div className="flex items-center gap-2">
                <span className="rounded border border-border bg-muted px-3 py-1.5 font-mono text-lg font-semibold tracking-widest">
                  {device.code.userCode}
                </span>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => void copyUserCode(device.code.userCode)}
                >
                  <Copy className="mr-1.5 h-3.5 w-3.5" />
                  {t('settings.plugins.store.deviceCopy')}
                </Button>
              </div>
            </div>
            <p className="text-sm text-muted-foreground">{t('settings.plugins.store.deviceSteps')}</p>
            <div className="flex flex-wrap items-center gap-2">
              <Button
                onClick={async () => {
                  try {
                    await openUrl(device.code.verificationUriComplete)
                  } catch (e) {
                    notify(e instanceof Error ? e.message : String(e), 'error')
                  }
                }}
              >
                {t('settings.plugins.store.deviceOpenPage')}
              </Button>
              <span className="flex items-center gap-2 text-sm text-muted-foreground">
                <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-primary" />
                {t('settings.plugins.store.deviceWaiting')}
              </span>
            </div>
            <Button size="sm" variant="ghost" onClick={cancelDeviceLogin}>
              {t('settings.plugins.store.deviceCancel')}
            </Button>
          </div>
        )}
      </div>
    )
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-4">
        <div className="flex h-12 w-12 items-center justify-center overflow-hidden rounded-full bg-primary/10">
          {user.avatarUrl ? (
            <img src={user.avatarUrl} alt="" className="h-full w-full object-cover" />
          ) : (
            <User className="h-5 w-5 text-primary" />
          )}
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-base font-medium">{user.displayName || user.username}</div>
          {user.email && <div className="truncate text-xs text-muted-foreground">{user.email}</div>}
          <div className="mt-1 flex flex-wrap gap-1.5">
            <span className="rounded bg-primary/10 px-1.5 py-0.5 text-[11px] text-primary">{t(roleLabelKey(user.role))}</span>
            <span className="rounded border border-border px-1.5 py-0.5 text-[11px] text-muted-foreground">{t(levelLabelKey(user.developerLevel))}</span>
          </div>
        </div>
        <Button variant="outline" size="sm" onClick={() => void handleLogout()}>
          <LogOut className="mr-1.5 h-3.5 w-3.5" />
          {t('settings.plugins.store.logout')}
        </Button>
      </div>

      <Separator className="my-2" />

      <p className="text-sm font-medium">{t('settings.plugins.store.myPlugins')}</p>
      {myLoading ? (
        <p className="py-6 text-center text-sm text-muted-foreground">{t('common.loading')}</p>
      ) : myPlugins.length === 0 ? (
        <p className="py-6 text-center text-sm text-muted-foreground">{t('settings.plugins.store.myPluginsEmpty')}</p>
      ) : (
        <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
          {myPlugins.map((p, i) => (
            <div key={p.slug ?? i} className="flex items-center gap-3 rounded-lg border border-border px-3 py-2 text-sm">
              <span className="min-w-0 flex-1 truncate font-medium">{p.name ?? p.slug}</span>
              {p.latestVersion && <span className="text-xs text-muted-foreground">v{p.latestVersion}</span>}
              <span className="rounded bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">{p.status ?? ''}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
