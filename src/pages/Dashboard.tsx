import { useEffect, useState, useCallback, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import { faPlay, faRotate, faChevronDown, faUser, faCheck, faMemory, faCube } from '@fortawesome/free-solid-svg-icons'
import { Button } from '../components/ui/button.tsx'
import { getRuntimes, scanRuntimes, loadCustomRuntimes, hasAnyRuntimes, subscribe } from '../stores/javaStore.ts'
import { getDefaultInstance, launchInstance } from '../api/instance.ts'
import { getAccounts, getDefaultAccount, setDefaultAccount } from '../api/account.ts'
import type { GameInstance, Account, JavaRuntime } from '../types/index.ts'
import { usePageAnimation } from '../hooks/usePageAnimation.ts'
import { AccountAvatar } from '../components/AccountAvatar.tsx'
import { InstanceIcon } from '../components/InstanceIcon.tsx'
import { ErrorReportDialog } from '../components/ErrorReportDialog.tsx'
import { getSettings, onSettingsChange } from '../api/settings.ts'

export default function Dashboard() {
  const navigate = useNavigate()
  const [defaultInstance, setDefaultInstance] = useState<GameInstance | null>(null)
  const [launching, setLaunching] = useState(false)
  const [launchError, setLaunchError] = useState<{ title: string; message: string; detail?: string | null; args?: string | null } | null>(null)
  const [defaultAccount, setDefaultAccountState] = useState<Account | null>(null)
  const [allAccounts, setAllAccounts] = useState<Account[]>([])
  const [accountsOpen, setAccountsOpen] = useState(false)
  const [javaRuntimes, setJavaRuntimes] = useState<JavaRuntime[]>(() => getRuntimes())
  const [watermarkEnabled, setWatermarkEnabled] = useState(true)
  const [watermarkText, setWatermarkText] = useState('Qomicex')
  const [watermarkSubtext, setWatermarkSubtext] = useState('启动器')
  const pageRef = usePageAnimation()
  const accountRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const unsub = subscribe(() => setJavaRuntimes([...getRuntimes()]))
    return unsub
  }, [])

  useEffect(() => {
    Promise.all([
      getDefaultInstance(),
      getDefaultAccount().catch(() => null),
    ]).then(([inst, acc]) => {
      setDefaultInstance(inst)
      setDefaultAccountState(acc)
    })
    loadCustomRuntimes().catch(() => {})
    if (!hasAnyRuntimes()) {
      scanRuntimes('quick').catch(() => {})
    }
  }, [])

  useEffect(() => {
    function load(s = getSettings()) {
      setWatermarkEnabled(s.watermarkEnabled !== false)
      setWatermarkText(s.watermarkText || 'Qomicex')
      setWatermarkSubtext(s.watermarkSubtext || '启动器')
    }
    load()
    return onSettingsChange(load)
  }, [])

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (accountRef.current && !accountRef.current.contains(e.target as Node)) setAccountsOpen(false)
    }
    if (accountsOpen) document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [accountsOpen])

  const openAccountDropdown = useCallback(async () => {
    if (accountsOpen) { setAccountsOpen(false); return }
    try {
      const list = await getAccounts()
      setAllAccounts(list)
      setAccountsOpen(true)
    } catch { /* ignore */ }
  }, [accountsOpen])

  async function handleSwitchAccount(uuid: string) {
    try {
      const acc = await setDefaultAccount(uuid)
      setDefaultAccountState(acc)
      setAccountsOpen(false)
    } catch { /* ignore */ }
  }

  const handleLaunch = async () => {
    if (!defaultInstance) return
    setLaunching(true)
    try {
      const result = await launchInstance(defaultInstance.id)
      if (!result.success) {
        setLaunchError({
          title: '启动失败',
          message: result.error || '未知错误',
          detail: result.detail,
          args: result.arguments,
        })
      }
    } catch (e) {
      setLaunchError({ title: '启动失败', message: e instanceof Error ? e.message : String(e) })
    }
    setLaunching(false)
  }

  const validJava = javaRuntimes.filter((j) => j.state === 'Valid')

  return (
    <div ref={pageRef} className="relative flex h-full flex-col p-8">
      {/* Center branding */}
      <div className="flex flex-1 flex-col items-center justify-center">
        {watermarkEnabled && (
          <>
            <h1 className="select-none text-6xl font-bold tracking-widest text-foreground/90">{watermarkText}</h1>
            <p className="mt-2 select-none text-xs font-semibold tracking-[0.5em] text-primary/60">{watermarkSubtext}</p>
          </>
        )}
      </div>

      {/* Right widgets */}
      <div className="absolute right-8 top-24 w-72 space-y-4">
        {/* Account widget */}
        <div className="relative z-50">
          <div className="rounded-xl border border-border/30 bg-card/70 p-4 backdrop-blur-md">
            <p className="mb-3 text-[10px] font-semibold uppercase tracking-widest text-muted-foreground/60">账户</p>
            <div ref={accountRef} className="flex items-center gap-3">
              {defaultAccount ? (
                <AccountAvatar account={defaultAccount} className="h-9 w-9 shrink-0" textClassName="text-sm font-bold" />
              ) : (
                <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-muted">
                  <FontAwesomeIcon icon={faUser} className="h-4 w-4 text-muted-foreground" />
                </div>
              )}
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">{defaultAccount ? defaultAccount.name : '未设置默认账户'}</p>
                <p className="text-[10px] text-muted-foreground/60">{defaultAccount ? '默认账户' : '在设置中添加'}</p>
              </div>
              <Button variant="ghost" size="sm" onClick={openAccountDropdown} className="h-6 w-6 shrink-0 p-0">
                <FontAwesomeIcon icon={faChevronDown} className="h-3 w-3" />
              </Button>
            </div>
          </div>
          {accountsOpen && (
            <div className="absolute right-0 top-full z-50 mt-1 w-56 rounded-lg border bg-popover p-1 shadow-lg">
              <div className="max-h-60 overflow-y-auto">
                {allAccounts.map((acc) => {
                  const isDefault = acc.uuid === defaultAccount?.uuid
                  return (
                    <button
                      key={acc.uuid}
                      onMouseDown={() => handleSwitchAccount(acc.uuid)}
                      className="flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left text-xs hover:bg-accent"
                    >
                      <AccountAvatar account={acc} className="h-6 w-6 shrink-0" textClassName="text-[10px] font-bold" />
                      <span className="flex-1 truncate">{acc.name}</span>
                      {isDefault && <FontAwesomeIcon icon={faCheck} className="h-3 w-3 text-primary" />}
                    </button>
                  )
                })}
              </div>
              <div className="border-t border-border pt-1 mt-1">
                <button
                  onMouseDown={() => { navigate('/accounts'); setAccountsOpen(false) }}
                  className="flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left text-xs text-muted-foreground hover:bg-accent"
                >
                  <FontAwesomeIcon icon={faUser} className="h-3 w-3" />
                  管理账户
                </button>
              </div>
            </div>
          )}
        </div>

        {/* System widget */}
        <div className="rounded-xl border border-border/30 bg-card/70 p-4 backdrop-blur-md">
          <p className="mb-3 text-[10px] font-semibold uppercase tracking-widest text-muted-foreground/60">系统</p>
          <div className="space-y-2.5">
            <div className="flex items-center gap-2 text-xs">
              <FontAwesomeIcon icon={faCube} className="h-3 w-3 text-muted-foreground/50" />
              <span className="text-muted-foreground/70">Java</span>
              <span className="ml-auto font-medium">{validJava.length > 0 ? validJava[0].version : '未检测'}</span>
            </div>
            <div className="flex items-center gap-2 text-xs">
              <FontAwesomeIcon icon={faMemory} className="h-3 w-3 text-muted-foreground/50" />
              <span className="text-muted-foreground/70">版本</span>
              <span className="ml-auto font-medium">1.0.0</span>
            </div>
          </div>
        </div>
      </div>

      {/* Bottom action bar */}
      {defaultInstance ? (
        <div className="mt-auto flex items-center justify-between rounded-2xl border border-border/30 bg-card/70 px-6 py-4 backdrop-blur-md">
          <div className="flex items-center gap-4">
            <InstanceIcon icon={defaultInstance.icon} loader={defaultInstance.loader} className="h-12 w-12 shrink-0 rounded-xl" imgClassName="rounded-xl" />
            <div>
              <div className="flex items-center gap-2">
                <button onClick={() => navigate(`/instances/${defaultInstance.id}`)} className="text-base font-semibold hover:underline">
                  {defaultInstance.name}
                </button>
                <span className="rounded bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium text-primary">
                  {defaultInstance.loader || 'Vanilla'}
                </span>
              </div>
              <p className="mt-0.5 text-xs text-muted-foreground/70">
                {defaultInstance.gameVersion}
                {defaultInstance.loader && ` · ${defaultInstance.loader} ${defaultInstance.loaderVersion}`}
                {defaultInstance.lastPlayed && ` · 上次游玩 ${new Date(defaultInstance.lastPlayed).toLocaleDateString('zh-CN')}`}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-4">
            <div className="hidden text-right md:block">
              <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/60">状态</p>
              <p className="text-sm text-muted-foreground">{launching ? '启动中...' : '准备就绪'}</p>
            </div>
            <Button
              onClick={handleLaunch}
              disabled={launching}
              className="flex h-14 items-center gap-3 rounded-xl px-10 text-lg font-bold tracking-widest transition-all hover:brightness-110 active:scale-95"
            >
              <FontAwesomeIcon icon={launching ? faRotate : faPlay} className={cn('h-5 w-5', launching && 'animate-spin')} />
              {launching ? '启动中' : '启动'}
            </Button>
          </div>
        </div>
      ) : (
        <div className="mt-auto flex flex-col items-center gap-2 rounded-2xl border border-dashed border-border/40 bg-card/30 px-6 py-8 text-center backdrop-blur-md">
          <FontAwesomeIcon icon={faCube} className="h-6 w-6 text-muted-foreground/30" />
          <p className="text-sm text-muted-foreground">尚未固定实例</p>
          <Button variant="outline" size="sm" onClick={() => navigate('/instances')} className="mt-1">
            前往实例管理
          </Button>
        </div>
      )}

      <ErrorReportDialog
        open={!!launchError}
        title={launchError?.title || ''}
        message={launchError?.message || ''}
        detail={launchError?.detail}
        args={launchError?.args}
        onClose={() => setLaunchError(null)}
      />
    </div>
  )
}

function cn(...classes: (string | boolean | undefined | null)[]): string {
  return classes.filter(Boolean).join(' ')
}
