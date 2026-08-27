import { useState, useEffect, useCallback, useRef } from 'react'
import { ArrowLeft, Copy, DoorOpen, Loader2, LogIn, Minus, Play, Plus, UserX, Wifi } from 'lucide-react'
import { Tabs, TabContent, Tooltip, Dialog, DialogHeader, DialogTitle, DialogDescription } from '../components/ui'
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
import { getInstances, getLaunchProgress } from '../api/instance.ts'
import { useRunning } from '../contexts/RunningContext.tsx'
import { useI18n } from '../i18n/index.tsx'
import { cropHeadFromSkin } from '../lib/skin-avatar.ts'
import type { ConnectorStatus, ConnectorPlayer, GameInstance, EasyTierStatus, NatTypeResult, LaunchProgress, KickReviewRequest } from '../types/index.ts'

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

function PlayerRow({ p, onKick }: { p: ConnectorPlayer; onKick?: () => void }) {
  const { t } = useI18n()
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
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium">
          {p.name}
          {p.kind === 'host' && <span className="ml-2 text-xs text-primary">{t('connect.hostBadge')}</span>}
        </div>
        <div className="truncate text-xs text-muted-foreground">{p.vendor}</div>
      </div>
      {onKick && (
        <Tooltip content={t('connect.kick')}>
          <Button size="sm" variant="ghost" onClick={onKick} className="h-8 w-8 shrink-0 text-destructive hover:text-destructive">
            <UserX />
          </Button>
        </Tooltip>
      )}
    </div>
  )
}

function PlayerList({ players, onKick }: { players: ConnectorPlayer[]; onKick?: (p: ConnectorPlayer) => void }) {
  const { t } = useI18n()
  if (players.length === 0) return <p className="text-sm text-muted-foreground">{t('connect.noPlayers')}</p>
  return (
    <div className="space-y-2">
      <Label>{t('connect.playerList', { count: players.length })}</Label>
      {players.map((p, i) => <PlayerRow key={p.machineId || p.name + i} p={p} onKick={onKick && p.kind !== 'host' ? () => onKick(p) : undefined} />)}
    </div>
  )
}

