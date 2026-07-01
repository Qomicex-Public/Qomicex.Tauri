import { useEffect, useState, useCallback, useRef } from 'react'
import { useNavigate } from 'react-router-dom'

import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import { faPlus, faFileImport, faRotate, faPlay, faGear, faTrashCan, faFolderOpen, faMagnifyingGlass, faCube, faCheck, faTriangleExclamation, faCalendar, faDownload, faFolder, faArrowLeft, faChevronDown, faList, faGrip, faPen, faHammer, faTag, faStar } from '@fortawesome/free-solid-svg-icons'
import { PageHeader } from '../components/PageHeader.tsx'
import { open as tauriOpen } from '@tauri-apps/plugin-dialog'

import { Button } from '../components/ui/button.tsx'
import { Input } from '../components/ui/input.tsx'
import { Label } from '../components/ui/label.tsx'
import { Card, CardContent } from '../components/ui/card.tsx'
import { Dialog, DialogHeader, DialogTitle, DialogBody, DialogFooter } from '../components/ui/dialog.tsx'
import { Tooltip } from '../components/ui/tooltip.tsx'
import { useMessageBox } from '../components/ui/message-box.tsx'
import { scanVersions, getRemoteVersions, getLoaderVersions, getLoaderAddons } from '../api/versions.ts'
import { createInstance, startInstall, getInstances, repairInstance, launchInstance, getLaunchProgress, setDefaultInstance, clearDefaultInstance, getDefaultInstance } from '../api/instance.ts'
import { addTask, updateTask, getTasks } from '../stores/downloadStore.ts'
import { Select, SelectOption, SelectDivider } from '../components/ui/select.tsx'
import type { ScannedVersion, RemoteVersionInfo, CreateInstanceRequest, LoaderVersionInfo, LoaderAddonInfo, DownloadTask, GameInstance, LaunchProgress } from '../types/index.ts'
import { getSettings, saveSettings as apiSaveSettings, loadSettings as apiLoadSettings, onSettingsChange, autoSelectDownloadSource, openFolder } from '../api/settings.ts'
import { InstanceIcon } from '../components/InstanceIcon.tsx'

interface ManagedDir {
  path: string
  name: string
}

const LOADER_COLORS: Record<string, string> = {
  Forge: 'text-orange-500 bg-orange-500/10 border-orange-500/25',
  Fabric: 'text-cyan-400 bg-cyan-400/10 border-cyan-400/25',
  NeoForge: 'text-green-500 bg-green-500/10 border-green-500/25',
  Quilt: 'text-purple-400 bg-purple-400/10 border-purple-400/25',
  OptiFine: 'text-yellow-500 bg-yellow-500/10 border-yellow-500/25',
  LiteLoader: 'text-sky-400 bg-sky-400/10 border-sky-400/25',
}

const TYPE_LABEL: Record<string, string> = { release: '正式版', snapshot: '快照', old_beta: '远古测试版', old_alpha: '远古阿尔法' }
const TYPE_ORDER: Record<string, number> = { release: 0, snapshot: 1, old_beta: 2, old_alpha: 3 }
const REMOTE_VERSION_CATEGORIES = [
  { key: 'all', label: '全部' },
  { key: 'release', label: '正式版' },
  { key: 'snapshot', label: '快照' },
  { key: 'old_beta', label: '远古测试版' },
  { key: 'old_alpha', label: '远古阿尔法' },
]

const REMOTE_SORT_OPTIONS = [
  { key: 'recommended', label: '推荐排序' },
  { key: 'newest', label: '最新优先' },
  { key: 'oldest', label: '最早优先' },
  { key: 'name-asc', label: '名称 A-Z' },
  { key: 'name-desc', label: '名称 Z-A' },
]

function cn(...classes: (string | boolean | undefined | null)[]): string { return classes.filter(Boolean).join(' ') }

function autoInstanceName(gameVersion: string, loader: string, loaderVersion: string): string {
  let name = gameVersion
  if (loader) {
    name += `-${loader}`
    if (loaderVersion) {
      name += `-${loaderVersion}`
    }
  }
  return name
}

function loadDirs(): ManagedDir[] {
  try { return JSON.parse(localStorage.getItem('qomicex-directories') || '[]') } catch { return [] }
}
function saveDirs(dirs: ManagedDir[]) { localStorage.setItem('qomicex-directories', JSON.stringify(dirs)) }

function loadSettings() {
  return getSettings()
}
function saveSettings(s: Record<string, unknown>) {
  apiLoadSettings().then((fresh) => {
    apiSaveSettings({ ...fresh, ...s })
  }).catch(() => {})
}

function formatDate(dateStr: string): string {
  try {
    const d = new Date(dateStr)
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  } catch { return dateStr }
}

function dirName(path: string): string {
  if (!path) return ''
  return path.replace(/\\/g, '/').split('/').filter(Boolean).pop() || path
}

type PageStep = 'list' | 'select-version' | 'configure'

