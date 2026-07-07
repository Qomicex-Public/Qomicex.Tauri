import { useEffect, useState, useCallback, useMemo, useRef } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import { faArrowLeft, faInfoCircle, faSliders, faSave, faCamera, faCube, faBox, faSun, faServer, faPlay, faFolderOpen, faGear, faTrashCan, faRotate, faRobot, faGlobe, faPlus, faMagnifyingGlass, faDownload, faClipboard, faStar, faWifi, faDatabase, faGamepad, faUser, faPen, faList, faGrip } from '@fortawesome/free-solid-svg-icons'
import { Button } from '../components/ui/button.tsx'
import { Card, CardContent } from '../components/ui/card.tsx'
import { Separator } from '../components/ui/separator.tsx'
import { Input } from '../components/ui/input.tsx'
import { Label } from '../components/ui/label.tsx'
import { Checkbox } from '../components/ui/checkbox.tsx'
import { Select, SelectOption } from '../components/ui/select.tsx'
import { Tooltip } from '../components/ui/tooltip.tsx'
import { Dialog, DialogHeader, DialogTitle, DialogBody, DialogFooter } from '../components/ui/dialog.tsx'
import { cn } from '../lib/utils.ts'
import { cacheGet, cacheSet, cacheFresh, cacheInvalidate } from '../lib/simple-cache.ts'
import { useMessageBox } from '../components/ui/message-box.tsx'
import { getInstance, updateInstance, launchInstance, deleteInstance, setDefaultInstance, clearDefaultInstance, getDefaultInstance, verifyResources, repairResources, getInstallProgress, getGameSettings, setGameSetting, getLaunchProgress } from '../api/instance.ts'
import { openFolder } from '../api/settings.ts'
import { getRuntimes, scanRuntimes, loadCustomRuntimes, hasAnyRuntimes, subscribe } from '../stores/javaStore.ts'
import { getAccounts } from '../api/account.ts'
import { getSystemInfo } from '../api/system.ts'
import type { GameInstance, JavaRuntime, Account, SystemInfo, ServerEntry, ServerState, LanGameEntry, MissingFile, GameSettingDto, LaunchProgress } from '../types/index.ts'
import { getServers, addServer, deleteServer, pingServer, getLanGames, getModsMetadata, getModsCount, getModsProgress, batchEnableMods, batchDisableMods, batchDeleteMods, getResourcePacksMetadata, getShadersMetadata, getSavesMetadata, getScreenshotsMetadata, getDataPacksMetadata } from '../api/instance-files.ts'
import { ContextMenu, type ContextMenuItem } from '../components/ContextMenu.tsx'
import { ErrorReportDialog } from '../components/ErrorReportDialog.tsx'
import { MicrosoftReauthDialog } from '../components/MicrosoftReauthDialog.tsx'
import { ApiError } from '../api/client.ts'
import { AccountSelectDialog } from '../components/AccountSelectDialog.tsx'
import { NoAccountDialog } from '../components/NoAccountDialog.tsx'
import { InstanceIcon, ICON_NAMES } from '../components/InstanceIcon.tsx'
import ModCard from '../components/ModCard.tsx'
import VersionPickerDialog from '../components/VersionPickerDialog.tsx'
import type { ModMetadata, ResourcePackMetadata, ShaderMetadata, SaveMetadata, ScreenshotMetadata, DataPackMetadata } from '../types/index.ts'
import ResourcePackCard from '../components/ResourcePackCard.tsx'
import ShaderCard from '../components/ShaderCard.tsx'
import SaveCard from '../components/SaveCard.tsx'
import ScreenshotCard from '../components/ScreenshotCard.tsx'
import DataPackCard from '../components/DataPackCard.tsx'
import { useRequireDefaultAccount } from '../hooks/useRequireDefaultAccount.ts'
import { useDebug } from '../components/DebugContext.tsx'

const LOADER_COLORS: Record<string, string> = {
  forge: 'bg-orange-500/10 text-orange-500 border-orange-500/25',
  fabric: 'bg-cyan-500/10 text-cyan-400 border-cyan-400/25',
  neoforge: 'bg-green-500/10 text-green-500 border-green-500/25',
  quilt: 'bg-purple-500/10 text-purple-400 border-purple-400/25',
}

const TABS = [
  { id: 'overview', label: '概况', icon: faInfoCircle },
  { id: 'settings', label: '设置', icon: faSliders },
  { id: 'gamesettings', label: '游戏设置', icon: faGamepad },
  { id: 'saves', label: '存档', icon: faSave },
  { id: 'screenshots', label: '截图', icon: faCamera },
  { id: 'mods', label: 'Mod', icon: faCube },
  { id: 'resourcepacks', label: '资源包', icon: faBox },
  { id: 'shaderpacks', label: '光影包', icon: faSun },
  { id: 'datapacks', label: '数据包', icon: faDatabase },
  { id: 'servers', label: '服务器', icon: faServer },
] as const

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