const SOURCE_BADGE: Record<string, { label: string; cls: string }> = {
  modrinth: { label: 'Modrinth', cls: 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 border-emerald-500/30' },
  curseforge: { label: 'CurseForge', cls: 'bg-orange-500/15 text-orange-600 dark:text-orange-400 border-orange-500/30' },
}

function RoomModsCard({ data, onLaunch, launching, hostVersion, players, loading }: {
  data: MatchInstancesResponse | null
  onLaunch: (instanceId: string) => void
  launching: string | null
  hostVersion: string
  players: ConnectorPlayer[]
  loading: boolean
}) {
  const { t } = useI18n()
  const mods = data?.mods ?? []
  const instances = data?.instances ?? []
  const missingSet = new Set<string>(data?.missingHashes ?? [])
  const referenceInstance = data?.referenceInstance ?? null
  const matched = instances.filter(i => i.matched)
  const unmatched = instances.filter(i => !i.matched)
  const noHostInfo = !hostVersion
  const missingCount = mods.filter(m => missingSet.has(m.hash)).length
  const [roomTab, setRoomTab] = useState<'players' | 'mods' | 'instances'>('players')
  return (
    <>
    <Tabs
      tabs={[
        { id: 'players', label: t('connect.playerList', { count: players.length }) },
        { id: 'mods', label: `${t('connect.hostMods')}${mods.length > 0 ? ` (${mods.length})` : ''}` },
        { id: 'instances', label: t('connect.matchInstances', { count: instances.length }) },
      ]}
      activeTab={roomTab}
      onChange={(id) => setRoomTab(id as 'players' | 'mods' | 'instances')}
      className="[&>button]:px-3 [&>button]:py-1.5 [&>button]:text-xs"
    />
    <TabContent activeTab={roomTab} tabId="players" className="space-y-3 pt-2">
      <PlayerList players={players} />
    </TabContent>
    <TabContent activeTab={roomTab} tabId="mods" className="space-y-3">
      {loading && !data ? (
        <p className="flex items-center gap-2 pt-2 text-xs text-muted-foreground">
          <Loader2 className="animate-spin" /> {t('connect.scanningMatch')}
        </p>
      ) : mods.length === 0 ? (
        <p className="pt-2 text-xs text-muted-foreground">{t('connect.noHostMods')}</p>
      ) : (
        <>
          {(noHostInfo || referenceInstance) && (
            <p className="pt-1 text-xs text-muted-foreground">
              {referenceInstance
                ? t('connect.missingModsDesc', { instance: referenceInstance, countSuffix: missingCount > 0 ? t('connect.missingModsCountSuffix', { count: missingCount }) : '' })
                : t('connect.noVersionInfo')}
            </p>
          )}
          <ul className="max-h-40 space-y-0.5 overflow-y-auto rounded border border-border/50 p-2 text-xs">
            {mods.map((m, i) => {
              const badge = SOURCE_BADGE[m.source]
              const missing = missingSet.has(m.hash)
              return (
                <li key={m.hash + i} className="flex items-center gap-2">
                  <span className={`min-w-0 flex-1 truncate ${missing ? 'text-destructive' : ''}`}>{m.name || m.hash.slice(0, 12)}</span>
                  {missing && (
                    <Tooltip content={t('connect.missingTooltip')}>
                      <span className="shrink-0 rounded-full border border-destructive/40 bg-destructive/10 px-1.5 py-0.5 text-[10px] font-medium text-destructive">{t('connect.missing')}</span>
                    </Tooltip>
                  )}
                  {badge && (
                    <span className={`shrink-0 rounded-full border px-1.5 py-0.5 text-[10px] ${badge.cls}`}>{badge.label}</span>
                  )}
                  <code className="shrink-0 text-[10px] text-muted-foreground">{m.hash.slice(0, 8)}</code>
                </li>
              )
            })}
          </ul>
        </>
      )}
    </TabContent>
    <TabContent activeTab={roomTab} tabId="instances" className="space-y-3 pt-2">
      {loading && !data ? (
        <p className="flex items-center gap-2 text-xs text-muted-foreground">
          <Loader2 className="animate-spin" /> {t('connect.scanningLocal')}
        </p>
      ) : (
        <>
      {noHostInfo && (
        <p className="text-xs text-muted-foreground">{t('connect.noVersionForMatch')}</p>
      )}
      {!noHostInfo && instances.length === 0 && mods.length > 0 && (
        <p className="text-xs text-muted-foreground">{t('connect.noMatchingInstance')}</p>
      )}
      {matched.length > 0 && (
        <div className="space-y-1.5">
          <Label>{t('connect.matchedInstances', { count: matched.length })}</Label>
          {matched.map(inst => (
            <div key={inst.instanceId} className="flex items-center gap-2 rounded border border-emerald-500/30 bg-emerald-500/5 px-3 py-2">
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium">{inst.name}</div>
                <div className="text-xs text-muted-foreground">
                  {inst.gameVersion}{inst.loader ? ` · ${inst.loader} ${inst.loaderVersion ?? ''}` : ''}
                  <span className="ml-2 text-emerald-600 dark:text-emerald-400">{t('connect.modsConsistent', { count: inst.modCount })}</span>
                </div>
              </div>
              <Button size="sm" onClick={() => onLaunch(inst.instanceId)} disabled={launching !== null}>
                {launching === inst.instanceId ? <Loader2 className="animate-spin" /> : <Play className="mr-1" />}
                {t('connect.quickLaunch')}
              </Button>
            </div>
          ))}
        </div>
      )}
      {unmatched.length > 0 && (
        <div className="space-y-1">
          <Label>{t('connect.unmatchedInstances', { count: unmatched.length })}</Label>
          {unmatched.map(inst => (
            <div key={inst.instanceId} className="flex items-center gap-2 rounded border border-border/50 px-3 py-1.5 text-sm">
              <div className="min-w-0 flex-1">
                <div className="truncate">{inst.name}</div>
                <div className="text-xs text-muted-foreground">{t('connect.modsInconsistent', { count: inst.modCount })}</div>
              </div>
              <Tooltip content={t('connect.forceLaunchTitle')}>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => onLaunch(inst.instanceId)}
                  disabled={launching !== null}
                >
                  {launching === inst.instanceId ? <Loader2 className="animate-spin" /> : <Play className="mr-1" />}
                  {t('connect.forceLaunch')}
                </Button>
              </Tooltip>
            </div>
          ))}
        </div>
      )}
      {!noHostInfo && instances.length === 0 && mods.length === 0 && (
        <p className="text-xs text-muted-foreground">{t('connect.noLocalInstance')}</p>
      )}
        </>
      )}
    </TabContent>
    </>
  )
}

