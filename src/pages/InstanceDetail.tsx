import { useEffect, useState, useCallback, useMemo, useRef } from 'react'
import { useParams, useNavigate, useSearchParams } from 'react-router-dom'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import { faArrowLeft, faInfoCircle, faSliders, faSave, faCamera, faCube, faBox, faSun, faServer, faPlay, faFolderOpen, faGear, faTrashCan, faRotate, faRobot, faGlobe, faPlus, faMagnifyingGlass, faDownload, faClipboard, faStar, faWifi, faDatabase, faGamepad, faUser, faPen, faCheck, faBan, faArrowUp, faClone, faList, faLayerGroup, faFileExport, faXmark, faDrawPolygon, faEye, faUpload, faTerminal} from '@fortawesome/free-solid-svg-icons'
import { Button } from '../components/ui'
import { Card, CardContent } from '../components/ui'
import { Separator } from '../components/ui'
import { Input } from '../components/ui'
import { Label } from '../components/ui'
import { Checkbox } from '../components/ui'
import { Select, SelectOption } from '../components/ui'
import { Tooltip } from '../components/ui'
import { Tabs, TabContent } from '../components/ui'
import { I18nBatchToolbar } from '../components/I18nBatchToolbar.tsx'
import { Dialog, DialogHeader, DialogTitle, DialogBody, DialogFooter } from '../components/ui'
import { cn } from '../lib/utils.ts'
import { cacheGet, cacheSet, cacheFresh, cacheInvalidate } from '../lib/simple-cache.ts'
import { updateModsViaDownloadCenter } from '../lib/updateMods.ts'
import { useMessageBox } from '../components/ui'
import { getInstance, updateInstance, deleteInstance, setDefaultInstance, clearDefaultInstance, getDefaultInstance, verifyResources, repairResources, getInstallProgress, getGameSettings, setGameSetting, getInstanceGroups } from '../api/instance.ts'
import type { InstanceGroup } from '../api/instance.ts'
import { openFolder, getSettings } from '../api/settings.ts'
import { getRuntimes, getValidRuntimes, scanRuntimes, loadCustomRuntimes, hasAnyRuntimes, subscribe } from '../stores/javaStore.ts'
import { getAccounts } from '../api/account.ts'
import { getSystemInfo } from '../api/system.ts'
import type { GameInstance, JavaRuntime, Account, SystemInfo, ServerEntry, ServerState, LanGameEntry, MissingFile, GameSettingDto, FileEntry } from '../types/index.ts'
import { getServers, addServer, deleteServer, pingServer, getLanGames, getModsMetadata, enrichMods, getModsCount, getModsProgress, batchEnableMods, batchDisableMods, batchDeleteMods, getResourcePacksMetadata, getShadersMetadata, getSavesMetadata, getScreenshotsMetadata, getDataPacksMetadata, getModUpdatesCache, checkModUpdates, getSchematics, deleteSchematic, renameSchematic, importSchematic } from '../api/instance-files.ts'
import { ContextMenu, type ContextMenuItem } from '../components/ContextMenu.tsx'
import { MicrosoftReauthDialog } from '../components/MicrosoftReauthDialog.tsx'
import { ApiError } from '../api/client.ts'
import { AccountSelectDialog } from '../components/AccountSelectDialog.tsx'
import { NoAccountDialog } from '../components/NoAccountDialog.tsx'
import { InstanceIcon, ICON_NAMES } from '../components/InstanceIcon.tsx'
import { useRunning } from '../contexts/RunningContext.tsx'
import { PageShell } from '../components/PageShell.tsx'
import ModCard from '../components/ModCard.tsx'
import VersionPickerDialog from '../components/VersionPickerDialog.tsx'
import ModUpdateDialog from '../components/ModUpdateDialog.tsx'
import ExportModpackDialog from '../components/ExportModpackDialog.tsx'
import type { ModMetadata, ResourcePackMetadata, ShaderMetadata, SaveMetadata, ScreenshotMetadata, DataPackMetadata, ModUpdateEntry } from '../types/index.ts'
import ResourcePackCard from '../components/ResourcePackCard.tsx'
import DragSelectArea from '../components/DragSelectArea.tsx'
import ShaderCard from '../components/ShaderCard.tsx'
import SaveCard from '../components/SaveCard.tsx'
import ScreenshotCard from '../components/ScreenshotCard.tsx'
import DataPackCard from '../components/DataPackCard.tsx'
import { useRequireDefaultAccount } from '../hooks/useRequireDefaultAccount.ts'
import { useDebug } from '../components/DebugContext.tsx'
import { MinecraftText } from '../components/MinecraftText.tsx'
import { useI18n } from '../i18n/index.tsx'
import SchematicPreviewDialog from '../components/SchematicPreviewDialog.tsx'

/** 测试游戏的独立日志窗口 label（固定，重复点击先关旧的再开新的）。 */
const GAME_LOG_WINDOW_LABEL = 'game-log-window'

/** 独立日志窗口加载本 SPA 的地址（带 logWindow 分支参数）。 */
function logWindowUrl(instanceId: string): string {
  return `${window.location.origin}/?logWindow=1&instance=${encodeURIComponent(instanceId)}`
}

/**
 * 打开独立的游戏实时日志窗口（Tauri 原生子窗口，加载本 SPA 的 `?logWindow=1` 分支，
 * 与主窗口共用主题/字体）。Windows 下隐藏系统标题栏并渲染自定义标题栏（同主窗口做法）；
 * 非 Windows 保留系统标题栏。
 * 非 Tauri（纯浏览器 dev）退回 `window.open`。
 */
async function openLogWindow(instanceId: string): Promise<void> {
  try {
    const { WebviewWindow } = await import('@tauri-apps/api/webviewWindow')
    const existing = await WebviewWindow.getByLabel(GAME_LOG_WINDOW_LABEL)
    if (existing) await existing.close().catch(() => {})
    const isWindows = !navigator.userAgent.includes('Linux') && !navigator.userAgent.includes('Mac')
    // eslint-disable-next-line no-new
    new WebviewWindow(GAME_LOG_WINDOW_LABEL, {
      url: logWindowUrl(instanceId),
      title: '实时游戏日志',
      width: 780,
      height: 620,
      minWidth: 480,
      minHeight: 360,
      resizable: true,
      center: true,
      decorations: !isWindows,
    })
  } catch {
    window.open(logWindowUrl(instanceId), '_blank')
  }
}

const LOADER_COLORS: Record<string, string> = {
  forge: 'bg-orange-500/10 text-orange-500 border-orange-500/25',
  fabric: 'bg-cyan-500/10 text-cyan-400 border-cyan-400/25',
  legacyfabric: 'bg-cyan-500/10 text-cyan-400 border-cyan-400/25',
  neoforge: 'bg-green-500/10 text-green-500 border-green-500/25',
  quilt: 'bg-purple-500/10 text-purple-400 border-purple-400/25',
  cleanroom: 'bg-yellow-500/10 text-yellow-400 border-yellow-400/25',
  babric: 'bg-amber-500/10 text-amber-400 border-amber-400/25',
}

const TABS = [
  { id: 'overview', icon: faInfoCircle },
  { id: 'settings', icon: faSliders },
  { id: 'gamesettings', icon: faGamepad },
  { id: 'saves', icon: faSave },
  { id: 'screenshots', icon: faCamera },
  { id: 'mods', icon: faCube },
  { id: 'resourcepacks', icon: faBox },
  { id: 'shaderpacks', icon: faSun },
  { id: 'datapacks', icon: faDatabase },
  { id: 'schematics', icon: faDrawPolygon },
  { id: 'servers', icon: faServer },
] as const

function isQuickPlaySupported(gameVersion: string | undefined | null): boolean {
  if (!gameVersion) return false
  const parts = gameVersion.split('.').map(Number)
  if (parts.length < 2) return false
  return parts[0] > 1 || (parts[0] === 1 && parts[1] >= 20)
}

type TabId = typeof TABS[number]['id']

function formatPlayTime(minutes: number, t: (k: string, p?: Record<string, string | number>) => string): string {
  if (minutes < 60) return t('instanceDetail.time.minutes', { count: minutes })
  const hours = Math.floor(minutes / 60)
  const mins = minutes % 60
  return mins > 0 ? t('instanceDetail.time.hoursMinutes', { hours, minutes: mins }) : t('instanceDetail.time.hours', { count: hours })
}

function formatDate(iso: string | null, t: (k: string, p?: Record<string, string | number>) => string, lang: string): string {
  if (!iso) return t('instanceDetail.time.never')
  const d = new Date(iso)
  const now = new Date()
  const diff = now.getTime() - d.getTime()
  if (diff < 60000) return t('instanceDetail.time.justNow')
  if (diff < 3600000) return t('instanceDetail.time.minutesAgo', { count: Math.floor(diff / 60000) })
  if (diff < 86400000) return t('instanceDetail.time.hoursAgo', { count: Math.floor(diff / 3600000) })
  return d.toLocaleDateString(lang, { month: 'short', day: 'numeric', year: d.getFullYear() !== now.getFullYear() ? 'numeric' : undefined })
}

function ConfirmDialog({ open, title, message, onConfirm, onCancel, loading }: {
  open: boolean
  title: string
  message: string
  onConfirm: () => void
  onCancel: () => void
  loading?: boolean
}) {
  const { t } = useI18n()
  return (
    <Dialog open={open} onClose={onCancel}>
      <DialogHeader onClose={onCancel}><DialogTitle>{title}</DialogTitle></DialogHeader>
      <DialogBody><p className="text-sm text-muted-foreground">{message}</p></DialogBody>
      <DialogFooter>
        <Button variant="outline" size="sm" onClick={onCancel}>{t('instanceDetail.confirm.cancel')}</Button>
        <Button size="sm" variant="destructive" onClick={onConfirm} disabled={loading}>{loading ? t('instanceDetail.confirm.deleting') : t('instanceDetail.confirm.delete')}</Button>
      </DialogFooter>
    </Dialog>
  )
}

function SavesTab({ instanceId, gameDir, refreshKey, onRefresh: _onRefresh, onQuickJoinWorld, gameVersion, running }: { instanceId: string; gameDir: string; refreshKey: number; onRefresh: () => void; onQuickJoinWorld: (name: string) => void; gameVersion: string | undefined; running: boolean }) {
  const { t } = useI18n()
  const [search, setSearch] = useState('')
  const [saves, setSaves] = useState<SaveMetadata[]>([])
  const [loading, setLoading] = useState(true)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const lastClickedRef = useRef(-1)
  const [batchDeleteOpen, setBatchDeleteOpen] = useState(false)
  const [batchDeleting, setBatchDeleting] = useState(false)

  const load = useCallback(async () => {
    setSelected(new Set())
    setLoading(true)
    try { const data = await getSavesMetadata(instanceId); setSaves(data) }
    catch { setSaves([]) }
    setLoading(false)
  }, [instanceId])

  useEffect(() => { load() }, [load, refreshKey])

  const toggleSelect = useCallback((filePath: string, shift?: boolean, ctrl?: boolean) => {
    setSelected(prev => {
      const next = new Set(prev)
      if (ctrl) {
        if (next.has(filePath)) next.delete(filePath); else next.add(filePath)
      } else if (shift && lastClickedRef.current >= 0) {
        const start = Math.min(lastClickedRef.current, saves.findIndex(s => s.filePath === filePath))
        const end = Math.max(lastClickedRef.current, saves.findIndex(s => s.filePath === filePath))
        for (let i = start; i <= end; i++) next.add(saves[i].filePath)
      } else {
        next.clear(); next.add(filePath)
      }
      return next
    })
    lastClickedRef.current = saves.findIndex(s => s.filePath === filePath)
  }, [saves])

  const handleBatchDelete = useCallback(async () => {
    setBatchDeleting(true)
    const names = Array.from(selected).map(fp => fp.replace(/\\/g, '/').split('/').pop()!).filter(Boolean)
    try {
      const { deleteSave } = await import('../api/instance-files.ts')
      for (const name of names) {
        try { await deleteSave(instanceId, name) } catch {}
      }
    } catch {}
    setSelected(new Set())
    setBatchDeleteOpen(false)
    setBatchDeleting(false)
    load()
  }, [instanceId, selected, saves, load])

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
            <FontAwesomeIcon icon={faSave} className="mr-2 h-4 w-4 text-muted-foreground" />{t('instanceDetail.tabs.saves')}
            {saves.length > 0 && <span className="ml-1.5 text-xs font-normal text-muted-foreground">({saves.length})</span>}
          </h3>
          <div className="flex items-center gap-2 flex-1 max-w-sm">
            <div className="relative flex-1">
              <FontAwesomeIcon icon={faMagnifyingGlass} className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder={t('instanceDetail.saves.search')} className="h-8 pl-8 text-xs" />
            </div>
          </div>
          <div className="flex items-center gap-1.5">
            <Button size="sm" variant="ghost" onClick={() => openFolder(gameDir + '/saves').catch(() => {})} className="gap-1.5 h-7 text-xs">
              <FontAwesomeIcon icon={faFolderOpen} className="h-3.5 w-3.5" />{t('instanceDetail.openFolder')}
            </Button>
          </div>
        </div>
        {loading ? (
          <div className="flex items-center justify-center gap-2 py-8 text-sm text-muted-foreground">
            <FontAwesomeIcon icon={faRotate} className="h-4 w-4 animate-spin" />{t('instanceDetail.loading')}
          </div>
        ) : filtered.length === 0 ? (
          <div className="py-8 text-center text-sm text-muted-foreground">
            {search ? t('instanceDetail.saves.noMatch') : t('instanceDetail.saves.empty')}
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            {filtered.map((save) => (
              <SaveCard key={save.filePath} save={save} instanceId={instanceId} onRefresh={load} selected={selected.has(save.filePath)} onSelect={(e) => toggleSelect(save.filePath, e.shiftKey, e.ctrlKey)} onQuickJoin={isQuickPlaySupported(gameVersion) ? () => onQuickJoinWorld(save.name) : undefined} running={running} />
            ))}
          </div>
        )}
      </CardContent>
      <I18nBatchToolbar
        selectedCount={selected.size}
        onClear={() => setSelected(new Set())}
        onSelectAll={() => setSelected(new Set(filtered.map(s => s.filePath)))}
      >
        <Button variant="destructive" size="sm" onClick={() => setBatchDeleteOpen(true)}>
          <FontAwesomeIcon icon={faTrashCan} className="h-3.5 w-3.5" />
          {t('instanceDetail.deleteSelected', { count: selected.size })}
        </Button>
      </I18nBatchToolbar>
      <Dialog open={batchDeleteOpen} onClose={() => !batchDeleting && setBatchDeleteOpen(false)}>
        <DialogHeader onClose={() => !batchDeleting && setBatchDeleteOpen(false)}>
          <DialogTitle>{t('instanceDetail.batchDeleteTitle', { type: t('instanceDetail.saves.type') })}</DialogTitle>
        </DialogHeader>
        <DialogBody>
          <p className="text-sm text-muted-foreground">{t('instanceDetail.batchDeleteConfirm', { count: selected.size, type: t('instanceDetail.saves.type') })}</p>
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" size="sm" onClick={() => setBatchDeleteOpen(false)} disabled={batchDeleting}>{t('instanceDetail.confirm.cancel')}</Button>
          <Button size="sm" variant="destructive" onClick={handleBatchDelete} disabled={batchDeleting}>
            {batchDeleting ? t('instanceDetail.confirm.deleting') : t('instanceDetail.confirm.delete')}
          </Button>
        </DialogFooter>
      </Dialog>
    </Card>
  )
}

