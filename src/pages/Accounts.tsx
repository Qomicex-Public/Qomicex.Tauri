import { useState, useEffect, useCallback, useRef } from 'react'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import { faMicrosoft, faKeycdn } from '@fortawesome/free-brands-svg-icons'
import { faPlus, faUser, faRightToBracket, faFingerprint, faTrashCan, faUserLarge, faSpinner, faCheck, faCopy, faExternalLinkAlt, faCloud, faCheckCircle } from '@fortawesome/free-solid-svg-icons'
import { Button } from '../components/ui/button.tsx'
import { Input } from '../components/ui/input.tsx'
import { Label } from '../components/ui/label.tsx'
import { useMessageBox } from '../components/ui/message-box.tsx'
import { Tooltip } from '../components/ui/tooltip.tsx'
import { cn } from '../lib/utils.ts'
import { ApiError } from '../api/client.ts'
import * as accountApi from '../api/account.ts'
import type { MicrosoftOAuthResponse, Account } from '../types/index.ts'
import { openUrl } from '@tauri-apps/plugin-opener'

function fmtErr(e: unknown): string {
  if (e instanceof ApiError) return e.message
  if (e instanceof Error) return e.message
  return String(e)
}

const TYPE_META: Record<string, { label: string; icon: typeof faUser; color: string }> = {
  Microsoft: { label: 'Microsoft', icon: faMicrosoft, color: 'text-green-400' },
  Offline: { label: '离线', icon: faUserLarge, color: 'text-yellow-400' },
  Yggdrasil: { label: '第三方', icon: faKeycdn, color: 'text-purple-400' },
}

type MicrosoftStep = 'idle' | 'fetching-oauth' | 'waiting-auth' | 'fetching-info' | 'done' | 'error'

