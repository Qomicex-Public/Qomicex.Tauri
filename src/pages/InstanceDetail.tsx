import { useEffect, useState, useCallback, useMemo, useRef } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import { faArrowLeft, faInfoCircle, faSliders, faSave, faCamera, faCube, faBox, faSun, faServer, faPlay, faFolderOpen, faGear, faTrashCan, faRotate, faRobot, faFile, faImage, faGlobe, faFolder, faCopy, faPlus, faMagnifyingGlass, faDownload, faClipboard, faStar, faWifi } from '@fortawesome/free-solid-svg-icons'
import { Button } from '../components/ui/button.tsx'
import { Card, CardContent } from '../components/ui/card.tsx'
import { Input } from '../components/ui/input.tsx'
import { Label } from '../components/ui/label.tsx'
import { Select, SelectOption } from '../components/ui/select.tsx'
import { Tooltip } from '../components/ui/tooltip.tsx'
import { Dialog, DialogHeader, DialogTitle, DialogBody, DialogFooter } from '../components/ui/dialog.tsx'
import { cn } from '../lib/utils.ts'
import { getInstance, updateInstance, launchInstance, deleteInstance, setDefaultInstance, clearDefaultInstance, getDefaultInstance, verifyResources, repairResources, getInstallProgress } from '../api/instance.ts'
import { openPath } from '@tauri-apps/plugin-opener'
import { getRuntimes, scanRuntimes, loadCustomRuntimes, hasAnyRuntimes, subscribe } from '../stores/javaStore.ts'
import { getAccounts } from '../api/account.ts'
import { getSystemInfo } from '../api/system.ts'
import type { GameInstance, JavaRuntime, Account, SystemInfo, FileEntry, ServerEntry, ServerState, MissingFile } from '../types/index.ts'
import { getSaves, getScreenshots, getResourcePacks, getShaderPacks, getServers, deleteSave, copySave, deleteScreenshot, deleteResourcePack, deleteShaderPack, addServer, deleteServer, pingServer, getModsMetadata, batchEnableMods, batchDisableMods, batchDeleteMods } from '../api/instance-files.ts'
import { ErrorReportDialog } from '../components/ErrorReportDialog.tsx'
import { InstanceIcon, ICON_NAMES } from '../components/InstanceIcon.tsx'
import ModCard from '../components/ModCard.tsx'
import VersionPickerDialog from '../components/VersionPickerDialog.tsx'
import type { ModMetadata } from '../types/index.ts'

const LOADER_COLORS: Record<string, string> = {
  forge: 'bg-orange-500/10 text-orange-500 border-orange-500/25',
  fabric: 'bg-cyan-500/10 text-cyan-400 border-cyan-400/25',
  neoforge: 'bg-green-500/10 text-green-500 border-green-500/25',
  quilt: 'bg-purple-500/10 text-purple-400 border-purple-400/25',
}

const TABS = [
  { id: 'overview', label: '概况', icon: faInfoCircle },
  { id: 'settings', label: '设置', icon: faSliders },
  { id: 'saves', label: '存档', icon: faSave },
  { id: 'screenshots', label: '截图', icon: faCamera },
  { id: 'mods', label: 'Mod', icon: faCube },
  { id: 'resourcepacks', label: '资源包', icon: faBox },
  { id: 'shaderpacks', label: '光影包', icon: faSun },
  { id: 'servers', label: '服务器', icon: faServer },
]

type TabId = typeof TABS[number]['id']

function formatPlayTime(minutes: number): string {
  if (minutes < 60) return `${minutes} 分钟`
  const hours = Math.floor(minutes / 60)
  const mins = minutes % 60
  return mins > 0 ? `${hours} 小时 ${mins} 分钟` : `${hours} 小时`
}

function formatDate(iso: string | null): string {
  if (!iso) return '从未'
  const d = new Date(iso)
  const now = new Date()
  const diff = now.getTime() - d.getTime()
  if (diff < 60000) return '刚刚'
  if (diff < 3600000) return `${Math.floor(diff / 60000)} 分钟前`
  if (diff < 86400000) return `${Math.floor(diff / 3600000)} 小时前`
  return d.toLocaleDateString('zh-CN', { month: 'short', day: 'numeric', year: d.getFullYear() !== now.getFullYear() ? 'numeric' : undefined })
}