function ScreenshotsTab({ instanceId, gameDir, refreshKey, onRefresh: _onRefresh }: { instanceId: string; gameDir: string; refreshKey: number; onRefresh: () => void }) {
  const { t } = useI18n()
  const [search, setSearch] = useState('')
  const [screenshots, setScreenshots] = useState<ScreenshotMetadata[]>([])
  const [loading, setLoading] = useState(true)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const lastClickedRef = useRef(-1)
  const [batchDeleteOpen, setBatchDeleteOpen] = useState(false)
  const [batchDeleting, setBatchDeleting] = useState(false)

  const load = useCallback(async () => {
    setSelected(new Set())
    setLoading(true)
    try { const data = await getScreenshotsMetadata(instanceId); setScreenshots(data) }
    catch { setScreenshots([]) }
    setLoading(false)
  }, [instanceId])

  useEffect(() => { load() }, [load, refreshKey])

  const toggleSelect = useCallback((filePath: string, shift?: boolean, ctrl?: boolean) => {
    setSelected(prev => {
      const next = new Set(prev)
      if (ctrl) {
        if (next.has(filePath)) next.delete(filePath); else next.add(filePath)
      } else if (shift && lastClickedRef.current >= 0) {
        const start = Math.min(lastClickedRef.current, screenshots.findIndex(s => s.filePath === filePath))
        const end = Math.max(lastClickedRef.current, screenshots.findIndex(s => s.filePath === filePath))
        for (let i = start; i <= end; i++) next.add(screenshots[i].filePath)
      } else {
        next.clear(); next.add(filePath)
      }
      return next
    })
    lastClickedRef.current = screenshots.findIndex(s => s.filePath === filePath)
  }, [screenshots])

  const handleBatchDelete = useCallback(async () => {
    setBatchDeleting(true)
    const names = Array.from(selected).map(fp => screenshots.find(s => s.filePath === fp)?.fileName).filter((n): n is string => !!n)
    try {
      const { deleteScreenshot } = await import('../api/instance-files.ts')
      for (const name of names) {
        try { await deleteScreenshot(instanceId, name) } catch {}
      }
    } catch {}
    setSelected(new Set())
    setBatchDeleteOpen(false)
    setBatchDeleting(false)
    load()
  }, [instanceId, selected, screenshots, load])

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
            <FontAwesomeIcon icon={faCamera} className="mr-2 h-4 w-4 text-muted-foreground" />{t('instanceDetail.tabs.screenshots')}
            {screenshots.length > 0 && <span className="ml-1.5 text-xs font-normal text-muted-foreground">({screenshots.length})</span>}
          </h3>
          <div className="flex items-center gap-2 flex-1 max-w-sm">
            <div className="relative flex-1">
              <FontAwesomeIcon icon={faMagnifyingGlass} className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder={t('instanceDetail.screenshots.search')} className="h-8 pl-8 text-xs" />
            </div>
          </div>
          <div className="flex items-center gap-1.5">
            <Button size="sm" variant="ghost" onClick={() => openFolder(gameDir + '/screenshots').catch(() => {})} className="gap-1.5 h-7 text-xs">
              <FontAwesomeIcon icon={faFolderOpen} className="h-3.5 w-3.5" />{t('instanceDetail.openFolder')}
            </Button>
          </div>
        </div>
        {loading ? (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
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
            {search ? t('instanceDetail.screenshots.noMatch') : t('instanceDetail.screenshots.empty')}
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {filtered.map((s) => (
              <ScreenshotCard key={s.filePath} screenshot={s} instanceId={instanceId} onRefresh={load} selected={selected.has(s.filePath)} onSelect={(e) => toggleSelect(s.filePath, e.shiftKey, e.ctrlKey)} />
            ))}
          </div>
        )}
      </CardContent>
      <I18nBatchToolbar
        selectedCount={selected.size}
        onClear={() => setSelected(new Set())}
        onSelectAll={() => setSelected(new Set(filtered.map(s => s.filePath)))}
      >
        <Button variant="destructive" size="sm" onClick={() => setBatchDeleteOpen(true)}>
          <FontAwesomeIcon icon={faTrashCan} className="h-3.5 w-3.5" />
          {t('instanceDetail.deleteSelected', { count: selected.size })}
        </Button>
      </I18nBatchToolbar>
      <Dialog open={batchDeleteOpen} onClose={() => !batchDeleting && setBatchDeleteOpen(false)}>
        <DialogHeader onClose={() => !batchDeleting && setBatchDeleteOpen(false)}>
          <DialogTitle>{t('instanceDetail.batchDeleteTitle', { type: t('instanceDetail.screenshots.type') })}</DialogTitle>
        </DialogHeader>
        <DialogBody>
          <p className="text-sm text-muted-foreground">{t('instanceDetail.batchDeleteConfirm', { count: selected.size, type: t('instanceDetail.screenshots.type') })}</p>
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" size="sm" onClick={() => setBatchDeleteOpen(false)} disabled={batchDeleting}>{t('instanceDetail.confirm.cancel')}</Button>
          <Button size="sm" variant="destructive" onClick={handleBatchDelete} disabled={batchDeleting}>
            {batchDeleting ? t('instanceDetail.confirm.deleting') : t('instanceDetail.confirm.delete')}
          </Button>
        </DialogFooter>
      </Dialog>
    </Card>
  )
}

