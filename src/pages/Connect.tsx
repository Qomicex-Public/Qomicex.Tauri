import { useState, useEffect, useCallback, useRef } from 'react'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import { faCopy, faSpinner, faDoorOpen, faRightToBracket, faPlay, faPlus, faMinus } from '@fortawesome/free-solid-svg-icons'
import { PageHeader } from '../components/PageHeader.tsx'
import { PageShell } from '../components/PageShell.tsx'
import { Card } from '../components/ui/card.tsx'
import { Button } from '../components/ui/button.tsx'
import { Input } from '../components/ui/input.tsx'
import { Label } from '../components/ui/label.tsx'
import { Select, SelectOption } from '../components/ui/select.tsx'
import { useMessageBox } from '../components/ui/message-box.tsx'
import { ApiError } from '../api/client.ts'
import * as connectorApi from '../api/connector.ts'
import { getInstances } from '../api/instance.ts'
import { cropHeadFromSkin } from '../lib/skin-avatar.ts'
import type { ConnectorStatus, ConnectorPlayer, GameInstance, EasyTierStatus } from '../types/index.ts'

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

  const refreshStatus = useCallback(async () => {
    try { setStatus(await connectorApi.getStatus()) } catch { /* ignore poll errors */ }
  }, [])

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

  useEffect(() => {
    if (hostSubMode !== 'scan') return
    setScanning(true)
    setDetectedPort(null)
    let cancelled = false
    const interval = setInterval(async () => {
      try {
        const result = await connectorApi.scanPorts()
        if (!cancelled && result.port !== null) {
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
    setBusy(true)
    try { await connectorApi.hostByInstance(selectedInstance); await refreshStatus() }
    catch (e) { msgError(fmtErr(e)) }
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
    try { await connectorApi.leave(); await refreshStatus() }
    catch (e) { msgError(fmtErr(e)) }
    finally { setBusy(false) }
  }

  const copy = (text: string) => navigator.clipboard.writeText(text)

  const isHost = status.mode === 'host'
  const isGuest = status.mode === 'guest'
  const isStarting = status.mode === 'starting'
  const etReady = easyTier?.installed ?? false

  return (
    <PageShell className="p-8 space-y-6 overflow-y-auto">
      <PageHeader title="联机" subtitle="创建或加入联机房间" />

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
          <div className="flex gap-2 border-b border-border pb-2 mb-4">
            <Button variant={tab === 'create' ? 'default' : 'ghost'} onClick={() => setTab('create')}>
              <FontAwesomeIcon icon={faDoorOpen} className="mr-2" />创建房间
            </Button>
            <Button variant={tab === 'join' ? 'default' : 'ghost'} onClick={() => setTab('join')}>
              <FontAwesomeIcon icon={faRightToBracket} className="mr-2" />加入房间
            </Button>
          </div>

          {tab === 'create' && hostSubMode === 'instance' && (
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

          {tab === 'create' && hostSubMode === 'scan' && (
            <Card className="space-y-4 border p-5">
              <div className="flex items-center gap-2">
                <button className="text-sm text-muted-foreground hover:text-foreground" onClick={() => setHostSubMode('instance')}>
                  &larr; 返回实例选择
                </button>
              </div>
              <h2 className="text-lg font-semibold">扫描本地端口</h2>
              
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

          {tab === 'join' && (
            <Card className="space-y-4 border p-5">
              <h2 className="text-lg font-semibold">加入房间</h2>
              <Label>房间码</Label>
              <Input value={code} onChange={(e) => setCode(e.target.value)} placeholder="U/XXXX-XXXX-XXXX-XXXX" />
              <Button onClick={handleJoin} disabled={busy || !etReady} className="w-full">
                {busy ? <><FontAwesomeIcon icon={faSpinner} spin className="mr-2" />正在加入…</> : <><FontAwesomeIcon icon={faRightToBracket} className="mr-2" />加入房间</>}
              </Button>
            </Card>
          )}
        </>
      )}

      {isStarting && (
        <Card className="space-y-4 border p-5">
          <h2 className="text-lg font-semibold">创建房间</h2>
          <div className="space-y-3">
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <FontAwesomeIcon icon={faSpinner} spin />
              <span>正在启动游戏，请在游戏内点击"对局域网开放"…</span>
            </div>
            <Button variant="destructive" onClick={handleLeave} disabled={busy} className="w-full">
              <FontAwesomeIcon icon={faDoorOpen} className="mr-2" />取消
            </Button>
          </div>
        </Card>
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
            <Button variant="destructive" onClick={handleLeave} disabled={busy} className="w-full">
              <FontAwesomeIcon icon={faDoorOpen} className="mr-2" />退出房间
            </Button>
          </div>
        </Card>
      )}
    </PageShell>
  )
}
