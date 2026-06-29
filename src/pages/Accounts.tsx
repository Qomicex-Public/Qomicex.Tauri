import { useState, useEffect, useCallback, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import { faMicrosoft, faKeycdn } from '@fortawesome/free-brands-svg-icons'
import { faPlus, faUser, faRightToBracket, faFingerprint, faTrashCan, faUserLarge, faSpinner, faCheck, faCopy, faExternalLinkAlt, faCloud, faStar } from '@fortawesome/free-solid-svg-icons'
import { Button } from '../components/ui/button.tsx'
import { Input } from '../components/ui/input.tsx'
import { Label } from '../components/ui/label.tsx'
import { useMessageBox } from '../components/ui/message-box.tsx'
import { cn } from '../lib/utils.ts'
import { PageHeader } from '../components/PageHeader.tsx'
import { AccountAvatar } from '../components/AccountAvatar.tsx'
import { Dialog, DialogHeader, DialogTitle, DialogBody } from '../components/ui/dialog.tsx'
import { ApiError } from '../api/client.ts'
import { Tooltip } from '../components/ui/tooltip.tsx'
import * as accountApi from '../api/account.ts'
import type { MicrosoftOAuthResponse, Account } from '../types/index.ts'
import { openUrl } from '@tauri-apps/plugin-opener'

function fmtErr(e: unknown): string {
  if (e instanceof ApiError) return e.message
  if (e instanceof Error) return e.message
  return String(e)
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

  const [tyServerId, setTyServerId] = useState('')
  const [tyEmail, setTyEmail] = useState('')
  const [tyPwd, setTyPwd] = useState('')
  const [, setMetaVersion] = useState(0)

  const defaultUuid = accounts.find((a) => a.isDefault)?.uuid

  const refresh = useCallback(async () => {
    try {
      const list = await accountApi.getAccounts()
      setAccounts(list)
      const fetches = list
        .filter((a) => a.loginMethod === 'Yggdrasil' && a.serverUrl && !accountApi.getCachedMeta(a.serverUrl))
        .map((a) => accountApi.getYggdrasilMeta(a.serverUrl!))
      if (fetches.length > 0) { await Promise.all(fetches); setMetaVersion((v) => v + 1) }
    } catch { /* ignore */ }
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
              setTimeout(() => { setAddOpen(false); setOauthData(null); setMicrosoftStep('idle') }, 1500)
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
      const saved = await accountApi.saveAccount(acc)
      setAccounts((prev) => [...prev.filter((a) => a.uuid !== saved.uuid), saved])
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
      const result = await accountApi.yggdrasilLogin(yggEmail, yggPwd, yggServer)
      await refresh()
      if (result.length > 0) navigate(`/accounts/${result[0].uuid}`)
      setAddOpen(false)
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
      if (result.length > 0) navigate(`/accounts/${result[0].uuid}`)
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
      if (uuid === defaultUuid) await accountApi.clearDefaultAccount()
      await accountApi.deleteAccount(uuid)
      setAccounts((prev) => prev.filter((a) => a.uuid !== uuid))
    } catch (e: unknown) {
      await msgError(fmtErr(e))
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
    <div className="animate-in slide-up space-y-6 p-8">
      <PageHeader title="账户管理" />

      <div className="flex flex-col gap-1.5">
        {accounts.map((acc) => {
          const icon = getAccountIcon(acc.loginMethod)
          const isDefault = acc.uuid === defaultUuid
          return (
            <button
              key={acc.uuid}
              onClick={() => navigate(`/accounts/${acc.uuid}`)}
              className="group flex w-full items-center gap-3 rounded-lg border border-transparent bg-card px-3.5 py-3 text-left transition-colors hover:border-border"
            >
              <AccountAvatar account={acc} className="h-10 w-10 shrink-0" textClassName="text-base font-bold" />
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
                  <button
                    onClick={(e) => { e.stopPropagation(); handleSetDefault(acc.uuid) }}
                    className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground opacity-0 transition-opacity hover:bg-primary/10 hover:text-primary group-hover:opacity-100"
                    title="设为默认"
                  >
                    <FontAwesomeIcon icon={faStar} className="h-3 w-3" />
                  </button>
                )}
                <button
                  onClick={(e) => { e.stopPropagation(); handleDelete(acc.uuid) }}
                  className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground opacity-0 transition-opacity hover:bg-destructive/10 hover:text-destructive group-hover:opacity-100"
                >
                  <FontAwesomeIcon icon={faTrashCan} className="h-3 w-3" />
                </button>
              </div>
            </button>
          )
        })}

        <Button variant="outline" className="mt-2 justify-start gap-2" onClick={startAdd}>
          <FontAwesomeIcon icon={faPlus} className="h-3.5 w-3.5" />
          添加账户
        </Button>
      </div>

      <Dialog open={addOpen} onClose={() => setAddOpen(false)} className="max-w-md">
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
            <div key="tongyi" className="animate-in slide-up space-y-4">
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
        </DialogBody>
      </Dialog>
    </div>
  )
}