function ModsTab({ instanceId, gameVersion, loader, gameDir, refreshKey, onRefresh: _onRefresh }: {
  instanceId: string
  gameVersion?: string
  loader?: string
  gameDir: string
  refreshKey: number
  onRefresh: () => void
}) {
  const navigate = useNavigate()
  const { notify } = useMessageBox()
  const { t } = useI18n()
  const [search, setSearch] = useState('')
  const [mods, setMods] = useState<ModMetadata[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [loadProgress, setLoadProgress] = useState<{ current: number; total: number } | null>(null)
  const [versionDialogMod, setVersionDialogMod] = useState<ModMetadata | null>(null)
  const [updateDialogOpen, setUpdateDialogOpen] = useState(false)
  const [updates, setUpdates] = useState<ModUpdateEntry[]>([])
  // 蓝点标记 / updatable 筛选 / ModCard 右键更新，均由 updates 派生
  const updateFileNames = useMemo(() => new Set(updates.map(u => u.fileName)), [updates])
  const updateMap = useMemo(() => new Map(updates.map(u => [u.fileName, u])), [updates])

  const [filterType, setFilterType] = useState('all')
  const [sortBy, setSortBy] = useState('name-asc')

  const FILTER_OPTIONS = [
    { key: 'all', label: t('instanceDetail.mods.filterAll'), icon: faList },
    { key: 'active', label: t('instanceDetail.mods.enable'), icon: faCheck },
    { key: 'disabled', label: t('instanceDetail.mods.disable'), icon: faBan },
    { key: 'updatable', label: t('instanceDetail.mods.updatable'), icon: faArrowUp },
    { key: 'duplicate', label: t('instanceDetail.mods.duplicate'), icon: faClone },
  ]
  const SORT_OPTIONS = [
    { key: 'name-asc', label: t('instanceDetail.mods.sortNameAsc') },
    { key: 'name-desc', label: t('instanceDetail.mods.sortNameDesc') },
    { key: 'time-desc', label: t('instanceDetail.mods.sortTimeDesc') },
    { key: 'time-asc', label: t('instanceDetail.mods.sortTimeAsc') },
    { key: 'size-desc', label: t('instanceDetail.mods.sortSizeDesc') },
    { key: 'size-asc', label: t('instanceDetail.mods.sortSizeAsc') },
  ]

  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [batchConfirm, setBatchConfirm] = useState<{ type: 'enable' | 'disable' | 'delete' } | null>(null)
  const [batchProcessing, setBatchProcessing] = useState(false)
  const [updatingMods, setUpdatingMods] = useState(false)
  /** 远程信息反查（enrich）进行中：列表顶部显示加载提示 */
  const [enriching, setEnriching] = useState(false)

  const loadMods = useCallback(async () => {
    setSelected(new Set())
    setLoadError(null)
    const cacheKey = `api-instance-${instanceId}-mods`
    // enrich 合并（两段式第二步）：异步反查远程 id/图标，合并后回写缓存，
    // 使缓存命中场景（30s 内重复打开）也能拿到远程信息。
    const applyEnrich = async () => {
      setEnriching(true)
      try {
        const entries = await enrichMods(instanceId)
        const map = new Map(entries.map(e => [e.fileName, e]))
        setMods(prev => {
          const next = prev.map(m => {
            const e = map.get(m.fileName)
            if (!e) return m
            return {
              ...m,
              name: e.name ?? m.name,
              curseForgeId: e.curseForgeId ?? m.curseForgeId,
              modrinthId: e.modrinthId ?? m.modrinthId,
              modrinthVersionId: e.modrinthVersionId ?? m.modrinthVersionId,
              curseForgeFileId: e.curseForgeFileId ?? m.curseForgeFileId,
              source: e.source ?? m.source,
              iconUrl: e.iconUrl ?? m.iconUrl,
              chineseName: e.chineseName ?? m.chineseName,
              mcmodId: e.mcmodId ?? m.mcmodId,
            }
          })
          cacheSet(cacheKey, next)
          return next
        })
      } catch { /* 反查失败不影响列表 */ }
      finally { setEnriching(false) }
    }
    const fresh = cacheFresh<ModMetadata[]>(cacheKey)
    if (fresh) { setMods(fresh); setLoading(false); void applyEnrich(); return }
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
      void applyEnrich()
    } catch (e) {
      console.error('Load mods failed:', e)
      setMods([])
      setLoadError(e instanceof Error ? e.message : String(e))
    }
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

  // 列表加载后自动检查模组更新（受独立 6h 缓存门控）：
  // update-cache 读取最近一次结果并标记；仅当缓存缺失/过期时才联网检查。
  // 按钮打开 ModUpdateDialog 走 force=true（强制联网），不受本处门控影响。
  const updateCheckRanRef = useRef('')
  useEffect(() => {
    if (loading || mods.length === 0) return
    const key = `${instanceId}-${refreshKey}`
    if (updateCheckRanRef.current === key) return
    updateCheckRanRef.current = key
    void (async () => {
      try {
        const cache = await getModUpdatesCache(instanceId)
        setUpdates(cache.updates)
        if (!cache.stale) return
        notify(t('instanceDetail.mods.checkingUpdates'), 'info')
        const updates = await checkModUpdates(instanceId)
        setUpdates(updates)
        if (updates.length) notify(t('instanceDetail.mods.foundUpdates', { count: updates.length }), 'success')
      } catch { /* 检查失败静默 */ }
    })()
  }, [loading, mods.length, instanceId, refreshKey, notify, t])

  const filtered = useMemo(() => {
    let result = [...mods]
    const q = search.toLowerCase()
    if (q) result = result.filter(m =>
      m.name.toLowerCase().includes(q) ||
      (m.chineseName?.toLowerCase().includes(q)) ||
      m.fileName.toLowerCase().includes(q)
    )
    if (filterType === 'active') result = result.filter(m => m.active)
    else if (filterType === 'disabled') result = result.filter(m => !m.active)
    else if (filterType === 'updatable') result = result.filter(m => updateFileNames.has(m.fileName))
    else if (filterType === 'duplicate') {
      const seen = new Map<string, number>()
      result.forEach(m => seen.set(m.name.toLowerCase(), (seen.get(m.name.toLowerCase()) ?? 0) + 1))
      result = result.filter(m => (seen.get(m.name.toLowerCase()) ?? 0) > 1)
    }
    result.sort((a, b) => {
      if (sortBy === 'name-asc') return a.name.localeCompare(b.name)
      if (sortBy === 'name-desc') return b.name.localeCompare(a.name)
      if (sortBy === 'time-desc') return (b.lastModified ?? '').localeCompare(a.lastModified ?? '')
      if (sortBy === 'time-asc') return (a.lastModified ?? '').localeCompare(b.lastModified ?? '')
      if (sortBy === 'size-desc') return (b.fileSize ?? 0) - (a.fileSize ?? 0)
      if (sortBy === 'size-asc') return (a.fileSize ?? 0) - (b.fileSize ?? 0)
      return 0
    })
    return result
  }, [mods, search, filterType, sortBy, updateFileNames])

  const lastClickedRef = useRef(-1)
  const toggleSelect = useCallback((fileName: string, shift?: boolean, ctrl?: boolean) => {
    const index = filtered.findIndex(m => m.fileName === fileName)
    if (index === -1) return
    const prevLastClicked = lastClickedRef.current
    setSelected(prev => {
      const next = new Set(prev)
      if (shift && prevLastClicked >= 0) {
        const start = Math.min(prevLastClicked, index)
        const end = Math.max(prevLastClicked, index)
        for (let i = start; i <= end; i++)
          next.add(filtered[i].fileName)
      } else if (ctrl) {
        if (next.has(fileName)) next.delete(fileName); else next.add(fileName)
      } else {
        next.clear()
        next.add(fileName)
      }
      return next
    })
    lastClickedRef.current = index
  }, [filtered])

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
      setSelected(new Set())
    } catch (e) { console.error('Batch action failed:', e) }
    setBatchProcessing(false)
    setBatchConfirm(null)
  }, [batchConfirm, selected, instanceId, loadMods])

  // 悬浮工具条「更新模组」：仅更新当前选中且存在 update 条目的模组
  const handleUpdateSelected = useCallback(async () => {
    const toUpdate = updates.filter(u => selected.has(u.fileName)).map(u => ({
      ...u,
      // 后端 check-updates 已带图标；旧缓存缺失时回退 enrich 后的 mods 列表
      iconUrl: u.iconUrl ?? mods.find(m => m.fileName === u.fileName)?.iconUrl ?? undefined,
    }))
    if (toUpdate.length === 0) return
    setUpdatingMods(true)
    try {
      const result = await updateModsViaDownloadCenter(
        instanceId,
        toUpdate,
        (n) => notify(t('instanceDetail.mods.addedToDownload', { count: n }), 'success'),
        t
      )
      await loadMods()
      setSelected(new Set())
      setUpdates(prev => prev.filter(u => !result.succeededFileNames.includes(u.fileName)))
      const failNames = result.failedFileNames.length > 0 && result.failedFileNames.length <= 3
        ? `：${result.failedFileNames.join('、')}`
        : ''
      notify(
        result.failed === 0 ? t('instanceDetail.mods.updatedCount', { count: result.success }) : t('instanceDetail.mods.updateResult', { success: result.success, failed: result.failed, failures: failNames }),
        result.failed === 0 ? 'success' : 'error'
      )
    } catch { notify(t('instanceDetail.mods.updateFailed'), 'error') }
    setUpdatingMods(false)
  }, [updates, selected, instanceId, notify, t, loadMods])

  const updateTargets = updates.filter(u => selected.has(u.fileName))

  // 拖动框选：Shift 追加，普通替换（DragSelectArea 回调）
  const handleDragSelect = useCallback((names: string[], mode: 'replace' | 'add') => {
    setSelected(prev => {
      const next = new Set(prev)
      if (mode === 'add') {
        names.forEach(n => next.add(n))
      } else {
        next.clear()
        names.forEach(n => next.add(n))
      }
      return next
    })
  }, [])

  if (!loader) {
    return (
      <Card>
        <CardContent className="p-5">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
              <FontAwesomeIcon icon={faCube} className="h-5 w-5" />
            </div>
            <div>
              <h3 className="text-sm font-medium">{t('instanceDetail.mods.management')}</h3>
              <p className="mt-0.5 text-xs text-muted-foreground">{t('instanceDetail.mods.noModsHint')}</p>
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
              <FontAwesomeIcon icon={faCube} className="mr-2 h-4 w-4 text-muted-foreground" />Mod
              {mods.length > 0 && <span className="ml-1.5 text-xs font-normal text-muted-foreground">({mods.length})</span>}
            </h3>
            <div className="flex items-center gap-2 flex-1 max-w-sm">
              <div className="relative flex-1">
                <FontAwesomeIcon icon={faMagnifyingGlass} className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
                <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder={t('instanceDetail.mods.search')} className="h-8 pl-8 text-xs" />
              </div>
            </div>
            <div className="flex items-center gap-1.5">
              <Button size="sm" variant="ghost" onClick={() => openFolder(gameDir + '/mods').catch(() => {})} className="gap-1.5 h-7 text-xs">
                <FontAwesomeIcon icon={faFolderOpen} className="h-3.5 w-3.5" />{t('instanceDetail.openFolder')}
              </Button>
              <Button size="sm" variant="outline" onClick={() => setUpdateDialogOpen(true)} className="gap-1.5 h-7 text-xs">
                <FontAwesomeIcon icon={faDownload} className="h-3.5 w-3.5" />{t('instanceDetail.mods.checkUpdates')}
              </Button>
              <Button size="sm" onClick={() => {
                const p = new URLSearchParams({ category: 'mod', source: 'modrinth' })
                if (gameVersion) p.set('gameVersion', gameVersion)
                if (loader) p.set('loader', loader.toLowerCase())
                if (instanceId) p.set('instanceId', instanceId)
                navigate(`/resource-center?${p.toString()}`)
              }} className="gap-1.5 h-7 text-xs">
                <FontAwesomeIcon icon={faDownload} className="h-3.5 w-3.5" />{t('instanceDetail.mods.install')}
              </Button>
            </div>
          </div>

          <div className="mb-3 flex items-center justify-between gap-3">
            <Tabs
              tabs={FILTER_OPTIONS.map(o => ({ id: o.key, label: o.label, icon: <FontAwesomeIcon icon={o.icon} className="h-3 w-3" /> }))}
              activeTab={filterType}
              onChange={setFilterType}
              className="[&>button]:px-3 [&>button]:py-1.5 [&>button]:text-xs"
            />
            <Select value={sortBy} onChange={setSortBy} className="w-32">
              {SORT_OPTIONS.map((item) => (
                <SelectOption key={item.key} value={item.key}>{item.label}</SelectOption>
              ))}
            </Select>
          </div>

          {enriching && (
            <div className="mb-3 flex items-center gap-2 rounded-md border border-primary/20 bg-primary/5 px-3 py-2 text-xs text-muted-foreground">
              <FontAwesomeIcon icon={faRotate} className="h-3.5 w-3.5 animate-spin text-primary" />
              {t('instanceDetail.mods.fetchingRemoteInfo')}
            </div>
          )}

          {loading ? (
            <div className="space-y-3">
              {loadProgress && loadProgress.total > 0 && (
                <div className="space-y-1.5">
                  <div className="flex items-center justify-between text-xs text-muted-foreground">
                    <div className="flex items-center gap-2">
                      <FontAwesomeIcon icon={faRotate} className="h-3 w-3 animate-spin" />
                      {t('instanceDetail.mods.readingMods')}
                    </div>
                    <span className="tabular-nums">{Math.round(loadProgress.current / loadProgress.total * 100)}%</span>
                  </div>
                  <div className="h-1 w-full overflow-hidden rounded-full bg-muted">
                    <div className="h-full rounded-full bg-primary transition-all duration-300" style={{ width: `${Math.round(loadProgress.current / loadProgress.total * 100)}%` }} />
                  </div>
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
          ) : loadError ? (
            <div className="py-8 text-center text-sm text-destructive">
              {t('instanceDetail.mods.loadFailed', { error: loadError })}
            </div>
          ) : filtered.length === 0 ? (
            <div className="py-8 text-center text-sm text-muted-foreground">
              {search ? t('instanceDetail.mods.noMatch') : t('instanceDetail.mods.empty')}
            </div>
          ) : (
            <DragSelectArea onSelect={handleDragSelect}>
              <div className="flex flex-col gap-2">
                {filtered.map((mod) => (
                  <div key={mod.fileName} data-select-item={mod.fileName}>
                    <ModCard
                      mod={mod}
                      instanceId={instanceId}
                      gameVersion={gameVersion}
                      loader={loader}
                      onRefresh={loadMods}
                      onToggle={toggleModLocal}
                      onChangeVersion={setVersionDialogMod}
                      selected={selected.has(mod.fileName)}
                      onSelect={(fileName, shift, ctrl) => toggleSelect(fileName, shift, ctrl)}
                      update={updateMap.get(mod.fileName)}
                      onUpdated={(fn) => setUpdates(prev => prev.filter(u => u.fileName !== fn))}
                    />
                  </div>
                ))}
              </div>
            </DragSelectArea>
          )}
        </CardContent>
      </Card>

      <I18nBatchToolbar
        selectedCount={selected.size}
        onClear={() => setSelected(new Set())}
        onSelectAll={() => setSelected(new Set(filtered.map(m => m.fileName)))}
      >
        <Button variant="ghost" size="sm" onClick={() => setBatchConfirm({ type: 'enable' })}>{t('instanceDetail.mods.enable')}</Button>
        <Button variant="ghost" size="sm" onClick={() => setBatchConfirm({ type: 'disable' })}>{t('instanceDetail.mods.disable')}</Button>
        <Button variant="ghost" size="sm" onClick={handleUpdateSelected} disabled={updatingMods || updateTargets.length === 0} className="gap-1.5">
          {updatingMods ? <FontAwesomeIcon icon={faRotate} className="h-3.5 w-3.5 animate-spin" /> : <FontAwesomeIcon icon={faArrowUp} className="h-3.5 w-3.5" />}
          {t('instanceDetail.mods.updateMods')}
        </Button>
        <Button variant="destructive" size="sm" onClick={() => setBatchConfirm({ type: 'delete' })}>
          <FontAwesomeIcon icon={faTrashCan} className="h-3.5 w-3.5" />
          {t('instanceDetail.deleteSelected', { count: selected.size })}
        </Button>
      </I18nBatchToolbar>
      <Dialog open={batchConfirm !== null} onClose={() => setBatchConfirm(null)}>
        <DialogHeader onClose={() => setBatchConfirm(null)}>
          <DialogTitle>
            {batchConfirm?.type === 'enable' ? t('instanceDetail.mods.batchEnable') : batchConfirm?.type === 'disable' ? t('instanceDetail.mods.batchDisable') : t('instanceDetail.mods.batchDelete')}
          </DialogTitle>
        </DialogHeader>
        <DialogBody>
          <p className="text-sm text-muted-foreground">
            {t('instanceDetail.mods.batchConfirm', { action: batchConfirm?.type === 'enable' ? t('instanceDetail.mods.enable') : batchConfirm?.type === 'disable' ? t('instanceDetail.mods.disable') : t('instanceDetail.confirm.delete'), count: selected.size })}
            {batchConfirm?.type === 'delete' ? t('instanceDetail.mods.moveToRecycleBin') : ''}
          </p>
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" size="sm" onClick={() => setBatchConfirm(null)}>{t('instanceDetail.confirm.cancel')}</Button>
          <Button size="sm" variant={batchConfirm?.type === 'delete' ? 'destructive' : 'default'} onClick={handleBatchAction} disabled={batchProcessing}>
            {batchProcessing ? t('instanceDetail.mods.processing') : t('instanceDetail.confirm.confirm')}
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
      <ModUpdateDialog
        open={updateDialogOpen}
        onClose={() => setUpdateDialogOpen(false)}
        instanceId={instanceId}
        onDone={() => { setUpdates([]); loadMods() }}
        onUpdatesFound={(list) => setUpdates(list)}
      />
    </>
  )
}

function ResourcePacksTab({ instanceId, gameDir, gameVersion, loader, refreshKey, onRefresh: _onRefresh }: { instanceId: string; gameDir: string; gameVersion?: string; loader?: string; refreshKey: number; onRefresh: () => void }) {
  const navigate = useNavigate()
  const { t } = useI18n()
  const [search, setSearch] = useState('')
  const [packs, setPacks] = useState<ResourcePackMetadata[]>([])
  const [loading, setLoading] = useState(true)
  const { notify } = useMessageBox()
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const lastClickedRef = useRef(-1)
  const [batchDeleteOpen, setBatchDeleteOpen] = useState(false)
  const [batchDeleting, setBatchDeleting] = useState(false)

  const load = useCallback(async () => {
    setSelected(new Set())
    const cacheKey = `api-instance-${instanceId}-resourcepacks`
    const fresh = cacheFresh<ResourcePackMetadata[]>(cacheKey)
    if (fresh) { setPacks(fresh); setLoading(false); return }
    const stale = cacheGet<ResourcePackMetadata[]>(cacheKey)
    if (stale) { setPacks(stale); setLoading(false) }
    setLoading(true)
    try { const data = await getResourcePacksMetadata(instanceId); setPacks(data); cacheSet(cacheKey, data) }
    catch (e) {
      setPacks([])
      notify(t('instanceDetail.resourcepacks.loadFailed', { error: e instanceof ApiError ? e.displayMessage : t('instanceDetail.mods.unknownError') }), 'error')
    }
    setLoading(false)
  }, [instanceId, notify])

  useEffect(() => { load() }, [load, refreshKey])

  const toggleSelect = useCallback((fileName: string, shift?: boolean, ctrl?: boolean) => {
    setSelected(prev => {
      const next = new Set(prev)
      if (ctrl) {
        if (next.has(fileName)) next.delete(fileName); else next.add(fileName)
      } else if (shift && lastClickedRef.current >= 0) {
        const start = Math.min(lastClickedRef.current, packs.findIndex(p => p.fileName === fileName))
        const end = Math.max(lastClickedRef.current, packs.findIndex(p => p.fileName === fileName))
        for (let i = start; i <= end; i++) next.add(packs[i].fileName)
      } else {
        next.clear(); next.add(fileName)
      }
      return next
    })
    lastClickedRef.current = packs.findIndex(p => p.fileName === fileName)
  }, [packs])

  // 拖动框选：Shift 追加，普通替换
  const handleDragSelect = useCallback((names: string[], mode: 'replace' | 'add') => {
    setSelected(prev => {
      const next = new Set(prev)
      if (mode === 'add') {
        names.forEach(n => next.add(n))
      } else {
        next.clear()
        names.forEach(n => next.add(n))
      }
      return next
    })
  }, [])

  const handleBatchDelete = useCallback(async () => {
    setBatchDeleting(true)
    const names = Array.from(selected)
    try {
      const { deleteResourcePack } = await import('../api/instance-files.ts')
      for (const name of names) {
        try { await deleteResourcePack(instanceId, name) } catch {}
      }
    } catch {}
    setSelected(new Set())
    setBatchDeleteOpen(false)
    setBatchDeleting(false)
    load()
  }, [instanceId, selected, load])

  const filtered = useMemo(() => {
    if (!search) return packs
    const q = search.toLowerCase()
    return packs.filter(p => p.name.toLowerCase().includes(q) || p.fileName.toLowerCase().includes(q))
  }, [packs, search])

  return (
    <Card>
      <CardContent className="p-5">
        <div className="mb-3 flex items-center justify-between gap-3">
          <h3 className="text-sm font-medium shrink-0">
            <FontAwesomeIcon icon={faBox} className="mr-2 h-4 w-4 text-muted-foreground" />{t('instanceDetail.tabs.resourcepacks')}
            {packs.length > 0 && <span className="ml-1.5 text-xs font-normal text-muted-foreground">({packs.length})</span>}
          </h3>
          <div className="flex items-center gap-2 flex-1 max-w-sm">
            <div className="relative flex-1">
              <FontAwesomeIcon icon={faMagnifyingGlass} className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder={t('instanceDetail.resourcepacks.search')} className="h-8 pl-8 text-xs" />
            </div>
          </div>
          <div className="flex items-center gap-1.5">
            <Button size="sm" variant="ghost" onClick={() => openFolder(gameDir + '/resourcepacks').catch(() => {})} className="gap-1.5 h-7 text-xs">
              <FontAwesomeIcon icon={faFolderOpen} className="h-3.5 w-3.5" />{t('instanceDetail.openFolder')}
            </Button>
            <Button size="sm" onClick={() => {
              const p = new URLSearchParams({ category: 'resourcepack', source: 'modrinth' })
              if (gameVersion) p.set('gameVersion', gameVersion)
              if (loader) p.set('loader', loader.toLowerCase())
              if (instanceId) p.set('instanceId', instanceId)
              navigate(`/resource-center?${p.toString()}`)
            }} className="gap-1.5 h-7 text-xs">
              <FontAwesomeIcon icon={faDownload} className="h-3.5 w-3.5" />{t('instanceDetail.resourcepacks.install')}
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
            {search ? t('instanceDetail.resourcepacks.noMatch') : t('instanceDetail.resourcepacks.empty')}
          </div>
        ) : (
          <DragSelectArea onSelect={handleDragSelect}>
            <div className="flex flex-col gap-2">
              {filtered.map((pack) => (
                <div key={pack.fileName} data-select-item={pack.fileName}>
                  <ResourcePackCard pack={pack} instanceId={instanceId} gameDir={gameDir} gameVersion={gameVersion} loader={loader} onDelete={() => load()} selected={selected.has(pack.fileName)} onSelect={(e) => toggleSelect(pack.fileName, e.shiftKey, e.ctrlKey)} />
                </div>
              ))}
            </div>
          </DragSelectArea>
        )}
      </CardContent>
      <I18nBatchToolbar
        selectedCount={selected.size}
        onClear={() => setSelected(new Set())}
        onSelectAll={() => setSelected(new Set(filtered.map(p => p.fileName)))}
      >
        <Button variant="destructive" size="sm" onClick={() => setBatchDeleteOpen(true)}>
          <FontAwesomeIcon icon={faTrashCan} className="h-3.5 w-3.5" />
          {t('instanceDetail.deleteSelected', { count: selected.size })}
        </Button>
      </I18nBatchToolbar>
      <Dialog open={batchDeleteOpen} onClose={() => !batchDeleting && setBatchDeleteOpen(false)}>
        <DialogHeader onClose={() => !batchDeleting && setBatchDeleteOpen(false)}>
          <DialogTitle>{t('instanceDetail.batchDeleteTitle', { type: t('instanceDetail.resourcepacks.type') })}</DialogTitle>
        </DialogHeader>
        <DialogBody>
          <p className="text-sm text-muted-foreground">{t('instanceDetail.batchDeleteConfirm', { count: selected.size, type: t('instanceDetail.resourcepacks.type') })}</p>
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" size="sm" onClick={() => setBatchDeleteOpen(false)} disabled={batchDeleting}>{t('instanceDetail.confirm.cancel')}</Button>
          <Button size="sm" variant="destructive" onClick={handleBatchDelete} disabled={batchDeleting}>
            {batchDeleting ? t('instanceDetail.confirm.deleting') : t('instanceDetail.confirm.delete')}
          </Button>
        </DialogFooter>
      </Dialog>
    </Card>
  )
}