function formatSize(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${bytes} B`
}

function formatDateTime(iso: string | Date | null | undefined): string {
  if (!iso) return ''
  const d = typeof iso === 'string' ? new Date(iso) : iso
  return d.toLocaleDateString('zh-CN', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

function ConfirmDialog({ open, title, message, onConfirm, onCancel, loading }: {
  open: boolean
  title: string
  message: string
  onConfirm: () => void
  onCancel: () => void
  loading?: boolean
}) {
  return (
    <Dialog open={open} onClose={onCancel}>
      <DialogHeader onClose={onCancel}><DialogTitle>{title}</DialogTitle></DialogHeader>
      <DialogBody><p className="text-sm text-muted-foreground">{message}</p></DialogBody>
      <DialogFooter>
        <Button variant="outline" size="sm" onClick={onCancel}>取消</Button>
        <Button size="sm" variant="destructive" onClick={onConfirm} disabled={loading}>{loading ? '删除中...' : '删除'}</Button>
      </DialogFooter>
    </Dialog>
  )
}

function SavesTab({ instanceId, files, loading, onRefresh }: {
  instanceId: string
  files?: FileEntry[] | null
  loading?: boolean
  onRefresh: () => void
}) {
  const [deleting, setDeleting] = useState<string | null>(null)
  const [confirmName, setConfirmName] = useState<string | null>(null)
  const handleDelete = useCallback(async (name: string) => {
    setDeleting(name)
    setConfirmName(null)
    try { await deleteSave(instanceId, name); onRefresh() } catch {}
    setDeleting(null)
  }, [instanceId, onRefresh])
  const handleCopy = useCallback(async (name: string) => {
    try { await copySave(instanceId, name, `${name} 副本`); onRefresh() } catch {}
  }, [instanceId, onRefresh])
  return (
    <>
      <Card>
        <CardContent className="p-5">
          <div className="mb-3 flex items-center justify-between">
            <h3 className="text-sm font-medium"><FontAwesomeIcon icon={faSave} className="mr-2 h-4 w-4 text-primary" />存档</h3>
            <Button size="sm" variant="ghost" onClick={() => {/* open saves folder */}} className="gap-1.5 h-7 text-xs">
              <FontAwesomeIcon icon={faFolderOpen} className="h-3.5 w-3.5" />打开文件夹
            </Button>
          </div>
          {loading ? (
            <div className="flex items-center justify-center gap-2 py-8 text-sm text-muted-foreground">
              <FontAwesomeIcon icon={faRotate} className="h-4 w-4 animate-spin" />加载中...
            </div>
          ) : !files || files.length === 0 ? (
            <div className="py-8 text-center text-sm text-muted-foreground">暂无存档</div>
          ) : (
            <div className="space-y-1">
              {files.map((f) => (
                <div key={f.name} className="flex items-center gap-2 rounded-lg px-3 py-2 text-sm transition-colors hover:bg-accent group">
                  <FontAwesomeIcon icon={faFolder} className="h-4 w-4 shrink-0 text-muted-foreground" />
                  <span className="flex-1 truncate min-w-0">{f.name}</span>
                  <span className="shrink-0 text-[11px] text-muted-foreground hidden sm:block">{formatDateTime(f.lastModified)}</span>
                  <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
                    <Tooltip content="复制存档"><button onClick={() => handleCopy(f.name)} className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"><FontAwesomeIcon icon={faCopy} className="h-3.5 w-3.5" /></button></Tooltip>
                    <Tooltip content="删除"><button onClick={() => setConfirmName(f.name)} className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-destructive/10 hover:text-destructive"><FontAwesomeIcon icon={faTrashCan} className="h-3.5 w-3.5" /></button></Tooltip>
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
      <ConfirmDialog open={confirmName !== null} title="删除存档" message={`确定要删除存档「${confirmName}」吗？此操作不可撤销。`} onConfirm={() => confirmName && handleDelete(confirmName)} onCancel={() => setConfirmName(null)} loading={deleting !== null} />
    </>
  )
}

function ScreenshotsTab({ instanceId, files, loading, onRefresh }: {
  instanceId: string
  files?: FileEntry[] | null
  loading?: boolean
  onRefresh: () => void
}) {
  const [deleting, setDeleting] = useState<string | null>(null)
  const [confirmName, setConfirmName] = useState<string | null>(null)
  const handleDelete = useCallback(async (name: string) => {
    setDeleting(name)
    setConfirmName(null)
    try { await deleteScreenshot(instanceId, name); onRefresh() } catch {}
    setDeleting(null)
  }, [instanceId, onRefresh])
  return (
    <>
      <Card>
        <CardContent className="p-5">
          <div className="mb-3 flex items-center justify-between">
            <h3 className="text-sm font-medium"><FontAwesomeIcon icon={faCamera} className="mr-2 h-4 w-4 text-primary" />截图</h3>
            <Button size="sm" variant="ghost" onClick={() => {/* open screenshots folder */}} className="gap-1.5 h-7 text-xs">
              <FontAwesomeIcon icon={faFolderOpen} className="h-3.5 w-3.5" />打开文件夹
            </Button>
          </div>
          {loading ? (
            <div className="flex items-center justify-center gap-2 py-8 text-sm text-muted-foreground">
              <FontAwesomeIcon icon={faRotate} className="h-4 w-4 animate-spin" />加载中...
            </div>
          ) : !files || files.length === 0 ? (
            <div className="py-8 text-center text-sm text-muted-foreground">暂无截图</div>
          ) : (
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
              {files.map((f) => (
                <div key={f.name} className="group relative overflow-hidden rounded-lg border bg-muted">
                  <div className="aspect-video flex items-center justify-center text-muted-foreground/40">
                    <FontAwesomeIcon icon={faImage} className="h-10 w-10" />
                  </div>
                  <div className="p-2">
                    <p className="truncate text-xs">{f.name}</p>
                    <p className="text-[11px] text-muted-foreground">{formatSize(f.size)}</p>
                  </div>
                  <div className="absolute right-1 top-1 opacity-0 group-hover:opacity-100 transition-opacity">
                    <Tooltip content="删除"><button onClick={() => setConfirmName(f.name)} className="flex h-7 w-7 items-center justify-center rounded-md bg-background/80 text-muted-foreground hover:bg-destructive hover:text-destructive-foreground"><FontAwesomeIcon icon={faTrashCan} className="h-3.5 w-3.5" /></button></Tooltip>
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
      <ConfirmDialog open={confirmName !== null} title="删除截图" message={`确定要删除截图「${confirmName}」吗？此操作不可撤销。`} onConfirm={() => confirmName && handleDelete(confirmName)} onCancel={() => setConfirmName(null)} loading={deleting !== null} />
    </>
  )
}

function ModsTab({ instanceId, gameVersion, loader, gameDir }: {
  instanceId: string
  gameVersion?: string
  loader?: string
  gameDir: string
}) {
  const navigate = useNavigate()
  const [search, setSearch] = useState('')
  const [mods, setMods] = useState<ModMetadata[]>([])
  const [loading, setLoading] = useState(true)
  const [versionDialogMod, setVersionDialogMod] = useState<ModMetadata | null>(null)

  const [batchMode, setBatchMode] = useState(false)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [batchConfirm, setBatchConfirm] = useState<{ type: 'enable' | 'disable' | 'delete' } | null>(null)
  const [batchProcessing, setBatchProcessing] = useState(false)

  const loadMods = useCallback(async () => {
    setLoading(true)
    try {
      const data = await getModsMetadata(instanceId)
      setMods(data)
    } catch (e) { console.error('Load mods failed:', e); setMods([]) }
    setLoading(false)
  }, [instanceId])

  useEffect(() => {
    loadMods()
  }, [loadMods])

  const filtered = useMemo(() => {
    if (!search) return mods
    const q = search.toLowerCase()
    return mods.filter(m =>
      m.name.toLowerCase().includes(q) ||
      (m.chineseName && m.chineseName.includes(q)) ||
      m.fileName.toLowerCase().includes(q)
    )
  }, [mods, search])

  const toggleSelect = useCallback((fileName: string) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(fileName)) next.delete(fileName)
      else next.add(fileName)
      return next
    })
  }, [])

  const enterBatchMode = useCallback(() => {
    setBatchMode(true)
    setSelected(new Set())
  }, [])

  const exitBatchMode = useCallback(() => {
    setBatchMode(false)
    setSelected(new Set())
  }, [])

  const handleBatchAction = useCallback(async () => {
    if (!batchConfirm) return
    setBatchProcessing(true)
    const names = Array.from(selected)
    try {
      if (batchConfirm.type === 'enable') await batchEnableMods(instanceId, names)
      else if (batchConfirm.type === 'disable') await batchDisableMods(instanceId, names)
      else if (batchConfirm.type === 'delete') await batchDeleteMods(instanceId, names)
      await loadMods()
      exitBatchMode()
    } catch (e) { console.error('Batch action failed:', e) }
    setBatchProcessing(false)
    setBatchConfirm(null)
  }, [batchConfirm, selected, instanceId, loadMods, exitBatchMode])

  if (!loader) {
    return (
      <Card>
        <CardContent className="p-5">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
              <FontAwesomeIcon icon={faCube} className="h-5 w-5" />
            </div>
            <div>
              <h3 className="text-sm font-medium">Mod 管理</h3>
              <p className="mt-0.5 text-xs text-muted-foreground">该实例不可使用 Mod，需要使用 Forge、Fabric 等加载器</p>
            </div>
          </div>
        </CardContent>
      </Card>
    )
  }

  return (
    <>
      <Card>
        <CardContent className="p-5">
          <div className="mb-3 flex items-center justify-between gap-3">
            <h3 className="text-sm font-medium shrink-0">
              <FontAwesomeIcon icon={faCube} className="mr-2 h-4 w-4 text-primary" />Mod
              {mods.length > 0 && <span className="ml-1.5 text-xs font-normal text-muted-foreground">({mods.length})</span>}
            </h3>
            <div className="flex items-center gap-2 flex-1 max-w-sm">
              <div className="relative flex-1">
                <FontAwesomeIcon icon={faMagnifyingGlass} className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
                <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="搜索 Mod..." className="h-8 pl-8 text-xs" />
              </div>
            </div>
            <div className="flex items-center gap-1.5">
              {batchMode ? (
                <>
                  <Button size="sm" variant="outline" onClick={exitBatchMode} className="gap-1.5 h-7 text-xs">取消</Button>
                  <Button size="sm" variant="outline" onClick={() => setBatchConfirm({ type: 'enable' })} disabled={selected.size === 0} className="gap-1.5 h-7 text-xs">启用</Button>
                  <Button size="sm" variant="outline" onClick={() => setBatchConfirm({ type: 'disable' })} disabled={selected.size === 0} className="gap-1.5 h-7 text-xs">禁用</Button>
                  <Button size="sm" variant="outline" onClick={() => setBatchConfirm({ type: 'delete' })} disabled={selected.size === 0} className="gap-1.5 h-7 text-xs text-destructive hover:text-destructive">删除</Button>
                </>
              ) : (
                <>
                  <Button size="sm" variant="ghost" onClick={() => openPath(gameDir + '\\mods').catch(e => console.error('Open mods folder failed:', e))} className="gap-1.5 h-7 text-xs">
                    <FontAwesomeIcon icon={faFolderOpen} className="h-3.5 w-3.5" />打开文件夹
                  </Button>
                  <Button size="sm" variant="outline" onClick={enterBatchMode} className="gap-1.5 h-7 text-xs">
                    批量操作
                  </Button>
                  <Button size="sm" onClick={() => {
                    const p = new URLSearchParams({ category: 'mod', source: 'modrinth' })
                    if (gameVersion) p.set('gameVersion', gameVersion)
                    if (loader) p.set('loader', loader.toLowerCase())
                    if (instanceId) p.set('instanceId', instanceId)
                    navigate(`/resource-center?${p.toString()}`)
                  }} className="gap-1.5 h-7 text-xs">
                    <FontAwesomeIcon icon={faDownload} className="h-3.5 w-3.5" />安装 Mod
                  </Button>
                </>
              )}
            </div>
          </div>

          {loading ? (
            <div className="flex items-center justify-center gap-2 py-8 text-sm text-muted-foreground">
              <FontAwesomeIcon icon={faRotate} className="h-4 w-4 animate-spin" />加载中...
            </div>
          ) : filtered.length === 0 ? (
            <div className="py-8 text-center text-sm text-muted-foreground">
              {search ? '无匹配 Mod' : '暂无 Mod'}
            </div>
          ) : (
            <div className="flex flex-col gap-2">
              {filtered.map((mod) => (
                <ModCard
                  key={mod.fileName}
                  mod={mod}
                  instanceId={instanceId}
                  gameVersion={gameVersion}
                  loader={loader}
                  onRefresh={loadMods}
                  onChangeVersion={setVersionDialogMod}
                  batchMode={batchMode}
                  selected={selected.has(mod.fileName)}
                  onSelect={toggleSelect}
                />
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <Dialog open={batchConfirm !== null} onClose={() => setBatchConfirm(null)}>
        <DialogHeader onClose={() => setBatchConfirm(null)}>
          <DialogTitle>
            {batchConfirm?.type === 'enable' ? '批量启用' : batchConfirm?.type === 'disable' ? '批量禁用' : '批量删除'}
          </DialogTitle>
        </DialogHeader>
        <DialogBody>
          <p className="text-sm text-muted-foreground">
            确定要
            {batchConfirm?.type === 'enable' ? '启用' : batchConfirm?.type === 'disable' ? '禁用' : '删除'}
            {selected.size} 个 Mod 吗？
          </p>
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" size="sm" onClick={() => setBatchConfirm(null)}>取消</Button>
          <Button size="sm" variant={batchConfirm?.type === 'delete' ? 'destructive' : 'default'} onClick={handleBatchAction} disabled={batchProcessing}>
            {batchProcessing ? '处理中...' : '确定'}
          </Button>
        </DialogFooter>
      </Dialog>

      <VersionPickerDialog
        open={versionDialogMod !== null}
        onClose={() => setVersionDialogMod(null)}
        mod={versionDialogMod}
        instanceId={instanceId}
        gameVersion={gameVersion}
        loader={loader}
        onDone={loadMods}
      />
    </>
  )
}

function GenericFileTab({ instanceId, type, icon, label, files, loading, onRefresh, showSize, emptyText }: {
  instanceId: string
  type: string
  icon: any
  label: string
  files?: FileEntry[] | null
  loading?: boolean
  onRefresh: () => void
  showSize?: boolean
  emptyText: string
}) {
  const [deleting, setDeleting] = useState<string | null>(null)
  const [confirmName, setConfirmName] = useState<string | null>(null)
  const handleDelete = useCallback(async (name: string) => {
    setDeleting(name)
    setConfirmName(null)
    try {
      if (type === 'resourcepacks') { await deleteResourcePack(instanceId, name) }
      else if (type === 'shaderpacks') { await deleteShaderPack(instanceId, name) }
      onRefresh()
    } catch {}
    setDeleting(null)
  }, [instanceId, type, onRefresh])
  return (
    <>
      <Card>
        <CardContent className="p-5">
          <div className="mb-3 flex items-center justify-between">
            <h3 className="text-sm font-medium"><FontAwesomeIcon icon={icon} className="mr-2 h-4 w-4 text-primary" />{label}</h3>
            <Button size="sm" variant="ghost" onClick={() => {/* open folder */}} className="gap-1.5 h-7 text-xs">
              <FontAwesomeIcon icon={faFolderOpen} className="h-3.5 w-3.5" />打开文件夹
            </Button>
          </div>
          {loading ? (
            <div className="flex items-center justify-center gap-2 py-8 text-sm text-muted-foreground">
              <FontAwesomeIcon icon={faRotate} className="h-4 w-4 animate-spin" />加载中...
            </div>
          ) : !files || files.length === 0 ? (
            <div className="py-8 text-center text-sm text-muted-foreground">{emptyText}</div>
          ) : (
            <div className="space-y-1">
              {files.map((f) => (
                <div key={f.name} className="flex items-center gap-2 rounded-lg px-3 py-2 text-sm transition-colors hover:bg-accent group">
                  <FontAwesomeIcon icon={faFile} className="h-4 w-4 shrink-0 text-muted-foreground" />
                  <span className="flex-1 truncate min-w-0">{f.name}</span>
                  {showSize && <span className="shrink-0 text-xs text-muted-foreground">{formatSize(f.size)}</span>}
                  <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
                    <Tooltip content="删除"><button onClick={() => setConfirmName(f.name)} className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-destructive/10 hover:text-destructive"><FontAwesomeIcon icon={faTrashCan} className="h-3.5 w-3.5" /></button></Tooltip>
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
      <ConfirmDialog open={confirmName !== null} title={`删除${label}`} message={`确定要删除${label}「${confirmName}」吗？此操作不可撤销。`} onConfirm={() => confirmName && handleDelete(confirmName)} onCancel={() => setConfirmName(null)} loading={deleting !== null} />
    </>
  )
}

function ServersTab({ instanceId, servers, loading, onRefresh }: {
  instanceId: string
  servers?: ServerEntry[] | null
  loading?: boolean
  onRefresh: () => void
}) {
  const [showAdd, setShowAdd] = useState(false)
  const [addName, setAddName] = useState('')
  const [addIp, setAddIp] = useState('')
  const [adding, setAdding] = useState(false)
  const [confirmIp, setConfirmIp] = useState<string | null>(null)
  const [pingStates, setPingStates] = useState<Record<string, ServerState>>({})
  const [pinging, setPinging] = useState<Record<string, boolean>>({})

  const handleDelete = useCallback(async (ip: string) => {
    setConfirmIp(null)
    try { await deleteServer(instanceId, ip); onRefresh() } catch {}
  }, [instanceId, onRefresh])

  const handleAdd = useCallback(async () => {
    if (!addName || !addIp) return
    setAdding(true)
    try { await addServer(instanceId, addName, addIp); onRefresh(); setShowAdd(false); setAddName(''); setAddIp('') } catch {}
    setAdding(false)
  }, [instanceId, addName, addIp, onRefresh])

  const handleCopyIp = useCallback(async (ip: string) => {
    try { await navigator.clipboard.writeText(ip) } catch {}
  }, [])

  const handlePing = useCallback(async (address: string) => {
    setPinging(p => ({ ...p, [address]: true }))
    try {
      const state = await pingServer(instanceId, address)
      setPingStates(p => ({ ...p, [address]: state }))
    } catch {}
    setPinging(p => ({ ...p, [address]: false }))
  }, [instanceId])

  return (
    <>
      <Card>
        <CardContent className="p-5">
          <div className="mb-3 flex items-center justify-between">
            <h3 className="text-sm font-medium"><FontAwesomeIcon icon={faGlobe} className="mr-2 h-4 w-4 text-primary" />服务器</h3>
            <Button size="sm" onClick={() => setShowAdd(true)} className="gap-1.5 h-7 text-xs">
              <FontAwesomeIcon icon={faPlus} className="h-3.5 w-3.5" />添加服务器
            </Button>
          </div>
          {loading ? (
            <div className="flex items-center justify-center gap-2 py-8 text-sm text-muted-foreground">
              <FontAwesomeIcon icon={faRotate} className="h-4 w-4 animate-spin" />加载中...
            </div>
          ) : !servers || servers.length === 0 ? (
            <div className="py-8 text-center text-sm text-muted-foreground">暂无服务器</div>
          ) : (
            <div className="space-y-1">
              {servers.map((s, i) => {
                const ps = pingStates[s.ip]
                return (
                  <div key={i} className="flex items-center gap-2 rounded-lg px-3 py-2 text-sm transition-colors hover:bg-accent group">
                    <FontAwesomeIcon icon={faServer} className="h-4 w-4 shrink-0 text-muted-foreground" />
                    <div className="flex-1 truncate min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="font-medium">{s.name}</span>
                        {ps && <span className={`text-xs font-medium ${ps.isOnline ? 'text-green-500' : 'text-red-500'}`}>
                          {ps.isOnline ? `${ps.ping}ms` : '离线'}
                        </span>}
                      </div>
                      <span className="text-xs text-muted-foreground">{s.ip}</span>
                    </div>
                    <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
                      <Tooltip content="测速">
                        <button onClick={() => handlePing(s.ip)} disabled={pinging[s.ip]} className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground">
                          <FontAwesomeIcon icon={pinging[s.ip] ? faRotate : faWifi} className={`h-3.5 w-3.5 ${pinging[s.ip] ? 'animate-spin' : ''}`} />
                        </button>
                      </Tooltip>
                      <Tooltip content="复制 IP"><button onClick={() => handleCopyIp(s.ip)} className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"><FontAwesomeIcon icon={faClipboard} className="h-3.5 w-3.5" /></button></Tooltip>
                      <Tooltip content="删除"><button onClick={() => setConfirmIp(s.ip)} className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-destructive/10 hover:text-destructive"><FontAwesomeIcon icon={faTrashCan} className="h-3.5 w-3.5" /></button></Tooltip>
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </CardContent>
      </Card>
      <ConfirmDialog open={confirmIp !== null} title="删除服务器" message={`确定要删除服务器「${confirmIp}」吗？`} onConfirm={() => confirmIp && handleDelete(confirmIp)} onCancel={() => setConfirmIp(null)} />
      <Dialog open={showAdd} onClose={() => setShowAdd(false)}>
        <DialogHeader onClose={() => setShowAdd(false)}><DialogTitle>添加服务器</DialogTitle></DialogHeader>
        <DialogBody className="space-y-3">
          <div className="space-y-1.5">
            <Label className="text-xs">服务器名称</Label>
            <Input value={addName} onChange={(e) => setAddName(e.target.value)} placeholder="My Server" />
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">服务器地址</Label>
            <Input value={addIp} onChange={(e) => setAddIp(e.target.value)} placeholder="example.com:25565" />
          </div>
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" size="sm" onClick={() => setShowAdd(false)}>取消</Button>
          <Button size="sm" onClick={handleAdd} disabled={adding || !addName || !addIp}>{adding ? '添加中...' : '添加'}</Button>
        </DialogFooter>
      </Dialog>
    </>
  )
}

export default function InstanceDetailPage() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const [tab, setTab] = useState<TabId>('overview')
  const [instance, setInstance] = useState<GameInstance | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [runtimes, setRuntimes] = useState<JavaRuntime[]>(() => getRuntimes())
  const [accounts, setAccounts] = useState<Account[]>([])
  const [form, setForm] = useState<GameInstance | null>(null)
  const [sysInfo, setSysInfo] = useState<SystemInfo | null>(null)
  const [memoryMode, setMemoryMode] = useState<'auto' | 'custom'>('auto')
  const [fileData, setFileData] = useState<Record<string, FileEntry[] | ServerEntry[] | null>>({})
  const [fileLoading, setFileLoading] = useState<Record<string, boolean>>({})
  const [isDefault, setIsDefault] = useState(false)
  const [verifying, setVerifying] = useState(false)
  const [verifyResult, setVerifyResult] = useState<{ complete: boolean; missingFiles: MissingFile[] } | null>(null)
  const [repairing, setRepairing] = useState(false)
  const [repairProgress, setRepairProgress] = useState(0)

  useEffect(() => {
    const unsub = subscribe(() => setRuntimes([...getRuntimes()]))
    return unsub
  }, [])

  useEffect(() => {
    if (!id) return
    let cancelled = false
    async function load() {
      setLoading(true)
      try {
        const [inst, accts, sys, def] = await Promise.all([getInstance(id!), getAccounts(), getSystemInfo(), getDefaultInstance()])
        if (cancelled) return
        setInstance(inst)
        setForm({ ...inst })
        setRuntimes([...getRuntimes()])
        setAccounts(accts)
        setSysInfo(sys)
        setIsDefault(def?.id === id)
        setMemoryMode(sys ? 'auto' : 'custom')
      } catch { if (!cancelled) navigate('/instances') }
      if (!cancelled) setLoading(false)
      loadCustomRuntimes().catch(() => {})
      if (!hasAnyRuntimes()) {
        scanRuntimes('quick').catch(() => {})
      }
    }
    load()
    return () => { cancelled = true }
  }, [id, navigate])

  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const doSave = useCallback(async (formToSave: GameInstance) => {
    if (!id) return
    setSaving(true)
    try {
      const updated = await updateInstance(id, {
        name: formToSave.name,
        gameVersion: formToSave.gameVersion,
        loader: formToSave.loader || undefined,
        loaderVersion: formToSave.loaderVersion || undefined,
        javaPath: formToSave.javaPath,
        maxMemory: formToSave.maxMemory,
        gameDir: formToSave.gameDir,
        accountName: formToSave.accountName || undefined,
        accountUuid: formToSave.accountUuid || undefined,
        accessToken: formToSave.accessToken || undefined,
        jvmArgs: formToSave.jvmArgs || undefined,
        versionIsolation: formToSave.versionIsolation,
        icon: formToSave.icon || undefined,
      })
      setInstance(updated)
    } catch {}
    setSaving(false)
  }, [id])

  const debouncedSave = useCallback((formToSave: GameInstance) => {
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
    saveTimerRef.current = setTimeout(() => doSave(formToSave), 800)
  }, [doSave])

  useEffect(() => () => { if (saveTimerRef.current) clearTimeout(saveTimerRef.current) }, [])

  const [launchError, setLaunchError] = useState<{ title: string; message: string; detail?: string | null; args?: string | null } | null>(null)

  const handleLaunch = useCallback(async () => {
    if (!id) return
    try {
      const result = await launchInstance(id)
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
  }, [id])

  const handleVerifyResources = useCallback(async () => {
    if (!id) return
    setVerifying(true)
    setVerifyResult(null)
    try {
      const result = await verifyResources(id)
      setVerifyResult({ complete: result.complete, missingFiles: result.missingFiles })
      if (!result.complete && result.missingFiles.length > 0) {
        await handleRepairResources()
      }
    } catch {
      setVerifyResult({ complete: true, missingFiles: [] })
    } finally {
      setVerifying(false)
    }
  }, [id])

  const handleRepairResources = useCallback(async () => {
    if (!id) return
    setRepairing(true)
    setRepairProgress(0)
    try {
      await repairResources(id)
      const poll = setInterval(async () => {
        try {
          const progress = await getInstallProgress(id)
          if (progress.status === 'completed') {
            setRepairProgress(100)
            clearInterval(poll)
            setRepairing(false)
            setVerifyResult(null)
          } else if (progress.status === 'failed') {
            clearInterval(poll)
            setRepairing(false)
          } else {
            setRepairProgress(Math.round(progress.progress))
          }
        } catch {
          clearInterval(poll)
          setRepairing(false)
        }
      }, 1000)
    } catch {
      setRepairing(false)
    }
  }, [id])

  const handleDelete = useCallback(async () => {
    if (!id || !instance) return
    try {
      await deleteInstance(id)
      navigate('/instances')
    } catch {}
  }, [id, instance, navigate])

  const toggleDefault = useCallback(async () => {
    if (!id) return
    try {
      if (isDefault) {
        await clearDefaultInstance(id)
        setIsDefault(false)
      } else {
        await setDefaultInstance(id)
        setIsDefault(true)
      }
    } catch {}
  }, [id, isDefault])

  const loadFiles = useCallback((t: string) => {
    if (!id) return
    const loaders: Record<string, (id: string) => Promise<FileEntry[] | ServerEntry[]>> = {
      saves: getSaves, screenshots: getScreenshots,
      resourcepacks: getResourcePacks, shaderpacks: getShaderPacks, servers: getServers,
    }
    const fn = loaders[t]
    if (!fn) return
    setFileLoading((f) => ({ ...f, [t]: true }))
    fn(id).then((data) => {
      setFileData((f) => ({ ...f, [t]: data }))
    }).catch(() => {
      setFileData((f) => ({ ...f, [t]: [] }))
    }).finally(() => {
      setFileLoading((f) => ({ ...f, [t]: false }))
    })
  }, [id])

  // load on tab change
  useEffect(() => {
    if (!id || tab === 'overview' || tab === 'settings') return
    loadFiles(tab)
  }, [id, tab, loadFiles])

  const update = useCallback((field: string, value: unknown) => {
    setForm((f) => {
      if (!f) return f
      const next = { ...f, [field]: value }
      debouncedSave(next)
      return next
    })
  }, [])

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center p-8">
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <FontAwesomeIcon icon={faRotate} className="h-4 w-4 animate-spin" />加载实例...
        </div>
      </div>
    )
  }

  if (!instance || !form) {
    return (
      <div className="p-8">
        <Button variant="ghost" onClick={() => navigate('/instances')} className="gap-2">
          <FontAwesomeIcon icon={faArrowLeft} className="h-4 w-4" />返回实例列表
        </Button>
        <p className="mt-4 text-sm text-muted-foreground text-center">实例不存在</p>
      </div>
    )
  }

  return (
    <div className="animate-in slide-up space-y-6 p-8">
      <div className="flex items-center gap-3">
        <Button variant="ghost" size="icon" onClick={() => navigate('/instances')}>
          <FontAwesomeIcon icon={faArrowLeft} className="h-4 w-4" />
        </Button>
        <InstanceIcon icon={instance.icon} loader={instance.loader} className="h-10 w-10 shrink-0 rounded-lg" imgClassName="rounded-lg" />
        <div className="flex-1">
          <h1 className="text-2xl font-semibold tracking-tight">{instance.name}</h1>
          <p className="text-xs text-muted-foreground">
            {instance.gameVersion}
            {instance.loader && ` · ${instance.loader} ${instance.loaderVersion || ''}`}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button onClick={handleLaunch} className="gap-2">
            <FontAwesomeIcon icon={faPlay} className="h-3.5 w-3.5" />启动
          </Button>
          <Tooltip content={isDefault ? '取消固定' : '固定到主页'}>
            <Button variant="outline" size="icon" onClick={toggleDefault}>
              <FontAwesomeIcon icon={faStar} className={cn('h-4 w-4', isDefault && 'text-yellow-400')} />
            </Button>
          </Tooltip>
          <Button variant="outline" size="icon" onClick={() => openPath(instance.gameDir).catch(() => {})}>
            <FontAwesomeIcon icon={faFolderOpen} className="h-4 w-4" />
          </Button>
        </div>
      </div>

      <div className="flex gap-4">
        <div className="flex w-44 shrink-0 flex-col gap-0.5">
          {TABS.map((t) => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={cn(
                'flex items-center gap-2.5 rounded-lg px-3.5 py-2.5 text-left text-sm transition-colors',
                tab === t.id ? 'bg-primary/10 font-medium text-primary' : 'text-muted-foreground hover:bg-accent hover:text-foreground'
              )}
            >
              <FontAwesomeIcon icon={t.icon} className="h-4 w-4" />
              {t.label}
            </button>
          ))}
        </div>

        <div className="flex-1 min-w-0">
          {tab === 'overview' && (
            <div className="space-y-4">
              <Card>
                <CardContent className="p-5 space-y-4">
                  <div className="grid grid-cols-2 gap-4 text-sm">
                    <div>
                      <p className="text-xs text-muted-foreground">游戏版本</p>
                      <p className="font-medium">{instance.gameVersion}</p>
                    </div>
                    <div>
                      <p className="text-xs text-muted-foreground">加载器</p>
                      {instance.loader ? (
                        <span className={cn('inline-flex items-center rounded border px-2 py-0.5 text-xs font-medium mt-0.5', LOADER_COLORS[instance.loader.toLowerCase()] ?? 'bg-muted text-muted-foreground border-border')}>
                          {instance.loader} {instance.loaderVersion}
                        </span>
                      ) : <p className="font-medium text-muted-foreground">纯净原版</p>}
                    </div>
                    <div>
                      <p className="text-xs text-muted-foreground">最后游玩</p>
                      <p className="font-medium">{formatDate(instance.lastPlayed)}</p>
                    </div>
                    <div>
                      <p className="text-xs text-muted-foreground">累计游玩</p>
                      <p className="font-medium">{formatPlayTime(instance.playTime)}</p>
                    </div>
                  </div>
                </CardContent>
              </Card>

              <Card>
                <CardContent className="p-5 space-y-3">
                  <h3 className="text-sm font-medium">快速操作</h3>
                  <div className="flex flex-wrap gap-2">
                    <Button size="sm" onClick={handleLaunch} className="gap-2">
                      <FontAwesomeIcon icon={faPlay} className="h-3.5 w-3.5" />启动游戏
                    </Button>
                    <Button size="sm" variant="outline" onClick={() => setTab('settings')} className="gap-2">
                      <FontAwesomeIcon icon={faGear} className="h-3.5 w-3.5" />实例设置
                    </Button>
                    <Button size="sm" variant="outline" onClick={handleVerifyResources} disabled={verifying || repairing} className="gap-2">
                      <FontAwesomeIcon icon={faRotate} className={cn('h-3.5 w-3.5', verifying && 'animate-spin')} />检查资源完整性
                    </Button>
                    {repairing && (
                      <span className="self-center text-xs text-muted-foreground">正在补全 {repairProgress}%</span>
                    )}
                    <Button size="sm" variant="outline" className="gap-2" onClick={() => openPath(instance.gameDir).catch(() => {})}>
                      <FontAwesomeIcon icon={faFolderOpen} className="h-3.5 w-3.5" />打开游戏目录
                    </Button>
                    <Button size="sm" variant="outline" className="gap-2 text-destructive hover:text-destructive" onClick={handleDelete}>
                      <FontAwesomeIcon icon={faTrashCan} className="h-3.5 w-3.5" />删除实例
                    </Button>
                  </div>
                </CardContent>
              </Card>
            </div>
          )}

          {tab === 'settings' && (
            <Card>
              <CardContent className="p-5 space-y-5">
                <div className="space-y-2">
                  <Label>实例名称</Label>
                  <Input value={form.name} onChange={(e) => update('name', e.target.value)} />
                </div>

                <div className="space-y-2">
                  <Label>实例图标</Label>
                  <div className="grid grid-cols-8 gap-2">
                    {ICON_NAMES.map((name) => (
                      <button
                        key={name}
                        onClick={async () => {
                          if (!id) return
                          update('icon', name)
                          const updated = await updateInstance(id, { icon: name })
                          setInstance(updated)
                        }}
                        className="flex items-center justify-center rounded-lg border border-transparent p-1 transition-colors hover:border-muted-foreground/30"
                      >
                        <InstanceIcon icon={name} className="h-8 w-8" />
                      </button>
                    ))}
                  </div>
                </div>

                <div className="space-y-2">
                  <Label>游戏版本</Label>
                  <Input value={form.gameVersion} disabled className="text-muted-foreground" />
                </div>

                <div className="space-y-2">
                  <Label>Java 运行时</Label>
                  <Select value={form.javaPath ?? ''} onChange={(v) => update('javaPath', v || null)}>
                    <SelectOption value="">自动选择</SelectOption>
                    {runtimes.filter((j) => j.state === 'Valid').map((j, i) => (
                      <SelectOption key={i} value={j.path}>{j.name} - {j.version} ({j.arch})</SelectOption>
                    ))}
                  </Select>
                </div>

                <div className="space-y-2">
                  <Label>资源完整性</Label>
                  <div className="flex items-center gap-2">
                    <Button size="sm" variant="outline" onClick={handleVerifyResources} disabled={verifying || repairing}>
                      <FontAwesomeIcon icon={faRotate} className={cn('h-4 w-4', verifying && 'animate-spin')} />
                      检查资源完整性
                    </Button>
                    {repairing && (
                      <span className="text-sm text-muted-foreground">正在补全 {repairProgress}%</span>
                    )}
                  </div>
                  {verifyResult && !verifyResult.complete && (
                    <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-3">
                      <p className="text-sm font-medium text-destructive">缺失 {verifyResult.missingFiles.length} 个文件</p>
                      <ul className="mt-2 max-h-40 space-y-1 overflow-y-auto text-xs text-muted-foreground">
                        {verifyResult.missingFiles.map((f, i) => (
                          <li key={i} className="truncate" title={f.url}>{f.name} — {f.url}</li>
                        ))}
                      </ul>
                      <p className="mt-2 text-xs text-muted-foreground">正在自动补全...</p>
                    </div>
                  )}
                  {verifyResult && verifyResult.complete && (
                    <p className="text-xs text-muted-foreground">资源完整</p>
                  )}
                </div>

                <div className="space-y-2">
                  <Label>版本隔离</Label>
                  <Select
                    value={form.versionIsolation === null ? 'global' : form.versionIsolation ? 'on' : 'off'}
                    onChange={(v) => update('versionIsolation', v === 'global' ? null : v === 'on')}
                  >
                    <SelectOption value="global">跟随全局设置</SelectOption>
                    <SelectOption value="on">开启</SelectOption>
                    <SelectOption value="off">关闭</SelectOption>
                  </Select>
                  <p className="text-xs text-muted-foreground">每个版本使用独立的 mods/config/saves 目录</p>
                </div>

                <div className="space-y-2">
                  <Label>内存分配</Label>
                  <div className="flex items-center gap-2">
                    <button onClick={() => {
                      setMemoryMode('auto')
                      if (sysInfo) update('maxMemory', Math.max(512, Math.floor(sysInfo.availableMemory * 0.7)))
                    }} className={cn('h-9 rounded-lg border px-3.5 text-sm transition-colors', memoryMode === 'auto' ? 'border-primary bg-primary/10 font-medium text-primary' : 'border-border hover:border-muted-foreground/30')}>
                      <FontAwesomeIcon icon={faRobot} className="mr-1.5 h-3.5 w-3.5" />自动
                    </button>
                    <button onClick={() => setMemoryMode('custom')} className={cn('h-9 rounded-lg border px-3.5 text-sm transition-colors', memoryMode === 'custom' ? 'border-primary bg-primary/10 font-medium text-primary' : 'border-border hover:border-muted-foreground/30')}>
                      <FontAwesomeIcon icon={faSliders} className="mr-1.5 h-3.5 w-3.5" />自定义
                    </button>
                  </div>

                  <div className="flex items-center gap-3 py-1">
                    <input
                      type="range"
                      min={512}
                      max={sysInfo ? Math.max(512, Math.floor(sysInfo.availableMemory)) : 16384}
                      step={256}
                      value={form.maxMemory}
                      disabled={memoryMode === 'auto'}
                      onChange={(e) => update('maxMemory', parseInt(e.target.value))}
                      className={cn('flex-1', memoryMode === 'auto' && 'pointer-events-none opacity-60')}
                    />
                    <span className="w-28 shrink-0 text-right text-sm tabular-nums text-muted-foreground">
                      {form.maxMemory >= 1024 ? `${(form.maxMemory / 1024).toFixed(1)} GiB` : `${form.maxMemory} MiB`}
                    </span>
                  </div>

                  {sysInfo && (() => {
                    const totalMb = sysInfo.memory
                    const availMb = sysInfo.availableMemory
                    const usedMb = Math.max(0, totalMb - availMb)
                    const gameMb = Math.min(form.maxMemory, availMb)
                    const usedPct = (usedMb / totalMb) * 100
                    const gamePct = (gameMb / totalMb) * 100
                    return (
                      <div className="space-y-1">
                        <div className="flex h-2 overflow-hidden rounded-full bg-muted">
                          <div className="rounded-l-full bg-primary/30 transition-all" style={{ width: `${usedPct}%` }} />
                          <div className="bg-primary transition-all" style={{ width: `${gamePct}%` }} />
                        </div>
                        <div className="flex justify-between text-[11px] text-muted-foreground">
                          <span>总内存 {(totalMb / 1024).toFixed(1)} GiB</span>
                          <span>已使用 {(usedMb / 1024).toFixed(1)} GiB</span>
                          <span>游戏分配 {(gameMb / 1024).toFixed(1)} GiB</span>
                          <span>剩余 {((availMb - gameMb) / 1024).toFixed(1)} GiB</span>
                        </div>
                      </div>
                    )
                  })()}
                </div>

                <div className="space-y-2">
                  <Label>JVM 参数</Label>
                  <textarea
                    value={form.jvmArgs ?? ''}
                    onChange={(e) => update('jvmArgs', e.target.value)}
                    placeholder="-Xmx2G -XX:+UseG1GC"
                    rows={3}
                    className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring resize-none"
                  />
                </div>

                <div className="space-y-2">
                  <Label>关联账号</Label>
                  <Select value={form.accountUuid ?? ''} onChange={(v) => {
                    const acc = accounts.find((a) => a.uuid === v)
                    update('accountUuid', v || null)
                    update('accountName', acc?.name || null)
                    update('accessToken', acc?.accessToken || null)
                  }}>
                    <SelectOption value="">未关联</SelectOption>
                    {accounts.map((a) => (
                      <SelectOption key={a.uuid} value={a.uuid}>{a.name}</SelectOption>
                    ))}
                  </Select>
                </div>

                {saving && (
                  <div className="flex justify-end pt-2">
                    <span className="text-xs text-muted-foreground">保存中...</span>
                  </div>
                )}
              </CardContent>
            </Card>
          )}

          {tab === 'saves' && <SavesTab instanceId={id!} files={fileData['saves'] as FileEntry[] | null} loading={fileLoading['saves']} onRefresh={() => loadFiles('saves')} />}
          {tab === 'screenshots' && <ScreenshotsTab instanceId={id!} files={fileData['screenshots'] as FileEntry[] | null} loading={fileLoading['screenshots']} onRefresh={() => loadFiles('screenshots')} />}
          {tab === 'mods' && <ModsTab instanceId={id!} gameVersion={instance.gameVersion} loader={instance.loader || undefined} gameDir={instance.gameDir} />}
          {tab === 'resourcepacks' && <GenericFileTab instanceId={id!} type="resourcepacks" icon={faBox} label="资源包" files={fileData['resourcepacks'] as FileEntry[] | null} loading={fileLoading['resourcepacks']} onRefresh={() => loadFiles('resourcepacks')} showSize emptyText="暂无资源包" />}
          {tab === 'shaderpacks' && <GenericFileTab instanceId={id!} type="shaderpacks" icon={faSun} label="光影包" files={fileData['shaderpacks'] as FileEntry[] | null} loading={fileLoading['shaderpacks']} onRefresh={() => loadFiles('shaderpacks')} showSize emptyText="暂无光影包" />}
          {tab === 'servers' && <ServersTab instanceId={id!} servers={fileData['servers'] as ServerEntry[] | null} loading={fileLoading['servers']} onRefresh={() => loadFiles('servers')} />}
        </div>
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