export default function Accounts() {
  const { error: msgError, confirm: msgConfirm } = useMessageBox()
  const [accounts, setAccounts] = useState<Account[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)
  const [addTab, setAddTab] = useState<'microsoft' | 'offline' | 'yggdrasil' | 'tongyi'>('microsoft')
  const [loading, setLoading] = useState(false)

  const [oauthData, setOauthData] = useState<MicrosoftOAuthResponse | null>(null)
  const [microsoftStep, setMicrosoftStep] = useState<MicrosoftStep>('idle')
  const [microsoftMsg, setMicrosoftMsg] = useState('')
  const pollTimer = useRef<ReturnType<typeof setInterval> | null>(null)

  const [offlineName, setOfflineName] = useState('')

  const [yggEmail, setYggEmail] = useState('')
  const [yggPwd, setYggPwd] = useState('')
  const [yggServer, setYggServer] = useState('https://littleskin.cn/api/yggdrasil')

  const [tyServerId, setTyServerId] = useState('')
  const [tyEmail, setTyEmail] = useState('')
  const [tyPwd, setTyPwd] = useState('')
  const [copied, setCopied] = useState(false)

  const selected = accounts.find((a) => a.uuid === selectedId)

  const refresh = useCallback(async () => {
    try {
      const list = await accountApi.getAccounts()
      setAccounts(list)
    } catch { /* ignore */ }
  }, [])

  useEffect(() => { refresh() }, [refresh])

  useEffect(() => {
    return () => {
      if (pollTimer.current) clearInterval(pollTimer.current)
    }
  }, [])

  function handleSelect(uuid: string) {
    setSelectedId(uuid)
    setAdding(false)
  }

  function startAdd() {
    setAdding(true)
    setOauthData(null)
    setMicrosoftStep('idle')
    setMicrosoftMsg('')
    setOfflineName('')
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
      pollTimer.current = setInterval(async () => {
        try {
          const result = await accountApi.microsoftPoll(data)
          if (result.access_token) {
            if (pollTimer.current) { clearInterval(pollTimer.current); pollTimer.current = null }
            setMicrosoftStep('fetching-info')
            setMicrosoftMsg('正在获取账户信息...')
            try {
              await accountApi.microsoftUserInfo(result.access_token, result.refresh_token ?? '')
              await refresh()
              setMicrosoftStep('done')
              setMicrosoftMsg('登录成功')
              setTimeout(() => { setAdding(false); setOauthData(null); setMicrosoftStep('idle') }, 1500)
            } catch (e: unknown) {
              setMicrosoftStep('error')
              setMicrosoftMsg(fmtErr(e))
            }
          }
        } catch {
          // poll error — likely authorization_pending, keep waiting
        }
      }, intervalMs)
    } catch (e: unknown) {
      setMicrosoftStep('error')
      setMicrosoftMsg(fmtErr(e))
    }
  }

  async function handleOfflineAdd() {
    if (!offlineName.trim()) return
    const acc: Account = {
      name: offlineName.trim(),
      uuid: crypto.randomUUID(),
      token: '',
      accessToken: '',
      refreshToken: '',
      loginMethod: 'Offline',
    }
    try {
      const saved = await accountApi.saveAccount(acc)
      setAccounts((prev) => [...prev.filter((a) => a.uuid !== saved.uuid), saved])
      setSelectedId(saved.uuid)
      setAdding(false)
      setOfflineName('')
    } catch (e: unknown) {
      await msgError(fmtErr(e))
    }
  }

  async function handleYggdrasilLogin() {
    setLoading(true)
    try {
      const result = await accountApi.yggdrasilLogin(yggEmail, yggPwd, yggServer)
      await refresh()
      if (result.length > 0) setSelectedId(result[0].uuid)
      setAdding(false)
    } catch (e: unknown) {
      await msgError(fmtErr(e))
    } finally {
      setLoading(false)
    }
  }

  async function handleTongyiLogin() {
    setLoading(true)
    try {
      const result = await accountApi.tongyiLogin(tyServerId, tyEmail, tyPwd)
      await refresh()
      if (result.length > 0) setSelectedId(result[0].uuid)
      setAdding(false)
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
      setAccounts((prev) => {
        const next = prev.filter((a) => a.uuid !== uuid)
        if (selectedId === uuid) setSelectedId(next[0]?.uuid ?? null)
        return next
      })
    } catch (e: unknown) {
      await msgError(fmtErr(e))
    }
  }

  function maskToken(t?: string) {
    if (!t || t.length < 8) return '无'
    return `${t.slice(0, 4)}...${t.slice(-4)}`
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
    <div className="animate-in space-y-6 p-8">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">账户管理</h1>
      </div>

      <div className="flex gap-4">
        <div className="flex w-64 shrink-0 flex-col gap-1.5">
          {accounts.map((acc) => {
            const meta = TYPE_META[acc.loginMethod] || TYPE_META.Offline
            return (
              <button
                key={acc.uuid}
                onClick={() => handleSelect(acc.uuid)}
                className={cn(
                  'group flex w-full items-center gap-3 rounded-lg border px-3.5 py-3 text-left transition-colors',
                  selectedId === acc.uuid
                    ? 'border-primary/40 bg-primary/5'
                    : 'border-transparent bg-card hover:border-border'
                )}
              >
                <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-primary/20 to-primary/5 text-base font-bold text-primary ring-1 ring-primary/20">
                  {acc.name.charAt(0).toUpperCase()}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium">{acc.name}</div>
                  <div className="flex items-center gap-1">
                    <FontAwesomeIcon icon={meta.icon} className={cn('h-2.5 w-2.5', meta.color)} />
                    <span className="text-[11px] text-muted-foreground">{meta.label}</span>
                  </div>
                </div>
                <button
                  onClick={(e) => { e.stopPropagation(); handleDelete(acc.uuid) }}
                  className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground opacity-0 transition-opacity hover:bg-destructive/10 hover:text-destructive group-hover:opacity-100"
                >
                  <FontAwesomeIcon icon={faTrashCan} className="h-3 w-3" />
                </button>
              </button>
            )
          })}

          <Button variant="outline" className="mt-2 justify-start gap-2" onClick={startAdd}>
            <FontAwesomeIcon icon={faPlus} className="h-3.5 w-3.5" />
            添加账户
          </Button>
        </div>

        <div className="flex-1">
          {adding ? (
            <div className="rounded-xl border bg-card p-6">
              <h3 className="mb-4 text-base font-medium">添加账户</h3>

              <div className="mb-5 flex flex-wrap gap-1 rounded-lg bg-muted p-1">
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
                <div className="space-y-4">
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
                <div className="space-y-4">
                  <div className="space-y-2">
                    <Label htmlFor="offline-name">玩家名称</Label>
                    <Input id="offline-name" value={offlineName} onChange={(e) => setOfflineName(e.target.value)} placeholder="输入离线模式用户名" />
                  </div>
                  <Button className="w-full" onClick={handleOfflineAdd} disabled={!offlineName.trim()}>
                    <FontAwesomeIcon icon={faPlus} className="h-4 w-4" />
                    添加离线账户
                  </Button>
                </div>
              )}

              {addTab === 'yggdrasil' && (
                <div className="space-y-4">
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
                </div>
              )}

              {addTab === 'tongyi' && (
                <div className="space-y-4">
                  <div className="rounded-lg border bg-muted/30 p-3 text-xs text-muted-foreground">
                    统一通行证是部分 Minecraft 皮肤站使用的认证系统，需要输入服务器 ID。
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
            </div>
          ) : selected ? (
            <div className="rounded-xl border bg-card p-6">
              <div className="flex items-center gap-4">
                <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-gradient-to-br from-primary/20 to-primary/5 text-2xl font-bold text-primary ring-1 ring-primary/20">
                  {selected.name.charAt(0).toUpperCase()}
                </div>
                <div className="flex-1">
                  <h3 className="text-lg font-semibold">{selected.name}</h3>
                  <div className="flex items-center gap-1.5 text-sm text-muted-foreground">
                    <FontAwesomeIcon icon={TYPE_META[selected.loginMethod]?.icon || faUser} className={cn('h-3 w-3', TYPE_META[selected.loginMethod]?.color)} />
                    {TYPE_META[selected.loginMethod]?.label || selected.loginMethod}
                  </div>
                </div>
                <Button variant="destructive" size="sm" onClick={() => handleDelete(selected.uuid)}>
                  <FontAwesomeIcon icon={faTrashCan} className="h-3.5 w-3.5" />
                  删除
                </Button>
              </div>

              <div className="mt-5 grid grid-cols-2 gap-4 rounded-lg bg-background p-4">
                {[
                  ['UUID', selected.uuid, true],
                  ['登录方式', TYPE_META[selected.loginMethod]?.label || selected.loginMethod],
                  ['Access Token', maskToken(selected.accessToken)],
                  ['Refresh Token', maskToken(selected.refreshToken)],
                ].map((item) => {
                  const label = item[0] as string
                  const value = item[1] as string
                  const copyable = item[2] as boolean | undefined
                  return (
                  <div key={label}>
                    <div className="text-xs text-muted-foreground">{label}</div>
                    {copyable ? (
                      <Tooltip content="点击复制">
                        <div
                          className="mt-0.5 truncate font-mono text-sm cursor-pointer rounded px-1 hover:bg-muted min-w-0"
                          onClick={() => { navigator.clipboard.writeText(value); setCopied(true); setTimeout(() => setCopied(false), 1500) }}
                        >
                          {value}
                        </div>
                      </Tooltip>
                    ) : (
                      <div className="mt-0.5 truncate font-mono text-sm min-w-0">
                        {value}
                      </div>
                    )}
                  </div>
                  )
                })}
              </div>
            </div>
          ) : (
            <div className="flex flex-col items-center justify-center gap-3 rounded-xl border bg-card py-20 text-center text-muted-foreground">
              <FontAwesomeIcon icon={faUser} className="h-10 w-10 opacity-30" />
              <p className="text-sm">选择一个账户或添加新账户</p>
            </div>
          )}

          {copied && (
            <div className="fixed bottom-6 right-6 flex items-center gap-2 rounded-lg bg-primary px-4 py-2.5 text-sm font-medium text-primary-foreground shadow-lg animate-in zoom-in">
              <FontAwesomeIcon icon={faCheckCircle} className="h-4 w-4" />
              已复制到剪贴板
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
