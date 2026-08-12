import { useState, useEffect, useCallback, useRef } from 'react'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import { faCopy, faSpinner, faDoorOpen, faRightToBracket, faPlay, faPlus, faMinus, faWifi, faArrowLeft } from '@fortawesome/free-solid-svg-icons'
import { Tabs, TabContent } from '../components/ui'
import { PageHeader } from '../components/PageHeader.tsx'
import { PageShell } from '../components/PageShell.tsx'
import { Card } from '../components/ui'
import { Button } from '../components/ui'
import { Badge } from '../components/ui'
import { Input } from '../components/ui'
import { Label } from '../components/ui'
import { Select, SelectOption } from '../components/ui'
import { useMessageBox } from '../components/ui'
import { ApiError } from '../api/client.ts'
import * as connectorApi from '../api/connector.ts'
import type { MatchInstancesResponse } from '../api/connector.ts'
import { getInstances, launchInstance, getLaunchProgress } from '../api/instance.ts'
import { cropHeadFromSkin } from '../lib/skin-avatar.ts'
import type { ConnectorStatus, ConnectorPlayer, GameInstance, EasyTierStatus, NatTypeResult, LaunchProgress } from '../types/index.ts'

function fmtSpeed(bytesPerSec: number): string {
  if (bytesPerSec <= 0) return ''
  const mb = bytesPerSec / (1024 * 1024)
  if (mb >= 1) return `${mb.toFixed(1)} MB/s`
  return `${(bytesPerSec / 1024).toFixed(0)} KB/s`
}

function fmtErr(e: unknown): string {
  if (e instanceof ApiError) return e.displayMessage
  if (e instanceof Error) return e.message
  return String(e)
}

const skinHeadCache = new Map<string, string>()

function PlayerRow({ p }: { p: ConnectorPlayer }) {
  const [headUrl, setHeadUrl] = useState<string | null>(() => skinHeadCache.get(p.name) ?? null)

  useEffect(() => {
    if (!p.iconBase64) return
    const iconData = p.iconBase64
    const cached = skinHeadCache.get(p.name)
    if (cached) { setHeadUrl(cached); return }
    let cancelled = false
    ;(async () => {
      try {
        const skinBytes = Uint8Array.from(atob(iconData), c => c.charCodeAt(0))
        const skinBlob = new Blob([skinBytes], { type: 'image/png' })
        const headBlob = await cropHeadFromSkin(skinBlob, 64)
        const url = URL.createObjectURL(headBlob)
        if (!cancelled) { skinHeadCache.set(p.name, url); setHeadUrl(url) }
      } catch { /* ignore */ }
    })()
    return () => { cancelled = true }
  }, [p.iconBase64, p.name])

  return (
    <div className="flex items-center gap-3 rounded-lg border border-border/50 px-3 py-2">
      {headUrl ? (
        <img src={headUrl} alt={p.name} className="h-8 w-8 rounded-full object-cover [image-rendering:pixelated]" />
      ) : (
        <div className="flex h-8 w-8 items-center justify-center rounded-full bg-primary/10 font-bold text-primary">
          {p.name.charAt(0).toUpperCase()}
        </div>
      )}
      <div className="min-w-0">
        <div className="truncate text-sm font-medium">
          {p.name}
          {p.kind === 'host' && <span className="ml-2 text-xs text-primary">房主</span>}
        </div>
        <div className="truncate text-xs text-muted-foreground">{p.vendor}</div>
      </div>
    </div>
  )
}

function PlayerList({ players }: { players: ConnectorPlayer[] }) {
  if (players.length === 0) return <p className="text-sm text-muted-foreground">暂无玩家</p>
  return (
    <div className="space-y-2">
      <Label>玩家列表 ({players.length})</Label>
      {players.map((p, i) => <PlayerRow key={p.name + i} p={p} />)}
    </div>
  )
}

