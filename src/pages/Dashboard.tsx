import { useEffect, useState, useCallback, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import { faPlay, faPlus, faComputer, faLayerGroup, faCube, faStar, faRotate, faArrowRight, faChevronDown, faUser, faCheck } from '@fortawesome/free-solid-svg-icons'
import { Button } from '../components/ui/button.tsx'
import { Card, CardHeader, CardTitle, CardContent } from '../components/ui/card.tsx'
import { Badge } from '../components/ui/badge.tsx'
import { getSystemInfo } from '../api/system.ts'
import { getJavaList } from '../api/java.ts'
import { getDefaultInstance, launchInstance } from '../api/instance.ts'
import { getAccounts, getDefaultAccount, setDefaultAccount } from '../api/account.ts'
import type { SystemInfo, JavaRuntime, GameInstance, Account } from '../types/index.ts'
import { usePageAnimation } from '../hooks/usePageAnimation.ts'
import { AccountAvatar } from '../components/AccountAvatar.tsx'
import { ErrorReportDialog } from '../components/ErrorReportDialog.tsx'

const LOADER_COLORS: Record<string, string> = {
  forge: 'bg-orange-500/10 text-orange-500 border-orange-500/25',
  fabric: 'bg-cyan-500/10 text-cyan-400 border-cyan-400/25',
  neoforge: 'bg-green-500/10 text-green-500 border-green-500/25',
  quilt: 'bg-purple-500/10 text-purple-400 border-purple-400/25',
}

export default function Dashboard() {
  const navigate = useNavigate()
  const [sysInfo, setSysInfo] = useState<SystemInfo | null>(null)
  const [javaRuntimes, setJavaRuntimes] = useState<JavaRuntime[]>([])
  const [defaultInstance, setDefaultInstance] = useState<GameInstance | null>(null)
  const [launching, setLaunching] = useState(false)
  const [launchError, setLaunchError] = useState<{ title: string; message: string; detail?: string | null; args?: string | null } | null>(null)
  const [defaultAccount, setDefaultAccountState] = useState<Account | null>(null)
  const [allAccounts, setAllAccounts] = useState<Account[]>([])
  const [accountsOpen, setAccountsOpen] = useState(false)
  const pageRef = usePageAnimation()
  const accountRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    Promise.all([getSystemInfo(), getJavaList('quick'), getDefaultInstance(), getDefaultAccount().catch(() => null)])
      .then(([sys, java, inst, acc]) => {
        setSysInfo(sys)
        setJavaRuntimes(java)
        setDefaultInstance(inst)
        setDefaultAccountState(acc)
      })
      .catch(console.error)
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

  const validJava = javaRuntimes.filter((j) => j.state === 'Valid')

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

  function formatDate(iso: string | null): string {
    if (!iso) return '从未'
    const d = new Date(iso)
    const now = new Date()
    const diff = now.getTime() - d.getTime()
    if (diff < 60000) return '刚刚'
    if (diff < 3600000) return `${Math.floor(diff / 60000)} 分钟前`
    if (diff < 86400000) return `${Math.floor(diff / 3600000)} 小时前`
    return d.toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' })
  }

  return (
    <div ref={pageRef} className="space-y-6 p-8">
      {defaultInstance ? (
        <Card className="overflow-hidden border-primary/20 bg-gradient-to-br from-primary/5 to-card">
          <CardContent className="p-6">
            <div className="flex items-start justify-between gap-4">
              <div className="space-y-3 min-w-0">
                <div className="flex items-center gap-2">
                  <FontAwesomeIcon icon={faStar} className="h-4 w-4 text-amber-400" />
                  <h2 className="text-lg font-semibold">{defaultInstance.name}</h2>
                </div>
                <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
                  <span>{defaultInstance.gameVersion}</span>
                  {defaultInstance.loader && (
                    <span className={cn('inline-flex items-center rounded border px-1.5 py-0.5 text-[11px] font-medium', LOADER_COLORS[defaultInstance.loader.toLowerCase()] ?? 'bg-muted text-muted-foreground border-border')}>
                      {defaultInstance.loader} {defaultInstance.loaderVersion}
                    </span>
                  )}
                  <span>· 最后游玩 {formatDate(defaultInstance.lastPlayed)}</span>
                </div>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <Button size="lg" onClick={handleLaunch} disabled={launching} className="gap-2">
                  <FontAwesomeIcon icon={launching ? faRotate : faPlay} className={cn('h-4 w-4', launching && 'animate-spin')} />
                  {launching ? '启动中...' : '启动游戏'}
                </Button>
                <Button variant="outline" size="icon" onClick={() => navigate(`/instances/${defaultInstance.id}`)}>
                  <FontAwesomeIcon icon={faArrowRight} className="h-4 w-4" />
                </Button>
              </div>
            </div>
          </CardContent>
        </Card>
      ) : (
        <Card className="border-dashed">
          <CardContent className="flex flex-col items-center gap-3 py-12 text-center">
            <FontAwesomeIcon icon={faStar} className="h-8 w-8 text-muted-foreground/30" />
            <p className="text-sm text-muted-foreground">尚未固定实例</p>
            <Button variant="outline" size="sm" onClick={() => navigate('/instances')}>
              <FontAwesomeIcon icon={faPlus} className="mr-1.5 h-3.5 w-3.5" />前往实例管理
            </Button>
          </CardContent>
        </Card>
      )}

      <Card ref={accountRef} className="relative">
        <CardContent className="flex items-center justify-between gap-3 p-4">
          <div className="flex items-center gap-3 min-w-0">
            {defaultAccount ? (
              <AccountAvatar account={defaultAccount} className="h-9 w-9 shrink-0" textClassName="text-sm font-bold" />
            ) : (
              <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-muted">
                <FontAwesomeIcon icon={faUser} className="h-4 w-4 text-muted-foreground" />
              </div>
            )}
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium truncate">{defaultAccount ? defaultAccount.name : '未设置默认账户'}</span>
                {defaultAccount && (
                  <span className="inline-flex items-center gap-1 rounded-full bg-amber-500/10 px-2 py-0.5 text-[10px] font-medium text-amber-400">
                    <FontAwesomeIcon icon={faStar} className="h-2 w-2" />默认
                  </span>
                )}
              </div>
              <p className="text-[11px] text-muted-foreground">启动游戏时使用的账户</p>
            </div>
          </div>
          <Button variant="outline" size="sm" onClick={openAccountDropdown} className="gap-1.5 shrink-0 h-7 text-xs">
            <FontAwesomeIcon icon={faChevronDown} className="h-3 w-3" />切换
          </Button>
          {accountsOpen && (
            <div className="absolute right-0 top-full z-50 mt-1 w-56 rounded-lg border bg-popover p-1 shadow-lg">
              {allAccounts.map((acc) => {
                const isDefault = acc.uuid === defaultAccount?.uuid
                return (
                  <button
                    key={acc.uuid}
                    onClick={() => handleSwitchAccount(acc.uuid)}
                    className="flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left text-xs hover:bg-accent"
                  >
                    <AccountAvatar account={acc} className="h-6 w-6 shrink-0" textClassName="text-[10px] font-bold" />
                    <span className="flex-1 truncate">{acc.name}</span>
                    {isDefault && <FontAwesomeIcon icon={faCheck} className="h-3 w-3 text-primary" />}
                  </button>
                )
              })}
              <div className="border-t border-border mt-1 pt-1">
                <button
                  onClick={() => { navigate('/accounts'); setAccountsOpen(false) }}
                  className="flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left text-xs text-muted-foreground hover:bg-accent"
                >
                  <FontAwesomeIcon icon={faUser} className="h-3 w-3" />
                  管理账户
                </button>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      <div className="anim-stagger grid gap-4 md:grid-cols-2">
        <Card>
          <CardHeader className="flex-row items-center justify-between pb-2">
            <CardTitle className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              <FontAwesomeIcon icon={faComputer} className="mr-1.5 h-3 w-3" />
              系统信息
            </CardTitle>
          </CardHeader>
          <CardContent>
            {sysInfo ? (
              <div className="space-y-1.5">
                {[
                  ['操作系统', sysInfo.osName],
                  ['版本', sysInfo.osVersion],
                  ['架构', sysInfo.architecture],
                  ['内存', `${(sysInfo.memory / 1024).toFixed(1)} GB`],
                ].map(([label, value]) => (
                  <div key={label as string} className="flex items-center justify-between border-b border-border py-1.5 text-sm last:border-0">
                    <span className="text-muted-foreground">{label as string}</span>
                    <span className="font-medium">{value as string}</span>
                  </div>
                ))}
              </div>
            ) : (
              <p className="py-3 text-sm text-muted-foreground">加载中...</p>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex-row items-center justify-between pb-2">
            <CardTitle className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              <FontAwesomeIcon icon={faLayerGroup} className="mr-1.5 h-3 w-3" />
              Java 运行时
            </CardTitle>
            <Badge variant="secondary">{validJava.length} 个</Badge>
          </CardHeader>
          <CardContent>
            {validJava.length > 0 ? (
              <div className="space-y-1.5">
                {validJava.slice(0, 4).map((j, i) => (
                  <div key={i} className="flex items-center justify-between border-b border-border py-1.5 text-sm last:border-0">
                    <span className="text-muted-foreground">{j.name}</span>
                    <span className="font-medium">{j.version} · {j.arch}</span>
                  </div>
                ))}
              </div>
            ) : (
              <p className="py-3 text-sm text-muted-foreground">未检测到 Java 运行时</p>
            )}
          </CardContent>
        </Card>
      </div>

      <div className="flex items-center gap-2">
        <h3 className="text-sm font-semibold">快捷操作</h3>
      </div>
      <div className="grid gap-3 md:grid-cols-4">
        <Button variant="outline" className="h-20 flex-col gap-1" onClick={() => navigate('/instances')}>
          <FontAwesomeIcon icon={faCube} className="h-5 w-5" />
          <span className="text-xs">实例管理</span>
        </Button>
        <Button variant="outline" className="h-20 flex-col gap-1" onClick={() => navigate('/resource-center')}>
          <FontAwesomeIcon icon={faPlus} className="h-5 w-5" />
          <span className="text-xs">资源中心</span>
        </Button>
        <Button variant="outline" className="h-20 flex-col gap-1" onClick={() => navigate('/downloads')}>
          <FontAwesomeIcon icon={faPlay} className="h-5 w-5" />
          <span className="text-xs">下载中心</span>
        </Button>
        <Button variant="outline" className="h-20 flex-col gap-1" onClick={() => navigate('/settings')}>
          <FontAwesomeIcon icon={faComputer} className="h-5 w-5" />
          <span className="text-xs">设置</span>
        </Button>
      </div>
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