function ShadersTab({ instanceId, gameDir, gameVersion, loader, refreshKey, onRefresh: _onRefresh }: { instanceId: string; gameDir: string; gameVersion?: string; loader?: string; refreshKey: number; onRefresh: () => void }) {
  const navigate = useNavigate()
  const { t } = useI18n()
  const [search, setSearch] = useState('')
  const [shaders, setShaders] = useState<ShaderMetadata[]>([])
  const [loading, setLoading] = useState(true)
  const { notify } = useMessageBox()
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const lastClickedRef = useRef(-1)
  const [batchDeleteOpen, setBatchDeleteOpen] = useState(false)
  const [batchDeleting, setBatchDeleting] = useState(false)

  const load = useCallback(async () => {
    setSelected(new Set())
    const cacheKey = `api-instance-${instanceId}-shaders`
    const fresh = cacheFresh<ShaderMetadata[]>(cacheKey)
    if (fresh) { setShaders(fresh); setLoading(false); return }
    const stale = cacheGet<ShaderMetadata[]>(cacheKey)
    if (stale) { setShaders(stale); setLoading(false) }
    setLoading(true)
    try { const data = await getShadersMetadata(instanceId); setShaders(data); cacheSet(cacheKey, data) }
    catch (e) {
      setShaders([])
      notify(t('instanceDetail.shaderpacks.loadFailed', { error: e instanceof ApiError ? e.displayMessage : t('instanceDetail.mods.unknownError') }), 'error')
    }
    setLoading(false)
  }, [instanceId, notify])

  useEffect(() => { load() }, [load, refreshKey])

  const toggleSelect = useCallback((fileName: string, shift?: boolean, ctrl?: boolean) => {
    setSelected(prev => {
      const next = new Set(prev)
      if (ctrl) {
        if (next.has(fileName)) next.delete(fileName); else next.add(fileName)
      } else if (shift && lastClickedRef.current >= 0) {
        const start = Math.min(lastClickedRef.current, shaders.findIndex(s => s.fileName === fileName))
        const end = Math.max(lastClickedRef.current, shaders.findIndex(s => s.fileName === fileName))
        for (let i = start; i <= end; i++) next.add(shaders[i].fileName)
      } else {
        next.clear(); next.add(fileName)
      }
      return next
    })
    lastClickedRef.current = shaders.findIndex(s => s.fileName === fileName)
  }, [shaders])

  // 拖动框选：Shift 追加，普通替换
  const handleDragSelect = useCallback((names: string[], mode: 'replace' | 'add') => {
    setSelected(prev => {
      const next = new Set(prev)
      if (mode === 'add') {
        names.forEach(n => next.add(n))
      } else {
        next.clear()
        names.forEach(n => next.add(n))
      }
      return next
    })
  }, [])

  const handleBatchDelete = useCallback(async () => {
    setBatchDeleting(true)
    const names = Array.from(selected)
    try {
      const { deleteShaderPack } = await import('../api/instance-files.ts')
      for (const name of names) {
        try { await deleteShaderPack(instanceId, name) } catch {}
      }
    } catch {}
    setSelected(new Set())
    setBatchDeleteOpen(false)
    setBatchDeleting(false)
    load()
  }, [instanceId, selected, load])

  const filtered = useMemo(() => {
    if (!search) return shaders
    const q = search.toLowerCase()
    return shaders.filter(s => s.name.toLowerCase().includes(q) || s.fileName.toLowerCase().includes(q))
  }, [shaders, search])

  return (
    <Card>
      <CardContent className="p-5">
        <div className="mb-3 flex items-center justify-between gap-3">
          <h3 className="text-sm font-medium shrink-0">
            <FontAwesomeIcon icon={faSun} className="mr-2 h-4 w-4 text-muted-foreground" />{t('instanceDetail.tabs.shaderpacks')}
            {shaders.length > 0 && <span className="ml-1.5 text-xs font-normal text-muted-foreground">({shaders.length})</span>}
          </h3>
          <div className="flex items-center gap-2 flex-1 max-w-sm">
            <div className="relative flex-1">
              <FontAwesomeIcon icon={faMagnifyingGlass} className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder={t('instanceDetail.shaderpacks.search')} className="h-8 pl-8 text-xs" />
            </div>
          </div>
          <div className="flex items-center gap-1.5">
            <Button size="sm" variant="ghost" onClick={() => openFolder(gameDir + '/shaderpacks').catch(() => {})} className="gap-1.5 h-7 text-xs">
              <FontAwesomeIcon icon={faFolderOpen} className="h-3.5 w-3.5" />{t('instanceDetail.openFolder')}
            </Button>
            <Button size="sm" onClick={() => {
              const p = new URLSearchParams({ category: 'shader', source: 'modrinth' })
              if (gameVersion) p.set('gameVersion', gameVersion)
              if (loader) p.set('loader', loader.toLowerCase())
              if (instanceId) p.set('instanceId', instanceId)
              navigate(`/resource-center?${p.toString()}`)
            }} className="gap-1.5 h-7 text-xs">
              <FontAwesomeIcon icon={faDownload} className="h-3.5 w-3.5" />{t('instanceDetail.shaderpacks.install')}
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
            {search ? t('instanceDetail.shaderpacks.noMatch') : t('instanceDetail.shaderpacks.empty')}
          </div>
        ) : (
          <DragSelectArea onSelect={handleDragSelect}>
            <div className="flex flex-col gap-2">
              {filtered.map((shader) => (
                <div key={shader.fileName} data-select-item={shader.fileName}>
                  <ShaderCard shader={shader} instanceId={instanceId} gameDir={gameDir} gameVersion={gameVersion} loader={loader} onDelete={() => load()} selected={selected.has(shader.fileName)} onSelect={(e) => toggleSelect(shader.fileName, e.shiftKey, e.ctrlKey)} />
                </div>
              ))}
            </div>
          </DragSelectArea>
        )}
      </CardContent>
      <I18nBatchToolbar
        selectedCount={selected.size}
        onClear={() => setSelected(new Set())}
        onSelectAll={() => setSelected(new Set(filtered.map(s => s.fileName)))}
      >
        <Button variant="destructive" size="sm" onClick={() => setBatchDeleteOpen(true)}>
          <FontAwesomeIcon icon={faTrashCan} className="h-3.5 w-3.5" />
          {t('instanceDetail.deleteSelected', { count: selected.size })}
        </Button>
      </I18nBatchToolbar>
      <Dialog open={batchDeleteOpen} onClose={() => !batchDeleting && setBatchDeleteOpen(false)}>
        <DialogHeader onClose={() => !batchDeleting && setBatchDeleteOpen(false)}>
          <DialogTitle>{t('instanceDetail.batchDeleteTitle', { type: t('instanceDetail.shaderpacks.type') })}</DialogTitle>
        </DialogHeader>
        <DialogBody>
          <p className="text-sm text-muted-foreground">{t('instanceDetail.batchDeleteConfirm', { count: selected.size, type: t('instanceDetail.shaderpacks.type') })}</p>
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" size="sm" onClick={() => setBatchDeleteOpen(false)} disabled={batchDeleting}>{t('instanceDetail.confirm.cancel')}</Button>
          <Button size="sm" variant="destructive" onClick={handleBatchDelete} disabled={batchDeleting}>
            {batchDeleting ? t('instanceDetail.confirm.deleting') : t('instanceDetail.confirm.delete')}
          </Button>
        </DialogFooter>
      </Dialog>
    </Card>
  )
}

function DataPacksTab({ instanceId, gameDir, gameVersion, loader, refreshKey, onRefresh: _onRefresh }: { instanceId: string; gameDir: string; gameVersion?: string; loader?: string; refreshKey: number; onRefresh: () => void }) {
  const navigate = useNavigate()
  const { t } = useI18n()
  const [search, setSearch] = useState('')
  const [packs, setPacks] = useState<DataPackMetadata[]>([])
  const [loading, setLoading] = useState(true)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const lastClickedRef = useRef(-1)
  const [batchDeleteOpen, setBatchDeleteOpen] = useState(false)
  const [batchDeleting, setBatchDeleting] = useState(false)

  const load = useCallback(async () => {
    setSelected(new Set())
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

  const toggleSelect = useCallback((fileName: string, shift?: boolean, ctrl?: boolean) => {
    setSelected(prev => {
      const next = new Set(prev)
      if (ctrl) {
        if (next.has(fileName)) next.delete(fileName); else next.add(fileName)
      } else if (shift && lastClickedRef.current >= 0) {
        const start = Math.min(lastClickedRef.current, packs.findIndex(p => p.fileName === fileName))
        const end = Math.max(lastClickedRef.current, packs.findIndex(p => p.fileName === fileName))
        for (let i = start; i <= end; i++) next.add(packs[i].fileName)
      } else {
        next.clear(); next.add(fileName)
      }
      return next
    })
    lastClickedRef.current = packs.findIndex(p => p.fileName === fileName)
  }, [packs])

  // 拖动框选：Shift 追加，普通替换
  const handleDragSelect = useCallback((names: string[], mode: 'replace' | 'add') => {
    setSelected(prev => {
      const next = new Set(prev)
      if (mode === 'add') {
        names.forEach(n => next.add(n))
      } else {
        next.clear()
        names.forEach(n => next.add(n))
      }
      return next
    })
  }, [])

  const handleBatchDelete = useCallback(async () => {
    setBatchDeleting(true)
    const names = Array.from(selected)
    try {
      const { deleteDataPack } = await import('../api/instance-files.ts')
      for (const name of names) {
        try { await deleteDataPack(instanceId, name) } catch {}
      }
    } catch {}
    setSelected(new Set())
    setBatchDeleteOpen(false)
    setBatchDeleting(false)
    load()
  }, [instanceId, selected, load])

  const filtered = useMemo(() => {
    if (!search) return packs
    const q = search.toLowerCase()
    return packs.filter(p => p.name.toLowerCase().includes(q) || p.fileName.toLowerCase().includes(q))
  }, [packs, search])

  return (
    <Card>
      <CardContent className="p-5">
        <div className="mb-3 flex items-center justify-between gap-3">
          <h3 className="text-sm font-medium shrink-0">
            <FontAwesomeIcon icon={faDatabase} className="mr-2 h-4 w-4 text-muted-foreground" />{t('instanceDetail.tabs.datapacks')}
            {packs.length > 0 && <span className="ml-1.5 text-xs font-normal text-muted-foreground">({packs.length})</span>}
          </h3>
          <div className="flex items-center gap-2 flex-1 max-w-sm">
            <div className="relative flex-1">
              <FontAwesomeIcon icon={faMagnifyingGlass} className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder={t('instanceDetail.datapacks.search')} className="h-8 pl-8 text-xs" />
            </div>
          </div>
          <div className="flex items-center gap-1.5">
            <Button size="sm" variant="ghost" onClick={() => openFolder(gameDir + '/datapacks').catch(() => {})} className="gap-1.5 h-7 text-xs">
              <FontAwesomeIcon icon={faFolderOpen} className="h-3.5 w-3.5" />{t('instanceDetail.openFolder')}
            </Button>
            <Button size="sm" onClick={() => {
              const p = new URLSearchParams({ category: 'datapack', source: 'modrinth' })
              if (gameVersion) p.set('gameVersion', gameVersion)
              if (loader) p.set('loader', loader.toLowerCase())
              if (instanceId) p.set('instanceId', instanceId)
              navigate(`/resource-center?${p.toString()}`)
            }} className="gap-1.5 h-7 text-xs">
              <FontAwesomeIcon icon={faDownload} className="h-3.5 w-3.5" />{t('instanceDetail.datapacks.install')}
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
            {search ? t('instanceDetail.datapacks.noMatch') : t('instanceDetail.datapacks.empty')}
          </div>
        ) : (
          <DragSelectArea onSelect={handleDragSelect}>
            <div className="flex flex-col gap-2">
              {filtered.map((pack) => (
                <div key={pack.fileName} data-select-item={pack.fileName}>
                  <DataPackCard pack={pack} instanceId={instanceId} gameDir={gameDir} gameVersion={gameVersion} loader={loader} onDelete={() => load()} selected={selected.has(pack.fileName)} onSelect={(e) => toggleSelect(pack.fileName, e.shiftKey, e.ctrlKey)} />
                </div>
              ))}
            </div>
          </DragSelectArea>
        )}
      </CardContent>
      <I18nBatchToolbar
        selectedCount={selected.size}
        onClear={() => setSelected(new Set())}
        onSelectAll={() => setSelected(new Set(filtered.map(p => p.fileName)))}
      >
        <Button variant="destructive" size="sm" onClick={() => setBatchDeleteOpen(true)}>
          <FontAwesomeIcon icon={faTrashCan} className="h-3.5 w-3.5" />
          {t('instanceDetail.deleteSelected', { count: selected.size })}
        </Button>
      </I18nBatchToolbar>
      <Dialog open={batchDeleteOpen} onClose={() => !batchDeleting && setBatchDeleteOpen(false)}>
        <DialogHeader onClose={() => !batchDeleting && setBatchDeleteOpen(false)}>
          <DialogTitle>{t('instanceDetail.batchDeleteTitle', { type: t('instanceDetail.datapacks.type') })}</DialogTitle>
        </DialogHeader>
        <DialogBody>
          <p className="text-sm text-muted-foreground">{t('instanceDetail.batchDeleteConfirm', { count: selected.size, type: t('instanceDetail.datapacks.type') })}</p>
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" size="sm" onClick={() => setBatchDeleteOpen(false)} disabled={batchDeleting}>{t('instanceDetail.confirm.cancel')}</Button>
          <Button size="sm" variant="destructive" onClick={handleBatchDelete} disabled={batchDeleting}>
            {batchDeleting ? t('instanceDetail.confirm.deleting') : t('instanceDetail.confirm.delete')}
          </Button>
        </DialogFooter>
      </Dialog>
    </Card>
  )
}