function SavesTab({ instanceId, gameDir, refreshKey, onRefresh }: { instanceId: string; gameDir: string; refreshKey: number; onRefresh: () => void }) {
  const [search, setSearch] = useState('')
  const [saves, setSaves] = useState<SaveMetadata[]>([])
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    setLoading(true)
    try { const data = await getSavesMetadata(instanceId); setSaves(data) }
    catch { setSaves([]) }
    setLoading(false)
  }, [instanceId])

  useEffect(() => { load() }, [load, refreshKey])

  const filtered = useMemo(() => {
    if (!search) return saves
    const q = search.toLowerCase()
    return saves.filter(s => s.name.toLowerCase().includes(q))
  }, [saves, search])

  return (
    <Card>
      <CardContent className="p-5">
        <div className="mb-3 flex items-center justify-between gap-3">
          <h3 className="text-sm font-medium shrink-0">
            <FontAwesomeIcon icon={faSave} className="mr-2 h-4 w-4 text-primary" />存档
            {saves.length > 0 && <span className="ml-1.5 text-xs font-normal text-muted-foreground">({saves.length})</span>}
          </h3>
          <div className="flex items-center gap-2 flex-1 max-w-sm">
            <div className="relative flex-1">
              <FontAwesomeIcon icon={faMagnifyingGlass} className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="搜索存档..." className="h-8 pl-8 text-xs" />
            </div>
            <Tooltip content="刷新">
              <Button size="sm" variant="ghost" onClick={onRefresh} className="h-7 w-7 px-0">
                <FontAwesomeIcon icon={faRotate} className="h-3.5 w-3.5" />
              </Button>
            </Tooltip>
            <Button size="sm" variant="ghost" onClick={() => openFolder(gameDir + '/saves').catch(() => {})} className="gap-1.5 h-7 text-xs">
              <FontAwesomeIcon icon={faFolderOpen} className="h-3.5 w-3.5" />打开文件夹
            </Button>
          </div>
        </div>
        {loading ? (
          <div className="flex items-center justify-center gap-2 py-8 text-sm text-muted-foreground">
            <FontAwesomeIcon icon={faRotate} className="h-4 w-4 animate-spin" />加载中...
          </div>
        ) : filtered.length === 0 ? (
          <div className="py-8 text-center text-sm text-muted-foreground">
            {search ? '无匹配存档' : '暂无存档'}
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            {filtered.map((save) => (
              <SaveCard key={save.filePath} save={save} instanceId={instanceId} onRefresh={load} />
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  )
}

function ScreenshotsTab({ instanceId, gameDir, refreshKey, onRefresh }: { instanceId: string; gameDir: string; refreshKey: number; onRefresh: () => void }) {
  const [search, setSearch] = useState('')
  const [screenshots, setScreenshots] = useState<ScreenshotMetadata[]>([])
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    setLoading(true)
    try { const data = await getScreenshotsMetadata(instanceId); setScreenshots(data) }
    catch { setScreenshots([]) }
    setLoading(false)
  }, [instanceId])

  useEffect(() => { load() }, [load, refreshKey])

  const filtered = useMemo(() => {
    if (!search) return screenshots
    const q = search.toLowerCase()
    return screenshots.filter(s => s.fileName.toLowerCase().includes(q))
  }, [screenshots, search])

  return (
    <Card>
      <CardContent className="p-5">
        <div className="mb-3 flex items-center justify-between gap-3">
          <h3 className="text-sm font-medium shrink-0">
            <FontAwesomeIcon icon={faCamera} className="mr-2 h-4 w-4 text-primary" />截图
            {screenshots.length > 0 && <span className="ml-1.5 text-xs font-normal text-muted-foreground">({screenshots.length})</span>}
          </h3>
          <div className="flex items-center gap-2 flex-1 max-w-sm">
            <div className="relative flex-1">
              <FontAwesomeIcon icon={faMagnifyingGlass} className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="搜索截图..." className="h-8 pl-8 text-xs" />
            </div>
            <Tooltip content="刷新">
              <Button size="sm" variant="ghost" onClick={onRefresh} className="h-7 w-7 px-0">
                <FontAwesomeIcon icon={faRotate} className="h-3.5 w-3.5" />
              </Button>
            </Tooltip>
            <Button size="sm" variant="ghost" onClick={() => openFolder(gameDir + '/screenshots').catch(() => {})} className="gap-1.5 h-7 text-xs">
              <FontAwesomeIcon icon={faFolderOpen} className="h-3.5 w-3.5" />打开文件夹
            </Button>
          </div>
        </div>
        {loading ? (
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
            {Array.from({ length: 6 }).map((_, i) => (
              <div key={i} className="animate-pulse rounded-xl border bg-card overflow-hidden">
                <div className="aspect-video bg-muted" />
                <div className="p-3 space-y-2">
                  <div className="h-3 w-2/3 rounded bg-muted" />
                  <div className="h-2.5 w-1/3 rounded bg-muted" />
                </div>
              </div>
            ))}
          </div>
        ) : filtered.length === 0 ? (
          <div className="py-8 text-center text-sm text-muted-foreground">
            {search ? '无匹配截图' : '暂无截图'}
          </div>
        ) : (
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
            {filtered.map((s) => (
              <ScreenshotCard key={s.filePath} screenshot={s} instanceId={instanceId} onRefresh={load} />
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  )
}

function ModsTab({ instanceId, gameVersion, loader, gameDir, refreshKey, onRefresh }: {
  instanceId: string
  gameVersion?: string
  loader?: string
  gameDir: string
  refreshKey: number
  onRefresh: () => void
}) {
  const navigate = useNavigate()
  const [search, setSearch] = useState('')
  const [mods, setMods] = useState<ModMetadata[]>([])
  const [loading, setLoading] = useState(true)
  const [loadProgress, setLoadProgress] = useState<{ current: number; total: number } | null>(null)
  const [versionDialogMod, setVersionDialogMod] = useState<ModMetadata | null>(null)

  const [batchMode, setBatchMode] = useState(false)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [batchConfirm, setBatchConfirm] = useState<{ type: 'enable' | 'disable' | 'delete' } | null>(null)
  const [batchProcessing, setBatchProcessing] = useState(false)

  const loadMods = useCallback(async () => {
    const cacheKey = `api-instance-${instanceId}-mods`
    const fresh = cacheFresh<ModMetadata[]>(cacheKey)
    if (fresh) { setMods(fresh); setLoading(false); return }
    const stale = cacheGet<ModMetadata[]>(cacheKey)
    if (stale) { setMods(stale); setLoading(false) }
    setLoading(true)
    setLoadProgress(null)
    try {
      getModsCount(instanceId).then(count => setLoadProgress({ current: 0, total: count })).catch(() => {})
      const pollId = setInterval(async () => {
        try {
          const p = await getModsProgress(instanceId)
          if (p) setLoadProgress(p)
        } catch {}
      }, 300)
      const data = await getModsMetadata(instanceId)
      clearInterval(pollId)
      setLoadProgress(null)
      setMods(data)
      cacheSet(cacheKey, data)
    } catch (e) { console.error('Load mods failed:', e); setMods([]) }
    setLoading(false)
  }, [instanceId])

  const toggleModLocal = useCallback((fileName: string) => {
    setMods(prev => prev.map(m => {
      if (m.fileName !== fileName) return m
      if (m.active) {
        return { ...m, fileName: m.fileName + '.disabled', active: false }
      } else {
        const newName = m.fileName.endsWith('.disabled') ? m.fileName.slice(0, -9) : m.fileName
        return { ...m, fileName: newName, active: true }
      }
    }))
  }, [])

  useEffect(() => {
    loadMods()
  }, [loadMods, refreshKey])

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
      cacheInvalidate(`api-instance-${instanceId}-mods`)
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
                  <Tooltip content="刷新">
                    <Button size="sm" variant="ghost" onClick={onRefresh} className="h-7 w-7 px-0">
                      <FontAwesomeIcon icon={faRotate} className="h-3.5 w-3.5" />
                    </Button>
                  </Tooltip>
                  <Button size="sm" variant="ghost" onClick={() => openFolder(gameDir + '/mods').catch(() => {})} className="gap-1.5 h-7 text-xs">
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
            <div className="space-y-3">
              {loadProgress && loadProgress.total > 0 && (
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  <FontAwesomeIcon icon={faRotate} className="h-3 w-3 animate-spin" />
                  加载中 {loadProgress.current}/{loadProgress.total}
                </div>
              )}
              <div className="flex flex-col gap-2">
                {Array.from({ length: 4 }).map((_, i) => (
                  <div key={i} className="animate-pulse flex items-center gap-3 rounded-xl border p-4">
                    <div className="h-10 w-10 shrink-0 rounded-lg bg-muted" />
                    <div className="flex-1 space-y-2">
                      <div className="h-4 w-2/5 rounded bg-muted" />
                      <div className="h-3 w-3/5 rounded bg-muted" />
                    </div>
                    <div className="flex gap-1.5">
                      <div className="h-6 w-14 rounded bg-muted" />
                      <div className="h-6 w-14 rounded bg-muted" />
                    </div>
                  </div>
                ))}
              </div>
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
                  onToggle={toggleModLocal}
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

function ResourcePacksTab({ instanceId, gameDir, refreshKey, onRefresh }: { instanceId: string; gameDir: string; refreshKey: number; onRefresh: () => void }) {
  const [search, setSearch] = useState('')
  const [packs, setPacks] = useState<ResourcePackMetadata[]>([])
  const [loading, setLoading] = useState(true)
  const [viewMode, setViewMode] = useState<'grid' | 'list'>(
    () => (localStorage.getItem('rp-view-mode') as 'grid' | 'list') || 'grid'
  )
  const { notify } = useMessageBox()

  const toggleView = useCallback(() => {
    setViewMode(prev => {
      const next = prev === 'grid' ? 'list' : 'grid'
      localStorage.setItem('rp-view-mode', next)
      return next
    })
  }, [])

  const load = useCallback(async () => {
    const cacheKey = `api-instance-${instanceId}-resourcepacks`
    const fresh = cacheFresh<ResourcePackMetadata[]>(cacheKey)
    if (fresh) { setPacks(fresh); setLoading(false); return }
    const stale = cacheGet<ResourcePackMetadata[]>(cacheKey)
    if (stale) { setPacks(stale); setLoading(false) }
    setLoading(true)
    try { const data = await getResourcePacksMetadata(instanceId); setPacks(data); cacheSet(cacheKey, data) }
    catch (e) {
      setPacks([])
      notify(`加载资源包失败: ${e instanceof ApiError ? e.displayMessage : '未知错误'}`, 'error')
    }
    setLoading(false)
  }, [instanceId, notify])

  useEffect(() => { load() }, [load, refreshKey])

  const filtered = useMemo(() => {
    if (!search) return packs
    const q = search.toLowerCase()
    return packs.filter(p => p.name.toLowerCase().includes(q) || p.fileName.toLowerCase().includes(q))
  }, [packs, search])

  const handleDelete = useCallback((fileName: string) => {
    setPacks(prev => prev.filter(p => p.fileName !== fileName))
  }, [])

  return (
    <Card>
      <CardContent className="p-5">
        <div className="mb-3 flex items-center justify-between gap-3">
          <h3 className="text-sm font-medium shrink-0">
            <FontAwesomeIcon icon={faBox} className="mr-2 h-4 w-4 text-primary" />资源包
            {packs.length > 0 && <span className="ml-1.5 text-xs font-normal text-muted-foreground">({packs.length})</span>}
          </h3>
          <div className="flex items-center gap-2 flex-1 max-w-sm">
            <div className="relative flex-1">
              <FontAwesomeIcon icon={faMagnifyingGlass} className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="搜索资源包..." className="h-8 pl-8 text-xs" />
            </div>
            <Tooltip content="刷新">
              <Button size="sm" variant="ghost" onClick={onRefresh} className="h-7 w-7 px-0">
                <FontAwesomeIcon icon={faRotate} className="h-3.5 w-3.5" />
              </Button>
            </Tooltip>
            <Button size="sm" variant="ghost" onClick={() => openFolder(gameDir + '/resourcepacks').catch(() => {})} className="gap-1.5 h-7 text-xs">
              <FontAwesomeIcon icon={faFolderOpen} className="h-3.5 w-3.5" />打开文件夹
            </Button>
            <Tooltip content={viewMode === 'grid' ? '切换列表' : '切换网格'}>
              <Button size="sm" variant="ghost" onClick={toggleView} className="h-7 w-7 px-0">
                <FontAwesomeIcon icon={viewMode === 'grid' ? faList : faGrip} className="h-3.5 w-3.5" />
              </Button>
            </Tooltip>
          </div>
        </div>
        {loading ? (
          <div className="flex flex-col gap-2">
            {Array.from({ length: 3 }).map((_, i) => (
              <div key={i} className="animate-pulse flex items-center gap-3 rounded-xl border p-4">
                <div className="h-10 w-10 shrink-0 rounded-lg bg-muted" />
                <div className="flex-1 space-y-2">
                  <div className="h-4 w-1/3 rounded bg-muted" />
                  <div className="h-3 w-1/2 rounded bg-muted" />
                </div>
                <div className="h-6 w-16 rounded bg-muted" />
              </div>
            ))}
          </div>
        ) : filtered.length === 0 ? (
          <div className="py-8 text-center text-sm text-muted-foreground">
            {search ? '无匹配资源包' : '暂无资源包'}
          </div>
        ) : viewMode === 'grid' ? (
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
            {filtered.map((pack) => (
              <ResourcePackCard key={pack.fileName} pack={pack} instanceId={instanceId} gameDir={gameDir} onDelete={handleDelete} compact />
            ))}
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            {filtered.map((pack) => (
              <ResourcePackCard key={pack.fileName} pack={pack} instanceId={instanceId} gameDir={gameDir} onDelete={handleDelete} />
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  )
}

function ShadersTab({ instanceId, gameDir, refreshKey, onRefresh }: { instanceId: string; gameDir: string; refreshKey: number; onRefresh: () => void }) {
  const [search, setSearch] = useState('')
  const [shaders, setShaders] = useState<ShaderMetadata[]>([])
  const [loading, setLoading] = useState(true)
  const [viewMode, setViewMode] = useState<'grid' | 'list'>(
    () => (localStorage.getItem('shader-view-mode') as 'grid' | 'list') || 'grid'
  )
  const { notify } = useMessageBox()

  const toggleView = useCallback(() => {
    setViewMode(prev => {
      const next = prev === 'grid' ? 'list' : 'grid'
      localStorage.setItem('shader-view-mode', next)
      return next
    })
  }, [])

  const load = useCallback(async () => {
    const cacheKey = `api-instance-${instanceId}-shaders`
    const fresh = cacheFresh<ShaderMetadata[]>(cacheKey)
    if (fresh) { setShaders(fresh); setLoading(false); return }
    const stale = cacheGet<ShaderMetadata[]>(cacheKey)
    if (stale) { setShaders(stale); setLoading(false) }
    setLoading(true)
    try { const data = await getShadersMetadata(instanceId); setShaders(data); cacheSet(cacheKey, data) }
    catch (e) {
      setShaders([])
      notify(`加载光影包失败: ${e instanceof ApiError ? e.displayMessage : '未知错误'}`, 'error')
    }
    setLoading(false)
  }, [instanceId, notify])

  useEffect(() => { load() }, [load, refreshKey])

  const filtered = useMemo(() => {
    if (!search) return shaders
    const q = search.toLowerCase()
    return shaders.filter(s => s.name.toLowerCase().includes(q) || s.fileName.toLowerCase().includes(q))
  }, [shaders, search])

  const handleDelete = useCallback((fileName: string) => {
    setShaders(prev => prev.filter(s => s.fileName !== fileName))
  }, [])

  return (
    <Card>
      <CardContent className="p-5">
        <div className="mb-3 flex items-center justify-between gap-3">
          <h3 className="text-sm font-medium shrink-0">
            <FontAwesomeIcon icon={faSun} className="mr-2 h-4 w-4 text-primary" />光影包
            {shaders.length > 0 && <span className="ml-1.5 text-xs font-normal text-muted-foreground">({shaders.length})</span>}
          </h3>
          <div className="flex items-center gap-2 flex-1 max-w-sm">
            <div className="relative flex-1">
              <FontAwesomeIcon icon={faMagnifyingGlass} className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="搜索光影包..." className="h-8 pl-8 text-xs" />
            </div>
          </div>
          <div className="flex items-center gap-1.5">
            <Tooltip content="刷新">
              <Button size="sm" variant="ghost" onClick={onRefresh} className="h-7 w-7 px-0">
                <FontAwesomeIcon icon={faRotate} className="h-3.5 w-3.5" />
              </Button>
            </Tooltip>
            <Button size="sm" variant="ghost" onClick={() => openFolder(gameDir + '/shaderpacks').catch(() => {})} className="gap-1.5 h-7 text-xs">
              <FontAwesomeIcon icon={faFolderOpen} className="h-3.5 w-3.5" />打开文件夹
            </Button>
            <Tooltip content={viewMode === 'grid' ? '切换列表' : '切换网格'}>
              <Button size="sm" variant="ghost" onClick={toggleView} className="h-7 w-7 px-0">
                <FontAwesomeIcon icon={viewMode === 'grid' ? faList : faGrip} className="h-3.5 w-3.5" />
              </Button>
            </Tooltip>
          </div>
        </div>
        {loading ? (
          <div className="flex flex-col gap-2">
            {Array.from({ length: 3 }).map((_, i) => (
              <div key={i} className="animate-pulse flex items-center gap-3 rounded-xl border p-4">
                <div className="h-10 w-10 shrink-0 rounded-lg bg-muted" />
                <div className="flex-1 space-y-2">
                  <div className="h-4 w-1/3 rounded bg-muted" />
                  <div className="h-3 w-1/2 rounded bg-muted" />
                </div>
                <div className="h-6 w-16 rounded bg-muted" />
              </div>
            ))}
          </div>
        ) : filtered.length === 0 ? (
          <div className="py-8 text-center text-sm text-muted-foreground">
            {search ? '无匹配光影包' : '暂无光影包'}
          </div>
        ) : viewMode === 'grid' ? (
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
            {filtered.map((shader) => (
              <ShaderCard key={shader.fileName} shader={shader} instanceId={instanceId} gameDir={gameDir} onDelete={handleDelete} compact />
            ))}
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            {filtered.map((shader) => (
              <ShaderCard key={shader.fileName} shader={shader} instanceId={instanceId} gameDir={gameDir} onDelete={handleDelete} />
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  )
}

function DataPacksTab({ instanceId, gameDir, refreshKey, onRefresh }: { instanceId: string; gameDir: string; refreshKey: number; onRefresh: () => void }) {
  const [search, setSearch] = useState('')
  const [packs, setPacks] = useState<DataPackMetadata[]>([])
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    const cacheKey = `api-instance-${instanceId}-datapacks`
    const fresh = cacheFresh<DataPackMetadata[]>(cacheKey)
    if (fresh) { setPacks(fresh); setLoading(false); return }
    const stale = cacheGet<DataPackMetadata[]>(cacheKey)
    if (stale) { setPacks(stale); setLoading(false) }
    setLoading(true)
    try { const data = await getDataPacksMetadata(instanceId); setPacks(data); cacheSet(cacheKey, data) }
    catch { setPacks([]) }
    setLoading(false)
  }, [instanceId])

  useEffect(() => { load() }, [load, refreshKey])

  const filtered = useMemo(() => {
    if (!search) return packs
    const q = search.toLowerCase()
    return packs.filter(p => p.name.toLowerCase().includes(q) || p.fileName.toLowerCase().includes(q))
  }, [packs, search])

  const handleDelete = useCallback((fileName: string) => {
    setPacks(prev => prev.filter(p => p.fileName !== fileName))
  }, [])

  return (
    <Card>
      <CardContent className="p-5">
        <div className="mb-3 flex items-center justify-between gap-3">
          <h3 className="text-sm font-medium shrink-0">
            <FontAwesomeIcon icon={faDatabase} className="mr-2 h-4 w-4 text-primary" />数据包
            {packs.length > 0 && <span className="ml-1.5 text-xs font-normal text-muted-foreground">({packs.length})</span>}
          </h3>
          <div className="flex items-center gap-2 flex-1 max-w-sm">
            <div className="relative flex-1">
              <FontAwesomeIcon icon={faMagnifyingGlass} className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="搜索数据包..." className="h-8 pl-8 text-xs" />
            </div>
          </div>
          <div className="flex items-center gap-1.5">
            <Tooltip content="刷新">
              <Button size="sm" variant="ghost" onClick={onRefresh} className="h-7 w-7 px-0">
                <FontAwesomeIcon icon={faRotate} className="h-3.5 w-3.5" />
              </Button>
            </Tooltip>
            <Button size="sm" variant="ghost" onClick={() => openFolder(gameDir + '/datapacks').catch(() => {})} className="gap-1.5 h-7 text-xs">
              <FontAwesomeIcon icon={faFolderOpen} className="h-3.5 w-3.5" />打开文件夹
            </Button>
          </div>
        </div>
        {loading ? (
          <div className="flex flex-col gap-2">
            {Array.from({ length: 3 }).map((_, i) => (
              <div key={i} className="animate-pulse flex items-center gap-3 rounded-xl border p-4">
                <div className="h-10 w-10 shrink-0 rounded-lg bg-muted" />
                <div className="flex-1 space-y-2">
                  <div className="h-4 w-1/3 rounded bg-muted" />
                  <div className="h-3 w-1/2 rounded bg-muted" />
                </div>
                <div className="h-6 w-16 rounded bg-muted" />
              </div>
            ))}
          </div>
        ) : filtered.length === 0 ? (
          <div className="py-8 text-center text-sm text-muted-foreground">
            {search ? '无匹配数据包' : '暂无数据包'}
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            {filtered.map((pack) => (
              <DataPackCard key={pack.fileName} pack={pack} instanceId={instanceId} onDelete={handleDelete} />
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  )
}

function ServersTab({ instanceId, refreshKey, onRefresh }: { instanceId: string; refreshKey: number; onRefresh: () => void }) {
  const [search, setSearch] = useState('')
  const [servers, setServers] = useState<ServerEntry[]>([])
  const [lanGames, setLanGames] = useState<LanGameEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [showAdd, setShowAdd] = useState(false)
  const [addName, setAddName] = useState('')
  const [addIp, setAddIp] = useState('')
  const [adding, setAdding] = useState(false)
  const [confirmIp, setConfirmIp] = useState<string | null>(null)
  const [pingStates, setPingStates] = useState<Record<string, ServerState>>({})
  const [editServer, setEditServer] = useState<ServerEntry | null>(null)
  const { notify } = useMessageBox()

  const load = useCallback(async () => {
    setLoading(true)
    try { const data = await getServers(instanceId); setServers(data) }
    catch (e) {
      setServers([])
      notify(`加载服务器列表失败: ${e instanceof ApiError ? e.displayMessage : '未知错误'}`, 'error')
    }
    setLoading(false)
  }, [instanceId, notify])

  useEffect(() => { load() }, [load, refreshKey])

  useEffect(() => {
    if (loading || servers.length === 0) return
    const pingAll = async () => {
      const results: Record<string, ServerState> = {}
      for (const s of servers) {
        try {
          const state = await pingServer(instanceId, s.ip)
          results[s.ip] = state
        } catch {}
      }
      setPingStates(results)
    }
    pingAll()
  }, [servers, loading, instanceId])

  useEffect(() => {
    if (loading) return
    const fetchLan = async () => {
      try {
        const games = await getLanGames(instanceId)
        setLanGames(games)
      } catch {}
    }
    fetchLan()
  }, [loading, instanceId])

  const filtered = useMemo(() => {
    if (!search) return servers
    const q = search.toLowerCase()
    return servers.filter(s => s.name.toLowerCase().includes(q) || s.ip.toLowerCase().includes(q))
  }, [servers, search])

  const handleDelete = useCallback(async (ip: string) => {
    setConfirmIp(null)
    try {
      await deleteServer(instanceId, ip)
      notify('已删除服务器', 'success')
      load()
    } catch (e) {
      notify(`删除失败: ${e instanceof ApiError ? e.displayMessage : '未知错误'}`, 'error')
    }
  }, [instanceId, load, notify])

  const handleAdd = useCallback(async () => {
    if (!addName || !addIp) return
    setAdding(true)
    try {
      await addServer(instanceId, addName, addIp)
      notify(editServer ? `已更新「${addName}」` : `已添加「${addName}」`, 'success')
      load(); setShowAdd(false); setAddName(''); setAddIp(''); setEditServer(null)
    } catch (e) {
      notify(`操作失败: ${e instanceof ApiError ? e.displayMessage : '未知错误'}`, 'error')
    }
    setAdding(false)
  }, [instanceId, addName, addIp, load, notify, editServer])

  const handleEdit = useCallback((s: ServerEntry) => {
    setEditServer(s)
    setAddName(s.name)
    setAddIp(s.ip)
    setShowAdd(true)
  }, [])

  const handleCopyIp = useCallback(async (ip: string) => {
    try {
      await navigator.clipboard.writeText(ip)
      notify('已复制 IP 地址', 'success')
    } catch {
      notify('复制失败', 'error')
    }
  }, [notify])

  const handlePing = useCallback(async (address: string) => {
    try {
      const state = await pingServer(instanceId, address)
      setPingStates(p => ({ ...p, [address]: state }))
      notify(state.isOnline ? `测速完成: ${state.ping}ms` : `${address} 离线`, state.isOnline ? 'success' : 'warning')
    } catch (e) {
      notify('测速失败', 'error')
    }
  }, [instanceId, notify])

  return (
    <>
      <Card>
        <CardContent className="p-5">
          <div className="mb-3 flex items-center justify-between gap-3">
            <h3 className="text-sm font-medium shrink-0">
              <FontAwesomeIcon icon={faGlobe} className="mr-2 h-4 w-4 text-primary" />服务器
              {servers.length > 0 && <span className="ml-1.5 text-xs font-normal text-muted-foreground">({servers.length})</span>}
            </h3>
            <div className="flex items-center gap-2 flex-1 max-w-sm">
              <div className="relative flex-1">
                <FontAwesomeIcon icon={faMagnifyingGlass} className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
                <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="搜索服务器..." className="h-8 pl-8 text-xs" />
              </div>
            </div>
            <div className="flex items-center gap-1.5">
              <Tooltip content="刷新">
                <Button size="sm" variant="ghost" onClick={onRefresh} className="h-7 w-7 px-0">
                  <FontAwesomeIcon icon={faRotate} className="h-3.5 w-3.5" />
                </Button>
              </Tooltip>
              <Tooltip content="全部测速">
                <Button size="sm" variant="ghost" onClick={() => {
                  servers.forEach(s => handlePing(s.ip))
                }} className="h-7 w-7 px-0">
                  <FontAwesomeIcon icon={faWifi} className="h-3.5 w-3.5" />
                </Button>
              </Tooltip>
              <Button size="sm" onClick={() => setShowAdd(true)} className="gap-1.5 h-7 text-xs">
                <FontAwesomeIcon icon={faPlus} className="h-3.5 w-3.5" />添加服务器
              </Button>
            </div>
          </div>
          {loading ? (
            <div className="flex flex-col gap-1">
              {Array.from({ length: 3 }).map((_, i) => (
                <div key={i} className="animate-pulse flex items-center gap-3 rounded-lg px-3 py-2.5">
                  <div className="h-4 w-4 shrink-0 rounded bg-muted" />
                  <div className="flex-1 space-y-1.5">
                    <div className="h-3.5 w-1/3 rounded bg-muted" />
                    <div className="h-2.5 w-1/4 rounded bg-muted" />
                  </div>
                  <div className="flex gap-1">
                    <div className="h-7 w-7 rounded bg-muted" />
                    <div className="h-7 w-7 rounded bg-muted" />
                    <div className="h-7 w-7 rounded bg-muted" />
                  </div>
                </div>
              ))}
            </div>
          ) : filtered.length === 0 ? (
            <div className="py-8 text-center text-sm text-muted-foreground">
              {search ? '无匹配服务器' : '暂无服务器'}
            </div>
          ) : (
            <div className="space-y-2">
              {filtered.map((s, i) => {
                const ps = pingStates[s.ip]
                const contextItems: ContextMenuItem[] = [
                  { label: '编辑', onClick: () => handleEdit(s) },
                  { label: '测速', onClick: () => handlePing(s.ip) },
                  { label: '复制 IP', onClick: () => handleCopyIp(s.ip) },
                  { label: '删除', onClick: () => setConfirmIp(s.ip), danger: true },
                ]
                return (
                  <ContextMenu key={i} items={contextItems}>
                    <Card className="group border-border/60 bg-card/95 transition-all hover:border-primary/20 hover:shadow-sm">
                      <CardContent className="flex items-start gap-3 p-4">
                        <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-muted text-muted-foreground overflow-hidden">
                          {s.iconBase64 ? (
                            <img src={`data:image/png;base64,${s.iconBase64}`} alt={s.name} className="h-full w-full object-cover" loading="lazy" />
                          ) : (
                            <FontAwesomeIcon icon={faServer} className="h-5 w-5 opacity-50" />
                          )}
                        </div>
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2">
                            <h3 className="font-semibold text-sm">{s.name}</h3>
                            {ps && (
                              <span className={`inline-flex items-center gap-1 text-xs font-medium ${ps.isOnline ? 'text-green-500' : 'text-red-500'}`}>
                                <span className={`inline-block w-2 h-2 rounded-full ${ps.isOnline ? 'bg-green-500' : 'bg-red-500'}`} />
                                {ps.isOnline ? `${ps.ping}ms` : '离线'}
                              </span>
                            )}
                          </div>
                          <div className="mt-0.5 flex items-center gap-2 text-xs text-muted-foreground">
                            <span>{s.ip}</span>
                            {ps?.version && <><span className="text-border">·</span><span>{ps.version}</span></>}
                            {ps?.isOnline && <>
                              <span className="text-border">·</span>
                              <FontAwesomeIcon icon={faUser} className="h-3 w-3" />
                              <span>{ps.onlinePlayers}/{ps.maxPlayers}</span>
                            </>}
                          </div>
                          {ps?.description && (
                            <p className="mt-1 text-xs text-muted-foreground/70 line-clamp-1">{ps.description.replace(/§[0-9a-fk-or]/gi, '')}</p>
                          )}
                        </div>
                        <div className="flex items-center gap-0.5 shrink-0">
                          <Tooltip content="编辑">
                            <button onClick={() => handleEdit(s)} className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground">
                              <FontAwesomeIcon icon={faPen} className="h-3.5 w-3.5" />
                            </button>
                          </Tooltip>
                          <Tooltip content="复制 IP">
                            <button onClick={() => handleCopyIp(s.ip)} className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground">
                              <FontAwesomeIcon icon={faClipboard} className="h-3.5 w-3.5" />
                            </button>
                          </Tooltip>
                          <Tooltip content="删除">
                            <button onClick={() => setConfirmIp(s.ip)} className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-destructive/10 hover:text-destructive">
                              <FontAwesomeIcon icon={faTrashCan} className="h-3.5 w-3.5" />
                            </button>
                          </Tooltip>
                        </div>
                      </CardContent>
                    </Card>
                  </ContextMenu>
                )
              })}
            </div>
          )}
          {lanGames.length > 0 && (
            <>
              <Separator className="my-3" />
              <div className="mb-2 flex items-center gap-2">
                <FontAwesomeIcon icon={faWifi} className="h-3.5 w-3.5 text-primary" />
                <span className="text-xs font-medium text-muted-foreground">局域网游戏 ({lanGames.length})</span>
              </div>
              <div className="space-y-2">
                {lanGames.map((g, i) => (
                  <Card key={`${g.ip}:${g.port}-${i}`} className="group border-dashed border-border/60 bg-card/95 transition-all hover:border-primary/20 hover:shadow-sm">
                    <CardContent className="flex items-start gap-3 p-4">
                      <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
                        <FontAwesomeIcon icon={faWifi} className="h-5 w-5" />
                      </div>
                      <div className="min-w-0 flex-1">
                        <h3 className="font-semibold text-sm">{g.worldName || '局域网游戏'}</h3>
                        <div className="mt-0.5 flex items-center gap-2 text-xs text-muted-foreground">
                          <span>{g.ip}:{g.port}</span>
                          {g.gameVersion !== 'Unknown' && <><span className="text-border">·</span><span>{g.gameVersion}</span></>}
                        </div>
                        {g.motd && (
                          <p className="mt-1 text-xs text-muted-foreground/70 line-clamp-1">{g.motd}</p>
                        )}
                      </div>
                      <Button size="sm" className="shrink-0 gap-1.5 h-7 text-xs">
                        <FontAwesomeIcon icon={faPlay} className="h-3 w-3" />加入
                      </Button>
                    </CardContent>
                  </Card>
                ))}
              </div>
            </>
          )}
        </CardContent>
      </Card>
      <ConfirmDialog open={confirmIp !== null} title="删除服务器" message={`确定要删除服务器「${confirmIp}」吗？`} onConfirm={() => confirmIp && handleDelete(confirmIp)} onCancel={() => setConfirmIp(null)} />
      <Dialog open={showAdd} onClose={() => { setShowAdd(false); setEditServer(null) }}>
        <DialogHeader onClose={() => { setShowAdd(false); setEditServer(null) }}><DialogTitle>{editServer ? '编辑服务器' : '添加服务器'}</DialogTitle></DialogHeader>
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
          <Button variant="outline" size="sm" onClick={() => { setShowAdd(false); setEditServer(null) }}>取消</Button>
          <Button size="sm" onClick={handleAdd} disabled={adding || !addName || !addIp}>{adding ? (editServer ? '更新中...' : '添加中...') : (editServer ? '保存' : '添加')}</Button>
        </DialogFooter>
      </Dialog>
    </>
  )
}

const KEY_DISPLAY_MAP: Record<string, string> = {
  'key.keyboard.unknown': '未绑定',
  'key.keyboard.space': '空格',
  'key.keyboard.apostrophe': "'",
  'key.keyboard.comma': ',',
  'key.keyboard.minus': '-',
  'key.keyboard.period': '.',
  'key.keyboard.slash': '/',
  'key.keyboard.semicolon': ';',
  'key.keyboard.equal': '=',
  'key.keyboard.grave.accent': '`',
  'key.keyboard.left.bracket': '[',
  'key.keyboard.right.bracket': ']',
  'key.keyboard.backslash': '\\',
  'key.keyboard.escape': 'Esc',
  'key.keyboard.enter': '回车',
  'key.keyboard.tab': 'Tab',
  'key.keyboard.backspace': '退格',
  'key.keyboard.insert': 'Insert',
  'key.keyboard.delete': 'Delete',
  'key.keyboard.right': '→',
  'key.keyboard.left': '←',
  'key.keyboard.down': '↓',
  'key.keyboard.up': '↑',
  'key.keyboard.page.up': 'Page Up',
  'key.keyboard.page.down': 'Page Down',
  'key.keyboard.home': 'Home',
  'key.keyboard.end': 'End',
  'key.keyboard.caps.lock': 'Caps Lock',
  'key.keyboard.scroll.lock': 'Scroll Lock',
  'key.keyboard.num.lock': 'Num Lock',
  'key.keyboard.print.screen': 'Print Screen',
  'key.keyboard.pause': 'Pause',
  'key.keyboard.left.shift': '左 Shift',
  'key.keyboard.right.shift': '右 Shift',
  'key.keyboard.left.control': '左 Ctrl',
  'key.keyboard.right.control': '右 Ctrl',
  'key.keyboard.left.alt': '左 Alt',
  'key.keyboard.right.alt': '右 Alt',
  'key.keyboard.left.super': '左 Win',
  'key.keyboard.right.super': '右 Win',
  'key.keyboard.menu': '菜单键',
  'key.mouse.0': '鼠标左键',
  'key.mouse.1': '鼠标右键',
  'key.mouse.2': '鼠标中键',
  'key.mouse.3': '鼠标按键 3',
  'key.mouse.4': '鼠标按键 4',
  'key.mouse.5': '鼠标按键 5',
}

for (let i = 0; i <= 9; i++) KEY_DISPLAY_MAP[`key.keyboard.${i}`] = `${i}`
for (let i = 1; i <= 25; i++) KEY_DISPLAY_MAP[`key.keyboard.f${i}`] = `F${i}`
for (const c of 'abcdefghijklmnopqrstuvwxyz') KEY_DISPLAY_MAP[`key.keyboard.${c}`] = c.toUpperCase()
for (let i = 0; i <= 9; i++) KEY_DISPLAY_MAP[`key.keyboard.kp.${i}`] = `小键盘 ${i}`
KEY_DISPLAY_MAP['key.keyboard.kp.add'] = '小键盘 +'
KEY_DISPLAY_MAP['key.keyboard.kp.subtract'] = '小键盘 -'
KEY_DISPLAY_MAP['key.keyboard.kp.multiply'] = '小键盘 *'
KEY_DISPLAY_MAP['key.keyboard.kp.divide'] = '小键盘 /'
KEY_DISPLAY_MAP['key.keyboard.kp.decimal'] = '小键盘 .'
KEY_DISPLAY_MAP['key.keyboard.kp.enter'] = '小键盘 回车'

function mapJSCodeToMinecraft(code: string): string | null {
  const m: Record<string, string> = {
    Space: 'key.keyboard.space',
    Escape: 'key.keyboard.escape',
    Enter: 'key.keyboard.enter',
    Tab: 'key.keyboard.tab',
    Backspace: 'key.keyboard.backspace',
    Insert: 'key.keyboard.insert',
    Delete: 'key.keyboard.delete',
    ArrowRight: 'key.keyboard.right', ArrowLeft: 'key.keyboard.left',
    ArrowDown: 'key.keyboard.down', ArrowUp: 'key.keyboard.up',
    PageUp: 'key.keyboard.page.up', PageDown: 'key.keyboard.page.down',
    Home: 'key.keyboard.home', End: 'key.keyboard.end',
    CapsLock: 'key.keyboard.caps.lock',
    ScrollLock: 'key.keyboard.scroll.lock',
    NumLock: 'key.keyboard.num.lock',
    PrintScreen: 'key.keyboard.print.screen',
    Pause: 'key.keyboard.pause',
    ShiftLeft: 'key.keyboard.left.shift', ShiftRight: 'key.keyboard.right.shift',
    ControlLeft: 'key.keyboard.left.control', ControlRight: 'key.keyboard.right.control',
    AltLeft: 'key.keyboard.left.alt', AltRight: 'key.keyboard.right.alt',
    MetaLeft: 'key.keyboard.left.super', MetaRight: 'key.keyboard.right.super',
    ContextMenu: 'key.keyboard.menu',
    Semicolon: 'key.keyboard.semicolon', Quote: 'key.keyboard.apostrophe',
    Comma: 'key.keyboard.comma', Minus: 'key.keyboard.minus',
    Period: 'key.keyboard.period', Slash: 'key.keyboard.slash',
    BracketLeft: 'key.keyboard.left.bracket', BracketRight: 'key.keyboard.right.bracket',
    Backslash: 'key.keyboard.backslash',
    Backquote: 'key.keyboard.grave.accent',
    Equal: 'key.keyboard.equal',
  }
  if (m[code]) return m[code]
  if (code.startsWith('Key')) return `key.keyboard.${code.slice(3).toLowerCase()}`
  if (code.startsWith('Digit')) return `key.keyboard.${code.slice(5)}`
  if (code.startsWith('Numpad')) { const n = code.slice(6); return isNaN(Number(n)) ? null : `key.keyboard.kp.${n}` }
  if (code.startsWith('F') && code.length <= 4) { const n = parseInt(code.slice(1)); return n >= 1 && n <= 25 ? `key.keyboard.f${n}` : null }
  return null
}

function GameSettingsTab({ instanceId, refreshKey, onRefresh }: { instanceId: string; refreshKey: number; onRefresh: () => void }) {
  const [search, setSearch] = useState('')
  const [settings, setSettings] = useState<GameSettingDto[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState<Set<string>>(new Set())
  const [listeningKey, setListeningKey] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try { const data = await getGameSettings(instanceId); setSettings(data) }
    catch { setSettings([]) }
    setLoading(false)
  }, [instanceId])

  useEffect(() => { load() }, [load, refreshKey])

  const filtered = useMemo(() => {
    if (!search) return settings
    const q = search.toLowerCase()
    return settings.filter(s =>
      s.name.toLowerCase().includes(q) ||
      s.description.toLowerCase().includes(q)
    )
  }, [settings, search])

  const handleChange = useCallback(async (name: string, value: string) => {
    setSettings(prev => prev.map(s => s.name === name ? { ...s, currentValue: value } : s))
    setSaving(prev => new Set(prev).add(name))
    try { await setGameSetting(instanceId, name, value) } catch {}
    setSaving(prev => {
      const next = new Set(prev)
      next.delete(name)
      return next
    })
  }, [instanceId])

  const parseRange = (vv: string): [number, number, number, boolean] | null => {
    const m = vv.match(/^(\d+(?:\.\d+)?)\s*[-–]\s*(\d+(?:\.\d+)?)$/)
    if (!m) return null
    const min = parseFloat(m[1])
    const max = parseFloat(m[2])
    const step = m[1].includes('.') || m[2].includes('.') ? 0.1 : 1
    const isPercent = min === 0 && Math.abs(max - 1.0) < 0.001
    return isPercent ? [0, 100, 1, true] : [min, max, step, false]
  }

  const parseEnum = (vv: string): string[] => vv.split(',').map(v => v.trim()).filter(Boolean)
  const isKeybinding = (name: string) => name.startsWith('key_')

  const formatKeyDisplay = (code: string): string => {
    const name = KEY_DISPLAY_MAP[code]
    if (name) return name
    if (code.startsWith('key.keyboard.')) return code.slice('key.keyboard.'.length).toUpperCase()
    if (code.startsWith('key.mouse.')) return `鼠标按键 ${code.slice('key.mouse.'.length)}`
    return code
  }

  useEffect(() => {
    if (!listeningKey) return
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault()
      e.stopPropagation()
      const key = mapJSCodeToMinecraft(e.code)
      if (key) { handleChange(listeningKey, key); setListeningKey(null) }
    }
    const onMouse = (e: MouseEvent) => {
      e.preventDefault()
      e.stopPropagation()
      const btn = e.button
      const mc = btn === 0 ? 0 : btn === 2 ? 1 : btn === 1 ? 2 : btn
      handleChange(listeningKey, `key.mouse.${mc}`)
      setListeningKey(null)
    }
    window.addEventListener('keydown', onKey, true)
    window.addEventListener('mousedown', onMouse, true)
    return () => { window.removeEventListener('keydown', onKey, true); window.removeEventListener('mousedown', onMouse, true) }
  }, [listeningKey, handleChange])

  return (
    <Card>
      <CardContent className="p-5 overflow-hidden">
        <div className="mb-3 flex items-center justify-between gap-3">
          <h3 className="text-sm font-medium shrink-0">
            <FontAwesomeIcon icon={faGamepad} className="mr-2 h-4 w-4 text-primary" />游戏设置
            {!loading && <span className="ml-1.5 text-xs font-normal text-muted-foreground">({settings.length})</span>}
          </h3>
          <div className="flex items-center gap-2 flex-1 max-w-sm">
            <div className="relative flex-1">
              <FontAwesomeIcon icon={faMagnifyingGlass} className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="搜索设置项..." className="h-8 pl-8 text-xs" />
            </div>
            <Tooltip content="刷新">
              <Button size="sm" variant="ghost" onClick={onRefresh} className="h-7 w-7 px-0">
                <FontAwesomeIcon icon={faRotate} className="h-3.5 w-3.5" />
              </Button>
            </Tooltip>
          </div>
        </div>
        {loading ? (
          <div className="space-y-3">
            {Array.from({ length: 8 }).map((_, i) => (
              <div key={i} className="animate-pulse flex items-center gap-3">
                <div className="flex-1 space-y-1.5">
                  <div className="h-4 w-1/4 rounded bg-muted" />
                  <div className="h-3 w-1/2 rounded bg-muted" />
                </div>
                <div className="h-8 w-32 rounded bg-muted" />
              </div>
            ))}
          </div>
        ) : filtered.length === 0 ? (
          <div className="py-8 text-center text-sm text-muted-foreground">
            {search ? '无匹配设置项' : '暂无游戏设置'}
          </div>
        ) : (
          <div className="space-y-1 overflow-hidden">
            {filtered.map((s) => {
              const range = parseRange(s.validValues)
              const enumOpts = parseEnum(s.validValues)
              const keybind = isKeybinding(s.name)
              return (
                <div key={s.name} className="flex items-center justify-between gap-3 rounded-lg px-3 py-1.5 transition-colors hover:bg-accent/50 min-w-0">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5 min-w-0">
                      <span className="text-sm font-medium truncate">{s.name}</span>
                      {saving.has(s.name) && <span className="shrink-0 text-[10px] text-muted-foreground">...</span>}
                    </div>
                    <p className="text-xs text-muted-foreground truncate">{s.description}</p>
                  </div>
                  <div className="shrink-0 max-w-40 min-w-0">
                    {s.valueKind === 'Boolean' && (
                      <Checkbox
                        checked={s.currentValue === 'true'}
                        onCheckedChange={(c) => handleChange(s.name, c === true ? 'true' : 'false')}
                      />
                    )}
                    {keybind && (
                      <button
                        onClick={() => setListeningKey(s.name)}
                        className={cn(
                          'h-7 rounded-md border px-2.5 text-xs font-medium transition-colors min-w-[60px]',
                          listeningKey === s.name
                            ? 'border-primary bg-primary/10 text-primary animate-pulse'
                            : 'border-input bg-background hover:bg-accent hover:text-accent-foreground'
                        )}
                      >
                        {listeningKey === s.name ? '按下按键...' : formatKeyDisplay(s.currentValue)}
                      </button>
                    )}
                    {!keybind && s.valueKind === 'Enum' && enumOpts.length > 0 && (
                      <Select value={s.currentValue} onChange={(v) => handleChange(s.name, v)} className="w-full">
                        {enumOpts.map((opt) => (
                          <SelectOption key={opt} value={opt}>{opt}</SelectOption>
                        ))}
                      </Select>
                    )}
                    {!keybind && s.valueKind === 'Range' && range && (
                      <div className="flex items-center gap-1.5">
                        <input
                          type="range"
                          min={range[0]}
                          max={range[1]}
                          step={range[2]}
                          value={range[3] ? Math.round(parseFloat(s.currentValue || '0') * 100) : parseFloat(s.currentValue) || range[0]}
                          onChange={(e) => {
                            const raw = parseFloat(e.target.value)
                            handleChange(s.name, range[3] ? (raw / 100).toString() : raw.toString())
                          }}
                          className="w-24"
                        />
                        <span className="w-12 text-right text-xs tabular-nums text-muted-foreground truncate">
                          {range[3] ? `${Math.round(parseFloat(s.currentValue || '0') * 100)}%` : s.currentValue}
                        </span>
                      </div>
                    )}
                    {!keybind && s.valueKind === 'Text' && (
                      <Input
                        value={s.currentValue}
                        onChange={(e) => handleChange(s.name, e.target.value)}
                        className="h-7 w-full text-xs"
                      />
                    )}
                    {!keybind && s.valueKind !== 'Boolean' && s.valueKind !== 'Enum' && s.valueKind !== 'Range' && s.valueKind !== 'Text' && (
                      <span className="text-xs text-muted-foreground truncate block">{s.currentValue}</span>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </CardContent>
    </Card>
  )
}

export default function InstanceDetailPage() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const { needsAccount, resolve: resolveAccountCheck, showNoAccount, showSelectAccount, handleAddAccount, handleGoToAccounts, handleCancelNoAccount, handleCancelSelect, handleSelectAccount } = useRequireDefaultAccount()
  const { state: debugState } = useDebug()
  const [tab, setTab] = useState<TabId>('overview')
  const [instance, setInstance] = useState<GameInstance | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [runtimes, setRuntimes] = useState<JavaRuntime[]>(() => getRuntimes())
  const [accounts, setAccounts] = useState<Account[]>([])
  const [form, setForm] = useState<GameInstance | null>(null)
  const [sysInfo, setSysInfo] = useState<SystemInfo | null>(null)
  const [memoryMode, setMemoryMode] = useState<'auto' | 'custom'>('auto')
  const [isDefault, setIsDefault] = useState(false)
  const [verifying, setVerifying] = useState(false)
  const [verifyResult, setVerifyResult] = useState<{ complete: boolean; missingFiles: MissingFile[] } | null>(null)
  const [repairing, setRepairing] = useState(false)
  const [repairProgress, setRepairProgress] = useState(0)
  const [showMicrosoftReauth, setShowMicrosoftReauth] = useState(false)
  const [savesRefresh, setSavesRefresh] = useState(0)
  const [screenshotsRefresh, setScreenshotsRefresh] = useState(0)
  const [modsRefresh, setModsRefresh] = useState(0)
  const [resourcePacksRefresh, setResourcePacksRefresh] = useState(0)
  const [shadersRefresh, setShadersRefresh] = useState(0)
  const [dataPacksRefresh, setDataPacksRefresh] = useState(0)
  const [serversRefresh, setServersRefresh] = useState(0)
  const [gameSettingsRefresh, setGameSettingsRefresh] = useState(0)
  const [detailRefreshKey, setDetailRefreshKey] = useState(0)

  const refreshDetail = useCallback(() => {
    cacheInvalidate('api-instance-')
    cacheInvalidate('api-instances')
    setDetailRefreshKey(k => k + 1)
  }, [])

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
        const cacheKey = `api-instance-${id}`
        const cached = cacheGet<GameInstance>(cacheKey)
        if (cached) { setInstance(cached); setForm({ ...cached }) }
        const [inst, accts, sys, def] = await Promise.all([getInstance(id!), getAccounts(), getSystemInfo(), getDefaultInstance()])
        if (cancelled) return
        setInstance(inst)
        setForm({ ...inst })
        cacheSet(cacheKey, inst)
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
  }, [id, navigate, detailRefreshKey])

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
        skipIntegrityCheck: formToSave.skipIntegrityCheck,
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
  const [launchProgress, setLaunchProgress] = useState<LaunchProgress | null>(null)
  const launchPollRef = useRef<number | null>(null)
  const launchingInstanceIdRef = useRef<string | null>(null)

  const handleLaunch = useCallback(async () => {
    if (!id) return
    if (needsAccount) {
      const ok = await resolveAccountCheck()
      if (!ok) return
    }
    try {
      const result = await launchInstance(id)
      if (!result.success) {
        setLaunchError({
          title: '启动失败',
          message: result.error || '未知错误',
          detail: result.detail,
          args: result.arguments,
        })
        return
      }
      launchingInstanceIdRef.current = id
      setLaunchProgress({ stage: 'starting', message: '准备启动...', progress: 0, isRunning: false })
      if (launchPollRef.current) { clearTimeout(launchPollRef.current); launchPollRef.current = null }
      const poll = async () => {
        try {
          const p = await getLaunchProgress(id)
          if (p.stage === 'completed') {
            setLaunchProgress({ stage: p.stage, message: p.message, progress: 100, isRunning: false })
            launchingInstanceIdRef.current = null
            launchPollRef.current = null
          } else if (p.stage === 'crashed' || p.stage === 'failed') {
            setLaunchProgress(p)
            launchingInstanceIdRef.current = null
            launchPollRef.current = null
          } else {
            setLaunchProgress(p)
            launchPollRef.current = window.setTimeout(poll, p.stage === 'running' ? 2000 : 500)
          }
        } catch { }
      }
      launchPollRef.current = window.setTimeout(poll, 500)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      const code = e instanceof ApiError ? e.code : ''
      if (msg.includes('TOKEN_EXPIRED') || msg.includes('invalid_grant') || msg.includes('AADSTS70008') || code.includes('TOKEN_EXPIRED')) {
        setShowMicrosoftReauth(true)
        return
      }
      setLaunchError({ title: '启动失败', message: e instanceof Error ? e.message : String(e) })
    }
  }, [id])

  useEffect(() => {
    if (!launchProgress) return
    if (launchProgress.stage === 'completed' || launchProgress.stage === 'crashed') {
      const instId = launchingInstanceIdRef.current
      if (!instId) return
      ;(async () => {
        try {
          const updated = await getInstance(instId)
          if (updated) {
            setInstance(prev => prev ? { ...prev, ...updated } : prev)
          }
        } catch { /* ignore */ }
      })()
    }
  }, [launchProgress])

  useEffect(() => () => { if (launchPollRef.current) { clearTimeout(launchPollRef.current); launchPollRef.current = null } }, [])

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
      cacheInvalidate('api-')
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
        <InstanceIcon icon={instance.icon} iconData={instance.iconData} loader={instance.loader} className="h-10 w-10 shrink-0 rounded-lg" imgClassName="rounded-lg" />
        <div className="flex-1">
          <h1 className="text-2xl font-semibold tracking-tight">{instance.name}</h1>
          <p className="text-xs text-muted-foreground">
            {instance.gameVersion}
            {instance.loader && ` · ${instance.loader} ${instance.loaderVersion || ''}`}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Tooltip content="刷新">
            <Button variant="outline" size="icon" onClick={refreshDetail}>
              <FontAwesomeIcon icon={faRotate} className={cn('h-4 w-4', loading && 'animate-spin')} />
            </Button>
          </Tooltip>
          <Button onClick={handleLaunch} className="gap-2">
            <FontAwesomeIcon icon={faPlay} className="h-3.5 w-3.5" />启动
          </Button>
          <Tooltip content={isDefault ? '取消固定' : '固定到主页'}>
            <Button variant="outline" size="icon" onClick={toggleDefault}>
              <FontAwesomeIcon icon={faStar} className={cn('h-4 w-4', isDefault && 'text-yellow-400')} />
            </Button>
          </Tooltip>
          <Button variant="outline" size="icon" onClick={() => openFolder(instance.resolvedGameDir ?? instance.gameDir).catch(() => {})}>
            <FontAwesomeIcon icon={faFolderOpen} className="h-4 w-4" />
          </Button>
        </div>
      </div>

      <div className="flex gap-4 min-w-0">
        <div className="flex w-44 shrink-0 flex-col gap-0.5">
          {TABS.filter(t => t.id !== 'gamesettings' || debugState.showGameSettings).map((t) => (
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

              {instance.modpackName && (
                <Card>
                  <CardContent className="p-5 space-y-3">
                    <h3 className="text-sm font-medium">整合包信息</h3>
                    <div className="grid grid-cols-2 gap-4 text-sm">
                      <div>
                        <p className="text-xs text-muted-foreground">整合包名称</p>
                        <p className="font-medium">{instance.modpackName}</p>
                      </div>
                      {instance.modpackVersion && (
                        <div>
                          <p className="text-xs text-muted-foreground">版本</p>
                          <p className="font-medium">{instance.modpackVersion}</p>
                        </div>
                      )}
                      {instance.modpackAuthor && (
                        <div>
                          <p className="text-xs text-muted-foreground">作者</p>
                          <p className="font-medium">{instance.modpackAuthor}</p>
                        </div>
                      )}
                    </div>
                    {instance.modpackSummary && (
                      <div className="pt-1">
                        <p className="text-xs text-muted-foreground mb-1">简介</p>
                        <div className="text-sm text-muted-foreground prose prose-sm max-w-none" dangerouslySetInnerHTML={{ __html: instance.modpackSummary }} />
                      </div>
                    )}
                  </CardContent>
                </Card>
              )}

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
                    <Button size="sm" variant="outline" className="gap-2" onClick={() => openFolder(instance.resolvedGameDir ?? instance.gameDir).catch(() => {})}>
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

                <label className="flex items-center gap-3 cursor-pointer">
                  <Checkbox
                    checked={form.skipIntegrityCheck === true}
                    onCheckedChange={(c) => update('skipIntegrityCheck', c === true)}
                  />
                  <div>
                    <div className="text-sm font-medium">跳过资源完整性检查</div>
                    <div className="text-xs text-muted-foreground">启动时跳过文件完整性检查，可能因缺少文件导致游戏崩溃</div>
                  </div>
                </label>

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

          {tab === 'saves' && <SavesTab instanceId={id!} gameDir={instance.resolvedGameDir ?? instance.gameDir} refreshKey={savesRefresh} onRefresh={() => setSavesRefresh(k => k + 1)} />}
          {tab === 'screenshots' && <ScreenshotsTab instanceId={id!} gameDir={instance.resolvedGameDir ?? instance.gameDir} refreshKey={screenshotsRefresh} onRefresh={() => setScreenshotsRefresh(k => k + 1)} />}
          {tab === 'mods' && <ModsTab instanceId={id!} gameVersion={instance.gameVersion} loader={instance.loader || undefined} gameDir={instance.resolvedGameDir ?? instance.gameDir} refreshKey={modsRefresh} onRefresh={() => { cacheInvalidate(`api-instance-${id}-mods`); setModsRefresh(k => k + 1) }} />}
          {tab === 'resourcepacks' && <ResourcePacksTab instanceId={id!} gameDir={instance.resolvedGameDir ?? instance.gameDir} refreshKey={resourcePacksRefresh} onRefresh={() => { cacheInvalidate(`api-instance-${id}-resourcepacks`); setResourcePacksRefresh(k => k + 1) }} />}
          {tab === 'shaderpacks' && <ShadersTab instanceId={id!} gameDir={instance.resolvedGameDir ?? instance.gameDir} refreshKey={shadersRefresh} onRefresh={() => { cacheInvalidate(`api-instance-${id}-shaders`); setShadersRefresh(k => k + 1) }} />}
          {tab === 'datapacks' && <DataPacksTab instanceId={id!} gameDir={instance.resolvedGameDir ?? instance.gameDir} refreshKey={dataPacksRefresh} onRefresh={() => { cacheInvalidate(`api-instance-${id}-datapacks`); setDataPacksRefresh(k => k + 1) }} />}
          {tab === 'servers' && <ServersTab instanceId={id!} refreshKey={serversRefresh} onRefresh={() => setServersRefresh(k => k + 1)} />}
          {tab === 'gamesettings' && <GameSettingsTab instanceId={id!} refreshKey={gameSettingsRefresh} onRefresh={() => setGameSettingsRefresh(k => k + 1)} />}
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
      <AccountSelectDialog
        open={showSelectAccount}
        onClose={handleCancelSelect}
        onSelect={handleSelectAccount}
      />
      <NoAccountDialog
        open={showNoAccount}
        onClose={handleCancelNoAccount}
        onAddAccount={handleAddAccount}
        onGoToAccounts={handleGoToAccounts}
      />
      <MicrosoftReauthDialog
        open={showMicrosoftReauth}
        onClose={() => setShowMicrosoftReauth(false)}
        onReauth={() => {
          setShowMicrosoftReauth(false)
          navigate('/accounts')
        }}
      />
    </div>
  )
}
