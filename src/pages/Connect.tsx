import { useState, useEffect, useCallback, useRef } from 'react'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import { faCopy, faSpinner, faDoorOpen, faRightToBracket, faPlay } from '@fortawesome/free-solid-svg-icons'
import { PageHeader } from '../components/PageHeader.tsx'
import { Card } from '../components/ui/card.tsx'
import { Button } from '../components/ui/button.tsx'
import { Input } from '../components/ui/input.tsx'
import { Label } from '../components/ui/label.tsx'
import { Select, SelectOption } from '../components/ui/select.tsx'
import { useMessageBox } from '../components/ui/message-box.tsx'
import { ApiError } from '../api/client.ts'
import * as connectorApi from '../api/connector.ts'
import { getInstances } from '../api/instance.ts'
import type { ConnectorStatus, ConnectorPlayer, GameInstance } from '../types/index.ts'

function fmtErr(e: unknown): string {
  if (e instanceof ApiError) return e.displayMessage
  if (e instanceof Error) return e.message
  return String(e)
}

function PlayerRow({ p }: { p: ConnectorPlayer }) {
  return (
    <div className="flex items-center gap-3 rounded-lg border border-border/50 px-3 py-2">
      {p.iconBase64 ? (
        <img src={`data:image/png;base64,${p.iconBase64}`} alt={p.name} className="h-8 w-8 rounded-full object-cover" />
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
  const [hostMode, setHostMode] = useState<'port' | 'instance'>('port')
  const [busy, setBusy] = useState(false)
  const pollTimer = useRef<ReturnType<typeof setInterval> | null>(null)

  const refreshStatus = useCallback(async () => {
    try { setStatus(await connectorApi.getStatus()) } catch { /* ignore poll errors */ }
  }, [])

  useEffect(() => {
    refreshStatus()
    getInstances().then(setInstances).catch(() => {})
  }, [refreshStatus])

  useEffect(() => {
    if (status.mode !== 'idle') {
      pollTimer.current = setInterval(refreshStatus, 3000)
      return () => { if (pollTimer.current) clearInterval(pollTimer.current) }
    }
  }, [status.mode, refreshStatus])

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

  return (
    <div className="space-y-6">
      <PageHeader title="联机" subtitle="创建或加入联机房间" />

      <div className="grid gap-6 lg:grid-cols-2">
        {/* 创建房间 */}
        <Card className="space-y-4 border p-5">
          <h2 className="text-lg font-semibold">创建房间</h2>

          {!isGuest && !isHost && !isStarting && (
            <>
              <div className="flex gap-2">
                <Button variant={hostMode === 'port' ? 'default' : 'outline'} size="sm" onClick={() => setHostMode('port')}>手填端口</Button>
                <Button variant={hostMode === 'instance' ? 'default' : 'outline'} size="sm" onClick={() => setHostMode('instance')}>选择实例</Button>
              </div>

              {hostMode === 'port' ? (
                <div className="space-y-2">
                  <Label>MC 局域网端口</Label>
                  <Input type="number" value={port} onChange={(e) => setPort(e.target.value)} placeholder="例如 25565" />
                  <Button onClick={handleHostPort} disabled={busy} className="w-full">
                    {busy ? <FontAwesomeIcon icon={faSpinner} spin /> : '创建房间'}
                  </Button>
                </div>
              ) : (
                <div className="space-y-2">
                  <Label>选择实例</Label>
                  <Select value={selectedInstance} onChange={setSelectedInstance}>
                    <SelectOption value="">请选择...</SelectOption>
                    {instances.map((i) => <SelectOption key={i.id} value={i.id}>{i.name}</SelectOption>)}
                  </Select>
                  <Button onClick={handleHostInstance} disabled={busy} className="w-full">
                    <FontAwesomeIcon icon={faPlay} className="mr-2" />
                    启动并创建房间
                  </Button>
                  <p className="text-xs text-muted-foreground">启动后请在游戏内点击"对局域网开放"，将自动探测端口。</p>
                </div>
              )}
              {status.error && (
                <p className="text-sm text-destructive">{status.error}</p>
              )}
            </>
          )}

          {isStarting && (
            <div className="space-y-3">
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <FontAwesomeIcon icon={faSpinner} spin />
                <span>正在启动游戏，请在游戏内点击"对局域网开放"…</span>
              </div>
              <Button variant="destructive" onClick={handleLeave} disabled={busy} className="w-full">
                <FontAwesomeIcon icon={faDoorOpen} className="mr-2" />取消
              </Button>
            </div>
          )}

          {isHost && (
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
          )}
        </Card>

        {/* 加入房间 */}
        <Card className="space-y-4 border p-5">
          <h2 className="text-lg font-semibold">加入房间</h2>

          {!isHost && !isGuest && !isStarting && (
            <div className="space-y-2">
              <Label>房间码</Label>
              <Input value={code} onChange={(e) => setCode(e.target.value)} placeholder="U/XXXX-XXXX-XXXX-XXXX" />
              <Button onClick={handleJoin} disabled={busy} className="w-full">
                <FontAwesomeIcon icon={faRightToBracket} className="mr-2" />
                {busy ? <FontAwesomeIcon icon={faSpinner} spin /> : '加入房间'}
              </Button>
            </div>
          )}

          {isGuest && (
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
          )}
        </Card>
      </div>
    </div>
  )
}