function SchematicsTab({ instanceId, gameDir, refreshKey, onRefresh: _onRefresh }: { instanceId: string; gameDir: string; refreshKey: number; onRefresh: () => void }) {
  const { t } = useI18n()
  const { notify } = useMessageBox()
  const [search, setSearch] = useState('')
  const [files, setFiles] = useState<FileEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const lastClickedRef = useRef(-1)
  const [batchDeleteOpen, setBatchDeleteOpen] = useState(false)
  const [batchDeleting, setBatchDeleting] = useState(false)
  const [importing, setImporting] = useState(false)
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const [previewFile, setPreviewFile] = useState<string | null>(null)
  const [renameTarget, setRenameTarget] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const [renaming, setRenaming] = useState(false)

  const load = useCallback(async () => {
    setSelected(new Set())
    setLoading(true)
    try { const data = await getSchematics(instanceId); setFiles(data.filter((f) => !f.isDirectory).sort((a, b) => b.lastModified.localeCompare(a.lastModified))) }
    catch { setFiles([]) }
    setLoading(false)
  }, [instanceId])

  useEffect(() => { load() }, [load, refreshKey])

  const toggleSelect = useCallback((fileName: string, shift?: boolean, ctrl?: boolean) => {
    setSelected(prev => {
      const next = new Set(prev)
      if (ctrl) {
        if (next.has(fileName)) next.delete(fileName); else next.add(fileName)
      } else if (shift && lastClickedRef.current >= 0) {
        const start = Math.min(lastClickedRef.current, files.findIndex(f => f.name === fileName))
        const end = Math.max(lastClickedRef.current, files.findIndex(f => f.name === fileName))
        for (let i = start; i <= end; i++) next.add(files[i].name)
      } else {
        next.clear(); next.add(fileName)
      }
      return next
    })
    lastClickedRef.current = files.findIndex(f => f.name === fileName)
  }, [files])

  const handleImport = useCallback(async (file: File) => {
    setImporting(true)
    try {
      await importSchematic(instanceId, file)
      notify(t('instanceDetail.schematics.imported', { name: file.name }), 'success')
      load()
    } catch (e) {
      notify(t('instanceDetail.schematics.importFailed') + ': ' + (e instanceof ApiError ? e.displayMessage : String(e)), 'error')
    }
    setImporting(false)
  }, [instanceId, load, notify, t])

  const handleDeleteOne = useCallback(async (name: string) => {
    try { await deleteSchematic(instanceId, name); load() }
    catch (e) { notify(t('instanceDetail.schematics.deleteFailed') + ': ' + (e instanceof ApiError ? e.displayMessage : String(e)), 'error') }
  }, [instanceId, load, notify, t])

  const handleRename = useCallback(async () => {
    if (!renameTarget || !renameValue.trim() || renameValue === renameTarget) {
      setRenameTarget(null)
      return
    }
    setRenaming(true)
    try {
      await renameSchematic(instanceId, renameTarget, renameValue.trim())
      notify(t('instanceDetail.schematics.renamed', { name: renameValue }), 'success')
      setRenameTarget(null)
      load()
    } catch (e) {
      notify(t('instanceDetail.schematics.renameFailed') + ': ' + (e instanceof ApiError ? e.displayMessage : String(e)), 'error')
    }
    setRenaming(false)
  }, [instanceId, renameTarget, renameValue, load, notify, t])

  const handleBatchDelete = useCallback(async () => {
    setBatchDeleting(true)
    try {
      for (const name of Array.from(selected)) {
        try { await deleteSchematic(instanceId, name) } catch {}
      }
    } catch {}
    setSelected(new Set())
    setBatchDeleteOpen(false)
    setBatchDeleting(false)
    load()
  }, [instanceId, selected, load])

  const filtered = useMemo(() => {
    if (!search) return files
    const q = search.toLowerCase()
    return files.filter(f => f.name.toLowerCase().includes(q))
  }, [files, search])

  return (
    <Card>
      <CardContent className="p-5">
        <div className="mb-3 flex items-center justify-between gap-3">
          <h3 className="text-sm font-medium shrink-0">
            <FontAwesomeIcon icon={faDrawPolygon} className="mr-2 h-4 w-4 text-muted-foreground" />{t('instanceDetail.tabs.schematics')}
            {files.length > 0 && <span className="ml-1.5 text-xs font-normal text-muted-foreground">({files.length})</span>}
          </h3>
          <div className="flex items-center gap-2 flex-1 max-w-sm">
            <div className="relative flex-1">
              <FontAwesomeIcon icon={faMagnifyingGlass} className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder={t('instanceDetail.schematics.search')} className="h-8 pl-8 text-xs" />
            </div>
          </div>
          <div className="flex items-center gap-1.5">
            <Button size="sm" variant="ghost" onClick={() => openFolder(gameDir + '/schematics').catch(() => {})} className="gap-1.5 h-7 text-xs">
              <FontAwesomeIcon icon={faFolderOpen} className="h-3.5 w-3.5" />{t('instanceDetail.openFolder')}
            </Button>
            <Button size="sm" onClick={() => fileInputRef.current?.click()} disabled={importing} className="gap-1.5 h-7 text-xs">
              {importing ? <FontAwesomeIcon icon={faRotate} className="h-3.5 w-3.5 animate-spin" /> : <FontAwesomeIcon icon={faUpload} className="h-3.5 w-3.5" />}
              {t('instanceDetail.schematics.import')}
            </Button>
            <input
              ref={fileInputRef}
              type="file"
              accept=".litematic,.schematic,.schem,.nbt"
              multiple
              className="hidden"
              onChange={(e) => {
                const filesToImport = Array.from(e.target.files ?? [])
                e.target.value = ''
                for (const f of filesToImport) void handleImport(f)
              }}
            />
          </div>
        </div>
        {loading ? (
          <div className="flex items-center justify-center gap-2 py-8 text-sm text-muted-foreground">
            <FontAwesomeIcon icon={faRotate} className="h-4 w-4 animate-spin" />{t('instanceDetail.loading')}
          </div>
        ) : filtered.length === 0 ? (
          <div className="py-8 text-center text-sm text-muted-foreground">
            {search ? t('instanceDetail.schematics.noMatch') : t('instanceDetail.schematics.empty')}
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            {filtered.map((f) => (
              <div
                key={f.name}
                onClick={(e) => toggleSelect(f.name, e.shiftKey, e.ctrlKey)}
                className={cn(
                  'group glass-surface flex cursor-pointer items-center gap-3 rounded-xl border p-3 transition-all',
                  selected.has(f.name) ? 'border-primary/50 bg-primary/5' : 'border-border/60 bg-card hover:border-primary/20 hover:shadow-sm'
                )}
              >
                <div className={cn('flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors', selected.has(f.name) ? 'bg-primary/10 text-primary' : 'bg-muted/60 group-hover:text-primary')}>
                  <FontAwesomeIcon icon={faDrawPolygon} className="h-4 w-4" />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium">{f.name}</div>
                  <div className="mt-0.5 flex items-center gap-2 text-xs text-muted-foreground">
                    <span>{(f.size / 1024).toFixed(f.size >= 1024 * 1024 ? 1 : 0)}{f.size >= 1024 * 1024 ? ' MB' : ' KB'}</span>
                    <span className="text-border">·</span>
                    <span>{new Date(f.lastModified).toLocaleString()}</span>
                    {f.extension === 'litematic' && (
                      <span className="rounded border px-1 py-px text-[10px] text-muted-foreground/70">litematic</span>
                    )}
                  </div>
                </div>
                <div className="flex items-center gap-0.5 shrink-0">
                  <Tooltip content={t('instanceDetail.schematics.preview')}>
                    <button aria-label={t('instanceDetail.schematics.preview')} onClick={(e) => { e.stopPropagation(); setPreviewFile(f.name) }} className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-primary/10 hover:text-primary">
                      <FontAwesomeIcon icon={faEye} className="h-3.5 w-3.5" />
                    </button>
                  </Tooltip>
                  <Tooltip content={t('instanceDetail.schematics.rename')}>
                    <button aria-label={t('instanceDetail.schematics.rename')} onClick={(e) => { e.stopPropagation(); setRenameTarget(f.name); setRenameValue(f.name) }} className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground">
                      <FontAwesomeIcon icon={faPen} className="h-3.5 w-3.5" />
                    </button>
                  </Tooltip>
                  <Tooltip content={t('instanceDetail.schematics.delete')}>
                    <button aria-label={t('instanceDetail.schematics.delete')} onClick={(e) => { e.stopPropagation(); handleDeleteOne(f.name) }} className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-destructive/10 hover:text-destructive">
                      <FontAwesomeIcon icon={faTrashCan} className="h-3.5 w-3.5" />
                    </button>
                  </Tooltip>
                </div>
              </div>
            ))}
          </div>
        )}
      </CardContent>
      <I18nBatchToolbar
        selectedCount={selected.size}
        onClear={() => setSelected(new Set())}
        onSelectAll={() => setSelected(new Set(filtered.map(f => f.name)))}
      >
        <Button variant="destructive" size="sm" onClick={() => setBatchDeleteOpen(true)}>
          <FontAwesomeIcon icon={faTrashCan} className="h-3.5 w-3.5" />
          {t('instanceDetail.deleteSelected', { count: selected.size })}
        </Button>
      </I18nBatchToolbar>
      <Dialog open={batchDeleteOpen} onClose={() => !batchDeleting && setBatchDeleteOpen(false)}>
        <DialogHeader onClose={() => !batchDeleting && setBatchDeleteOpen(false)}>
          <DialogTitle>{t('instanceDetail.batchDeleteTitle', { type: t('instanceDetail.schematics.type') })}</DialogTitle>
        </DialogHeader>
        <DialogBody>
          <p className="text-sm text-muted-foreground">{t('instanceDetail.batchDeleteConfirm', { count: selected.size, type: t('instanceDetail.schematics.type') })}</p>
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" size="sm" onClick={() => setBatchDeleteOpen(false)} disabled={batchDeleting}>{t('instanceDetail.confirm.cancel')}</Button>
          <Button size="sm" variant="destructive" onClick={handleBatchDelete} disabled={batchDeleting}>
            {batchDeleting ? t('instanceDetail.confirm.deleting') : t('instanceDetail.confirm.delete')}
          </Button>
        </DialogFooter>
      </Dialog>
      <Dialog open={renameTarget !== null} onClose={() => setRenameTarget(null)}>
        <DialogHeader onClose={() => setRenameTarget(null)}><DialogTitle>{t('instanceDetail.schematics.renameTitle')}</DialogTitle></DialogHeader>
        <DialogBody className="space-y-3">
          <div className="space-y-1.5">
            <Label className="text-xs">{t('instanceDetail.schematics.renamePlaceholder')}</Label>
            <Input
              value={renameValue}
              onChange={(e) => setRenameValue(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') void handleRename() }}
              autoFocus
            />
          </div>
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" size="sm" onClick={() => setRenameTarget(null)} disabled={renaming}>{t('instanceDetail.confirm.cancel')}</Button>
          <Button size="sm" onClick={() => void handleRename()} disabled={renaming || !renameValue.trim() || renameValue === renameTarget}>
            {renaming ? t('instanceDetail.confirm.deleting') : t('instanceDetail.confirm.confirm')}
          </Button>
        </DialogFooter>
      </Dialog>
      <SchematicPreviewDialog
        open={previewFile !== null}
        instanceId={instanceId}
        fileName={previewFile ?? ''}
        onClose={() => setPreviewFile(null)}
      />
    </Card>
  )
}

function ServersTab({ instanceId, refreshKey, onRefresh: _onRefresh, onQuickJoinServer }: { instanceId: string; refreshKey: number; onRefresh: () => void; onQuickJoinServer: (ip: string) => void }) {
  const { t } = useI18n()
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
    try {
      const data = await getServers(instanceId)
      setServers(data)
      setLoading(false)
      const pingTasks = data.map(async (s) => {
        try {
          const state = await pingServer(instanceId, s.ip)
          setPingStates(p => ({ ...p, [s.ip]: state }))
        } catch {}
      })
      await Promise.allSettled(pingTasks)
    }
    catch (e) {
      setServers([])
      setLoading(false)
      notify(t('instanceDetail.servers.loadFailed') + ': ' + (e instanceof ApiError ? e.displayMessage : t('instanceDetail.mods.unknownError')), 'error')
    }
  }, [instanceId, notify, t])

  useEffect(() => { load() }, [load, refreshKey])

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
      notify(t('instanceDetail.servers.deleted'), 'success')
      load()
    } catch (e) {
      notify(t('instanceDetail.servers.deleteFailed') + ': ' + (e instanceof ApiError ? e.displayMessage : t('instanceDetail.mods.unknownError')), 'error')
    }
  }, [instanceId, load, notify, t])

  const handleAdd = useCallback(async () => {
    if (!addName || !addIp) return
    setAdding(true)
    try {
      await addServer(instanceId, addName, addIp)
      notify(editServer ? t('instanceDetail.servers.updated', { name: addName }) : t('instanceDetail.servers.added', { name: addName }), 'success')
      load(); setShowAdd(false); setAddName(''); setAddIp(''); setEditServer(null)
    } catch (e) {
      notify(t('instanceDetail.servers.opFailed') + ': ' + (e instanceof ApiError ? e.displayMessage : t('instanceDetail.mods.unknownError')), 'error')
    }
    setAdding(false)
  }, [instanceId, addName, addIp, load, notify, t, editServer])

  const handleEdit = useCallback((s: ServerEntry) => {
    setEditServer(s)
    setAddName(s.name)
    setAddIp(s.ip)
    setShowAdd(true)
  }, [])

  const handleCopyIp = useCallback(async (ip: string) => {
    try {
      await navigator.clipboard.writeText(ip)
      notify(t('instanceDetail.servers.copiedIp'), 'success')
    } catch {
      notify(t('instanceDetail.servers.copyFailed'), 'error')
    }
  }, [notify, t])

  const handlePing = useCallback(async (address: string) => {
    try {
      const state = await pingServer(instanceId, address)
      setPingStates(p => ({ ...p, [address]: state }))
      notify(state.isOnline ? t('instanceDetail.servers.pingDone', { ping: state.ping }) : t('instanceDetail.servers.addressOffline', { address }), state.isOnline ? 'success' : 'warning')
    } catch (e) {
      notify(t('instanceDetail.servers.pingFailed'), 'error')
    }
  }, [instanceId, notify, t])

  return (
    <>
      <Card>
        <CardContent className="p-5">
          <div className="mb-3 flex items-center justify-between gap-3">
            <h3 className="text-sm font-medium shrink-0">
              <FontAwesomeIcon icon={faGlobe} className="mr-2 h-4 w-4 text-muted-foreground" />{t('instanceDetail.tabs.servers')}
              {servers.length > 0 && <span className="ml-1.5 text-xs font-normal text-muted-foreground">({servers.length})</span>}
            </h3>
            <div className="flex items-center gap-2 flex-1 max-w-sm">
              <div className="relative flex-1">
                <FontAwesomeIcon icon={faMagnifyingGlass} className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
                <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder={t('instanceDetail.servers.search')} className="h-8 pl-8 text-xs" />
              </div>
            </div>
            <div className="flex items-center gap-1.5">
              <Tooltip content={t('instanceDetail.servers.pingAll')}>
                <Button size="sm" variant="ghost" onClick={() => {
                  servers.forEach(s => handlePing(s.ip))
                }} className="h-7 w-7 px-0">
                  <FontAwesomeIcon icon={faWifi} className="h-3.5 w-3.5" />
                </Button>
              </Tooltip>
              <Button size="sm" onClick={() => setShowAdd(true)} className="gap-1.5 h-7 text-xs">
                <FontAwesomeIcon icon={faPlus} className="h-3.5 w-3.5" />{t('instanceDetail.servers.addServer')}
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
              {search ? t('instanceDetail.servers.noMatch') : t('instanceDetail.servers.empty')}
            </div>
          ) : (
            <div className="space-y-2">
              {filtered.map((s, i) => {
                const ps = pingStates[s.ip]
                const contextItems: ContextMenuItem[] = [
                  { label: t('instanceDetail.servers.edit'), onClick: () => handleEdit(s) },
                  { label: t('instanceDetail.servers.ping'), onClick: () => handlePing(s.ip) },
                  { label: t('instanceDetail.servers.copyIp'), onClick: () => handleCopyIp(s.ip) },
                  { label: t('instanceDetail.servers.quickJoin'), onClick: () => onQuickJoinServer(s.ip) },
                  { label: t('instanceDetail.servers.delete'), onClick: () => setConfirmIp(s.ip), danger: true },
                ]
                return (
                  <ContextMenu key={i} items={contextItems}>
                    <Card className="group border-border/60 bg-card/95 transition-all hover:border-primary/20 hover:shadow-sm">
                      <CardContent className="flex items-start gap-3 p-4">
                        <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-muted text-muted-foreground overflow-hidden">
                          {(ps?.iconBase64 || s.iconBase64) ? (
                            <img src={`data:image/png;base64,${ps?.iconBase64 || s.iconBase64}`} alt={s.name} className="h-full w-full object-cover" loading="lazy" />
                          ) : (
                            <FontAwesomeIcon icon={faServer} className="h-5 w-5 opacity-50" />
                          )}
                        </div>
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2">
                            <h3 className="font-semibold text-sm">{s.name}</h3>
                            {ps ? (
                              <span className={`inline-flex items-center gap-1 text-xs font-medium ${ps.isOnline ? 'text-green-500' : 'text-red-500'}`}>
                                <span className={`inline-block w-2 h-2 rounded-full ${ps.isOnline ? 'bg-green-500' : 'bg-red-500'}`} />
                                {ps.isOnline ? `${ps.ping}ms` : t('instanceDetail.servers.offline')}
                              </span>
                            ) : (
                              <span className="inline-flex items-center gap-1 text-xs font-medium text-muted-foreground">
                                <span className="inline-block w-2 h-2 rounded-full bg-muted-foreground/40 animate-pulse" />
                                {t('instanceDetail.servers.pinging')}
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
                            <p className="mt-1 text-xs text-muted-foreground/70 whitespace-pre-line leading-relaxed">
                              <MinecraftText text={ps.description} />
                            </p>
                          )}
                        </div>
                        <div className="flex items-center gap-0.5 shrink-0">
                          <Tooltip content={t('instanceDetail.servers.edit')}>
                            <button onClick={() => handleEdit(s)} className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground">
                              <FontAwesomeIcon icon={faPen} className="h-3.5 w-3.5" />
                            </button>
                          </Tooltip>
                          <Tooltip content={t('instanceDetail.servers.copyIp')}>
                            <button onClick={() => handleCopyIp(s.ip)} className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground">
                              <FontAwesomeIcon icon={faClipboard} className="h-3.5 w-3.5" />
                            </button>
                          </Tooltip>
                          <Tooltip content={t('instanceDetail.servers.quickJoin')}>
                            <button onClick={() => onQuickJoinServer(s.ip)} className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-primary/10 hover:text-primary">
                              <FontAwesomeIcon icon={faPlay} className="h-3.5 w-3.5" />
                            </button>
                          </Tooltip>
                          <Tooltip content={t('instanceDetail.servers.delete')}>
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
                <FontAwesomeIcon icon={faWifi} className="h-3.5 w-3.5 text-muted-foreground" />
                <span className="text-xs font-medium text-muted-foreground">{t('instanceDetail.servers.lanGames', { count: lanGames.length })}</span>
              </div>
              <div className="space-y-2">
                {lanGames.map((g, i) => (
                  <Card key={`${g.ip}:${g.port}-${i}`} className="group border-dashed border-border/60 bg-card/95 transition-all hover:border-primary/20 hover:shadow-sm">
                    <CardContent className="flex items-start gap-3 p-4">
                      <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-muted/50 text-muted-foreground">
                        <FontAwesomeIcon icon={faWifi} className="h-5 w-5" />
                      </div>
                      <div className="min-w-0 flex-1">
                        <h3 className="font-semibold text-sm">{g.worldName || t('instanceDetail.servers.lanGame')}</h3>
                        <div className="mt-0.5 flex items-center gap-2 text-xs text-muted-foreground">
                          <span>{g.ip}:{g.port}</span>
                          {g.gameVersion !== 'Unknown' && <><span className="text-border">·</span><span>{g.gameVersion}</span></>}
                        </div>
                        {g.motd && (
                          <p className="mt-1 text-xs text-muted-foreground/70 whitespace-pre-line leading-relaxed">
                            <MinecraftText text={g.motd} />
                          </p>
                        )}
                      </div>
                      <Button size="sm" onClick={() => onQuickJoinServer(`${g.ip}:${g.port}`)} className="shrink-0 gap-1.5 h-7 text-xs">
                        <FontAwesomeIcon icon={faPlay} className="h-3 w-3" />{t('instanceDetail.servers.join')}
                      </Button>
                    </CardContent>
                  </Card>
                ))}
              </div>
            </>
          )}
        </CardContent>
      </Card>
      <ConfirmDialog open={confirmIp !== null} title={t('instanceDetail.servers.deleteTitle')} message={t('instanceDetail.servers.deleteConfirm', { ip: confirmIp ?? '' })} onConfirm={() => confirmIp && handleDelete(confirmIp)} onCancel={() => setConfirmIp(null)} />
      <Dialog open={showAdd} onClose={() => { setShowAdd(false); setEditServer(null) }}>
        <DialogHeader onClose={() => { setShowAdd(false); setEditServer(null) }}><DialogTitle>{editServer ? t('instanceDetail.servers.editTitle') : t('instanceDetail.servers.addTitle')}</DialogTitle></DialogHeader>
        <DialogBody className="space-y-3">
          <div className="space-y-1.5">
            <Label className="text-xs">{t('instanceDetail.servers.name')}</Label>
            <Input value={addName} onChange={(e) => setAddName(e.target.value)} placeholder="My Server" />
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">{t('instanceDetail.servers.address')}</Label>
            <Input value={addIp} onChange={(e) => setAddIp(e.target.value)} placeholder="example.com:25565" />
          </div>
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" size="sm" onClick={() => { setShowAdd(false); setEditServer(null) }}>{t('instanceDetail.confirm.cancel')}</Button>
          <Button size="sm" onClick={handleAdd} disabled={adding || !addName || !addIp}>{adding ? (editServer ? t('instanceDetail.servers.updating') : t('instanceDetail.servers.adding')) : (editServer ? t('instanceDetail.servers.save') : t('instanceDetail.servers.add'))}</Button>
        </DialogFooter>
      </Dialog>
    </>
  )
}

/** 需要翻译的按键名：code → instanceDetail.gamesettings.keys 下的 i18n key */
const KEY_I18N_MAP: Record<string, string> = {
  'key.keyboard.unknown': 'unbound',
  'key.keyboard.space': 'space',
  'key.keyboard.enter': 'enter',
  'key.keyboard.backspace': 'backspace',
  'key.keyboard.left.shift': 'leftShift',
  'key.keyboard.right.shift': 'rightShift',
  'key.keyboard.left.control': 'leftControl',
  'key.keyboard.right.control': 'rightControl',
  'key.keyboard.left.alt': 'leftAlt',
  'key.keyboard.right.alt': 'rightAlt',
  'key.keyboard.left.super': 'leftSuper',
  'key.keyboard.right.super': 'rightSuper',
  'key.keyboard.menu': 'menu',
  'key.mouse.0': 'mouseLeft',
  'key.mouse.1': 'mouseRight',
  'key.mouse.2': 'mouseMiddle',
  'key.keyboard.kp.add': 'keypadAdd',
  'key.keyboard.kp.subtract': 'keypadSubtract',
  'key.keyboard.kp.multiply': 'keypadMultiply',
  'key.keyboard.kp.divide': 'keypadDivide',
  'key.keyboard.kp.decimal': 'keypadDecimal',
  'key.keyboard.kp.enter': 'keypadEnter',
}

/** 无需翻译的按键名（符号/功能键），code → 显示文本 */
const KEY_DISPLAY_MAP: Record<string, string> = {
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
  'key.keyboard.tab': 'Tab',
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
}

for (let i = 0; i <= 9; i++) KEY_DISPLAY_MAP[`key.keyboard.${i}`] = `${i}`
for (let i = 1; i <= 25; i++) KEY_DISPLAY_MAP[`key.keyboard.f${i}`] = `F${i}`
for (const c of 'abcdefghijklmnopqrstuvwxyz') KEY_DISPLAY_MAP[`key.keyboard.${c}`] = c.toUpperCase()

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

/** 值是否为 JSON 数组形态（options.txt 的 resourcePacks/datapacks 等）。 */
function isJsonArrayValue(value: string): boolean {
  const v = value.trim()
  if (!v.startsWith('[') || !v.endsWith(']')) return false
  try { return Array.isArray(JSON.parse(v)) } catch { return false }
}

/** 解析 JSON 数组为字符串列表；失败/非数组 → 空列表。 */
function parseJsonArray(value: string): string[] {
  try {
    const arr = JSON.parse(value)
    if (Array.isArray(arr)) return arr.map((x) => String(x))
  } catch { /* fallthrough */ }
  return []
}

/** 数组类游戏设置（resourcePacks/datapacks 等）的列表编辑器：chips 可增删。 */
function GameListSettingEditor({ name, value, onChange, t }: {
  name: string
  value: string
  onChange: (name: string, value: string) => void
  t: (key: string, params?: Record<string, string | number>) => string
}) {
  const [draft, setDraft] = useState('')
  const items = parseJsonArray(value)
  const commit = (next: string[]) => onChange(name, JSON.stringify(next))
  const removeAt = (idx: number) => commit(items.filter((_, i) => i !== idx))
  const addItem = () => {
    const v = draft.trim()
    if (!v) return
    commit([...items, v])
    setDraft('')
  }
  return (
    <div className="flex max-w-full min-w-[260px] flex-wrap items-center justify-end gap-1">
      {items.map((item, i) => (
        <span
          key={`${i}-${item}`}
          className="inline-flex max-w-[180px] items-center gap-1 rounded-full border border-border bg-muted/50 px-2 py-0.5 text-xs"
        >
          <span className="truncate">{item}</span>
          <Tooltip content={t('instanceDetail.gamesettings.remove')}>
            <button
              type="button"
              onClick={() => removeAt(i)}
              className="text-muted-foreground transition-colors hover:text-destructive"
              aria-label={t('instanceDetail.gamesettings.remove')}
            >
              <FontAwesomeIcon icon={faXmark} className="h-3 w-3" />
            </button>
          </Tooltip>
        </span>
      ))}
      <div className="flex items-center gap-1">
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') addItem() }}
          placeholder={t('instanceDetail.gamesettings.addPlaceholder')}
          className="h-7 w-28 rounded-md border border-input bg-background px-2 text-xs shadow-sm outline-none focus-visible:ring-1 focus-visible:ring-ring"
        />
        <Tooltip content={t('instanceDetail.gamesettings.add')}>
          <button
            type="button"
            onClick={addItem}
            className="flex h-6 w-6 items-center justify-center rounded-md border border-input text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            aria-label={t('instanceDetail.gamesettings.add')}
          >
            <FontAwesomeIcon icon={faPlus} className="h-3 w-3" />
          </button>
        </Tooltip>
      </div>
    </div>
  )
}

function GameSettingsTab({ instanceId, refreshKey, onRefresh: _onRefresh }: { instanceId: string; refreshKey: number; onRefresh: () => void }) {
  const { t } = useI18n()
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
    const i18nKey = KEY_I18N_MAP[code]
    if (i18nKey) return t(`instanceDetail.gamesettings.keys.${i18nKey}`)
    const name = KEY_DISPLAY_MAP[code]
    if (name) return name
    if (code.startsWith('key.keyboard.kp.')) {
      const n = code.slice('key.keyboard.kp.'.length)
      if (/^\d+$/.test(n)) return t('instanceDetail.gamesettings.keys.keypad', { n })
    }
    if (code.startsWith('key.keyboard.')) return code.slice('key.keyboard.'.length).toUpperCase()
    if (code.startsWith('key.mouse.')) {
      const n = code.slice('key.mouse.'.length)
      return t('instanceDetail.gamesettings.keys.mouseButton', { n })
    }
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
            <FontAwesomeIcon icon={faGamepad} className="mr-2 h-4 w-4 text-muted-foreground" />{t('instanceDetail.tabs.gamesettings')}
            {!loading && <span className="ml-1.5 text-xs font-normal text-muted-foreground">({settings.length})</span>}
          </h3>
          <div className="flex items-center gap-2 flex-1 max-w-sm">
            <div className="relative flex-1">
              <FontAwesomeIcon icon={faMagnifyingGlass} className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder={t('instanceDetail.gamesettings.search')} className="h-8 pl-8 text-xs" />
            </div>
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
            {search ? t('instanceDetail.gamesettings.noMatch') : t('instanceDetail.gamesettings.empty')}
          </div>
        ) : (
          <div className="space-y-1 overflow-hidden">
            {filtered.map((s) => {
              const range = parseRange(s.validValuesRaw)
              const enumOpts = parseEnum(s.validValuesRaw)
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
                  <div className={cn('shrink-0 min-w-0', s.valueKind === 'List' || isJsonArrayValue(s.currentValue) ? 'max-w-[60%]' : 'max-w-40')}>
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
                        {listeningKey === s.name ? t('instanceDetail.gamesettings.pressKey') : formatKeyDisplay(s.currentValue)}
                      </button>
                    )}
                    {!keybind && s.valueKind === 'Enum' && enumOpts.length > 0 && (
                      <Select value={s.currentValue} onChange={(v) => handleChange(s.name, v)} className="w-full" placeholder={t('common.select')}>
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
                    {!keybind && (s.valueKind === 'List' || isJsonArrayValue(s.currentValue)) && (
                      <GameListSettingEditor name={s.name} value={s.currentValue} onChange={handleChange} t={t} />
                    )}
                    {!keybind && s.valueKind === 'Text' && !isJsonArrayValue(s.currentValue) && (
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
  const { t, lang } = useI18n()
  const { needsAccount, resolve: resolveAccountCheck, showNoAccount, showSelectAccount, handleAddAccount, handleGoToAccounts, handleCancelNoAccount, handleCancelSelect, handleSelectAccount } = useRequireDefaultAccount()
  const { state: _debugState } = useDebug()
  const [searchParams] = useSearchParams()
  const [tab, setTab] = useState<TabId>(() => {
    const t = searchParams.get('tab')
    return t && TABS.some(x => x.id === t) ? t as TabId : 'overview'
  })
  const [instance, setInstance] = useState<GameInstance | null>(null)
  const [loading, setLoading] = useState(true)
  const gameDir = useMemo(() => {
    if (!instance) return ''
    if (instance.resolvedGameDir) return instance.resolvedGameDir
    const isolated = instance.versionIsolation ?? getSettings().versionIsolation
    if (isolated) {
      const vn = instance.name
      return `${instance.gameDir.replace(/\\/g, '/')}/versions/${vn}`
    }
    return instance.gameDir
  }, [instance])
  const [saving, setSaving] = useState(false)
  const [, setRuntimes] = useState<JavaRuntime[]>(() => getRuntimes())
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
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false)
  const [exportOpen, setExportOpen] = useState(false)
  const [savesRefresh, setSavesRefresh] = useState(0)
  const [screenshotsRefresh, setScreenshotsRefresh] = useState(0)
  const [modsRefresh, setModsRefresh] = useState(0)
  const [resourcePacksRefresh, setResourcePacksRefresh] = useState(0)
  const [shadersRefresh, setShadersRefresh] = useState(0)
  const [dataPacksRefresh, setDataPacksRefresh] = useState(0)
  const [schematicsRefresh, setSchematicsRefresh] = useState(0)
  const [serversRefresh, setServersRefresh] = useState(0)
  const [gameSettingsRefresh, setGameSettingsRefresh] = useState(0)
  const [detailRefreshKey, setDetailRefreshKey] = useState(0)
  const [selectedAccountUuid, setSelectedAccountUuid] = useState<string | null>(null)
  const [groups, setGroups] = useState<InstanceGroup[]>([])

  const refreshDetail = useCallback(() => {
    cacheInvalidate('api-instance-')
    cacheInvalidate('api-instances')
    setDetailRefreshKey(k => k + 1)
    setSavesRefresh(k => k + 1)
    setScreenshotsRefresh(k => k + 1)
    setModsRefresh(k => k + 1)
    setResourcePacksRefresh(k => k + 1)
    setShadersRefresh(k => k + 1)
    setDataPacksRefresh(k => k + 1)
    setSchematicsRefresh(k => k + 1)
    setServersRefresh(k => k + 1)
    setGameSettingsRefresh(k => k + 1)
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
        getInstanceGroups().then(setGroups).catch(() => {})
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

  const handleToggleGroup = useCallback(async (groupId: string) => {
    if (!id || !instance) return
    const cur = instance.customGroupIds ?? []
    const next = cur.includes(groupId) ? cur.filter(g => g !== groupId) : [...cur, groupId]
    try {
      const updated = await updateInstance(id, { customGroupIds: next })
      setInstance(updated)
      cacheSet(`api-instance-${id}`, updated)
    } catch {}
  }, [id, instance])

  useEffect(() => () => { if (saveTimerRef.current) clearTimeout(saveTimerRef.current) }, [])

  const { launchInstance: ctxLaunchInstance, showLaunchError, runningInstances } = useRunning()
  const { confirm } = useMessageBox()

  const handleLaunch = useCallback(async () => {
    if (!id) return
    if (needsAccount && !selectedAccountUuid) {
      const ok = await resolveAccountCheck()
      if (!ok) return
    }
    try {
      await ctxLaunchInstance(id, instance?.name || id, { path: instance?.javaPath, gameVersion: instance?.gameVersion, gameDir: instance?.gameDir }, selectedAccountUuid ? { accountUuid: selectedAccountUuid } : undefined)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      const code = e instanceof ApiError ? e.code : ''
      if (msg.includes('TOKEN_EXPIRED') || msg.includes('invalid_grant') || msg.includes('AADSTS70008') || code.includes('TOKEN_EXPIRED')) {
        setShowMicrosoftReauth(true)
        return
      }
      if (code.includes('NETWORK_ERROR')) {
        showLaunchError(t('instanceDetail.launch.launchFailed'), t('errors.networkError'))
        return
      }
      showLaunchError(t('instanceDetail.launch.launchFailed'), e instanceof Error ? e.message : String(e))
    }
  }, [id, instance?.name, needsAccount, resolveAccountCheck, ctxLaunchInstance, selectedAccountUuid, t])

  const handleTestGame = useCallback(async () => {
    if (!id) return
    // 纯浏览器 dev：window.open 非同步会丢失手势被弹窗拦截，故在点击内先同步打开。
    const isTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
    let win: Window | null = null
    if (!isTauri) {
      win = window.open(logWindowUrl(id), '_blank')
    }
    if (needsAccount && !selectedAccountUuid) {
      const ok = await resolveAccountCheck()
      if (!ok) { win?.close(); return }
    }
    try {
      await ctxLaunchInstance(id, instance?.name || id, { path: instance?.javaPath, gameVersion: instance?.gameVersion, gameDir: instance?.gameDir }, selectedAccountUuid ? { accountUuid: selectedAccountUuid } : undefined)
      // 启动成功后在 Tauri 下另开原生独立日志窗口（IPC，不受弹窗/手势限制）。
      if (isTauri) {
        await openLogWindow(id)
      }
    } catch (e) {
      win?.close()
      const msg = e instanceof Error ? e.message : String(e)
      const code = e instanceof ApiError ? e.code : ''
      if (msg.includes('TOKEN_EXPIRED') || msg.includes('invalid_grant') || msg.includes('AADSTS70008') || code.includes('TOKEN_EXPIRED')) {
        setShowMicrosoftReauth(true)
        return
      }
      if (code.includes('NETWORK_ERROR')) {
        showLaunchError(t('instanceDetail.launch.launchFailed'), t('errors.networkError'))
        return
      }
      showLaunchError(t('instanceDetail.launch.launchFailed'), e instanceof Error ? e.message : String(e))
    }
  }, [id, instance?.name, instance?.javaPath, instance?.gameVersion, instance?.gameDir, needsAccount, resolveAccountCheck, ctxLaunchInstance, selectedAccountUuid, t])

  const handleQuickLaunch = useCallback(async (options: { joinServer?: string; joinWorld?: string }) => {
    if (!id) return
    if (needsAccount) {
      const ok = await resolveAccountCheck()
      if (!ok) return
    }
    const running = runningInstances.some(r => r.instanceId === id)
    if (running) {
      const ok = await confirm(t('instanceDetail.launch.instanceRunningConfirm'), t('instanceDetail.launch.instanceRunningTitle'))
      if (!ok) return
    }
    try {
      await ctxLaunchInstance(id, instance?.name || id, { path: instance?.javaPath, gameVersion: instance?.gameVersion, gameDir: instance?.gameDir }, options)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      const code = e instanceof ApiError ? e.code : ''
      if (msg.includes('TOKEN_EXPIRED') || msg.includes('invalid_grant') || msg.includes('AADSTS70008') || code.includes('TOKEN_EXPIRED')) {
        setShowMicrosoftReauth(true)
        return
      }
      if (code.includes('NETWORK_ERROR')) {
        showLaunchError(t('instanceDetail.launch.launchFailed'), t('errors.networkError'))
        return
      }
      showLaunchError(t('instanceDetail.launch.launchFailed'), e instanceof Error ? e.message : String(e))
    }
  }, [id, instance?.name, instance?.javaPath, instance?.gameVersion, instance?.gameDir, needsAccount, resolveAccountCheck, ctxLaunchInstance, runningInstances, confirm, showLaunchError, t])

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

  const confirmDelete = useCallback(async () => {
    if (!id || !instance) return
    setDeleteConfirmOpen(false)
    try {
      await deleteInstance(id)
      cacheInvalidate('api-')
      navigate('/instances')
    } catch {}
  }, [id, instance, navigate])

  const handleDelete = useCallback(() => {
    setDeleteConfirmOpen(true)
  }, [])

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
          <FontAwesomeIcon icon={faRotate} className="h-4 w-4 animate-spin" />{t('instanceDetail.launch.loadingInstance')}
        </div>
      </div>
    )
  }

  if (!instance || !form) {
    return (
      <div className="p-8">
        <Button variant="ghost" onClick={() => navigate('/instances')} className="gap-2">
          <FontAwesomeIcon icon={faArrowLeft} className="h-4 w-4" />{t('instanceDetail.launch.backToList')}
        </Button>
        <p className="mt-4 text-sm text-muted-foreground text-center">{t('instanceDetail.launch.instanceNotFound')}</p>
      </div>
    )
  }

  return (
    <PageShell className="flex h-screen flex-col space-y-6 overflow-hidden p-8">
      <div className="flex shrink-0 items-center gap-3">
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
          <Tooltip content={t('instanceDetail.overview.refresh')}>
            <Button variant="outline" size="icon" onClick={refreshDetail}>
              <FontAwesomeIcon icon={faRotate} className={cn('h-4 w-4', loading && 'animate-spin')} />
            </Button>
          </Tooltip>
          <Button onClick={handleLaunch} className="gap-2">
            <FontAwesomeIcon icon={faPlay} className="h-3.5 w-3.5" />{t('instanceDetail.overview.launch')}
          </Button>
          <Button variant="outline" onClick={handleTestGame} className="gap-2">
            <FontAwesomeIcon icon={faTerminal} className="h-3.5 w-3.5" />{t('instanceDetail.overview.testGame')}
          </Button>
          <Tooltip content={isDefault ? t('instanceDetail.overview.unpin') : t('instanceDetail.overview.pin')}>
            <Button variant="outline" size="icon" onClick={toggleDefault}>
              <FontAwesomeIcon icon={faStar} className={cn('h-4 w-4', isDefault && 'text-yellow-400')} />
            </Button>
          </Tooltip>
          <Button variant="outline" size="icon" onClick={() => openFolder(gameDir).catch(() => {})}>
            <FontAwesomeIcon icon={faFolderOpen} className="h-4 w-4" />
          </Button>
        </div>
      </div>

      <div className="flex-1 min-h-0 flex gap-4">
        <div className="flex w-44 shrink-0 flex-col">
          <Tabs
            tabs={TABS.map(tab => ({ id: tab.id, label: t(`instanceDetail.tabs.${tab.id}`), icon: <FontAwesomeIcon icon={tab.icon} className="h-4 w-4" /> }))}
            activeTab={tab}
            onChange={(id) => setTab(id as typeof tab)}
            orientation="vertical"
          />
        </div>

        <div className="flex-1 min-w-0 overflow-y-auto scroll-fade-mask relative" style={{ transform: 'translateZ(0)' }}>
          <TabContent activeTab={tab} tabId="overview">
            <div className="space-y-4">
              <Card>
                <CardContent className="p-5 space-y-4">
                  <div className="grid grid-cols-2 gap-4 text-sm">
                    <div>
                      <p className="text-xs text-muted-foreground">{t('instanceDetail.overview.gameVersion')}</p>
                      <p className="font-medium">{instance.gameVersion}</p>
                    </div>
                    <div>
                      <p className="text-xs text-muted-foreground">{t('instanceDetail.overview.loader')}</p>
                      {instance.loader ? (
                        <span className={cn('inline-flex items-center rounded border px-2 py-0.5 text-xs font-medium mt-0.5', LOADER_COLORS[instance.loader.toLowerCase()] ?? 'bg-muted text-muted-foreground border-border')}>
                          {instance.loader} {instance.loaderVersion}
                        </span>
                      ) : <p className="font-medium text-muted-foreground">{t('instanceDetail.overview.pureVanilla')}</p>}
                    </div>
                    <div>
                      <p className="text-xs text-muted-foreground">{t('instanceDetail.overview.lastPlayed')}</p>
                      <p className="font-medium">{formatDate(instance.lastPlayed, t, lang)}</p>
                    </div>
                    <div>
                      <p className="text-xs text-muted-foreground">{t('instanceDetail.overview.totalPlayTime')}</p>
                      <p className="font-medium">{formatPlayTime(instance.playTime, t)}</p>
                    </div>
                  </div>
                </CardContent>
              </Card>

              {instance.modpackName && (
                <Card>
                  <CardContent className="p-5 space-y-3">
                    <h3 className="text-sm font-medium">{t('instanceDetail.overview.modpackInfo')}</h3>
                    <div className="grid grid-cols-2 gap-4 text-sm">
                      <div>
                        <p className="text-xs text-muted-foreground">{t('instanceDetail.overview.modpackName')}</p>
                        <p className="font-medium">{instance.modpackName}</p>
                      </div>
                      {instance.modpackVersion && (
                        <div>
                          <p className="text-xs text-muted-foreground">{t('instanceDetail.overview.version')}</p>
                          <p className="font-medium">{instance.modpackVersion}</p>
                        </div>
                      )}
                      {instance.modpackAuthor && (
                        <div>
                          <p className="text-xs text-muted-foreground">{t('instanceDetail.overview.author')}</p>
                          <p className="font-medium">{instance.modpackAuthor}</p>
                        </div>
                      )}
                    </div>
                    {instance.modpackSummary && (
                      <div className="pt-1">
                        <p className="text-xs text-muted-foreground mb-1">{t('instanceDetail.overview.summary')}</p>
                        <div className="text-sm text-muted-foreground prose prose-sm max-w-none" dangerouslySetInnerHTML={{ __html: instance.modpackSummary }} />
                      </div>
                    )}
                  </CardContent>
                </Card>
              )}

              <Card>
                <CardContent className="p-5 space-y-3">
                  <h3 className="text-sm font-medium">{t('instanceDetail.overview.quickActions')}</h3>
                  <div className="flex flex-wrap gap-2 items-center">
                    <Select
                      value={selectedAccountUuid ?? ''}
                      onChange={(v) => setSelectedAccountUuid(v || null)}
                      placeholder={t('instanceDetail.overview.defaultAccount')}
                      className="min-w-[120px]"
                    >
                      <SelectOption value="">{t('instanceDetail.overview.defaultAccount')}</SelectOption>
                      {accounts.map((a) => (
                        <SelectOption key={a.uuid} value={a.uuid}>{a.name}</SelectOption>
                      ))}
                    </Select>
                    <Button size="sm" onClick={handleLaunch} className="gap-2">
                      <FontAwesomeIcon icon={faPlay} className="h-3.5 w-3.5" />{t('instanceDetail.overview.launchGame')}
                    </Button>
                    <Button size="sm" variant="outline" onClick={() => setTab('settings')} className="gap-2">
                      <FontAwesomeIcon icon={faGear} className="h-3.5 w-3.5" />{t('instanceDetail.overview.instanceSettings')}
                    </Button>
                    <Button size="sm" variant="outline" onClick={handleVerifyResources} disabled={verifying || repairing} className="gap-2">
                      <FontAwesomeIcon icon={faRotate} className={cn('h-3.5 w-3.5', verifying && 'animate-spin')} />{t('instanceDetail.overview.verifyIntegrity')}
                    </Button>
                    {repairing && (
                      <span className="self-center text-xs text-muted-foreground">{t('instanceDetail.overview.repairing', { progress: repairProgress })}</span>
                    )}
                    <Button size="sm" variant="outline" className="gap-2" onClick={() => openFolder(gameDir).catch(() => {})}>
                      <FontAwesomeIcon icon={faFolderOpen} className="h-3.5 w-3.5" />{t('instanceDetail.overview.openGameDir')}
                    </Button>
                    <Button size="sm" variant="outline" className="gap-2" onClick={() => setExportOpen(true)}>
                      <FontAwesomeIcon icon={faFileExport} className="h-3.5 w-3.5" />{t('instanceDetail.overview.exportModpack')}
                    </Button>
                    <Button size="sm" variant="outline" className="gap-2 text-destructive hover:text-destructive" onClick={handleDelete}>
                      <FontAwesomeIcon icon={faTrashCan} className="h-3.5 w-3.5" />{t('instanceDetail.overview.deleteInstance')}
                    </Button>
                  </div>
                </CardContent>
              </Card>

              <Card>
                <CardContent className="p-5 space-y-3">
                  <h3 className="text-sm font-medium flex items-center gap-2">
                    <FontAwesomeIcon icon={faLayerGroup} className="h-3.5 w-3.5 text-muted-foreground" />
                    {t('instances.groups')}
                  </h3>
                  {groups.length === 0 ? (
                    <p className="text-xs text-muted-foreground">{t('instances.noGroups')}</p>
                  ) : (
                    <div className="flex flex-wrap gap-2">
                      {groups.map((g) => {
                        const active = (instance?.customGroupIds ?? []).includes(g.id)
                        return (
                          <button
                            key={g.id}
                            type="button"
                            onClick={() => handleToggleGroup(g.id)}
                            className={cn('inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-sm transition-colors', active ? 'border-primary text-primary' : 'border-border text-muted-foreground hover:border-muted-foreground/40')}
                          >
                            <span className="h-2 w-2 rounded-full" style={{ backgroundColor: g.color }} />
                            {g.name}
                            {active && <FontAwesomeIcon icon={faCheck} className="h-3 w-3" />}
                          </button>
                        )
                      })}
                    </div>
                  )}
                  <p className="text-xs text-muted-foreground">{t('instances.groupsHint')}</p>
                </CardContent>
              </Card>
            </div>
          </TabContent>

          {tab === 'settings' && (
            <Card>
              <CardContent className="p-5 space-y-5">
                <div className="space-y-2">
                  <Label>{t('instanceDetail.settingsTab.instanceName')}</Label>
                  <Input value={form.name} onChange={(e) => update('name', e.target.value)} />
                </div>

                <div className="space-y-2">
                  <Label>{t('instanceDetail.settingsTab.instanceIcon')}</Label>
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
                  <Label>{t('instanceDetail.settingsTab.gameVersion')}</Label>
                  <Input value={form.gameVersion} disabled className="text-muted-foreground" />
                </div>

                <div className="space-y-2">
                  <Label>{t('instanceDetail.settingsTab.javaRuntime')}</Label>
                  <Select value={form.javaPath ?? ''} onChange={(v) => update('javaPath', v || null)}>
                    <SelectOption value="">{t('instanceDetail.settingsTab.autoSelect')}</SelectOption>
                    {getValidRuntimes().map((j, i) => (
                      <SelectOption key={i} value={j.path}>{j.name} - {j.version} ({j.arch})</SelectOption>
                    ))}
                  </Select>
                </div>

                <div className="space-y-2">
                  <Label>{t('instanceDetail.settingsTab.integrity')}</Label>
                  <div className="flex items-center gap-2">
                    <Button size="sm" variant="outline" onClick={handleVerifyResources} disabled={verifying || repairing}>
                      <FontAwesomeIcon icon={faRotate} className={cn('h-4 w-4', verifying && 'animate-spin')} />
                      {t('instanceDetail.settingsTab.checkIntegrity')}
                    </Button>
                    {repairing && (
                      <span className="text-sm text-muted-foreground">{t('instanceDetail.settingsTab.repairing', { progress: repairProgress })}</span>
                    )}
                  </div>
                  {verifyResult && !verifyResult.complete && (
                    <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-3">
                      <p className="text-sm font-medium text-destructive">{t('instanceDetail.settingsTab.missingFiles', { count: verifyResult.missingFiles.length })}</p>
                      <ul className="mt-2 max-h-40 space-y-1 overflow-y-auto text-xs text-muted-foreground">
                        {verifyResult.missingFiles.map((f, i) => (
                          <li key={i} className="truncate">
                            <Tooltip content={f.url}>
                              <span className="block truncate">{f.name} — {f.url}</span>
                            </Tooltip>
                          </li>
                        ))}
                      </ul>
                      <p className="mt-2 text-xs text-muted-foreground">{t('instanceDetail.settingsTab.autoRepairing')}</p>
                    </div>
                  )}
                  {verifyResult && verifyResult.complete && (
                    <p className="text-xs text-muted-foreground">{t('instanceDetail.settingsTab.integrityOk')}</p>
                  )}
                </div>

                <div className="space-y-2">
                  <Label>{t('instanceDetail.settingsTab.versionIsolation')}</Label>
                  <Select
                    value={form.versionIsolation == null ? 'global' : form.versionIsolation ? 'on' : 'off'}
                    onChange={(v) => update('versionIsolation', v === 'global' ? null : v === 'on')}
                  >
                    <SelectOption value="global">{t('instanceDetail.settingsTab.followGlobal')}</SelectOption>
                    <SelectOption value="on">{t('instanceDetail.settingsTab.on')}</SelectOption>
                    <SelectOption value="off">{t('instanceDetail.settingsTab.off')}</SelectOption>
                  </Select>
                  <p className="text-xs text-muted-foreground">{t('instanceDetail.settingsTab.isolationDesc')}</p>
                </div>

                <label className="flex items-center gap-3 cursor-pointer">
                  <Checkbox
                    checked={form.skipIntegrityCheck === true}
                    onCheckedChange={(c) => update('skipIntegrityCheck', c === true)}
                  />
                  <div>
                    <div className="text-sm font-medium">{t('instanceDetail.settingsTab.skipIntegrity')}</div>
                    <div className="text-xs text-muted-foreground">{t('instanceDetail.settingsTab.skipIntegrityDesc')}</div>
                  </div>
                </label>

                <div className="space-y-2">
                  <Label>{t('instanceDetail.settingsTab.memoryAllocation')}</Label>
                  <div className="flex items-center gap-2">
                    <button onClick={() => {
                      setMemoryMode('auto')
                      if (sysInfo) update('maxMemory', Math.max(512, Math.floor(sysInfo.availableMemory * 0.7)))
                    }} className={cn('h-9 rounded-lg border px-3.5 text-sm transition-colors', memoryMode === 'auto' ? 'border-primary bg-primary/10 font-medium text-primary' : 'border-border hover:border-muted-foreground/30')}>
                      <FontAwesomeIcon icon={faRobot} className="mr-1.5 h-3.5 w-3.5" />{t('instanceDetail.settingsTab.auto')}
                    </button>
                    <button onClick={() => setMemoryMode('custom')} className={cn('h-9 rounded-lg border px-3.5 text-sm transition-colors', memoryMode === 'custom' ? 'border-primary bg-primary/10 font-medium text-primary' : 'border-border hover:border-muted-foreground/30')}>
                      <FontAwesomeIcon icon={faSliders} className="mr-1.5 h-3.5 w-3.5" />{t('instanceDetail.settingsTab.custom')}
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
                          <span>{t('instanceDetail.settingsTab.totalMem', { size: (totalMb / 1024).toFixed(1) })}</span>
                          <span>{t('instanceDetail.settingsTab.usedMem', { size: (usedMb / 1024).toFixed(1) })}</span>
                          <span>{t('instanceDetail.settingsTab.gameAlloc', { size: (gameMb / 1024).toFixed(1) })}</span>
                          <span>{t('instanceDetail.settingsTab.remainingMem', { size: ((availMb - gameMb) / 1024).toFixed(1) })}</span>
                        </div>
                      </div>
                    )
                  })()}
                </div>

                <div className="space-y-2">
                  <Label>{t('instanceDetail.settingsTab.jvmArgs')}</Label>
                  <textarea
                    value={form.jvmArgs ?? ''}
                    onChange={(e) => update('jvmArgs', e.target.value)}
                    placeholder="-Xmx2G -XX:+UseG1GC"
                    rows={3}
                    className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring resize-none"
                  />
                </div>

                <div className="space-y-2">
                  <Label>{t('instanceDetail.settingsTab.linkedAccount')}</Label>
                  <Select value={form.accountUuid ?? ''} onChange={(v) => {
                    const acc = accounts.find((a) => a.uuid === v)
                    update('accountUuid', v || null)
                    update('accountName', acc?.name || null)
                    update('accessToken', acc?.accessToken || null)
                  }}>
                    <SelectOption value="">{t('instanceDetail.settingsTab.unlinked')}</SelectOption>
                    {accounts.map((a) => (
                      <SelectOption key={a.uuid} value={a.uuid}>{a.name}</SelectOption>
                    ))}
                  </Select>
                </div>

                {saving && (
                  <div className="flex justify-end pt-2">
                    <span className="text-xs text-muted-foreground">{t('instanceDetail.settingsTab.saving')}</span>
                  </div>
                )}
              </CardContent>
            </Card>
          )}

          <TabContent activeTab={tab} tabId="saves"><SavesTab instanceId={id!} gameDir={gameDir} gameVersion={instance.gameVersion} refreshKey={savesRefresh} onRefresh={() => setSavesRefresh(k => k + 1)} onQuickJoinWorld={(name) => handleQuickLaunch({ joinWorld: name })} running={runningInstances.some(r => r.instanceId === id)} /></TabContent>
          <TabContent activeTab={tab} tabId="screenshots"><ScreenshotsTab instanceId={id!} gameDir={gameDir} refreshKey={screenshotsRefresh} onRefresh={() => setScreenshotsRefresh(k => k + 1)} /></TabContent>
          <TabContent activeTab={tab} tabId="mods"><ModsTab instanceId={id!} gameVersion={instance.gameVersion} loader={instance.loader || undefined} gameDir={gameDir} refreshKey={modsRefresh} onRefresh={() => { cacheInvalidate(`api-instance-${id}-mods`); setModsRefresh(k => k + 1) }} /></TabContent>
          <TabContent activeTab={tab} tabId="resourcepacks"><ResourcePacksTab instanceId={id!} gameDir={gameDir} gameVersion={instance.gameVersion} loader={instance.loader ?? undefined} refreshKey={resourcePacksRefresh} onRefresh={() => { cacheInvalidate(`api-instance-${id}-resourcepacks`); setResourcePacksRefresh(k => k + 1) }} /></TabContent>
          <TabContent activeTab={tab} tabId="shaderpacks"><ShadersTab instanceId={id!} gameDir={gameDir} gameVersion={instance.gameVersion} loader={instance.loader ?? undefined} refreshKey={shadersRefresh} onRefresh={() => { cacheInvalidate(`api-instance-${id}-shaders`); setShadersRefresh(k => k + 1) }} /></TabContent>
          <TabContent activeTab={tab} tabId="datapacks"><DataPacksTab instanceId={id!} gameDir={gameDir} gameVersion={instance.gameVersion} loader={instance.loader ?? undefined} refreshKey={dataPacksRefresh} onRefresh={() => { cacheInvalidate(`api-instance-${id}-datapacks`); setDataPacksRefresh(k => k + 1) }} /></TabContent>
          <TabContent activeTab={tab} tabId="schematics"><SchematicsTab instanceId={id!} gameDir={gameDir} refreshKey={schematicsRefresh} onRefresh={() => { cacheInvalidate(`api-instance-${id}-schematics`); setSchematicsRefresh(k => k + 1) }} /></TabContent>
          <TabContent activeTab={tab} tabId="servers"><ServersTab instanceId={id!} refreshKey={serversRefresh} onRefresh={() => setServersRefresh(k => k + 1)} onQuickJoinServer={(ip) => handleQuickLaunch({ joinServer: ip })} /></TabContent>
          <TabContent activeTab={tab} tabId="gamesettings"><GameSettingsTab instanceId={id!} refreshKey={gameSettingsRefresh} onRefresh={() => setGameSettingsRefresh(k => k + 1)} /></TabContent>
        </div>
      </div>
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
        expiredAccountUuid={selectedAccountUuid}
      />
      <ConfirmDialog open={deleteConfirmOpen} title={t('instanceDetail.overview.deleteInstance')} message={t('instanceDetail.launch.deleteInstanceConfirm', { name: instance?.name ?? '' })} onConfirm={confirmDelete} onCancel={() => setDeleteConfirmOpen(false)} />
      <ExportModpackDialog
        open={exportOpen}
        onClose={() => setExportOpen(false)}
        instance={instance}
      />
    </PageShell>
  )
}