export default function Instances() {
  const navigate = useNavigate()
  const { alert: msgAlert, prompt: msgPrompt } = useMessageBox()

  const [scannedLocal, setScannedLocal] = useState<ScannedVersion[]>([])
  const [remoteVersions, setRemoteVersions] = useState<RemoteVersionInfo[]>([])
  const [loading, setLoading] = useState(true)
  const [scanning, setScanning] = useState(false)
  const [search, setSearch] = useState('')
  const [backedInstances, setBackedInstances] = useState<GameInstance[]>([])
  const [settingsVersion, setSettingsVersion] = useState<ScannedVersion | null>(null)
  const [settingsTab, setSettingsTab] = useState<'basic' | 'repair'>('basic')
  const [repairAdded, setRepairAdded] = useState(false)
  const [defaultInstanceId, setDefaultInstanceId] = useState<string | null>(null)
  const [launchProgress, setLaunchProgress] = useState<LaunchProgress | null>(null)
  const launchPollRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const [managedDirs, setManagedDirs] = useState<ManagedDir[]>(() => loadDirs())
  const [currentDir, setCurrentDir] = useState(() => loadSettings().gameDir || '')
  const [dirPopover, setDirPopover] = useState(false)

  useEffect(() => {
    return onSettingsChange((s) => {
      if (s.gameDir && s.gameDir !== currentDir) setCurrentDir(s.gameDir)
    })
  }, [currentDir])
  const [dirManager, setDirManager] = useState(false)
  const popoverRef = useRef<HTMLDivElement>(null)

  const [step, setStep] = useState<PageStep>('list')
  const [versionSearch, setVersionSearch] = useState('')
  const [remoteCategory, setRemoteCategory] = useState('all')
  const [remoteSort, setRemoteSort] = useState('recommended')
  const [remoteViewMode, setRemoteViewMode] = useState<'grid' | 'list'>('grid')
  const [viewMode, setViewMode] = useState<'grid' | 'list'>('grid')
  const [form, setForm] = useState({ name: '', gameVersion: '', loader: '', loaderVersion: '' })
  const [selectedAddons, setSelectedAddons] = useState<string[]>([])
  const [loaderVersions, setLoaderVersions] = useState<LoaderVersionInfo[]>([])
  const [loadingVersions, setLoadingVersions] = useState(false)
  const [loaderAddons, setLoaderAddons] = useState<LoaderAddonInfo[]>([])
  const [loadingAddons, setLoadingAddons] = useState(false)

  const doScan = useCallback(async (dir: string) => {
    if (!dir) { setScannedLocal([]); return }
    setScanning(true)
    try {
      const versions = await scanVersions(dir)
      setScannedLocal(versions)
      const instances = await getInstances()
      setBackedInstances(instances)
      const existingNames = new Set(instances.filter((i) => i.gameDir === dir).map((i) => i.name))
      const toCreate = versions.filter((v) => !existingNames.has(v.name))
      if (toCreate.length > 0) {
        const created = await Promise.all(toCreate.map((v) => createInstance({
          name: v.name,
          gameVersion: v.gameVersion,
          loader: v.loaders.find((l) => l.type)?.type,
          loaderVersion: v.loaders.find((l) => l.version)?.version,
          gameDir: dir,
          maxMemory: 4096,
        }).catch(() => null)))
        const valid = created.filter((c): c is GameInstance => c !== null)
        if (valid.length > 0) setBackedInstances((prev) => [...prev, ...valid])
      }
    } catch { setScannedLocal([]) } finally { setScanning(false) }
  }, [])

  useEffect(() => {
    async function init() {
      setLoading(true)
      try {
        const [remote, instances, def, settings] = await Promise.all([getRemoteVersions(), getInstances(), getDefaultInstance(), apiLoadSettings()])
        setRemoteVersions(remote)
        setBackedInstances(instances)
        setDefaultInstanceId(def?.id ?? null)
        if (settings.gameDir) setCurrentDir(settings.gameDir)
      } catch (e) { console.error(e) } finally { setLoading(false) }
    }
    init()
  }, [])

  useEffect(() => { if (currentDir) doScan(currentDir) }, [currentDir, doScan])

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (popoverRef.current && !popoverRef.current.contains(e.target as Node)) setDirPopover(false)
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [])

  useEffect(() => {
    if (!form.loader || !form.gameVersion) { setLoaderVersions([]); return }
    let cancelled = false
    setLoadingVersions(true)
    getLoaderVersions(form.gameVersion, form.loader)
      .then((versions) => { if (!cancelled) setLoaderVersions(versions) })
      .catch(() => { if (!cancelled) setLoaderVersions([]) })
      .finally(() => { if (!cancelled) setLoadingVersions(false) })
    return () => { cancelled = true }
  }, [form.loader, form.gameVersion])

  useEffect(() => {
    if (!form.loader) { setLoaderAddons([]); return }
    let cancelled = false
    setLoadingAddons(true)
    getLoaderAddons(form.loader)
      .then((addons) => { if (!cancelled) setLoaderAddons(addons) })
      .catch(() => { if (!cancelled) setLoaderAddons([]) })
      .finally(() => { if (!cancelled) setLoadingAddons(false) })
    return () => { cancelled = true }
  }, [form.loader])

  useEffect(() => {
    setForm((prev) => {
      let v = prev.loaderVersion
      if (prev.loader && !v && loaderVersions.length > 0) {
        v = loaderVersions[0].version
      }
      return { ...prev, name: autoInstanceName(prev.gameVersion, prev.loader, v) }
    })
  }, [form.gameVersion, form.loader, form.loaderVersion, loaderVersions])

  async function handlePickDir() {
    try {
      const dir = await tauriOpen({ directory: true, multiple: false, title: '选择游戏目录' })
      if (dir) {
        const path = dir as string
        setCurrentDir(path)
        saveSettings({ gameDir: path })
        setManagedDirs((prev) => {
          if (prev.some((d) => d.path === path)) return prev
          const next = [...prev, { path, name: dirName(path) }]
          saveDirs(next)
          return next
        })
        setDirPopover(false)
      }
    } catch {
      const dir = await msgPrompt('请输入游戏目录路径:', '选择目录')
      if (dir) {
        setCurrentDir(dir)
        saveSettings({ gameDir: dir })
        setManagedDirs((prev) => {
          if (prev.some((d) => d.path === dir)) return prev
          const next = [...prev, { path: dir, name: dirName(dir) }]
          saveDirs(next)
          return next
        })
      }
    }
  }

  function switchDir(dir: string) {
    if (dir === currentDir) { setDirPopover(false); return }
    setCurrentDir(dir)
    saveSettings({ gameDir: dir })
    setDirPopover(false)
  }

  function removeDir(path: string) {
    setManagedDirs((prev) => { const next = prev.filter((d) => d.path !== path); saveDirs(next); return next })
  }

  async function addDirManually() {
    const dir = await msgPrompt('请输入游戏目录路径:', '添加目录')
    if (dir) {
      setManagedDirs((prev) => {
        if (prev.some((d) => d.path === dir)) return prev
        const next = [...prev, { path: dir, name: dirName(dir) }]
        saveDirs(next)
        return next
      })
    }
  }

  function gotoNewInstance() {
    setForm({ name: '', gameVersion: '', loader: '', loaderVersion: '' })
    setSelectedAddons([])
    setLoaderVersions([])
    setVersionSearch('')
    setRemoteCategory('all')
    setRemoteSort('recommended')
    setStep('select-version')
  }

  function selectRemoteVersion(v: RemoteVersionInfo) {
    setForm((prev) => ({ ...prev, gameVersion: v.id, name: v.id }))
    setStep('configure')
  }

  async function handleDownload() {
    if (!form.gameVersion || !form.name.trim()) return

    let resolvedVersion = form.loaderVersion

    if (form.loader && !resolvedVersion) {
      if (loaderVersions.length > 0) {
        resolvedVersion = loaderVersions[0].version
      } else {
        await msgAlert(`未获取到 ${form.loader} 的可用版本列表，无法下载。请检查网络或稍后重试。`)
        return
      }
    }

    try {
      const data: CreateInstanceRequest = {
        name: form.name.trim(),
        gameVersion: form.gameVersion,
        loader: form.loader || undefined,
        loaderVersion: resolvedVersion || undefined,
        gameDir: currentDir,
        maxMemory: 4096,
      }
      const instance = await createInstance(data)

      const task: DownloadTask = {
        id: instance.id,
        name: data.name,
        type: 'game',
        gameVersion: data.gameVersion,
        loader: data.loader,
        loaderVersion: data.loaderVersion,
        addons: selectedAddons.length > 0 ? [...selectedAddons] : undefined,
        status: 'queued',
        progress: 0,
        createdAt: new Date().toISOString(),
        instanceId: instance.id,
      }
      addTask(task)

      const settings = loadSettings()
      const threads = settings.downloadThreads || 64
      const versionIsolation = settings.versionIsolation !== false
      let downloadSource = settings.downloadSource ?? 0
      const downloadTimeout = settings.downloadTimeout ?? 15

      if (settings.autoSelectDownloadSource) {
        try {
          const result = await autoSelectDownloadSource()
          downloadSource = result.id
        } catch {}
      }

      startInstall(instance.id, data.loader, data.loaderVersion, selectedAddons.length > 0 ? selectedAddons : undefined, threads, versionIsolation, downloadSource, downloadTimeout).catch((e) => {
        const ts = getTasks()
        const existing = ts.find((t) => t.id === instance.id)
        if (existing) {
          updateTask(instance.id, { status: 'failed', error: e instanceof Error ? e.message : String(e) })
        }
      })

      if (currentDir) await doScan(currentDir)
      navigate('/downloads')
    } catch (e) {
      await msgAlert(`创建失败: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  async function handleLaunch(v: ScannedVersion) {
    let inst = getInstanceForVersion(v)
    if (!inst) {
      try {
        inst = await createInstance({
          name: v.name,
          gameVersion: v.gameVersion,
          loader: v.loaders.find(l => l.type)?.type,
          loaderVersion: v.loaders.find(l => l.version)?.version,
          gameDir: currentDir!,
          maxMemory: 4096,
        })
        setBackedInstances((prev) => [...prev, inst!])
      } catch (e) {
        await msgAlert(`创建实例失败: ${e instanceof Error ? e.message : String(e)}`)
        return
      }
    }

    try {
      const result = await launchInstance(inst!.id)
      if (!result.success) {
        await msgAlert(`启动失败: ${result.error}\n${result.detail || ''}`)
        return
      }
    } catch (e) {
      await msgAlert(`启动失败: ${e instanceof Error ? e.message : String(e)}`)
      return
    }

    setLaunchProgress({ stage: 'starting', message: '准备启动...', progress: 0, isRunning: false })
    if (launchPollRef.current) clearInterval(launchPollRef.current)

    launchPollRef.current = setInterval(async () => {
      try {
        const p = await getLaunchProgress(inst!.id)
        if (p.stage === 'running' || p.stage === 'completed') {
          setLaunchProgress(null)
          if (launchPollRef.current) { clearInterval(launchPollRef.current); launchPollRef.current = null }
        } else if (p.stage === 'crashed' || p.stage === 'failed') {
          setLaunchProgress(p)
          if (launchPollRef.current) { clearInterval(launchPollRef.current); launchPollRef.current = null }
        } else {
          setLaunchProgress(p)
        }
      } catch { }
    }, 500)
  }

  async function openVersionSettings(v: ScannedVersion) {
    const existing = getInstanceForVersion(v)
    if (existing) {
      navigate(`/instances/${existing.id}`)
      return
    }

    try {
      const created = await createInstance({
        name: v.name,
        gameVersion: v.gameVersion,
        loader: v.loaders.find((l) => l.type)?.type,
        loaderVersion: v.loaders.find((l) => l.version)?.version,
        maxMemory: 4096,
        gameDir: currentDir,
      })
      setBackedInstances((prev) => [...prev, created])
      navigate(`/instances/${created.id}`)
    } catch (e) {
      await msgAlert(`创建实例失败: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  async function handleToggleDefault(v: ScannedVersion) {
    let inst = getInstanceForVersion(v)
    if (!inst) {
      try {
        inst = await createInstance({
          name: v.name,
          gameVersion: v.gameVersion,
          loader: v.loaders.find((l) => l.type)?.type,
          loaderVersion: v.loaders.find((l) => l.version)?.version,
          gameDir: currentDir!,
          maxMemory: 4096,
        })
        setBackedInstances((prev) => [...prev, inst!])
      } catch { return }
    }
    try {
      if (defaultInstanceId === inst.id) {
        await clearDefaultInstance(inst.id)
        setDefaultInstanceId(null)
      } else {
        await setDefaultInstance(inst.id)
        setDefaultInstanceId(inst.id)
      }
    } catch {}
  }

  const filtered = scannedLocal
    .filter((v, i, arr) => arr.findIndex(x => x.name === v.name) === i)
    .filter((v) => !search || v.name.toLowerCase().includes(search.toLowerCase()))

  const filteredRemote = remoteVersions
    .filter((v) => remoteCategory === 'all' || v.type === remoteCategory)
    .filter((v) => !versionSearch || v.id.toLowerCase().includes(versionSearch.toLowerCase()))

  const sortedRemote = [...filteredRemote].sort((a, b) => {
    if (remoteSort === 'newest') {
      return new Date(b.releaseTime).getTime() - new Date(a.releaseTime).getTime()
    }
    if (remoteSort === 'oldest') {
      return new Date(a.releaseTime).getTime() - new Date(b.releaseTime).getTime()
    }
    if (remoteSort === 'name-asc') {
      return a.id.localeCompare(b.id)
    }
    if (remoteSort === 'name-desc') {
      return b.id.localeCompare(a.id)
    }

    const ta = TYPE_ORDER[a.type] ?? 99
    const tb = TYPE_ORDER[b.type] ?? 99
    return ta !== tb ? ta - tb : new Date(b.releaseTime).getTime() - new Date(a.releaseTime).getTime()
  })

  if (step === 'select-version') {
    return (
      <div className="animate-in slide-up space-y-5 p-8">
        <div className="flex items-center gap-3">
          <button onClick={() => setStep('list')} className="flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground">
            <FontAwesomeIcon icon={faArrowLeft} className="h-4 w-4" />
          </button>
          <h2 className="text-lg font-semibold">下载新版本</h2>
        </div>
        <div className="rounded-xl border border-border/60 bg-muted/20 p-4 space-y-4">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs font-medium uppercase tracking-[0.2em] text-muted-foreground/70">分类</span>
            {REMOTE_VERSION_CATEGORIES.map((item) => (
              <button
                key={item.key}
                onClick={() => setRemoteCategory(item.key)}
                className={cn(
                  'rounded-xl px-3.5 py-1.5 text-xs font-medium transition-all',
                  remoteCategory === item.key
                    ? 'bg-primary text-primary-foreground shadow-sm'
                    : 'bg-background text-muted-foreground hover:bg-accent hover:text-foreground'
                )}
              >
                {item.label}
              </button>
            ))}
          </div>

          <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_180px_112px]">
            <div className="relative">
              <FontAwesomeIcon icon={faMagnifyingGlass} className="absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input placeholder="搜索版本..." value={versionSearch} onChange={(e) => setVersionSearch(e.target.value)} className="pl-9" />
            </div>

            <Select value={remoteSort} onChange={setRemoteSort}>
              {REMOTE_SORT_OPTIONS.map((item) => (
                <SelectOption key={item.key} value={item.key}>{item.label}</SelectOption>
              ))}
            </Select>

            <button onClick={() => setRemoteViewMode(remoteViewMode === 'grid' ? 'list' : 'grid')} className={cn('flex h-9 w-9 items-center justify-center rounded-lg border bg-card text-muted-foreground hover:bg-accent hover:text-foreground transition-colors', remoteViewMode === 'grid' ? 'border-primary/30 text-primary' : 'border-input')}>
              <FontAwesomeIcon icon={remoteViewMode === 'grid' ? faGrip : faList} className="h-3.5 w-3.5" />
            </button>
          </div>

          <div className="flex items-center justify-between text-xs text-muted-foreground">
            <span>共 {remoteVersions.length} 个远程版本</span>
            <span>筛选后 {sortedRemote.length} 个</span>
          </div>
        </div>

        {sortedRemote.length === 0 ? (
          <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-border/60 py-20 text-center text-muted-foreground">
            <FontAwesomeIcon icon={faCube} className="mb-3 h-8 w-8 opacity-30" />
            <p className="text-sm font-medium">没有匹配的远程版本</p>
            <p className="mt-1 text-xs text-muted-foreground/70">试试调整分类、排序或搜索关键词</p>
          </div>
        ) : remoteViewMode === 'grid' ? (
          <div className="grid max-h-[520px] grid-cols-2 gap-2 overflow-y-auto pr-1 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5">
            {sortedRemote.map((v) => (
              <button key={v.id} onClick={() => selectRemoteVersion(v)} className="group flex flex-col gap-1.5 rounded-lg border p-3 text-left transition-all hover:border-primary/30 hover:bg-accent/50">
                <div className="flex items-center gap-1.5">
                  <FontAwesomeIcon icon={faCube} className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                  <span className="truncate text-sm font-medium">{v.id}</span>
                </div>
                <div className="flex items-center gap-1.5">
                  <span className={cn('inline-flex items-center rounded-full border px-1.5 py-0.5 text-[10px] font-medium', v.type === 'release' ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-400' : v.type === 'snapshot' ? 'border-amber-500/30 bg-amber-500/10 text-amber-400' : 'border-muted-foreground/20 bg-muted text-muted-foreground')}>{TYPE_LABEL[v.type] || v.type}</span>
                </div>
                <span className="text-[10px] text-muted-foreground/60"><FontAwesomeIcon icon={faCalendar} className="mr-0.5 h-2.5 w-2.5" />{formatDate(v.releaseTime)}</span>
              </button>
            ))}
          </div>
        ) : (
          <div className="max-h-[520px] space-y-2 overflow-y-auto pr-1">
            {sortedRemote.map((v) => (
              <button key={v.id} onClick={() => selectRemoteVersion(v)} className="group flex w-full items-center justify-between gap-4 rounded-xl border p-4 text-left transition-all hover:border-primary/30 hover:bg-accent/50">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <div className="flex items-center gap-2">
                      <FontAwesomeIcon icon={faCube} className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                      <span className="text-sm font-medium text-foreground">{v.id}</span>
                    </div>
                    <span className={cn('inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-medium', v.type === 'release' ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-400' : v.type === 'snapshot' ? 'border-amber-500/30 bg-amber-500/10 text-amber-400' : 'border-muted-foreground/20 bg-muted text-muted-foreground')}>{TYPE_LABEL[v.type] || v.type}</span>
                  </div>
                  <div className="mt-1 text-xs text-muted-foreground/70">
                    <FontAwesomeIcon icon={faCalendar} className="mr-1 h-2.5 w-2.5" />
                    发布日期 {formatDate(v.releaseTime)}
                  </div>
                </div>
                <Button size="sm" className="shrink-0">选择</Button>
              </button>
            ))}
          </div>
        )}
      </div>
    )
  }

  if (step === 'configure') {
    const selectedVer = remoteVersions.find((v) => v.id === form.gameVersion)
    return (
      <div className="animate-in slide-up space-y-5 p-8">
        <div className="flex items-center gap-3">
          <button onClick={() => setStep('select-version')} className="flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground">
            <FontAwesomeIcon icon={faArrowLeft} className="h-4 w-4" />
          </button>
          <h2 className="text-lg font-semibold">配置下载</h2>
        </div>
        <Card>
          <CardContent className="space-y-5 p-6">
            <div className="space-y-2">
              <Label htmlFor="iname">实例名称</Label>
              <div className="relative">
                <FontAwesomeIcon icon={faPen} className="absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
                <Input id="iname" value={form.name} onChange={(e) => setForm((p) => ({ ...p, name: e.target.value }))} className="pl-9" placeholder="输入实例名称..." />
              </div>
            </div>
            <div className="space-y-2">
              <Label>游戏版本</Label>
              <div className="flex h-9 items-center gap-2 rounded-md border bg-muted/30 px-3 text-sm text-muted-foreground">
                <FontAwesomeIcon icon={faCube} className="h-3.5 w-3.5 shrink-0" />
                <span className="font-medium text-foreground">{form.gameVersion}</span>
                {selectedVer && (
                  <span className={cn('inline-flex items-center rounded-full border px-1.5 py-0.5 text-[10px] font-medium', selectedVer.type === 'release' ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-400' : selectedVer.type === 'snapshot' ? 'border-amber-500/30 bg-amber-500/10 text-amber-400' : 'border-muted-foreground/20 bg-muted text-muted-foreground')}>{TYPE_LABEL[selectedVer.type] || selectedVer.type}</span>
                )}
              </div>
            </div>
          <div className="anim-stagger space-y-3">
              <Label>模组加载器</Label>
              <div className="grid grid-cols-[1fr_1fr] gap-3">
                <Select
                  value={form.loader}
                  onChange={(v) => { setForm((p) => ({ ...p, loader: v, loaderVersion: '' })); setSelectedAddons([]) }}
                  placeholder="选择加载器"
                >
                  <SelectOption value="">无（纯净原版）</SelectOption>
                  <SelectOption value="Forge">Forge</SelectOption>
                  <SelectOption value="Fabric">Fabric</SelectOption>
                  <SelectOption value="NeoForge">NeoForge</SelectOption>
                  <SelectOption value="Quilt">Quilt</SelectOption>
                  <SelectOption value="LiteLoader">LiteLoader</SelectOption>
                </Select>
                {form.loader ? (
                  <Select
                    value={form.loaderVersion || '__latest__'}
                    onChange={(v) => setForm((p) => ({ ...p, loaderVersion: v === '__latest__' ? '' : v }))}
                    placeholder="选择版本"
                  >
                    {loadingVersions ? (
                      <SelectOption value="__latest__" disabled>加载中...</SelectOption>
                    ) : loaderVersions.length === 0 ? (
                      <SelectOption value="__latest__" disabled>暂无版本数据</SelectOption>
                    ) : (
                      <>
                        <SelectOption value="__latest__">最新版 {loaderVersions[0].version} (推荐)</SelectOption>
                        <SelectDivider />
                        {loaderVersions.map((lv) => (
                          <SelectOption key={lv.version} value={lv.version}>{lv.version}{lv.isRecommended ? ' (推荐)' : ''}</SelectOption>
                        ))}
                      </>
                    )}
                  </Select>
                ) : (
                  <div className="flex h-9 items-center rounded-md border bg-muted/30 px-3 text-sm text-muted-foreground">先选择加载器</div>
                )}
              </div>
              {form.loader && (
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  <span className={cn('inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-medium', LOADER_COLORS[form.loader] || '')}>{form.loader}</span>
                  <span>{form.loaderVersion || `最新版 ${loaderVersions.length > 0 ? loaderVersions[0].version : '...'}`}</span>
                </div>
              )}
            </div>
            {form.loader && (loadingAddons || loaderAddons.length > 0) && (
              <div className="space-y-2.5">
                <div className="flex items-center gap-2">
                  <Label>附加内容 <span className="text-xs font-normal text-muted-foreground">(可选)</span></Label>
                  {loadingAddons && <span className="text-xs text-muted-foreground animate-pulse">加载中...</span>}
                </div>
                <div className="space-y-2">
                  {loadingAddons ? (
                    <div className="flex h-10 items-center rounded-lg border border-dashed border-border/60 px-3 text-xs text-muted-foreground/50">正在获取附加内容...</div>
                  ) : (
                    loaderAddons.map((addon) => {
                    const checked = selectedAddons.includes(addon.id)
                    return (
                      <div
                        key={addon.id}
                        role="checkbox"
                        aria-checked={checked}
                        tabIndex={0}
                        onClick={() => setSelectedAddons((prev) => prev.includes(addon.id) ? prev.filter((a) => a !== addon.id) : [...prev, addon.id])}
                        onKeyDown={(e) => { if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); setSelectedAddons((prev) => prev.includes(addon.id) ? prev.filter((a) => a !== addon.id) : [...prev, addon.id]) } }}
                        className={cn(
                          'flex cursor-pointer items-start gap-3 rounded-lg border p-3 transition-colors',
                          checked ? 'border-primary/30 bg-primary/5' : 'border-border/60 bg-transparent hover:bg-accent/30'
                        )}
                      >
                        <div className={cn(
                          'mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded border transition-colors',
                          checked ? 'border-primary bg-primary text-primary-foreground' : 'border-muted-foreground/40'
                        )}>
                          {checked && (
                            <svg className="h-3 w-3" viewBox="0 0 12 12" fill="none">
                              <path d="M2.5 6L5 8.5L9.5 3.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                            </svg>
                          )}
                        </div>
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-1.5">
                            <span className="text-sm font-medium">{addon.label}</span>
                            {addon.recommended && (
                              <span className="inline-flex items-center rounded-full border border-emerald-500/30 bg-emerald-500/10 px-1.5 py-0.5 text-[10px] font-medium text-emerald-400">推荐</span>
                            )}
                          </div>
                          <p className="mt-0.5 text-xs text-muted-foreground/70">{addon.description}</p>
                        </div>
                      </div>
                    )
                  }))}
                </div>
              </div>
            )}
            <div className="flex items-center justify-between gap-4 rounded-lg border border-border/40 bg-muted/10 p-3">
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <FontAwesomeIcon icon={faDownload} className="h-3 w-3" />
                <span>仅下载游戏文件，运行内存和 Java 等配置可在创建后调整</span>
              </div>
            </div>
            <div className="flex items-center justify-end gap-3">
              {form.loader && !loadingVersions && loaderVersions.length === 0 && (
                <span className="text-xs text-destructive/80">暂无可用加载器版本，无法下载</span>
              )}
              <Button variant="secondary" onClick={() => setStep('list')}>取消</Button>
              <Button onClick={handleDownload} disabled={!form.gameVersion || !form.name.trim() || loadingVersions || (!!form.loader && !loadingVersions && loaderVersions.length === 0)}>
                <FontAwesomeIcon icon={faDownload} className="h-4 w-4" />开始下载
              </Button>
            </div>
          </CardContent>
        </Card>
      </div>
    )
  }

  function getInstanceForVersion(v: ScannedVersion): GameInstance | undefined {
    return backedInstances.find((i) => i.gameDir === currentDir && i.name === v.name)
  }

  async function handleRepairStart() {
    if (!settingsVersion) return
    const instance = getInstanceForVersion(settingsVersion)
    if (!instance) return
    if (getTasks().some((t) => t.instanceId === instance.id && t.type === 'repair' && (t.status === 'queued' || t.status === 'downloading' || t.status === 'paused'))) return

    const task: DownloadTask = {
      id: `repair-${instance.id}-${Date.now()}`,
      name: `补全 ${settingsVersion.name}`,
      type: 'repair',
      gameVersion: settingsVersion.gameVersion,
      status: 'queued',
      progress: 0,
      createdAt: new Date().toISOString(),
      instanceId: instance.id,
    }
    addTask(task)
    setRepairAdded(true)

    try {
      const threads = loadSettings().downloadThreads || 64
      await repairInstance(instance.id, threads)
    } catch (e) {
      updateTask(task.id, { status: 'failed', error: e instanceof Error ? e.message : String(e) })
    }
  }

  function handleCloseSettings() {
    setSettingsVersion(null)
    setRepairAdded(false)
    setSettingsTab('basic')
  }

  return (
      <div className="animate-in slide-up space-y-6 p-8">
        <PageHeader title="游戏实例" subtitle={`${scannedLocal.length} 个版本`} />

      <div className="flex items-center gap-3" ref={popoverRef}>
        <div className="relative">
          <button
            onClick={() => setDirPopover(!dirPopover)}
            className={cn(
              'flex items-center gap-2 rounded-lg border bg-card px-3 py-1.5 text-xs transition-all hover:bg-accent',
              !currentDir && 'border-dashed text-muted-foreground'
            )}
          >
            <FontAwesomeIcon icon={faFolder} className={cn('h-3.5 w-3.5', currentDir ? 'text-primary' : 'text-muted-foreground')} />
            <span className="max-w-[140px] truncate">{currentDir ? dirName(currentDir) : '选择游戏目录'}</span>
            <FontAwesomeIcon icon={faChevronDown} className={cn('h-2.5 w-2.5 text-muted-foreground transition-transform', dirPopover && 'rotate-180')} />
          </button>
          {dirPopover && (
            <div className="absolute left-0 top-full z-50 mt-1 w-96 rounded-xl border bg-popover p-2 shadow-xl">
              <div className="mb-1 flex items-center justify-between px-2 py-1">
                <span className="text-xs font-medium text-muted-foreground">已保存的目录</span>
                <button onClick={() => setDirManager(true)} className="text-xs text-muted-foreground hover:text-foreground">管理</button>
              </div>
              {managedDirs.length === 0 ? (
                <div className="px-3 py-4 text-center text-sm text-muted-foreground">暂无目录，可在管理中添加</div>
              ) : (
                <div className="max-h-56 space-y-0.5 overflow-y-auto">
                  {managedDirs.map((d) => (
                    <button key={d.path} onClick={() => switchDir(d.path)} className={cn('flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left transition-colors hover:bg-accent', currentDir === d.path && 'bg-accent/80')}>
                      <div className={cn('flex h-8 w-8 items-center justify-center rounded-lg', currentDir === d.path ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground')}>
                        <FontAwesomeIcon icon={faFolder} className="h-4 w-4" />
                      </div>
                      <div className="flex-1 truncate">
                        <div className="text-sm font-medium">{d.name}</div>
                        <div className="truncate text-xs text-muted-foreground">{d.path}</div>
                      </div>
                      {currentDir === d.path && <FontAwesomeIcon icon={faCheck} className="h-3 w-3 text-primary" />}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
        {scanning && <span className="text-xs text-muted-foreground animate-pulse">扫描中...</span>}
      </div>

      <Dialog open={dirManager} onClose={() => setDirManager(false)} className="w-[540px]">
        <DialogHeader onClose={() => setDirManager(false)}>
          <DialogTitle>目录管理</DialogTitle>
        </DialogHeader>
        <DialogBody className="space-y-2">
          {managedDirs.length === 0 && <p className="py-6 text-center text-sm text-muted-foreground">暂无目录</p>}
          {managedDirs.map((d) => (
            <div key={d.path} className="flex items-center gap-3 rounded-lg border p-3">
              <div className="flex-1">
                <Input value={d.name} onChange={(e) => { setManagedDirs((prev) => { const next = prev.map((dd) => dd.path === d.path ? { ...dd, name: e.target.value } : dd); saveDirs(next); return next }) }} className="h-8 text-sm" />
                <div className="mt-0.5 text-xs text-muted-foreground">{d.path}</div>
              </div>
              <Button variant="ghost" size="icon" className="h-8 w-8 shrink-0 text-destructive hover:bg-destructive/10 hover:text-destructive" onClick={() => removeDir(d.path)}>
                <FontAwesomeIcon icon={faTrashCan} className="h-3.5 w-3.5" />
              </Button>
            </div>
          ))}
        </DialogBody>
        <DialogFooter>
          <Button variant="secondary" onClick={addDirManually} className="gap-1.5"><FontAwesomeIcon icon={faPlus} className="h-4 w-4" />手动添加</Button>
          <Button onClick={() => { handlePickDir(); setDirManager(false) }} className="gap-1.5"><FontAwesomeIcon icon={faFolderOpen} className="h-4 w-4" />浏览添加</Button>
        </DialogFooter>
      </Dialog>

      <Dialog open={!!settingsVersion} onClose={handleCloseSettings} className="w-[560px]">
        <DialogHeader onClose={handleCloseSettings}>
          <DialogTitle>{settingsVersion?.name || '实例设置'}</DialogTitle>
        </DialogHeader>
        <DialogBody className="p-0">
          <div className="flex border-b border-border">
            <button
              onClick={() => setSettingsTab('basic')}
              className={`flex-1 px-4 py-2.5 text-sm font-medium transition-colors ${settingsTab === 'basic' ? 'border-b-2 border-primary text-foreground' : 'text-muted-foreground hover:text-foreground'}`}
            >基本信息</button>
            <button
              onClick={() => setSettingsTab('repair')}
              className={`flex-1 px-4 py-2.5 text-sm font-medium transition-colors ${settingsTab === 'repair' ? 'border-b-2 border-primary text-foreground' : 'text-muted-foreground hover:text-foreground'}`}
            >补全文件</button>
          </div>
          <div className="p-6">
            {settingsTab === 'basic' && settingsVersion && (
              <div className="space-y-4">
                <div>
                  <Label className="text-xs text-muted-foreground">版本名称</Label>
                  <p className="mt-0.5 text-sm font-medium">{settingsVersion.name}</p>
                </div>
                <div>
                  <Label className="text-xs text-muted-foreground">游戏版本</Label>
                  <p className="mt-0.5 text-sm font-medium">{settingsVersion.gameVersion}</p>
                </div>
                <div>
                  <Label className="text-xs text-muted-foreground">游戏目录</Label>
                  <p className="mt-0.5 text-sm text-muted-foreground break-all">{currentDir}</p>
                </div>
                {settingsVersion.loaders && settingsVersion.loaders.length > 0 && (
                  <div>
                    <Label className="text-xs text-muted-foreground">加载器</Label>
                    <div className="mt-1 flex flex-wrap gap-1.5">
                      {settingsVersion.loaders.map((l) => (
                        <span key={l.type} className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-medium ${LOADER_COLORS[l.type] || 'text-muted-foreground bg-muted border-border'}`}>{l.type} {l.version}</span>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}
            {settingsTab === 'repair' && settingsVersion && (() => {
              const instance = getInstanceForVersion(settingsVersion)
              if (!instance) return <p className="py-8 text-center text-sm text-muted-foreground">此版本尚未在启动器中创建，无法补全文件。</p>
              const existingTask = getTasks().find((t) => t.instanceId === instance.id && t.type === 'repair')
              const hasActive = existingTask && (existingTask.status === 'queued' || existingTask.status === 'downloading' || existingTask.status === 'paused')
              const isDone = existingTask?.status === 'completed'
              const isFailed = existingTask?.status === 'failed'
              return (
                <div className="space-y-4">
                  <p className="text-sm text-muted-foreground">扫描并下载此实例缺失的 Minecraft 游戏文件（libraries、assets、client.jar）。</p>
                  {(repairAdded || hasActive) ? (
                    <div className="rounded-lg border border-primary/30 bg-primary/5 p-3 text-sm text-primary">
                      <FontAwesomeIcon icon={faDownload} className="mr-1.5 h-4 w-4" />已加入下载任务
                      <button onClick={() => navigate('/downloads')} className="ml-2 text-xs underline hover:text-primary/80">前往下载中心查看</button>
                    </div>
                  ) : isDone ? (
                    <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/10 p-3 text-sm text-emerald-400">
                      <FontAwesomeIcon icon={faCheck} className="mr-1.5 h-4 w-4" />补全已完成
                    </div>
                  ) : isFailed ? (
                    <div className="space-y-2">
                      <div className="rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">{existingTask.error || '补全失败'}</div>
                      <Button variant="outline" size="sm" onClick={handleRepairStart}>重试</Button>
                    </div>
                  ) : (
                    <Button onClick={handleRepairStart} className="gap-2">
                      <FontAwesomeIcon icon={faHammer} className="h-4 w-4" />开始补全文件
                    </Button>
                  )}
                </div>
              )
            })()}
          </div>
        </DialogBody>
      </Dialog>

      <Dialog open={!!launchProgress} onClose={() => setLaunchProgress(null)} className="w-[480px]">
        <DialogHeader onClose={() => setLaunchProgress(null)}>
          <DialogTitle>启动失败</DialogTitle>
        </DialogHeader>
        <DialogBody className="space-y-4">
          {launchProgress && (() => {
            const stageLabels: Record<string, string> = {
              starting: '准备中',
              checking: '检查文件完整性',
              repairing: '补全文件',
              'logging-in': '验证账户',
              authlib: '配置外置登录',
              natives: '解压原生库',
              building: '构建启动参数',
              launching: '启动游戏',
              running: '游戏运行中',
              crashed: '游戏异常退出',
              failed: '启动失败',
              completed: '游戏已退出',
            }
            const isFinal = ['completed', 'crashed', 'failed'].includes(launchProgress.stage)
            const isError = ['crashed', 'failed'].includes(launchProgress.stage)
            return (
              <>
                <div className="flex items-center justify-between text-sm">
                  <span className={cn('font-medium', isError && 'text-destructive')}>
                    {stageLabels[launchProgress.stage] || launchProgress.stage}
                  </span>
                  <span className="text-muted-foreground">{Math.round(launchProgress.progress)}%</span>
                </div>
                <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
                  <div
                    className={cn('h-full rounded-full transition-all', isError ? 'bg-destructive' : 'bg-primary')}
                    style={{ width: `${launchProgress.progress}%` }}
                  />
                </div>
                <p className="text-sm text-muted-foreground">{launchProgress.message}</p>
                {launchProgress.error && (
                  <p className="rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">{launchProgress.error}</p>
                )}
                {launchProgress.crashReport && (
                  <details className="rounded-lg border border-border bg-muted/30">
                    <summary className="cursor-pointer px-3 py-2 text-xs font-medium text-muted-foreground hover:text-foreground">查看崩溃报告</summary>
                    <pre className="max-h-48 overflow-auto px-3 pb-3 text-[11px] text-muted-foreground">{launchProgress.crashReport}</pre>
                  </details>
                )}
                {launchProgress.stage === 'running' && launchProgress.processId && (
                  <p className="text-xs text-muted-foreground">进程 ID: {launchProgress.processId}</p>
                )}
                {!isFinal && (
                  <div className="flex items-center gap-2 text-xs text-muted-foreground">
                    <FontAwesomeIcon icon={faRotate} className="h-3 w-3 animate-spin" />
                    正在启动...
                  </div>
                )}
                {isFinal && (
                  <div className="flex justify-end">
                    <Button variant="secondary" size="sm" onClick={() => setLaunchProgress(null)}>
                      关闭
                    </Button>
                  </div>
                )}
              </>
            )
          })()}
        </DialogBody>
      </Dialog>

      <div className="flex items-center gap-3">
        <div className="relative max-w-sm flex-1">
          <FontAwesomeIcon icon={faMagnifyingGlass} className="absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input placeholder="搜索版本..." value={search} onChange={(e) => setSearch(e.target.value)} className="pl-9" />
        </div>
        <Button onClick={gotoNewInstance}>
          <FontAwesomeIcon icon={faDownload} className="h-4 w-4" />下载新版本
        </Button>
        <Button variant="outline" disabled><FontAwesomeIcon icon={faFileImport} className="h-4 w-4" />导入</Button>
        <button onClick={() => setViewMode(viewMode === 'grid' ? 'list' : 'grid')} className={cn('flex h-9 w-9 items-center justify-center rounded-lg border bg-card text-muted-foreground hover:bg-accent hover:text-foreground transition-colors', viewMode === 'grid' ? 'border-primary/30 text-primary' : 'border-input')}>
          <FontAwesomeIcon icon={viewMode === 'grid' ? faGrip : faList} className="h-3.5 w-3.5" />
        </button>
      </div>

      {!currentDir ? (
        <div className="flex flex-col items-center gap-3 py-24 text-center text-muted-foreground">
          <FontAwesomeIcon icon={faFolder} className="h-12 w-12 opacity-20" />
          <p className="text-sm font-medium">请选择 Minecraft 游戏目录</p>
          <p className="text-xs text-muted-foreground/70">选择一个包含 versions 文件夹的 .minecraft 目录</p>
          <Button variant="outline" onClick={handlePickDir} className="mt-2 gap-2">
            <FontAwesomeIcon icon={faFolderOpen} className="h-4 w-4" />浏览并选择
          </Button>
        </div>
      ) : null}

      {loading || scanning ? (
        <div className="flex items-center justify-center py-24 text-sm text-muted-foreground">扫描版本中...</div>
      ) : scannedLocal.length === 0 ? (
        <div className="flex flex-col items-center gap-3 py-24 text-center text-muted-foreground">
          <FontAwesomeIcon icon={faCube} className="h-10 w-10 opacity-30" />
          <p className="text-sm">{search ? '没有匹配的版本' : '该目录下未检测到任何 Minecraft 版本'}</p>
          <p className="text-xs text-muted-foreground/70">请确认目录下存在 versions/ 文件夹</p>
        </div>
      ) : (
        viewMode === 'grid' ? (
          <div className="anim-stagger grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6">
            {filtered.map((v) => (
              <div key={v.name} className="group relative flex cursor-pointer flex-col items-center rounded-xl border bg-card p-5 text-center transition-all hover:border-primary/30 hover:shadow-lg hover:shadow-primary/5" onClick={() => openVersionSettings(v)}>
                <InstanceIcon icon={getInstanceForVersion(v)?.icon ?? null} loader={v.loaders?.[0]?.type} className="mb-3 h-16 w-16 rounded-2xl" />
                <h3 className="w-full truncate text-sm font-medium leading-tight">{v.name}</h3>
                {v.loaders && v.loaders.filter((l) => l.type).length > 0 && (
                  <div className="mt-1 flex flex-wrap justify-center gap-1">
                    {v.loaders.filter((l) => l.type).map((l) => (
                      <span key={l.type} className={cn('inline-flex items-center rounded-full border px-1.5 py-0.5 text-[10px] font-medium', LOADER_COLORS[l.type] || 'text-muted-foreground bg-muted border-border')}>{l.type}</span>
                    ))}
                  </div>
                )}
                <div className="mt-2 flex items-center gap-1 text-[11px] text-muted-foreground/70">
                  <span className={cn('inline-flex items-center gap-0.5 rounded px-1.5 py-0.5 text-[10px] font-medium', v.state === 'Available' ? 'bg-emerald-500/15 text-emerald-400' : 'bg-amber-500/15 text-amber-400')}>
                    <FontAwesomeIcon icon={v.state === 'Available' ? faCheck : faTriangleExclamation} className="h-2.5 w-2.5" />
                    {v.state === 'Available' ? '可用' : '异常'}
                  </span>
                </div>
                <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 rounded-xl bg-black/60 opacity-0 backdrop-blur-sm transition-opacity group-hover:opacity-100">
                    <Tooltip content="启动">
                    <Button className="h-10 w-10 rounded-full bg-primary text-primary-foreground shadow-lg shadow-primary/30 hover:bg-primary/90" onClick={(e) => { e.stopPropagation(); handleLaunch(v) }}>
                      <FontAwesomeIcon icon={faPlay} className="h-5 w-5" />
                    </Button>
                  </Tooltip>
                  <div className="flex items-center gap-1">
                    <Tooltip content="设置">
                      <Button size="icon" variant="ghost" className="h-8 w-8 text-white/70 hover:bg-white/15 hover:text-white" onClick={(e) => { e.stopPropagation(); openVersionSettings(v) }}><FontAwesomeIcon icon={faGear} className="h-3.5 w-3.5" /></Button>
                    </Tooltip>
                    {(() => { const inst = getInstanceForVersion(v); return (
                      <Tooltip content={inst && defaultInstanceId === inst.id ? '取消固定' : '固定到主页'}>
                        <Button size="icon" variant="ghost" className="h-8 w-8 text-white/70 hover:bg-white/15 hover:text-white" onClick={(e) => { e.stopPropagation(); handleToggleDefault(v) }}>
                          <FontAwesomeIcon icon={faStar} className={cn('h-3.5 w-3.5', inst && defaultInstanceId === inst.id && 'text-yellow-400')} />
                        </Button>
                      </Tooltip>
                    )})()}
                    <Tooltip content="打开文件夹">
                      <Button size="icon" variant="ghost" className="h-8 w-8 text-white/70 hover:bg-white/15 hover:text-white" onClick={(e) => { e.stopPropagation(); openFolder(`${currentDir.replace(/\\/g, '/')}/versions/${v.name}`).catch(() => {}) }}><FontAwesomeIcon icon={faFolderOpen} className="h-3.5 w-3.5" /></Button>
                    </Tooltip>
                  </div>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="space-y-3">
            {filtered.map((v) => (
              <div key={v.name} className="group flex items-center gap-4 rounded-xl border bg-card px-5 py-4 transition-all hover:border-primary/30 hover:shadow-sm">
                <InstanceIcon icon={getInstanceForVersion(v)?.icon ?? null} loader={v.loaders?.[0]?.type} className="h-12 w-12 shrink-0 rounded-xl" />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <h3 className="truncate text-sm font-medium">{v.name}</h3>
                    {v.loaders && v.loaders.filter((l) => l.type).length > 0 && v.loaders.filter((l) => l.type).map((l) => (
                      <span key={l.type} className={cn('inline-flex items-center rounded-full border px-1.5 py-0.5 text-[10px] font-medium shrink-0', LOADER_COLORS[l.type] || 'text-muted-foreground bg-muted border-border')}>{l.type}</span>
                    ))}
                    <span className={cn('inline-flex items-center gap-0.5 rounded px-1.5 py-0.5 text-[10px] font-medium', v.state === 'Available' ? 'bg-emerald-500/15 text-emerald-400' : 'bg-amber-500/15 text-amber-400')}>
                      <FontAwesomeIcon icon={v.state === 'Available' ? faCheck : faTriangleExclamation} className="h-2.5 w-2.5" />
                      {v.state === 'Available' ? '可用' : '异常'}
                    </span>
                  </div>
                  <div className="mt-0.5 flex items-center gap-3 text-xs text-muted-foreground">
                    {v.loaders && v.loaders.filter((l) => l.version).length > 0 && (
                      <span className="flex items-center gap-1">
                        <FontAwesomeIcon icon={faTag} className="h-3 w-3" />
                        {v.loaders.filter((l) => l.version).map((l) => l.version).join(', ')}
                      </span>
                    )}
                    <span className="flex items-center gap-1">
                      <FontAwesomeIcon icon={faCalendar} className="h-3 w-3" />
                      {v.gameVersion}
                    </span>
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100">
                  <Tooltip content="启动">
                    <Button size="icon" variant="ghost" className="h-8 w-8" onClick={() => handleLaunch(v)}>
                      <FontAwesomeIcon icon={faPlay} className="h-4 w-4" />
                    </Button>
                  </Tooltip>
                  <Tooltip content="设置">
                    <Button size="icon" variant="ghost" className="h-8 w-8" onClick={() => openVersionSettings(v)}><FontAwesomeIcon icon={faGear} className="h-3.5 w-3.5" /></Button>
                  </Tooltip>
                  {(() => { const inst = getInstanceForVersion(v); return (
                    <Tooltip content={inst && defaultInstanceId === inst.id ? '取消固定' : '固定到主页'}>
                      <Button size="icon" variant="ghost" className="h-8 w-8" onClick={() => handleToggleDefault(v)}>
                        <FontAwesomeIcon icon={faStar} className={cn('h-3.5 w-3.5', inst && defaultInstanceId === inst.id && 'text-yellow-400')} />
                      </Button>
                    </Tooltip>
                  )})()}
                   <Tooltip content="打开文件夹">
                       <Button size="icon" variant="ghost" className="h-8 w-8" onClick={() => openFolder(`${currentDir.replace(/\\/g, '/')}/versions/${v.name}`).catch(() => {})}><FontAwesomeIcon icon={faFolderOpen} className="h-3.5 w-3.5" /></Button>
                   </Tooltip>
                </div>
              </div>
            ))}
          </div>
        )
      )}
    </div>
  )
}