export default function Connect() {
  const { t } = useI18n()
  const { error: msgError } = useMessageBox()
  const { launchInstance, watchInstance } = useRunning()
  const [status, setStatus] = useState<ConnectorStatus>({
    mode: 'idle', roomCode: null, mcHost: null, mcPort: null, gameInfo: null, players: [], pendingKickReviews: [], kickedPlayers: [], error: null,
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
  const [kickBusy, setKickBusy] = useState(false)
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
          setHostError(p.error || (p.stage === 'crashed' ? t('connect.gameCrashed') : t('connect.launchFailed')))
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
    if (!p || p < 1 || p > 65535) { msgError(t('connect.invalidPort')); return }
    setBusy(true)
    try { await connectorApi.hostByPort(p); await refreshStatus() }
    catch (e) { msgError(fmtErr(e)) }
    finally { setBusy(false) }
  }

  const handleHostInstance = async () => {
    if (!selectedInstance) { msgError(t('connect.selectInstanceFirst')); return }
    const inst = instances.find(i => i.id === selectedInstance)
    setHostError(null)
    setLaunchProgress(null)
    startInstanceIdRef.current = selectedInstance
    setBusy(true)
    try {
      await connectorApi.hostByInstance(selectedInstance)
      // 后端代启：注册进"运行中的游戏"（轮询进度直至 running/终态）
      if (inst) watchInstance(inst.id, inst.name)
      await refreshStatus()
    }
    catch (e) { startInstanceIdRef.current = null; msgError(fmtErr(e)) }
    finally { setBusy(false) }
  }

  const handleJoin = async () => {
    if (!code.trim()) { msgError(t('connect.enterRoomCode')); return }
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

  const handleKick = async (p: ConnectorPlayer) => {
    setKickBusy(true)
    try { await connectorApi.kickPlayer(p.machineId); await refreshStatus() }
    catch (e) { msgError(fmtErr(e)) }
    finally { setKickBusy(false) }
  }

  // 已踢玩家重连审核：status.pendingKickReviews 列表驱动，一次弹一个；
  // 当前项被决定（从列表消失）后自动推进到下一个或关闭。
  const [reviewTarget, setReviewTarget] = useState<KickReviewRequest | null>(null)
  const [reviewBusy, setReviewBusy] = useState(false)
  useEffect(() => {
    if (!reviewTarget) {
      if (status.pendingKickReviews.length > 0) setReviewTarget(status.pendingKickReviews[0])
      return
    }
    const stillPending = status.pendingKickReviews.some(r => r.machineId === reviewTarget.machineId)
    if (!stillPending) setReviewTarget(status.pendingKickReviews[0] ?? null)
  }, [status.pendingKickReviews, reviewTarget])

  const decideReview = async (action: 'allow' | 'reject' | 'reject_silent') => {
    const target = reviewTarget
    if (!target || reviewBusy) return
    setReviewBusy(true)
    try { await connectorApi.decideKickReview(target.machineId, action); await refreshStatus() }
    catch (e) { msgError(fmtErr(e)) }
    finally { setReviewBusy(false) }
  }

  // 已踢玩家管理：解除 deny 封禁（误踢放行）
  const [unbanBusyId, setUnbanBusyId] = useState<string | null>(null)
  const handleUnban = async (p: KickReviewRequest) => {
    if (unbanBusyId) return
    setUnbanBusyId(p.machineId)
    try { await connectorApi.decideKickReview(p.machineId, 'allow'); await refreshStatus() }
    catch (e) { msgError(fmtErr(e)) }
    finally { setUnbanBusyId(null) }
  }

  // 快捷启动匹配实例：启动并自动加入房间（joinServer = 本机转发端口）
  const handleQuickLaunch = async (instanceId: string) => {
    if (!status.mcPort) { msgError(t('connect.roomNotReady')); return }
    setLaunchingMatch(instanceId)
    try {
      const inst = matchData?.instances.find(i => i.instanceId === instanceId)
      // 走 RunningContext：进入"运行中的游戏"、崩溃弹窗、启动/退出通知
      await launchInstance(instanceId, inst?.name || instanceId, undefined, { joinServer: `127.0.0.1:${status.mcPort}` })
    } catch (e) { msgError(fmtErr(e)) }
    finally { setLaunchingMatch(null) }
  }

  const copy = (text: string) => navigator.clipboard.writeText(text)

  const testNatType = async () => {
    setNatTypeBusy(true)
    setNatType(null)
    try { setNatType(await connectorApi.getNatType()) }
    catch { msgError(t('connect.natCheckFailed')) }
    finally { setNatTypeBusy(false) }
  }

  const natTypeBadge = (() => {
    if (!natType) return null
    const cfg: Record<string, { variant: 'default' | 'secondary' | 'destructive' | 'outline' }> = {
      cone: { variant: 'default' },
      symmetric: { variant: 'destructive' },
      blocked: { variant: 'destructive' },
      unknown: { variant: 'secondary' },
    }
    const c = cfg[natType.type] ?? { variant: 'secondary' as const }
    return (
      <Tooltip content={t(`connect.natTypes.${natType.type}.tooltip`)}>
        <Badge variant={c.variant}>{t(`connect.natTypes.${natType.type}.label`)}</Badge>
      </Tooltip>
    )
  })()

  const isHost = status.mode === 'host'
  const isGuest = status.mode === 'guest'
  const isStarting = status.mode === 'starting'
  const etReady = easyTier?.installed ?? false

  return (
    <PageShell className="p-8 space-y-6 overflow-y-auto scroll-fade-mask">
      <PageHeader title={t('connect.title')} subtitle={t('connect.subtitle')} actions={
        <div className="flex items-center gap-2">
          {natTypeBadge}
          <Button variant="outline" size="sm" onClick={testNatType} disabled={natTypeBusy}>
            {natTypeBusy ? <Loader2 className="mr-1 animate-spin" /> : <Wifi className="mr-1" />}
            {t('connect.natCheck')}
          </Button>
        </div>
      } />

      {easyTier && !etReady && (
        <Card className="space-y-2 border p-4">
          {easyTier.status === 'failed' ? (
            <div className="flex items-center justify-between gap-4">
              <p className="text-sm text-destructive">{t('connect.easyTierDownloadFailed', { error: easyTier.error ?? '' })}</p>
              <Button size="sm" variant="outline" onClick={async () => {
                try { setEasyTier(await connectorApi.downloadEasyTier()) } catch (e) { msgError(fmtErr(e)) }
              }}>{t('connect.retry')}</Button>
            </div>
          ) : (
            <>
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="animate-spin" />
                <span>{t(`connect.easyTierStatus.${easyTier.status}`)}</span>
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
              { id: 'create', label: t('connect.tabCreate'), icon: <DoorOpen className="h-4 w-4" /> },
              { id: 'join', label: t('connect.tabJoin'), icon: <LogIn className="h-4 w-4" /> },
            ]}
            activeTab={tab}
            onChange={(id) => setTab(id as 'create' | 'join')}
          />

          <TabContent activeTab={tab} tabId="create">
            {hostSubMode === 'instance' && (
            <Card className="space-y-4 border p-5">
              <h2 className="text-lg font-semibold">{t('connect.createTitle')}</h2>
              <Label>{t('connect.selectInstance')}</Label>
              <Select value={selectedInstance} onChange={setSelectedInstance}>
                <SelectOption value="">{t('connect.pleaseSelect')}</SelectOption>
                {instances.map((i) => <SelectOption key={i.id} value={i.id}>{i.name}</SelectOption>)}
              </Select>
              <Button onClick={handleHostInstance} disabled={busy || !etReady} className="w-full">
                {busy ? <Loader2 className="mr-2 animate-spin" /> : null}
                {busy ? t('connect.starting') : <><Play className="mr-2" />{t('connect.startAndCreate')}</>}
              </Button>
              <p className="text-xs text-muted-foreground">
                {t('connect.openLanHint')}
              </p>
              <div className="text-center">
                <button className="text-xs text-primary hover:underline" onClick={() => setHostSubMode('scan')}>
                  {t('connect.manualStarted')}
                </button>
              </div>
            </Card>
          )}

          {hostSubMode === 'scan' && (
            <Card className="space-y-4 border p-5">
              <div className="flex items-center gap-2">
                <button onClick={() => setHostSubMode('instance')} className="flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-all duration-200 hover:bg-accent hover:text-foreground active:scale-95">
                  <ArrowLeft className="h-4 w-4" />
                </button>
                <h2 className="text-lg font-semibold">{t('connect.scanPortTitle')}</h2>
              </div>
              
              {scanning && detectedPort === null && (
                <div className="space-y-2">
                  <div className="flex items-center gap-2 text-sm text-muted-foreground">
                    <Loader2 className="animate-spin" />
                    <span>{t('connect.scanningPorts')}</span>
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
                      <p className="text-sm text-muted-foreground">{t('connect.portDetected')}</p>
                      <p className="text-2xl font-bold">{detectedPort}</p>
                    </div>
                    <Button onClick={handleHostPort} disabled={busy || !etReady}>
                      {busy ? <Loader2 className="animate-spin" /> : t('connect.createRoom')}
                    </Button>
                  </div>
                </div>
              )}

              <div className="space-y-2">
                  <Label>{t('connect.manualPort')}</Label>
                  <div className="flex gap-2">
                    <div className="flex items-center gap-2">
                      <Button variant="outline" size="icon" className="h-9 w-9 shrink-0" onClick={() => setPort(String(Math.max(1, (parseInt(port) || 0) - 1)))} disabled={!port || parseInt(port) <= 1}>
                        <Minus className="h-3.5 w-3.5" />
                      </Button>
                      <Input type="number" value={port} onChange={(e) => setPort(e.target.value)} placeholder="25565" className="w-24 text-center [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none" />
                      <Button variant="outline" size="icon" className="h-9 w-9 shrink-0" onClick={() => setPort(String(Math.min(65535, (parseInt(port) || 0) + 1)))} disabled={parseInt(port) >= 65535}>
                        <Plus className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                    <Button onClick={handleHostPort} disabled={busy || !etReady} variant="outline">
                      {busy ? <Loader2 className="animate-spin" /> : t('connect.createRoom')}
                    </Button>
                  </div>
                </div>
            </Card>
          )}
          </TabContent>

          <TabContent activeTab={tab} tabId="join">
            <Card className="space-y-4 border p-5">
              <h2 className="text-lg font-semibold">{t('connect.joinTitle')}</h2>
              <Label>{t('connect.roomCode')}</Label>
              <Input value={code} onChange={(e) => setCode(e.target.value)} placeholder="U/XXXX-XXXX-XXXX-XXXX" />
              <Button onClick={handleJoin} disabled={busy || !etReady} className="w-full">
                {busy ? <><Loader2 className="mr-2 animate-spin" />{t('connect.joining')}</> : <><LogIn className="mr-2" />{t('connect.joinRoom')}</>}
              </Button>
            </Card>
          </TabContent>
        </>
      )}

      {(isStarting || hostError) && (
        hostError ? (
          <Card className="space-y-4 border p-5">
            <h2 className="text-lg font-semibold text-destructive">{t('connect.launchFailed')}</h2>
            <p className="rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">{hostError}</p>
            <Button onClick={() => setHostError(null)} className="w-full">{t('connect.gotIt')}</Button>
          </Card>
        ) : (
          <Card className="space-y-4 border p-5">
            <h2 className="text-lg font-semibold">{t('connect.createTitle')}</h2>
            <div className="space-y-3">
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="animate-spin" />
                <span>{launchProgress ? launchProgress.message : t('connect.starting')}</span>
              </div>
              {launchProgress && (
                <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
                  <div className="h-full rounded-full bg-primary transition-all" style={{ width: `${Math.max(2, launchProgress.progress)}%` }} />
                </div>
              )}
              <Button variant="destructive" onClick={handleLeave} disabled={busy} className="w-full">
                <DoorOpen className="mr-2" />{t('connect.cancel')}
              </Button>
            </div>
          </Card>
        )
      )}

      {isHost && (
        <Card className="space-y-4 border p-5">
          <h2 className="text-lg font-semibold">{t('connect.createRoom')}</h2>
          <div className="space-y-3">
            <div className="flex items-center gap-2">
              <span className="text-sm text-muted-foreground">{t('connect.roomCode')}</span>
              <code className="rounded bg-muted px-2 py-1 text-sm">{status.roomCode}</code>
              <Button size="sm" variant="ghost" onClick={() => status.roomCode && copy(status.roomCode)}>
                <Copy />
              </Button>
            </div>
            <PlayerList players={status.players} onKick={(p) => { if (p.kind !== 'host' && !kickBusy) handleKick(p) }} />
            {status.kickedPlayers.length > 0 && (
              <div className="space-y-2">
                <Label>{t('connect.kickedPlayersTitle', { count: status.kickedPlayers.length })}</Label>
                <div className="space-y-1.5">
                  {status.kickedPlayers.map((p) => (
                    <div key={p.machineId} className="flex items-center justify-between rounded-md border border-border/60 bg-muted/30 px-3 py-2">
                      <div className="min-w-0">
                        <span className="truncate text-sm font-medium">{p.name}</span>
                        <span className="ml-2 text-xs text-muted-foreground">{p.vendor}</span>
                      </div>
                      <Button size="sm" variant="secondary" disabled={unbanBusyId === p.machineId} onClick={() => handleUnban(p)}>
                        {unbanBusyId === p.machineId ? <Loader2 className="mr-1 animate-spin" /> : null}
                        {t('connect.unban')}
                      </Button>
                    </div>
                  ))}
                </div>
              </div>
            )}
            <Button variant="destructive" onClick={handleLeave} disabled={busy} className="w-full">
              <DoorOpen className="mr-2" />{t('connect.closeRoom')}
            </Button>
          </div>
        </Card>
      )}

      {isGuest && (
        <Card className="space-y-4 border p-5">
          <h2 className="text-lg font-semibold">{t('connect.joinTitle')}</h2>
          <div className="space-y-3">
            <div className="flex items-center gap-2">
              <span className="text-sm text-muted-foreground">{t('connect.serverAddress')}</span>
              <code className="rounded bg-muted px-2 py-1 text-sm">{status.mcHost}:{status.mcPort}</code>
              <Button size="sm" variant="ghost" onClick={() => copy(`${status.mcHost}:${status.mcPort}`)}>
                <Copy />
              </Button>
            </div>
            {status.gameInfo && (
              <p className="text-xs text-muted-foreground">
                {t('connect.hostVersion', { version: status.gameInfo.gameVersion })}
                {status.gameInfo.loader ? ` · ${status.gameInfo.loader} ${status.gameInfo.loaderVersion ?? ''}` : ''}
              </p>
            )}
            <RoomModsCard data={matchData} onLaunch={handleQuickLaunch} launching={launchingMatch} hostVersion={status.gameInfo?.gameVersion ?? ''} players={status.players} loading={matchLoading} />
            <Button variant="destructive" onClick={handleLeave} disabled={busy} className="w-full">
              <DoorOpen className="mr-2" />{t('connect.leaveRoom')}
            </Button>
          </div>
        </Card>
      )}

      {/* 已踢玩家申请重新加入 → 房主三选（关闭弹窗 = 拒绝） */}
      <Dialog open={!!reviewTarget} onClose={() => decideReview('reject')}>
        {reviewTarget && (
          <>
            <DialogHeader onClose={() => decideReview('reject')}>
              <DialogTitle>{t('connect.kickReviewTitle')}</DialogTitle>
            </DialogHeader>
            <div className="p-6">
              <DialogDescription>{t('connect.kickReviewBody', { name: reviewTarget.name })}</DialogDescription>
              <div className="mt-6 flex flex-wrap justify-end gap-2">
                <Button variant="default" disabled={reviewBusy} onClick={() => decideReview('allow')}>{t('connect.kickReviewAllow')}</Button>
                <Button variant="secondary" disabled={reviewBusy} onClick={() => decideReview('reject')}>{t('connect.kickReviewReject')}</Button>
                <Button variant="outline" disabled={reviewBusy} onClick={() => decideReview('reject_silent')}>{t('connect.kickReviewRejectSilent')}</Button>
              </div>
            </div>
          </>
        )}
      </Dialog>
    </PageShell>
  )
}