const SOURCE_BADGE: Record<string, { label: string; cls: string }> = {
  modrinth: { label: 'Modrinth', cls: 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 border-emerald-500/30' },
  curseforge: { label: 'CurseForge', cls: 'bg-orange-500/15 text-orange-600 dark:text-orange-400 border-orange-500/30' },
}

function RoomModsCard({ data, onLaunch, launching }: {
  data: MatchInstancesResponse | null
  onLaunch: (instanceId: string) => void
  launching: string | null
}) {
  const mods = data?.mods ?? []
  const instances = data?.instances ?? []
  const matched = instances.filter(i => i.matched)
  const unmatched = instances.filter(i => !i.matched)
  return (
    <div className="space-y-3">
      <div>
        <Label>房主 Mods ({mods.length})</Label>
        {mods.length === 0 ? (
          <p className="text-xs text-muted-foreground">房主未发布 mods 列表（或扫描中）</p>
        ) : (
          <ul className="mt-1 max-h-40 space-y-0.5 overflow-y-auto rounded border border-border/50 p-2 text-xs">
            {mods.map((m, i) => {
              const badge = SOURCE_BADGE[m.source]
              return (
                <li key={m.hash + i} className="flex items-center gap-2">
                  <span className="min-w-0 flex-1 truncate">{m.name || m.hash.slice(0, 12)}</span>
                  {badge && (
                    <span className={`shrink-0 rounded-full border px-1.5 py-0.5 text-[10px] ${badge.cls}`}>{badge.label}</span>
                  )}
                  <code className="shrink-0 text-[10px] text-muted-foreground">{m.hash.slice(0, 8)}</code>
                </li>
              )
            })}
          </ul>
        )}
      </div>
      <div>
        <Label>匹配实例（{mods.length === 0 ? '房主未发布 mods' : `本地 ${instances.length} 个同版本实例`}）</Label>
        {instances.length === 0 && mods.length > 0 && (
          <p className="text-xs text-muted-foreground">没有与房主游戏版本/loader 相同的本地实例</p>
        )}
        {matched.length > 0 && (
          <div className="mt-1 space-y-1.5">
            {matched.map(inst => (
              <div key={inst.instanceId} className="flex items-center gap-2 rounded border border-emerald-500/30 bg-emerald-500/5 px-3 py-2">
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium">{inst.name}</div>
                  <div className="text-xs text-muted-foreground">
                    {inst.gameVersion}{inst.loader ? ` · ${inst.loader} ${inst.loaderVersion ?? ''}` : ''}
                    <span className="ml-2 text-emerald-600 dark:text-emerald-400">mods 一致 ({inst.modCount})</span>
                  </div>
                </div>
                <Button size="sm" onClick={() => onLaunch(inst.instanceId)} disabled={launching !== null}>
                  {launching === inst.instanceId ? <FontAwesomeIcon icon={faSpinner} spin /> : <FontAwesomeIcon icon={faPlay} className="mr-1" />}
                  快捷启动
                </Button>
              </div>
            ))}
          </div>
        )}
        {unmatched.length > 0 && (
          <div className="mt-1 space-y-1">
            {unmatched.map(inst => (
              <div key={inst.instanceId} className="flex items-center gap-2 rounded border border-border/50 px-3 py-1.5 text-sm">
                <span className="min-w-0 flex-1 truncate">{inst.name}</span>
                <span className="shrink-0 text-xs text-muted-foreground">mods 不一致 ({inst.modCount})</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

export default function Connect() {
  const { error: msgError } = useMessageBox()
  const [status, setStatus] = useState<ConnectorStatus>({
    mode: 'idle', roomCode: null, mcHost: null, mcPort: null, gameInfo: null, players: [], error: null,
  })
  const [port, setPort] = useState('')
  const [code, setCode] = useState('')
  const [instances, setInstances] = useState<GameInstance[]>([])
  const [selectedInstance, setSelectedInstance] = useState('')
  const [hostSubMode, setHostSubMode] = useState<'instance' | 'scan'>('instance')
  const [busy, setBusy] = useState(false)
  const [easyTier, setEasyTier] = useState<EasyTierStatus | null>(null)
  const pollTimer = useRef<ReturnType<typeof setInterval> | null>(null)
  const etTimer = useRef<ReturnType<typeof setInterval> | null>(null)
  const [tab, setTab] = useState<'create' | 'join'>('create')
  const [scanning, setScanning] = useState(false)
  const [detectedPort, setDetectedPort] = useState<number | null>(null)
  const [natType, setNatType] = useState<NatTypeResult | null>(null)
  const [natTypeBusy, setNatTypeBusy] = useState(false)
  const [matchData, setMatchData] = useState<MatchInstancesResponse | null>(null)
  const [matchLoading, setMatchLoading] = useState(false)
  const [launchingMatch, setLaunchingMatch] = useState<string | null>(null)
  const [launchProgress, setLaunchProgress] = useState<LaunchProgress | null>(null)
  const [hostError, setHostError] = useState<string | null>(null)
  const startInstanceIdRef = useRef<string | null>(null)
  const lpTimer = useRef<ReturnType<typeof setInterval> | null>(null)

  const refreshStatus = useCallback(async () => {
    try { setStatus(await connectorApi.getStatus()) } catch { /* ignore poll errors */ }
  }, [])

  // guest 模式：拉取房主 mods + 本地匹配实例（进入房间/每次轮询到 guest 时刷新一次）
  useEffect(() => {
    if (status.mode !== 'guest') { setMatchData(null); return }
    let cancelled = false
    setMatchLoading(true)
    connectorApi.matchInstances()
      .then(data => { if (!cancelled) setMatchData(data) })
      .catch(() => { /* 房主不支持/扫描失败，保持空 */ })
      .finally(() => { if (!cancelled) setMatchLoading(false) })
    return () => { cancelled = true }
  }, [status.mode, status.roomCode])

  useEffect(() => {
    refreshStatus()
    getInstances().then(setInstances).catch(() => {})
  }, [refreshStatus])

  useEffect(() => {
    let cancelled = false
    const init = async () => {
      try {
        let et = await connectorApi.getEasyTierStatus()
        if (!et.installed && et.status !== 'resolving' && et.status !== 'downloading' && et.status !== 'extracting') {
          et = await connectorApi.downloadEasyTier()
        }
        if (!cancelled) setEasyTier(et)
      } catch (e) {
        if (!cancelled) msgError(fmtErr(e))
      }
    }
    init()
    return () => { cancelled = true }
  }, [msgError])

  useEffect(() => {
    if (easyTier && !easyTier.installed && (easyTier.status === 'resolving' || easyTier.status === 'downloading' || easyTier.status === 'extracting')) {
      etTimer.current = setInterval(async () => {
        try { setEasyTier(await connectorApi.getEasyTierStatus()) } catch { /* ignore */ }
      }, 1000)
      return () => { if (etTimer.current) clearInterval(etTimer.current) }
    }
  }, [easyTier])

  useEffect(() => {
    if (status.mode !== 'idle') {
      pollTimer.current = setInterval(refreshStatus, 2000)
      return () => { if (pollTimer.current) clearInterval(pollTimer.current) }
    }
  }, [status.mode, refreshStatus])

  // Starting 阶段轮询 LaunchTracker 显示启动步骤/进度；failed/crashed → 卡片常驻错误
  useEffect(() => {
    if (status.mode !== 'starting' || hostError || !startInstanceIdRef.current) return
    lpTimer.current = setInterval(async () => {
      const id = startInstanceIdRef.current
      if (!id) return
      try {
        const p = await getLaunchProgress(id)
        if (p.stage === 'failed' || p.stage === 'crashed') {
          setLaunchProgress(null)
          setHostError(p.error || (p.stage === 'crashed' ? '游戏异常退出' : '启动失败'))
          if (lpTimer.current) clearInterval(lpTimer.current)
        } else if (p.stage === 'completed') {
          setLaunchProgress(null)
          if (lpTimer.current) clearInterval(lpTimer.current)
        } else {
          setLaunchProgress(p)
        }
      } catch {
        if (lpTimer.current) clearInterval(lpTimer.current)
      }
    }, 500)
    return () => { if (lpTimer.current) clearInterval(lpTimer.current) }
  }, [status.mode, hostError])

  useEffect(() => {
    if (hostSubMode !== 'scan') return
    setScanning(true)
    setDetectedPort(null)
    let cancelled = false
    const interval = setInterval(async () => {
      try {
        const result = await connectorApi.scanPorts()
        if (!cancelled && typeof result.port === 'number') {
          setDetectedPort(result.port)
          setPort(String(result.port))
          setScanning(false)
          clearInterval(interval)
        }
      } catch { /* ignore */ }
    }, 1000)
    return () => { cancelled = true; clearInterval(interval) }
  }, [hostSubMode])

  const handleHostPort = async () => {
    const p = parseInt(port, 10)
    if (!p || p < 1 || p > 65535) { msgError('请输入有效端口 (1-65535)'); return }
    setBusy(true)
    try { await connectorApi.hostByPort(p); await refreshStatus() }
    catch (e) { msgError(fmtErr(e)) }
    finally { setBusy(false) }
  }

  const handleHostInstance = async () => {
    if (!selectedInstance) { msgError('请选择一个实例'); return }
    setHostError(null)
    setLaunchProgress(null)
    startInstanceIdRef.current = selectedInstance
    setBusy(true)
    try { await connectorApi.hostByInstance(selectedInstance); await refreshStatus() }
    catch (e) { startInstanceIdRef.current = null; msgError(fmtErr(e)) }
    finally { setBusy(false) }
  }

  const handleJoin = async () => {
    if (!code.trim()) { msgError('请输入房间码'); return }
    setBusy(true)
    try { await connectorApi.joinRoom(code.trim()); await refreshStatus() }
    catch (e) { msgError(fmtErr(e)) }
    finally { setBusy(false) }
  }

  const handleLeave = async () => {
    setBusy(true)
    try { await connectorApi.leave(); await refreshStatus(); setMatchData(null) }
    catch (e) { msgError(fmtErr(e)) }
    finally {
      setBusy(false)
      setLaunchProgress(null)
      startInstanceIdRef.current = null
    }
  }

  // 快捷启动匹配实例：启动并自动加入房间（joinServer = 本机转发端口）
  const handleQuickLaunch = async (instanceId: string) => {
    if (!status.mcPort) { msgError('房间尚未就绪'); return }
    setLaunchingMatch(instanceId)
    try {
      const result = await launchInstance(instanceId, { joinServer: `127.0.0.1:${status.mcPort}` })
      if (!result.success) msgError(result.error || '启动失败')
    } catch (e) { msgError(fmtErr(e)) }
    finally { setLaunchingMatch(null) }
  }

  const copy = (text: string) => navigator.clipboard.writeText(text)

  const testNatType = async () => {
    setNatTypeBusy(true)
    setNatType(null)
    try { setNatType(await connectorApi.getNatType()) }
    catch { msgError('NAT 类型检测失败') }
    finally { setNatTypeBusy(false) }
  }

  const natTypeBadge = (() => {
    if (!natType) return null
    const cfg: Record<string, { label: string; variant: 'default' | 'secondary' | 'destructive' | 'outline' }> = {
      cone: { label: 'UDP: 宽松  TCP: 中等', variant: 'default' },
      symmetric: { label: 'UDP: 严格(对称)  TCP: 严格', variant: 'destructive' },
      blocked: { label: 'UDP: 阻断  TCP: 阻断', variant: 'destructive' },
      unknown: { label: '不确定', variant: 'secondary' },
    }
    const c = cfg[natType.type] ?? { label: natType.type, variant: 'secondary' as const }
    return <Badge variant={c.variant}>{c.label}</Badge>
  })()

  const isHost = status.mode === 'host'
  const isGuest = status.mode === 'guest'
  const isStarting = status.mode === 'starting'
  const etReady = easyTier?.installed ?? false

  return (
    <PageShell className="p-8 space-y-6 overflow-y-auto scroll-fade-mask">
      <PageHeader title="联机" subtitle="创建或加入联机房间" actions={
        <div className="flex items-center gap-2">
          {natTypeBadge}
          <Button variant="outline" size="sm" onClick={testNatType} disabled={natTypeBusy}>
            {natTypeBusy ? <FontAwesomeIcon icon={faSpinner} spin className="mr-1" /> : <FontAwesomeIcon icon={faWifi} className="mr-1" />}
            NAT 检测
          </Button>
        </div>
      } />

      {easyTier && !etReady && (
        <Card className="space-y-2 border p-4">
          {easyTier.status === 'failed' ? (
            <div className="flex items-center justify-between gap-4">
              <p className="text-sm text-destructive">EasyTier 下载失败：{easyTier.error}</p>
              <Button size="sm" variant="outline" onClick={async () => {
                try { setEasyTier(await connectorApi.downloadEasyTier()) } catch (e) { msgError(fmtErr(e)) }
              }}>重试</Button>
            </div>
          ) : (
            <>
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <FontAwesomeIcon icon={faSpinner} spin />
                <span>{easyTier.status === 'resolving' ? '正在测速选择最快下载源…' : easyTier.status === 'extracting' ? '正在解压 EasyTier…' : '正在下载 EasyTier 联机组件…'}</span>
                <span className="ml-auto text-xs">{Math.round(easyTier.progress)}% {fmtSpeed(easyTier.speed)}</span>
              </div>
              <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
                <div className="h-full rounded-full bg-primary transition-all" style={{ width: `${Math.max(2, easyTier.progress)}%` }} />
              </div>
            </>
          )}
        </Card>
      )}

      {status.mode === 'idle' && (
        <>
          <Tabs
            tabs={[
              { id: 'create', label: '创建房间', icon: <FontAwesomeIcon icon={faDoorOpen} className="h-4 w-4" /> },
              { id: 'join', label: '加入房间', icon: <FontAwesomeIcon icon={faRightToBracket} className="h-4 w-4" /> },
            ]}
            activeTab={tab}
            onChange={(id) => setTab(id as 'create' | 'join')}
          />

          <TabContent activeTab={tab} tabId="create">
            {hostSubMode === 'instance' && (
            <Card className="space-y-4 border p-5">
              <h2 className="text-lg font-semibold">启动实例并创建房间</h2>
              <Label>选择实例</Label>
              <Select value={selectedInstance} onChange={setSelectedInstance}>
                <SelectOption value="">请选择...</SelectOption>
                {instances.map((i) => <SelectOption key={i.id} value={i.id}>{i.name}</SelectOption>)}
              </Select>
              <Button onClick={handleHostInstance} disabled={busy || !etReady} className="w-full">
                {busy ? <FontAwesomeIcon icon={faSpinner} spin className="mr-2" /> : null}
                {busy ? '正在启动…' : <><FontAwesomeIcon icon={faPlay} className="mr-2" />启动并创建房间</>}
              </Button>
              <p className="text-xs text-muted-foreground">
                启动后请在游戏内点击"对局域网开放"，将自动探测端口。
              </p>
              <div className="text-center">
                <button className="text-xs text-primary hover:underline" onClick={() => setHostSubMode('scan')}>
                  已手动启动实例？点击这里
                </button>
              </div>
            </Card>
          )}

          {hostSubMode === 'scan' && (
            <Card className="space-y-4 border p-5">
              <div className="flex items-center gap-2">
                <button onClick={() => setHostSubMode('instance')} className="flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-all duration-200 hover:bg-accent hover:text-foreground active:scale-95">
                  <FontAwesomeIcon icon={faArrowLeft} className="h-4 w-4" />
                </button>
                <h2 className="text-lg font-semibold">扫描本地端口</h2>
              </div>
              
              {scanning && detectedPort === null && (
                <div className="space-y-2">
                  <div className="flex items-center gap-2 text-sm text-muted-foreground">
                    <FontAwesomeIcon icon={faSpinner} spin />
                    <span>正在扫描 Java 进程端口…</span>
                  </div>
                  <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
                    <div className="h-full w-full origin-left animate-pulse rounded-full bg-primary" />
                  </div>
                </div>
              )}

              {detectedPort !== null && (
                <div className="rounded-lg border border-border/50 bg-primary/5 p-4">
                  <div className="flex items-center justify-between">
                    <div>
                      <p className="text-sm text-muted-foreground">检测到端口</p>
                      <p className="text-2xl font-bold">{detectedPort}</p>
                    </div>
                    <Button onClick={handleHostPort} disabled={busy || !etReady}>
                      {busy ? <FontAwesomeIcon icon={faSpinner} spin /> : '创建房间'}
                    </Button>
                  </div>
                </div>
              )}

              <div className="space-y-2">
                  <Label>或者手动输入端口</Label>
                  <div className="flex gap-2">
                    <div className="flex items-center gap-2">
                      <Button variant="outline" size="icon" className="h-9 w-9 shrink-0" onClick={() => setPort(String(Math.max(1, (parseInt(port) || 0) - 1)))} disabled={!port || parseInt(port) <= 1}>
                        <FontAwesomeIcon icon={faMinus} className="h-3.5 w-3.5" />
                      </Button>
                      <Input type="number" value={port} onChange={(e) => setPort(e.target.value)} placeholder="25565" className="w-24 text-center [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none" />
                      <Button variant="outline" size="icon" className="h-9 w-9 shrink-0" onClick={() => setPort(String(Math.min(65535, (parseInt(port) || 0) + 1)))} disabled={parseInt(port) >= 65535}>
                        <FontAwesomeIcon icon={faPlus} className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                    <Button onClick={handleHostPort} disabled={busy || !etReady} variant="outline">
                      {busy ? <FontAwesomeIcon icon={faSpinner} spin /> : '创建房间'}
                    </Button>
                  </div>
                </div>
            </Card>
          )}
          </TabContent>

          <TabContent activeTab={tab} tabId="join">
            <Card className="space-y-4 border p-5">
              <h2 className="text-lg font-semibold">加入房间</h2>
              <Label>房间码</Label>
              <Input value={code} onChange={(e) => setCode(e.target.value)} placeholder="U/XXXX-XXXX-XXXX-XXXX" />
              <Button onClick={handleJoin} disabled={busy || !etReady} className="w-full">
                {busy ? <><FontAwesomeIcon icon={faSpinner} spin className="mr-2" />正在加入…</> : <><FontAwesomeIcon icon={faRightToBracket} className="mr-2" />加入房间</>}
              </Button>
            </Card>
          </TabContent>
        </>
      )}

      {(isStarting || hostError) && (
        hostError ? (
          <Card className="space-y-4 border p-5">
            <h2 className="text-lg font-semibold text-destructive">启动失败</h2>
            <p className="rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">{hostError}</p>
            <Button onClick={() => setHostError(null)} className="w-full">知道了</Button>
          </Card>
        ) : (
          <Card className="space-y-4 border p-5">
            <h2 className="text-lg font-semibold">启动实例并创建房间</h2>
            <div className="space-y-3">
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <FontAwesomeIcon icon={faSpinner} spin />
                <span>{launchProgress ? launchProgress.message : '正在启动...'}</span>
              </div>
              {launchProgress && (
                <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
                  <div className="h-full rounded-full bg-primary transition-all" style={{ width: `${Math.max(2, launchProgress.progress)}%` }} />
                </div>
              )}
              <Button variant="destructive" onClick={handleLeave} disabled={busy} className="w-full">
                <FontAwesomeIcon icon={faDoorOpen} className="mr-2" />取消
              </Button>
            </div>
          </Card>
        )
      )}

      {isHost && (
        <Card className="space-y-4 border p-5">
          <h2 className="text-lg font-semibold">创建房间</h2>
          <div className="space-y-3">
            <div className="flex items-center gap-2">
              <span className="text-sm text-muted-foreground">房间码</span>
              <code className="rounded bg-muted px-2 py-1 text-sm">{status.roomCode}</code>
              <Button size="sm" variant="ghost" onClick={() => status.roomCode && copy(status.roomCode)}>
                <FontAwesomeIcon icon={faCopy} />
              </Button>
            </div>
            <PlayerList players={status.players} />
            <Button variant="destructive" onClick={handleLeave} disabled={busy} className="w-full">
              <FontAwesomeIcon icon={faDoorOpen} className="mr-2" />关闭房间
            </Button>
          </div>
        </Card>
      )}

      {isGuest && (
        <Card className="space-y-4 border p-5">
          <h2 className="text-lg font-semibold">加入房间</h2>
          <div className="space-y-3">
            <div className="flex items-center gap-2">
              <span className="text-sm text-muted-foreground">服务器地址</span>
              <code className="rounded bg-muted px-2 py-1 text-sm">{status.mcHost}:{status.mcPort}</code>
              <Button size="sm" variant="ghost" onClick={() => copy(`${status.mcHost}:${status.mcPort}`)}>
                <FontAwesomeIcon icon={faCopy} />
              </Button>
            </div>
            {status.gameInfo && (
              <p className="text-xs text-muted-foreground">
                房主版本：{status.gameInfo.gameVersion}
                {status.gameInfo.loader ? ` · ${status.gameInfo.loader} ${status.gameInfo.loaderVersion ?? ''}` : ''}
              </p>
            )}
            <PlayerList players={status.players} />
            {matchLoading && !matchData ? (
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <FontAwesomeIcon icon={faSpinner} spin /> 正在扫描本地实例与房主 mods 比对...
              </div>
            ) : (
              <RoomModsCard data={matchData} onLaunch={handleQuickLaunch} launching={launchingMatch} />
            )}
            <Button variant="destructive" onClick={handleLeave} disabled={busy} className="w-full">
              <FontAwesomeIcon icon={faDoorOpen} className="mr-2" />退出房间
            </Button>
          </div>
        </Card>
      )}
    </PageShell>
  )
}
