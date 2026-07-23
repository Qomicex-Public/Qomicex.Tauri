import { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import { faMicrosoft, faKeycdn } from '@fortawesome/free-brands-svg-icons'
import { faPlus, faUser, faRightToBracket, faFingerprint, faTrashCan, faUserLarge, faSpinner, faCheck, faCopy, faExternalLinkAlt, faCloud, faStar, faRotate, faMagnifyingGlass } from '@fortawesome/free-solid-svg-icons'
import { Button } from '../components/ui/button.tsx'
import { Input } from '../components/ui/input.tsx'
import { Label } from '../components/ui/label.tsx'
import { useMessageBox } from '../components/ui/message-box.tsx'
import { cn } from '../lib/utils.ts'
import { cacheGet, cacheSet, cacheInvalidate } from '../lib/simple-cache.ts'
import { invalidateAvatarCache } from '../api/skin.ts'
import { PageHeader } from '../components/PageHeader.tsx'
import { PageShell } from '../components/PageShell.tsx'
import { Select, SelectOption } from '../components/ui/select.tsx'
import { AccountAvatar } from '../components/AccountAvatar.tsx'
import { Dialog, DialogHeader, DialogTitle, DialogBody } from '../components/ui/dialog.tsx'
import { ApiError } from '../api/client.ts'
import { Tooltip } from '../components/ui/tooltip.tsx'
import * as accountApi from '../api/account.ts'
import type { MicrosoftOAuthResponse, Account, YggdrasilProfileInfo } from '../types/index.ts'
import { openUrl } from '@tauri-apps/plugin-opener'

function fmtErr(e: unknown): string {
  if (e instanceof ApiError) return e.displayMessage
  if (e instanceof Error) return e.message
  return String(e)
}

function fmtOAuthError(code: string): string {
  switch (code) {
    case 'access_denied': return '你在浏览器中取消或拒绝了授权'
    case 'expired_token': return '验证码已过期，请重新登录'
    case 'invalid_grant': return '授权无效，请重新登录'
    default: return `登录失败：${code}`
  }
}

function getAccountLabel(loginMethod: string, serverUrl?: string | null): string {
  if (loginMethod === 'Microsoft') return 'Microsoft'
  if (loginMethod === 'Offline') return '离线'
  if (loginMethod === 'Yggdrasil') {
    const cached = accountApi.getCachedMeta(serverUrl)
    return cached ? `第三方/${cached}` : '第三方'
  }
  if (loginMethod === '统一通行证') {
    return serverUrl || '统一通行证'
  }
  return loginMethod
}

function getAccountIcon(loginMethod: string): { icon: typeof faUser; color: string } {
  if (loginMethod === 'Microsoft') return { icon: faMicrosoft, color: 'text-green-400' }
  if (loginMethod === 'Offline') return { icon: faUserLarge, color: 'text-yellow-400' }
  return { icon: faKeycdn, color: 'text-purple-400' }
}

type MicrosoftStep = 'idle' | 'fetching-oauth' | 'waiting-auth' | 'fetching-info' | 'done' | 'error'

export default function Accounts() {
  const navigate = useNavigate()
  const { error: msgError, confirm: msgConfirm } = useMessageBox()
  const [accounts, setAccounts] = useState<Account[]>([])
  const [addOpen, setAddOpen] = useState(false)
  const [addTab, setAddTab] = useState<'microsoft' | 'offline' | 'yggdrasil' | 'tongyi'>('microsoft')
  const [loading, setLoading] = useState(false)
  const [search, setSearch] = useState('')
  const [filterType, setFilterType] = useState<'all' | 'name' | 'loginMethod' | 'server'>('all')
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const lastClickedRef = useRef<number>(-1)
  // ponytail: shift-select uses filteredAccounts index — drifts if search changes mid-range. Fine for MVP.
  const filteredAccounts = useMemo(() => {
    if (!search) return accounts
    const q = search.toLowerCase()
    return accounts.filter(a => {
      if (filterType === 'name') return a.name.toLowerCase().includes(q)
      if (filterType === 'loginMethod') return getAccountLabel(a.loginMethod, a.serverUrl).toLowerCase().includes(q)
      if (filterType === 'server') return (a.serverUrl || '').toLowerCase().includes(q)
      return a.name.toLowerCase().includes(q) ||
        getAccountLabel(a.loginMethod, a.serverUrl).toLowerCase().includes(q) ||
        (a.serverUrl || '').toLowerCase().includes(q)
    })
  }, [accounts, search, filterType])

  const [oauthData, setOauthData] = useState<MicrosoftOAuthResponse | null>(null)
  const [microsoftStep, setMicrosoftStep] = useState<MicrosoftStep>('idle')
  const [microsoftMsg, setMicrosoftMsg] = useState('')
  const pollTimer = useRef<ReturnType<typeof setInterval> | null>(null)

  const [offlineName, setOfflineName] = useState('')
  const [offlineUuid, setOfflineUuid] = useState('')
  const uuidTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    if (!offlineName.trim()) { setOfflineUuid(''); return }
    if (uuidTimer.current) clearTimeout(uuidTimer.current)
    uuidTimer.current = setTimeout(async () => {
      try {
        const { uuid } = await accountApi.getOfflineUuid(offlineName.trim())
        setOfflineUuid(uuid)
      } catch { /* ignore */ }
    }, 400)
    return () => { if (uuidTimer.current) clearTimeout(uuidTimer.current) }
  }, [offlineName])

  const [yggEmail, setYggEmail] = useState('')
  const [yggPwd, setYggPwd] = useState('')
  const [yggServer, setYggServer] = useState('https://littleskin.cn/api/yggdrasil')
  const [yggStep, setYggStep] = useState<'form' | 'profiles'>('form')
  const [yggProfiles, setYggProfiles] = useState<YggdrasilProfileInfo[]>([])
  const [yggSelected, setYggSelected] = useState<Set<string>>(new Set())
  const [yggAuthToken, setYggAuthToken] = useState('')
  const [yggClientToken, setYggClientToken] = useState('')

  const [tyServerId, setTyServerId] = useState('')
  const [tyEmail, setTyEmail] = useState('')
  const [tyPwd, setTyPwd] = useState('')
  const [, setMetaVersion] = useState(0)

  const defaultUuid = accounts.find((a) => a.isDefault)?.uuid

  const refresh = useCallback(async () => {
    try {
      const list = await accountApi.getAccounts()
      setAccounts(list)
      cacheSet('api-accounts', list)
      const fetches = list
        .filter((a) => a.loginMethod === 'Yggdrasil' && a.serverUrl && !accountApi.getCachedMeta(a.serverUrl))
        .map((a) => accountApi.getYggdrasilMeta(a.serverUrl!))
      if (fetches.length > 0) { await Promise.all(fetches); setMetaVersion((v) => v + 1) }
    } catch { /* ignore */ }
  }, [])

  const forceRefresh = useCallback(async () => {
    cacheInvalidate('api-accounts')
    invalidateAvatarCache()
    await refresh()
  }, [refresh])

  // show cached accounts immediately on mount
  useEffect(() => {
    const cached = cacheGet<Account[]>('api-accounts')
    if (cached) setAccounts(cached)
  }, [])

  useEffect(() => {
    accountApi.checkAccountsLost().then(async lost => {
      if (lost) await msgError('账户数据文件已损坏或机器码变更，文件已被删除，请重新添加账户。')
    })
  }, [])

  async function handleSetDefault(uuid: string) {
    try {
      await accountApi.setDefaultAccount(uuid)
      await refresh()
    } catch (e: unknown) {
      await msgError(fmtErr(e))
    }
  }

  useEffect(() => { refresh() }, [refresh])

  useEffect(() => {
    return () => {
      if (pollTimer.current) clearInterval(pollTimer.current)
    }
  }, [])

  function startAdd() {
    setAddOpen(true)
    setOauthData(null)
    setMicrosoftStep('idle')
    setMicrosoftMsg('')
    setOfflineName('')
    setOfflineUuid('')
    setTyServerId('')
    setTyEmail('')
    setTyPwd('')
    if (pollTimer.current) { clearInterval(pollTimer.current); pollTimer.current = null }
  }

  async function handleOAuth() {
    setMicrosoftStep('fetching-oauth')
    setMicrosoftMsg('正在获取登录信息...')
    try {
      const data = await accountApi.microsoftOAuth()
      setOauthData(data)
      setMicrosoftMsg('正在打开浏览器...')

      try { await navigator.clipboard.writeText(data.userCode) } catch { /* clipboard not available */ }
      try { await openUrl(data.verificationUri) } catch { window.open(data.verificationUri, '_blank') }

      setMicrosoftStep('waiting-auth')
      setMicrosoftMsg(`验证码已复制到剪贴板，请在浏览器中登录 Microsoft 账号\n验证码: ${data.userCode}`)

      const intervalMs = Math.max((data.interval || 5) * 1000, 3000)
      const deadline = Date.now() + (data.expiresIn || 900) * 1000
      const stopPolling = () => {
        if (pollTimer.current) { clearInterval(pollTimer.current); pollTimer.current = null }
      }
      pollTimer.current = setInterval(async () => {
        if (Date.now() > deadline) {
          stopPolling()
          setMicrosoftStep('error')
          setMicrosoftMsg('登录超时，请重新登录')
          return
        }
        try {
          const result = await accountApi.microsoftPoll(data.deviceCode)
          if (result.isPending) return
          stopPolling()
          if (result.success === false) {
            setMicrosoftStep('error')
            setMicrosoftMsg(fmtOAuthError((result.errorMessage as string) ?? 'unknown'))
            return
          }
          if (result.accessToken) {
            setMicrosoftStep('fetching-info')
            setMicrosoftMsg('正在获取账户信息...')
            try {
              await accountApi.microsoftUserInfo(result.accessToken as string, (result.refreshToken as string) ?? '')
              await refresh()
              setMicrosoftStep('done')
              setMicrosoftMsg('登录成功')
              setTimeout(() => { setAddOpen(false); setOauthData(null); setMicrosoftStep('idle') }, 1500)
            } catch (e: unknown) {
              setMicrosoftStep('error')
              setMicrosoftMsg(fmtErr(e))
            }
          }
        } catch {
          // 网络抖动等瞬时错误：忽略，继续轮询（受 deadline 兜底）
        }
      }, intervalMs)
    } catch (e: unknown) {
      setMicrosoftStep('error')
      setMicrosoftMsg(fmtErr(e))
    }
  }

  async function handleOfflineAdd() {
    if (!offlineName.trim()) return
    let uuid = offlineUuid.trim()
    if (!uuid) {
      try { const r = await accountApi.getOfflineUuid(offlineName.trim()); uuid = r.uuid } catch { uuid = crypto.randomUUID() }
    }
    const acc: Account = {
      name: offlineName.trim(),
      uuid,
      token: '',
      accessToken: '',
      refreshToken: '',
      loginMethod: 'Offline',
    }
    try {
      await accountApi.saveAccount(acc)
      await refresh()
      setAddOpen(false)
      setOfflineName('')
      setOfflineUuid('')
    } catch (e: unknown) {
      await msgError(fmtErr(e))
    }
  }

  async function handleYggdrasilLogin() {
    setLoading(true)
    try {
      const result = await accountApi.yggdrasilGetProfiles(yggEmail, yggPwd, yggServer)
      if (!result.success || !result.profiles?.length) {
        await msgError(result.errorMessage || '未获取到可用角色')
        return
      }
      setYggProfiles(result.profiles)
      setYggAuthToken(result.accessToken ?? '')
      setYggClientToken(result.clientToken ?? '')
      setYggSelected(new Set(result.profiles.length > 0 ? [result.profiles[0].id] : []))
      setYggStep('profiles')
    } catch (e: unknown) {
      await msgError(fmtErr(e))
    } finally {
      setLoading(false)
    }
  }

  async function handleYggdrasilConfirm() {
    if (yggSelected.size === 0) return
    setLoading(true)
    try {
      const selected = yggProfiles.filter((p) => yggSelected.has(p.id))
      await accountApi.yggdrasilSelectProfiles(yggAuthToken, yggClientToken, yggServer, selected)
      await refresh()
      if (selected.length > 0) navigate(`/accounts/${selected[0].id}`)
      setAddOpen(false)
      setYggStep('form')
      setYggProfiles([])
      setYggSelected(new Set())
    } catch (e: unknown) {
      await msgError(fmtErr(e))
    } finally {
      setLoading(false)
    }
  }

  function toggleYggProfile(id: string) {
    setYggSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id); else next.add(id)
      return next
    })
  }

  async function handleTongyiLogin() {
    setLoading(true)
    try {
      const result = await accountApi.tongyiLogin(tyServerId, tyEmail, tyPwd)
      await refresh()
      if (result.uuid) navigate(`/accounts/${result.uuid}`)
      setAddOpen(false)
    } catch (e: unknown) {
      await msgError(fmtErr(e))
    } finally {
      setLoading(false)
    }
  }

  async function handleDelete(uuid: string) {
    const ok = await msgConfirm('确定要删除此账户吗？', '删除账户')
    if (!ok) return
    try {
      await accountApi.deleteAccount(uuid)
      await refresh()
    } catch (e: unknown) {
      await msgError(fmtErr(e))
    }
  }

  function toggleSelect(uuid: string, index: number, shift: boolean) {
    setSelected(prev => {
      const next = new Set(prev)
      if (shift && lastClickedRef.current >= 0) {
        const start = Math.min(lastClickedRef.current, index)
        const end = Math.max(lastClickedRef.current, index)
        for (let i = start; i <= end; i++)
          next.add(filteredAccounts[i].uuid)
      } else {
        if (next.has(uuid)) next.delete(uuid); else next.add(uuid)
      }
      return next
    })
    lastClickedRef.current = index
  }

  async function handleBatchDelete() {
    if (selected.size === 0) return
    const ok = await msgConfirm(`确定要删除选中的 ${selected.size} 个账户吗？`, '批量删除')
    if (!ok) return
    setLoading(true)
    try {
      for (const uuid of selected) { await accountApi.deleteAccount(uuid) }
      setSelected(new Set())
      await refresh()
    } catch (e: unknown) {
      await msgError(fmtErr(e))
    } finally {
      setLoading(false)
    }
  }

  function StatusDot({ step, active }: { step: MicrosoftStep; active: MicrosoftStep }) {
    if (step === active) {
      if (step === 'done') return <FontAwesomeIcon icon={faCheck} className="h-3 w-3 text-emerald-400" />
      if (step === 'error') return <FontAwesomeIcon icon={faUser} className="h-3 w-3 text-red-400" />
      return <FontAwesomeIcon icon={faSpinner} className="h-3 w-3 animate-spin text-primary" />
    }
    const order: MicrosoftStep[] = ['fetching-oauth', 'waiting-auth', 'fetching-info', 'done']
    const idx = order.indexOf(step)
    const activeIdx = order.indexOf(active)
    if (active === 'error') return <FontAwesomeIcon icon={faUser} className="h-3 w-3 text-muted-foreground" />
    if (idx < activeIdx) return <FontAwesomeIcon icon={faCheck} className="h-3 w-3 text-emerald-400" />
    return <FontAwesomeIcon icon={faUser} className="h-3 w-3 text-muted-foreground" />
  }

  return (
    <>
    <PageShell>
      <div className="shrink-0 space-y-4 px-8 pt-8">
        <PageHeader title="账户管理"
          actions={
            <>
              <Tooltip content="刷新">
                <button onClick={forceRefresh} className="flex h-8 w-8 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-accent hover:text-foreground">
                  <FontAwesomeIcon icon={loading ? faSpinner : faRotate} className={cn('h-3.5 w-3.5', loading && 'animate-spin')} />
                </button>
              </Tooltip>
              <Tooltip content="添加账户">
                <button onClick={startAdd} className="flex h-8 items-center gap-1.5 rounded-lg px-3 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground">
                  <FontAwesomeIcon icon={faPlus} className="h-3.5 w-3.5" />
                  <span className="text-sm">添加</span>
                </button>
              </Tooltip>
            </>
          }
        />

        <div className="flex items-center gap-2">
          <Select value={filterType} onChange={(v) => setFilterType(v as typeof filterType)} className="w-28">
            <SelectOption value="all">全部筛选</SelectOption>
            <SelectOption value="name">名称</SelectOption>
            <SelectOption value="loginMethod">登录方式</SelectOption>
            <SelectOption value="server">服务器</SelectOption>
          </Select>
          <div className="relative flex-1">
            <FontAwesomeIcon icon={faMagnifyingGlass} className="absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="搜索账户..." className="h-9 pl-9" />
          </div>
        </div>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto px-8 pb-8">
        <div className="flex flex-col gap-1.5 pt-4">
          {filteredAccounts.length === 0 ? (
            <div className="flex flex-col items-center gap-2 py-12 text-muted-foreground">
              <FontAwesomeIcon icon={faUser} className="h-10 w-10 opacity-30" />
              <p className="text-sm">{search ? '无匹配账户' : '暂无账户'}</p>
            </div>
          ) : filteredAccounts.map((acc, index) => {
            const icon = getAccountIcon(acc.loginMethod)
            const isDefault = acc.uuid === defaultUuid
            const isSelected = selected.has(acc.uuid)
            return (
              <div
                key={acc.uuid}
                onClick={() => { if (selected.size > 0) toggleSelect(acc.uuid, index, false); else navigate(`/accounts/${acc.uuid}`) }}
                className={cn(
                  'group flex w-full cursor-pointer items-center gap-3 rounded-lg border bg-card px-3.5 py-3 text-left transition-colors hover:border-border',
                  isSelected ? 'border-primary/40 bg-primary/[0.03]' : 'border-transparent'
                )}
                role="button"
                tabIndex={0}
                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); if (selected.size > 0) toggleSelect(acc.uuid, index, false); else navigate(`/accounts/${acc.uuid}`) } }}
              >
                <button
                  type="button"
                  onClick={(e) => { e.stopPropagation(); toggleSelect(acc.uuid, index, e.shiftKey) }}
                  className={cn(
                    'flex h-5 w-5 shrink-0 items-center justify-center rounded border transition-colors',
                    isSelected ? 'border-primary bg-primary text-primary-foreground' : 'border-muted-foreground/30 hover:border-foreground/50'
                  )}
                >
                  {isSelected && <FontAwesomeIcon icon={faCheck} className="h-3 w-3" />}
                </button>
                <AccountAvatar account={acc} className="h-10 w-10 shrink-0" />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium">{acc.name}</div>
                  <div className="flex items-center gap-1">
                    <FontAwesomeIcon icon={icon.icon} className={cn('h-2.5 w-2.5', icon.color)} />
                    <Tooltip content={acc.serverUrl}>
                      <span className="text-[11px] text-muted-foreground">{getAccountLabel(acc.loginMethod, acc.serverUrl)}</span>
                    </Tooltip>
                  </div>
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  {isDefault ? (
                    <span className="flex h-7 w-7 items-center justify-center">
                      <FontAwesomeIcon icon={faStar} className="h-3 w-3 text-amber-400" />
                    </span>
                  ) : (
                    <Tooltip content="设为默认">
                      <button
                        type="button"
                        onClick={(e) => { e.stopPropagation(); handleSetDefault(acc.uuid) }}
                        className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground opacity-0 transition-opacity hover:bg-primary/10 hover:text-primary group-hover:opacity-100"
                      >
                        <FontAwesomeIcon icon={faStar} className="h-3 w-3" />
                      </button>
                    </Tooltip>
                  )}
                  <button
                    type="button"
                    onClick={(e) => { e.stopPropagation(); handleDelete(acc.uuid) }}
                    className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground opacity-0 transition-opacity hover:bg-destructive/10 hover:text-destructive group-hover:opacity-100"
                  >
                    <FontAwesomeIcon icon={faTrashCan} className="h-3 w-3" />
                  </button>
                </div>
              </div>
            )
          })}

        </div>
      </div>
    </PageShell>

    {selected.size > 0 && (
      <div className="fixed bottom-8 left-1/2 z-50 flex -translate-x-1/2 items-center gap-3 rounded-xl border bg-card px-5 py-3 shadow-lg shadow-black/10">
        <span className="text-sm text-muted-foreground">已选 <span className="font-semibold text-foreground">{selected.size}</span> 个</span>
        <div className="h-5 w-px bg-border" />
        <Button variant="ghost" size="sm" onClick={() => setSelected(new Set())}>取消选择</Button>
        <Button variant="destructive" size="sm" onClick={handleBatchDelete} disabled={loading}>
          <FontAwesomeIcon icon={faTrashCan} className="h-3.5 w-3.5" />
          删除 {selected.size}
        </Button>
      </div>
    )}

    <Dialog open={addOpen} onClose={() => setAddOpen(false)} className="max-w-md" closeOnBackdrop={false}>
        <DialogHeader onClose={() => setAddOpen(false)}>
          <DialogTitle>添加账户</DialogTitle>
        </DialogHeader>
        <DialogBody>
          <div className="mb-4 flex flex-wrap gap-1 rounded-lg bg-muted p-1">
            {(['microsoft', 'offline', 'yggdrasil', 'tongyi'] as const).map((tab) => (
              <button
                key={tab}
                onClick={() => setAddTab(tab)}
                className={cn(
                  'flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-medium transition-colors',
                  addTab === tab ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'
                )}
              >
                {tab === 'microsoft' && <FontAwesomeIcon icon={faMicrosoft} className="h-3 w-3" />}
                {tab === 'offline' && <FontAwesomeIcon icon={faUserLarge} className="h-3 w-3" />}
                {tab === 'yggdrasil' && <FontAwesomeIcon icon={faKeycdn} className="h-3 w-3" />}
                {tab === 'tongyi' && <FontAwesomeIcon icon={faCloud} className="h-3 w-3" />}
                {tab === 'microsoft' && 'Microsoft'}
                {tab === 'offline' && '离线'}
                {tab === 'yggdrasil' && 'Yggdrasil'}
                {tab === 'tongyi' && '统一通'}
              </button>
            ))}
          </div>

          {addTab === 'microsoft' && (
            <div key="microsoft" className="animate-in slide-up space-y-4">
              {microsoftStep === 'idle' && (
                <Button className="w-full" onClick={handleOAuth}>
                  <FontAwesomeIcon icon={faRightToBracket} className="h-4 w-4" />
                  Microsoft OAuth 登录
                </Button>
              )}

              {microsoftStep !== 'idle' && (
                <div className="space-y-3 rounded-lg border bg-background p-4">
                  <div className="flex items-center gap-2 text-sm">
                    <StatusDot step="fetching-oauth" active={microsoftStep} />
                    <span className={microsoftStep === 'fetching-oauth' ? 'text-foreground' : 'text-muted-foreground'}>获取登录信息</span>
                  </div>
                  <div className="flex items-center gap-2 text-sm">
                    <StatusDot step="waiting-auth" active={microsoftStep} />
                    <span className={microsoftStep === 'waiting-auth' ? 'text-foreground' : 'text-muted-foreground'}>等待授权</span>
                  </div>
                  <div className="flex items-center gap-2 text-sm">
                    <StatusDot step="fetching-info" active={microsoftStep} />
                    <span className={microsoftStep === 'fetching-info' ? 'text-foreground' : 'text-muted-foreground'}>获取账户信息</span>
                  </div>

                  {microsoftStep === 'waiting-auth' && (
                    <div className="mt-3 space-y-2 rounded-md bg-muted p-3">
                      <div className="flex items-center gap-2 text-xs text-muted-foreground">
                        <FontAwesomeIcon icon={faCopy} className="h-3 w-3" />
                        验证码已复制
                      </div>
                      <code className="block rounded bg-background px-3 py-2 text-center text-lg font-bold tracking-widest text-primary">
                        {oauthData?.userCode}
                      </code>
                      <div className="flex items-center gap-2 text-xs text-muted-foreground">
                        <FontAwesomeIcon icon={faExternalLinkAlt} className="h-3 w-3" />
                        浏览器已自动打开
                      </div>
                    </div>
                  )}

                  {microsoftStep === 'error' && (
                    <p className="mt-2 text-sm text-red-400">{microsoftMsg}</p>
                  )}

                  {microsoftStep === 'done' && (
                    <p className="mt-2 text-sm text-emerald-400">{microsoftMsg}</p>
                  )}

                  {(microsoftStep === 'error' || microsoftStep === 'done') && (
                    <Button variant="outline" size="sm" onClick={() => { setMicrosoftStep('idle'); setMicrosoftMsg(''); setOauthData(null) }}>
                      重新登录
                    </Button>
                  )}
                </div>
              )}
            </div>
          )}

          {addTab === 'offline' && (
            <div key="offline" className="animate-in slide-up space-y-4">
              <div className="space-y-2">
                <Label htmlFor="offline-name">玩家名称</Label>
                <Input id="offline-name" value={offlineName} onChange={(e) => setOfflineName(e.target.value)} placeholder="输入离线模式用户名" />
              </div>
              <div className="space-y-2">
                <Label htmlFor="offline-uuid">UUID（可选，留空自动生成）</Label>
                <Input id="offline-uuid" value={offlineUuid} onChange={(e) => setOfflineUuid(e.target.value)} placeholder="例如: 069a79f4-44e9-4726-a5be-fca90e38aaf5" />
              </div>
              <Button className="w-full" onClick={handleOfflineAdd} disabled={!offlineName.trim()}>
                <FontAwesomeIcon icon={faPlus} className="h-4 w-4" />
                添加离线账户
              </Button>
            </div>
          )}

          {addTab === 'yggdrasil' && (
            <div key="yggdrasil" className="animate-in slide-up space-y-4">
              {yggStep === 'form' && (
                <>
                  <div className="space-y-2">
                    <Label>预设服务器</Label>
                    <div className="flex flex-wrap gap-2">
                      {[
                        { label: 'LittleSkin', url: 'https://littleskin.cn/api/yggdrasil' },
                        { label: 'Blessing Skin', url: 'https://skin.prinzeugen.net/api/yggdrasil' },
                      ].map((p) => (
                        <button
                          key={p.url}
                          onClick={() => setYggServer(p.url)}
                          className={cn(
                            'rounded-md border px-2.5 py-1 text-xs transition-colors',
                            yggServer === p.url ? 'border-primary/40 bg-primary/5 text-primary' : 'border-border text-muted-foreground hover:border-foreground/30'
                          )}
                        >
                          {p.label}
                        </button>
                      ))}
                    </div>
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="ygg-email">邮箱</Label>
                    <Input id="ygg-email" value={yggEmail} onChange={(e) => setYggEmail(e.target.value)} />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="ygg-pwd">密码</Label>
                    <Input id="ygg-pwd" type="password" value={yggPwd} onChange={(e) => setYggPwd(e.target.value)} />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="ygg-server">自定义服务器地址</Label>
                    <Input id="ygg-server" value={yggServer} onChange={(e) => setYggServer(e.target.value)} placeholder="https://example.com/api/yggdrasil" />
                  </div>
                  <Button className="w-full" onClick={handleYggdrasilLogin} disabled={loading}>
                    <FontAwesomeIcon icon={faFingerprint} className="h-4 w-4" />
                    {loading ? '登录中...' : '登录'}
                  </Button>
                </>
              )}
              {yggStep === 'profiles' && (
                <div className="space-y-3">
                  <p className="text-sm text-muted-foreground">选择要登录的角色：</p>
                  <div className="max-h-60 space-y-1 overflow-y-auto rounded-lg border bg-background p-2">
                    {yggProfiles.map((p) => (
                      <button
                        key={p.id}
                        type="button"
                        onClick={() => toggleYggProfile(p.id)}
                        className="flex w-full items-center gap-3 rounded-md px-3 py-2 text-left text-sm transition-colors hover:bg-accent"
                      >
                        <div
                          className={cn(
                            'flex h-4 w-4 shrink-0 items-center justify-center rounded border transition-colors',
                            yggSelected.has(p.id) ? 'border-primary bg-primary text-primary-foreground' : 'border-muted-foreground/30'
                          )}
                        >
                          {yggSelected.has(p.id) && <FontAwesomeIcon icon={faCheck} className="h-3 w-3" />}
                        </div>
                        <AccountAvatar account={{ uuid: p.id, name: p.name, loginMethod: 'Yggdrasil', serverUrl: yggServer }} className="h-8 w-8 shrink-0" />
                        <span className="flex-1 truncate font-medium">{p.name}</span>
                      </button>
                    ))}
                  </div>
                  <div className="flex gap-2">
                    <Button variant="secondary" className="flex-1" onClick={() => { setYggStep('form'); setYggProfiles([]) }}>
                      返回
                    </Button>
                    <Button className="flex-1" onClick={handleYggdrasilConfirm} disabled={yggSelected.size === 0 || loading}>
                      <FontAwesomeIcon icon={faCheck} className="h-4 w-4" />
                      {loading ? '保存中...' : `确认 (${yggSelected.size})`}
                    </Button>
                  </div>
                </div>
              )}
            </div>
          )}

          {addTab === 'tongyi' && (
            <div key="tongyi" className="animate-in slide-up space-y-4">
              <div className="rounded-lg border bg-muted/30 p-3 text-xs text-muted-foreground">
                统一通行证是部分 Minecraft 服务器使用的认证系统，需要输入服务器 ID。
              </div>
              <div className="space-y-2">
                <Label htmlFor="ty-sid">服务器 ID</Label>
                <Input id="ty-sid" value={tyServerId} onChange={(e) => setTyServerId(e.target.value)} placeholder="例如: lilu" />
              </div>
              <div className="space-y-2">
                <Label htmlFor="ty-email">邮箱</Label>
                <Input id="ty-email" value={tyEmail} onChange={(e) => setTyEmail(e.target.value)} />
              </div>
              <div className="space-y-2">
                <Label htmlFor="ty-pwd">密码</Label>
                <Input id="ty-pwd" type="password" value={tyPwd} onChange={(e) => setTyPwd(e.target.value)} />
              </div>
              <Button className="w-full" onClick={handleTongyiLogin} disabled={loading}>
                <FontAwesomeIcon icon={faCloud} className="h-4 w-4" />
                {loading ? '登录中...' : '登录'}
              </Button>
            </div>
          )}
        </DialogBody>
      </Dialog>
    </>
  )
}
