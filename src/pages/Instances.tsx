import { useEffect, useState, useCallback, useRef, useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import gsap from 'gsap'

import { Box, Bug, Calendar, Check, ChevronDown, Download, FileInput, Folder, FolderOpen, FolderPlus, Ghost, Hammer, Layers, Pen, Pencil, Play, Plus, RotateCw, Search, Settings, Star, Tag, Trash2, TriangleAlert, Wrench } from 'lucide-react'
import { Grip as GripData, List as ListData } from 'lucide'
import { MorphIcon } from 'morphicons/react'
import { PageHeader } from '../components/PageHeader.tsx'
import { PageShell } from '../components/PageShell.tsx'
import { invoke } from '@tauri-apps/api/core'
import { useI18n } from '../i18n/index.tsx'

import { Button } from '../components/ui'
import { Input } from '../components/ui'
import { Label } from '../components/ui'
import { Card, CardContent } from '../components/ui'
import { Dialog, DialogHeader, DialogTitle, DialogBody, DialogFooter } from '../components/ui'
import { Tooltip } from '../components/ui'
import { ContextMenu } from '../components/ContextMenu.tsx'
import type { ContextMenuItem } from '../components/ContextMenu.tsx'
import { useMessageBox } from '../components/ui'
import { scanVersions, getRemoteVersions, getLoaderVersions, getLoaderAddons } from '../api/versions.ts'
import { createInstance, startInstall, getInstances, syncScan, repairInstance, setDefaultInstance, clearDefaultInstance, getDefaultInstance, updateInstance, getInstanceGroups, createInstanceGroup, updateInstanceGroup, deleteInstanceGroup } from '../api/instance.ts'
import type { InstanceGroup } from '../api/instance.ts'
import { addTask, updateTask, getTasks } from '../stores/downloadStore.ts'
import { Select, SelectOption, SelectDivider } from '../components/ui'
import { Tabs } from '../components/ui'
import type { ScannedVersion, RemoteVersionInfo, CreateInstanceRequest, LoaderVersionInfo, LoaderAddonInfo, DownloadTask, GameInstance } from '../types/index.ts'
import { getSettings, saveSettings as apiSaveSettings, loadSettings as apiLoadSettings, onSettingsChange, autoSelectDownloadSource, openFolder } from '../api/settings.ts'
import { InstanceIcon } from '../components/InstanceIcon.tsx'
import { MicrosoftReauthDialog } from '../components/MicrosoftReauthDialog.tsx'
import { ApiError } from '../api/client.ts'
import { getAccounts, deleteAccount } from '../api/account.ts'
import { AccountSelectDialog } from '../components/AccountSelectDialog.tsx'
import { NoAccountDialog } from '../components/NoAccountDialog.tsx'
import { useRequireDefaultAccount } from '../hooks/useRequireDefaultAccount.ts'
import { useAnimatedList } from '../hooks/useGsapAnimations.ts'
import ImportDialog from '../components/ImportDialog.tsx'
import { cacheInvalidate, cacheGet, cacheSet } from '../lib/simple-cache.ts'
import { useRunning } from '../contexts/RunningContext.tsx'

interface ManagedDir {
  path: string
  name: string
}

const LOADER_COLORS: Record<string, string> = {
  Forge: 'text-orange-500 bg-orange-500/10 border-orange-500/25',
  Fabric: 'text-cyan-400 bg-cyan-400/10 border-cyan-400/25',
  LegacyFabric: 'text-cyan-400 bg-cyan-400/10 border-cyan-400/25',
  NeoForge: 'text-green-500 bg-green-500/10 border-green-500/25',
  Quilt: 'text-purple-400 bg-purple-400/10 border-purple-400/25',
  OptiFine: 'text-yellow-500 bg-yellow-500/10 border-yellow-500/25',
  LiteLoader: 'text-sky-400 bg-sky-400/10 border-sky-400/25',
  Cleanroom: 'text-yellow-400 bg-yellow-500/10 border-yellow-400/25',
  Babric: 'text-amber-400 bg-amber-400/10 border-amber-400/25',
  Vanilla: 'text-muted-foreground bg-muted border-border',
}

const TYPE_LABEL: Record<string, string> = { release: 'instances.type.release', snapshot: 'instances.type.snapshot', old_beta: 'instances.type.old_beta', old_alpha: 'instances.type.old_alpha', april_fools: 'instances.type.april_fools' }
const TYPE_ORDER: Record<string, number> = { release: 0, snapshot: 1, april_fools: 1.5, old_beta: 2, old_alpha: 3 }
const REMOTE_VERSION_CATEGORIES = [
  { key: 'all' },
  { key: 'release' },
  { key: 'snapshot' },
  { key: 'april_fools' },
  { key: 'old_beta' },
  { key: 'old_alpha' },
]

const REMOTE_SORT_OPTIONS = [
  { key: 'recommended' },
  { key: 'newest' },
  { key: 'oldest' },
  { key: 'name-asc' },
  { key: 'name-desc' },
]

function cn(...classes: (string | boolean | undefined | null)[]): string { return classes.filter(Boolean).join(' ') }

/** 取扫描版本里第一个真实加载器（过滤 Vanilla/Unknown——原版实例 loader 应保持空） */
function firstRealLoader(v: ScannedVersion): { type?: string; version?: string } {
  const l = v.loaders?.find((x) => x.type && x.type !== 'Vanilla' && x.type !== 'Unknown')
  return { type: l?.type, version: l?.version }
}

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
  apiSaveSettings({ ...getSettings(), ...s })
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

function truncateMiddle(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text
  const keep = Math.max(0, maxLen - 3)
  const head = Math.ceil(keep / 2)
  return text.slice(0, head) + '…' + text.slice(text.length - (keep - head))
}

type PageStep = 'list' | 'select-version' | 'configure'

export default function Instances() {
  const navigate = useNavigate()
  const { t } = useI18n()
  const { alert: msgAlert, prompt: msgPrompt, notify } = useMessageBox()
  const { launchInstance: ctxLaunchInstance } = useRunning()
  const { needsAccount, resolve: resolveAccountCheck, showNoAccount, showSelectAccount, handleAddAccount, handleGoToAccounts, handleCancelNoAccount, handleCancelSelect, handleSelectAccount } = useRequireDefaultAccount()

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
  const [showMicrosoftReauth, setShowMicrosoftReauth] = useState(false)
  const [importOpen, setImportOpen] = useState(false)
  const [instanceRefreshKey, setInstanceRefreshKey] = useState(0)

  const refreshInstances = useCallback(() => {
    cacheInvalidate('api-instances')
    cacheInvalidate('api-instance-')
    setInstanceRefreshKey(k => k + 1)
  }, [])

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
  const dirPopoverRef = useRef<HTMLDivElement>(null)
  const selectVersionRef = useRef<HTMLDivElement>(null)
  const configureRef = useRef<HTMLDivElement>(null)
  const [editingPath, setEditingPath] = useState<string | null>(null)
  const [editName, setEditName] = useState('')

  const [step, setStep] = useState<PageStep>('list')
  const [versionSearch, setVersionSearch] = useState('')
  const [remoteCategory, setRemoteCategory] = useState('all')
  const [remoteSort, setRemoteSort] = useState('recommended')
  const [remoteViewMode, setRemoteViewMode] = useState<'grid' | 'list'>('grid')
  const [viewMode, setViewMode] = useState<'grid' | 'list'>('grid')
  const [filterType, setFilterType] = useState('all')
  const [groups, setGroups] = useState<InstanceGroup[]>([])
  const [groupFilter, setGroupFilter] = useState<string | null>(null)
  const [groupsDirty, setGroupsDirty] = useState(0)
  const [manageGroupsOpen, setManageGroupsOpen] = useState(false)
  const [assignGroupVersion, setAssignGroupVersion] = useState<ScannedVersion | null>(null)
  const [form, setForm] = useState({ name: '', gameVersion: '', loader: '', loaderVersion: '' })
  const [selectedAddons, setSelectedAddons] = useState<string[]>([])
  const [loaderVersions, setLoaderVersions] = useState<LoaderVersionInfo[]>([])
  const [loadingVersions, setLoadingVersions] = useState(false)
  const [loaderAddons, setLoaderAddons] = useState<LoaderAddonInfo[]>([])
  const [loadingAddons, setLoadingAddons] = useState(false)

  const doScan = useCallback(async (dir: string) => {
    if (!dir) { setScannedLocal([]); return }
    setScanning(true)

    let versions: ScannedVersion[] = []
    try { versions = await scanVersions(dir) }
    catch {}
    setScannedLocal(versions)

    try {
      // 使用 syncScan 将扫描结果同步到后端，返回同步后的实例列表
      const instances = await syncScan(dir, versions)
      setBackedInstances(instances)
    } catch {}
    finally { setScanning(false) }
  }, [])

  useEffect(() => {
    async function init() {
      setLoading(true)
      try {
        const cached = await cacheGet<Awaited<ReturnType<typeof getInstances>>>('api-instances')
        if (cached) setBackedInstances(cached)
        const [remote, instances, def, settings] = await Promise.all([getRemoteVersions(), getInstances(), getDefaultInstance(), apiLoadSettings()])
        setRemoteVersions(remote)
        setBackedInstances(instances)
        cacheSet('api-instances', instances)
        setDefaultInstanceId(def?.id ?? null)
        if (settings.gameDir) setCurrentDir(settings.gameDir)
      } catch (e) { console.error(e) } finally { setLoading(false) }
    }
    init()
  }, [instanceRefreshKey])

  useEffect(() => {
    getInstanceGroups().then(setGroups).catch(() => {})
  }, [groupsDirty])

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
    getLoaderAddons(form.loader, form.gameVersion)
      .then((addons) => { if (!cancelled) setLoaderAddons(addons) })
      .catch(() => { if (!cancelled) setLoaderAddons([]) })
      .finally(() => { if (!cancelled) setLoadingAddons(false) })
    return () => { cancelled = true }
  }, [form.loader, form.gameVersion])

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
      const dir = await invoke<string | null>('pick_dialog', { options: { directory: true, title: t('instances.pickGameDirTitle') } })
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
      const dir = await msgPrompt(t('instances.enterDirPath'), t('instances.chooseDir'))
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

  function moveDir(from: number, to: number) {
    if (from === to) return
    setManagedDirs((prev) => {
      const next = [...prev]
      const [item] = next.splice(from, 1)
      next.splice(to, 0, item)
      saveDirs(next)
      return next
    })
  }

  function startEdit(d: ManagedDir) {
    setEditingPath(d.path)
    setEditName(d.name)
  }

  function commitEdit() {
    const name = editName.trim()
    if (editingPath && name) {
      setManagedDirs((prev) => { const next = prev.map((dd) => dd.path === editingPath ? { ...dd, name } : dd); saveDirs(next); return next })
    }
    setEditingPath(null)
  }

  async function addDirManually() {
    const dir = await msgPrompt(t('instances.enterDirPath'), t('instances.addDir'))
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
    setForm({ name: v.id, gameVersion: v.id, loader: '', loaderVersion: '' })
    setStep('configure')
  }

  async function handleDownload() {
    if (!form.gameVersion || !form.name.trim()) return
    if (!currentDir) {
      await msgAlert(t('instances.selectDirFirst'))
      return
    }

    let resolvedVersion = form.loaderVersion

    if (form.loader && !resolvedVersion) {
      if (loaderVersions.length > 0) {
        resolvedVersion = loaderVersions[0].version
      } else {
        await msgAlert(t('instances.noLoaderVersions', { loader: form.loader }))
        return
      }
    }

    // 后端按 loaderVersion 精确匹配（大小写不敏感）；空串会导致找不到任何安装器。
    if (form.loader && !resolvedVersion?.trim()) {
      await msgAlert(t('instances.selectLoaderVersion', { loader: form.loader }))
      return
    }

    try {
      const isAprilFools = remoteVersions.some((v) => v.id === form.gameVersion && v.type === 'april_fools')
      const data: CreateInstanceRequest = {
        name: form.name.trim(),
        gameVersion: form.gameVersion,
        loader: form.loader || undefined,
        loaderVersion: resolvedVersion || undefined,
        gameDir: currentDir,
        maxMemory: 4096,
        icon: isAprilFools ? 'TNT' : undefined,
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
      await msgAlert(t('instances.createFailed', { error: e instanceof Error ? e.message : String(e) }))
    }
  }

  async function handleLaunch(v: ScannedVersion) {
    let inst = getInstanceForVersion(v)
    if (!inst) {
      try {
        inst = await createInstance({
          name: v.name,
          gameVersion: v.gameVersion,
          loader: firstRealLoader(v).type,
          loaderVersion: firstRealLoader(v).version,
          gameDir: currentDir!,
          maxMemory: 4096,
          iconData: v.iconData ?? v.modpack?.iconData,
          modpackName: v.modpack?.modpackName,
          modpackVersion: v.modpack?.modpackVersion,
          modpackAuthor: v.modpack?.modpackAuthor,
          modpackSummary: v.modpack?.modpackSummary,
        })
        setBackedInstances((prev) => [...prev, inst!])
      } catch (e) {
        await msgAlert(t('instances.createInstanceFailed', { error: e instanceof Error ? e.message : String(e) }))
        return
      }
    }

    if (needsAccount) {
      const ok = await resolveAccountCheck()
      if (!ok) return
    }

    try {
      const result = await ctxLaunchInstance(inst!.id, inst!.name, { path: inst!.javaPath, gameVersion: inst!.gameVersion, gameDir: inst!.gameDir })
      if (!result.success) {
        await msgAlert(t('instances.launchFailedDetail', { error: result.error || '', detail: result.detail || '' }))
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      const code = e instanceof ApiError ? e.code : ''
      if (msg.includes('TOKEN_EXPIRED') || msg.includes('invalid_grant') || msg.includes('AADSTS70008') || code.includes('TOKEN_EXPIRED')) {
        setShowMicrosoftReauth(true)
        return
      }
      if (code.includes('NETWORK_ERROR')) {
        await msgAlert(t('errors.networkError'))
        return
      }
      await msgAlert(t('instances.launchFailed', { error: e instanceof Error ? e.message : String(e) }))
    }
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
        loader: firstRealLoader(v).type,
        loaderVersion: firstRealLoader(v).version,
        maxMemory: 4096,
        gameDir: currentDir,
        iconData: v.modpack?.iconData,
        modpackName: v.modpack?.modpackName,
        modpackVersion: v.modpack?.modpackVersion,
        modpackAuthor: v.modpack?.modpackAuthor,
        modpackSummary: v.modpack?.modpackSummary,
      })
      setBackedInstances((prev) => [...prev, created])
      navigate(`/instances/${created.id}`)
    } catch (e) {
      await msgAlert(t('instances.createInstanceFailed', { error: e instanceof Error ? e.message : String(e) }))
    }
  }

  async function handleToggleDefault(v: ScannedVersion) {
    let inst = getInstanceForVersion(v)
    if (!inst) {
      try {
        inst = await createInstance({
          name: v.name,
          gameVersion: v.gameVersion,
          loader: firstRealLoader(v).type,
          loaderVersion: firstRealLoader(v).version,
          gameDir: currentDir!,
          maxMemory: 4096,
          iconData: v.iconData ?? v.modpack?.iconData,
          modpackName: v.modpack?.modpackName,
          modpackVersion: v.modpack?.modpackVersion,
          modpackAuthor: v.modpack?.modpackAuthor,
          modpackSummary: v.modpack?.modpackSummary,
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

  const versionTypeMap = useMemo(() => {
    const m = new Map<string, string>()
    for (const v of remoteVersions) m.set(v.id, v.type)
    return m
  }, [remoteVersions])

  const getVersionType = useCallback((v: ScannedVersion): string => {
    if (v.state !== 'Available') return 'broken'
    // Vanilla/Unknown 不算 modded——后端对所有原版版本都会返回 [Vanilla] loader 条目
    if (firstRealLoader(v).type) return 'modded'
    const rt = versionTypeMap.get(v.name) ?? versionTypeMap.get(v.gameVersion)
    if (rt === 'snapshot') return 'snapshot'
    if (rt === 'april_fools') return 'april_fools'
    return 'vanilla'
  }, [versionTypeMap])

  const FILTER_OPTIONS = [
    { key: 'all', icon: Layers },
    { key: 'modded', icon: Wrench },
    { key: 'vanilla', icon: Box },
    { key: 'snapshot', icon: Ghost },
    { key: 'april_fools', icon: Star },
    { key: 'broken', icon: Bug },
  ]

  const filtered = useMemo(() => {
    let list = scannedLocal
      .filter((v, i, arr) => arr.findIndex(x => x.name === v.name) === i)
      .filter((v) => !search || v.name.toLowerCase().includes(search.toLowerCase()))
      .filter((v) => filterType === 'all' || getVersionType(v) === filterType)
    if (groupFilter) {
      list = list.filter((v) => {
        const inst = getInstanceForVersion(v)
        return inst?.customGroupIds?.includes(groupFilter) ?? false
      })
    }
    return list
  }, [scannedLocal, search, filterType, groupFilter, getVersionType, getInstanceForVersion])

  // 卡片列表 GSAP stagger 动画（性能版：只动画视口内条目 + 滚动暂停）
  // loading/scanning 进 deps：骨架图→内容切换时加载状态翻转触发动画
  const gridAnimRef = useAnimatedList<HTMLDivElement>([filtered.length, viewMode, loading, scanning], { y: 12, scale: 0.95 })

  // 列表视图 GSAP stagger 动画（性能版）
  const listAnimRef = useAnimatedList<HTMLDivElement>([filtered.length, viewMode, loading, scanning], { x: -12, duration: 0.25 })

  // 目录下拉框弹出动画
  useEffect(() => {
    if (!dirPopover || !dirPopoverRef.current) return

    const settings = getSettings()
    if (!settings.animationsEnabled) return

    const speed = settings.animationSpeed ?? 1
    const el = dirPopoverRef.current

    gsap.fromTo(el,
      { opacity: 0, scale: 0.95, y: -4 },
      {
        opacity: 1,
        scale: 1,
        y: 0,
        duration: 0.15 / speed,
        ease: 'power2.out'
      }
    )
  }, [dirPopover])

  const filteredRemote = useMemo(() => remoteVersions
    .filter((v) => remoteCategory === 'all' || v.type === remoteCategory)
    .filter((v) => !versionSearch || v.id.toLowerCase().includes(versionSearch.toLowerCase())),
    [remoteVersions, remoteCategory, versionSearch])

  const sortedRemote = useMemo(() => [...filteredRemote].sort((a, b) => {
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
  }), [filteredRemote, remoteSort])

  // 远程版本列表 GSAP stagger 动画（性能版：只动画视口内条目 + 滚动暂停）
  const remoteGridAnimRef = useAnimatedList<HTMLDivElement>([sortedRemote.length, remoteViewMode], { y: 12, scale: 0.95 })
  const remoteListAnimRef = useAnimatedList<HTMLDivElement>([sortedRemote.length, remoteViewMode], { y: 12, scale: 0.95 })

  // 步骤切换动画
  useEffect(() => {
    if (step === 'list') return

    const el = step === 'select-version' ? selectVersionRef.current : configureRef.current
    if (!el) return

    const settings = getSettings()
    if (!settings.animationsEnabled) return

    const speed = settings.animationSpeed ?? 1

    gsap.fromTo(el,
      { opacity: 0, x: 20 },
      {
        opacity: 1,
        x: 0,
        duration: 0.3 / speed,
        ease: 'power2.out'
      }
    )
  }, [step])

  if (step === 'select-version') {
    return (
      <PageShell className="p-8 space-y-6 overflow-y-auto scroll-fade-mask">
        <PageHeader
          title={t('instances.downloadTitle')}
          onBack={() => setStep('list')}
        />
        <div ref={selectVersionRef} className="glass-surface rounded-xl border border-border/60 bg-card/80 p-4 space-y-4">
          <div className="space-y-2">
            <p className="text-xs font-medium uppercase tracking-[0.2em] text-muted-foreground/70">{t('instances.categoryLabel')}</p>
            <Tabs tabs={REMOTE_VERSION_CATEGORIES.map(c => ({ id: c.key, label: t(`instances.category.${c.key}`) }))} activeTab={remoteCategory} onChange={setRemoteCategory} />
          </div>

          <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_180px_112px]">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input placeholder={t('instances.searchPlaceholder')} value={versionSearch} onChange={(e) => setVersionSearch(e.target.value)} className="pl-9" />
            </div>

            <Select value={remoteSort} onChange={setRemoteSort}>
              {REMOTE_SORT_OPTIONS.map((item) => (
                <SelectOption key={item.key} value={item.key}>{t(`instances.sort.${item.key}`)}</SelectOption>
              ))}
            </Select>

            <button onClick={() => setRemoteViewMode(remoteViewMode === 'grid' ? 'list' : 'grid')} className={cn('flex h-9 w-9 items-center justify-center rounded-lg border bg-card text-muted-foreground hover:bg-accent hover:text-foreground transition-colors', remoteViewMode === 'grid' ? 'border-primary/30 text-primary' : 'border-input')}>
              <MorphIcon icon={remoteViewMode === 'grid' ? GripData : ListData} className="h-3.5 w-3.5" spring="snappy" reducedMotion="user" />
            </button>
          </div>

          <div className="flex items-center justify-between text-xs text-muted-foreground">
            <span>{t('instances.remoteCount', { count: remoteVersions.length })}</span>
            <span>{t('instances.filteredCount', { count: sortedRemote.length })}</span>
          </div>
        </div>

        {sortedRemote.length === 0 ? (
          <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-border/60 py-20 text-center text-muted-foreground">
            <Box className="mb-3 h-8 w-8 opacity-30" />
            <p className="text-sm font-medium">{t('instances.noRemoteMatch')}</p>
            <p className="mt-1 text-xs text-muted-foreground/70">{t('instances.noRemoteMatchHint')}</p>
          </div>
        ) : remoteViewMode === 'grid' ? (
          <div ref={remoteGridAnimRef} className="grid max-h-[520px] grid-cols-2 gap-2 overflow-y-auto pr-1 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5">
            {sortedRemote.map((v) => (
              <button key={v.id} data-key={v.id} onClick={() => selectRemoteVersion(v)} className="group glass-surface flex flex-col gap-1.5 rounded-lg border bg-card p-3 text-left transition-all hover:border-primary/30 hover:shadow-lg hover:shadow-primary/5">
                <div className="flex items-center gap-1.5">
                  <Box className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                  <span className="truncate text-sm font-medium">{v.id}</span>
                </div>
                <div className="flex items-center gap-1.5">
                  <span className={cn('inline-flex items-center rounded-full border px-1.5 py-0.5 text-[10px] font-medium', v.type === 'release' ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-400' : v.type === 'snapshot' ? 'border-amber-500/30 bg-amber-500/10 text-amber-400' : v.type === 'april_fools' ? 'border-pink-500/30 bg-pink-500/10 text-pink-400' : 'border-muted-foreground/20 bg-muted text-muted-foreground')}>{t(TYPE_LABEL[v.type] ?? v.type)}</span>
                </div>
                <span className="inline-flex items-center gap-1 text-[10px] text-muted-foreground/60"><Calendar className="h-2.5 w-2.5 shrink-0" />{formatDate(v.releaseTime)}</span>
              </button>
            ))}
          </div>
        ) : (
          <div ref={remoteListAnimRef} className="max-h-[520px] space-y-2 overflow-y-auto pr-1">
            {sortedRemote.map((v) => (
              <div key={v.id} data-key={v.id} role="button" tabIndex={0} onClick={() => selectRemoteVersion(v)} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); selectRemoteVersion(v) } }} className="group glass-surface flex w-full cursor-pointer items-center justify-between gap-4 rounded-xl border bg-card p-4 text-left transition-all hover:border-primary/30 hover:shadow-sm">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <div className="flex items-center gap-2">
                      <Box className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                      <span className="text-sm font-medium text-foreground">{v.id}</span>
                    </div>
                    <span className={cn('inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-medium', v.type === 'release' ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-400' : v.type === 'snapshot' ? 'border-amber-500/30 bg-amber-500/10 text-amber-400' : v.type === 'april_fools' ? 'border-pink-500/30 bg-pink-500/10 text-pink-400' : 'border-muted-foreground/20 bg-muted text-muted-foreground')}>{t(TYPE_LABEL[v.type] ?? v.type)}</span>
                  </div>
                  <div className="mt-1 inline-flex items-center gap-1 text-xs text-muted-foreground/70">
                    <Calendar className="h-2.5 w-2.5 shrink-0" />
                    {t('instances.releaseDate', { date: formatDate(v.releaseTime) })}
                  </div>
                </div>
                <Button size="sm" className="shrink-0">{t('instances.select')}</Button>
              </div>
            ))}
          </div>
        )}
      </PageShell>
    )
  }

  if (step === 'configure') {
    const selectedVer = remoteVersions.find((v) => v.id === form.gameVersion)
    return (
      <PageShell className="p-8 space-y-6 overflow-y-auto scroll-fade-mask">
        <PageHeader
          title={t('instances.configTitle')}
          onBack={() => { setStep('select-version'); setLoaderVersions([]) }}
        />
        <Card ref={configureRef}>
          <CardContent className="space-y-5 p-6">
            <div className="space-y-2">
              <Label htmlFor="iname">{t('instances.instanceName')}</Label>
              <div className="relative">
                <Pen className="absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
                <Input id="iname" value={form.name} onChange={(e) => setForm((p) => ({ ...p, name: e.target.value }))} className="pl-9" placeholder={t('instances.instanceNamePlaceholder')} />
              </div>
            </div>
            <div className="space-y-2">
              <Label>{t('instances.gameVersion')}</Label>
              <div className="flex h-9 items-center gap-2 rounded-md border bg-muted/30 px-3 text-sm text-muted-foreground">
                <Box className="h-3.5 w-3.5 shrink-0" />
                <span className="font-medium text-foreground">{form.gameVersion}</span>
                {selectedVer && (
                  <span className={cn('inline-flex items-center rounded-full border px-1.5 py-0.5 text-[10px] font-medium', selectedVer.type === 'release' ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-400' : selectedVer.type === 'snapshot' ? 'border-amber-500/30 bg-amber-500/10 text-amber-400' : selectedVer.type === 'april_fools' ? 'border-pink-500/30 bg-pink-500/10 text-pink-400' : 'border-muted-foreground/20 bg-muted text-muted-foreground')}>{t(TYPE_LABEL[selectedVer.type] || selectedVer.type)}</span>
                )}
              </div>
            </div>
           <div className="space-y-3">
              <Label>{t('instances.loader')}</Label>
              <div className="grid grid-cols-[1fr_1fr] gap-3">
                <Select
                  value={form.loader}
                  onChange={(v) => { setForm((p) => ({ ...p, loader: v, loaderVersion: '' })); setSelectedAddons([]) }}
                  placeholder={t('instances.loaderPlaceholder')}
                >
                  <SelectOption value="">{t('instances.noneVanilla')}</SelectOption>
                  <SelectOption value="Forge">Forge</SelectOption>
                  <SelectOption value="Fabric">Fabric</SelectOption>
                  <SelectOption value="NeoForge">NeoForge</SelectOption>
                  <SelectOption value="Quilt">Quilt</SelectOption>
                  <SelectOption value="LegacyFabric">LegacyFabric</SelectOption>
                  <SelectOption value="LiteLoader">LiteLoader</SelectOption>
                  <SelectOption value="Cleanroom">Cleanroom</SelectOption>
                  <SelectOption value="Babric">Babric</SelectOption>
                </Select>
                {form.loader ? (
                  <Select
                    value={form.loaderVersion || '__latest__'}
                    onChange={(v) => setForm((p) => ({ ...p, loaderVersion: v === '__latest__' ? '' : v }))}
                    placeholder={t('instances.versionPlaceholder')}
                  >
                    {loadingVersions ? (
                      <SelectOption value="__latest__" disabled>{t('instances.loadingVersions')}</SelectOption>
                    ) : loaderVersions.length === 0 ? (
                      <SelectOption value="__latest__" disabled>{t('instances.noVersionData')}</SelectOption>
                    ) : (
                      <>
                        <SelectOption value="__latest__">{t('instances.latestRecommended', { version: loaderVersions[0].version })}</SelectOption>
                        <SelectDivider />
                        {loaderVersions.map((lv) => (
                          <SelectOption key={lv.version} value={lv.version}>{lv.version}{lv.isRecommended ? t('instances.recommended') : ''}</SelectOption>
                        ))}
                      </>
                    )}
                  </Select>
                ) : (
                  <div className="flex h-9 items-center rounded-md border bg-muted/30 px-3 text-sm text-muted-foreground">{t('instances.selectLoaderFirst')}</div>
                )}
              </div>
              {form.loader && (
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  <span className={cn('inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-medium', LOADER_COLORS[form.loader] || '')}>{form.loader}</span>
                  <span>{form.loaderVersion || t('instances.latestVersion', { version: loaderVersions.length > 0 ? loaderVersions[0].version : '...' })}</span>
                </div>
              )}
            </div>
            {form.loader && (loadingAddons || loaderAddons.length > 0) && (
              <div className="space-y-2.5">
                <div className="flex items-center gap-2">
                  <Label>{t('instances.addons')} <span className="text-xs font-normal text-muted-foreground">{t('instances.optional')}</span></Label>
                  {loadingAddons && <span className="text-xs text-muted-foreground animate-pulse">{t('common.loading')}</span>}
                </div>
                <div className="space-y-2">
                  {loadingAddons ? (
                    <div className="flex h-10 items-center rounded-lg border border-dashed border-border/60 px-3 text-xs text-muted-foreground/50">{t('instances.fetchingAddons')}</div>
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
                              <span className="inline-flex items-center rounded-full border border-emerald-500/30 bg-emerald-500/10 px-1.5 py-0.5 text-[10px] font-medium text-emerald-400">{t('instances.recommended')}</span>
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
                <Download className="h-3 w-3" />
                <span>{t('instances.onlyGameFiles')}</span>
              </div>
            </div>
            <div className="flex items-center justify-end gap-3">
              {form.loader && !loadingVersions && loaderVersions.length === 0 && (
                <span className="text-xs text-destructive/80">{t('instances.noLoaderAvailable')}</span>
              )}
              <Button variant="secondary" onClick={() => setStep('list')}>{t('instances.cancel')}</Button>
              <Button onClick={handleDownload} disabled={!form.gameVersion || !form.name.trim() || loadingVersions || (!!form.loader && !loadingVersions && loaderVersions.length === 0)}>
                <Download className="h-4 w-4" />{t('instances.startDownload')}
              </Button>
            </div>
          </CardContent>
        </Card>
      </PageShell>
    )
  }

  function getInstanceForVersion(v: ScannedVersion): GameInstance | undefined {
    return backedInstances.find((i) => i.gameDir === currentDir && i.name === v.name)
  }

  function getLoadersForVersion(v: ScannedVersion) {
    const inst = getInstanceForVersion(v)
    if (inst?.loader) return [{ type: inst.loader, version: inst.loaderVersion ?? '' }]
    return v.loaders?.filter((l) => l.type) ?? []
  }

  async function handleRepairStart() {
    if (!settingsVersion) return
    const instance = getInstanceForVersion(settingsVersion)
    if (!instance) return
    if (getTasks().some((t) => t.instanceId === instance.id && t.type === 'repair' && (t.status === 'queued' || t.status === 'downloading' || t.status === 'paused'))) return

    const task: DownloadTask = {
      id: `repair-${instance.id}-${Date.now()}`,
      name: t('instances.repairName', { name: settingsVersion.name }),
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

  const GROUP_COLORS = ['#22d3ee', '#22c55e', '#f59e0b', '#ef4444', '#a855f7', '#3b82f6', '#ec4899', '#84cc16']

  async function handleCreateGroup(name: string, color: string) {
    if (!name.trim()) return
    try {
      await createInstanceGroup(name.trim(), color)
      setGroupsDirty(d => d + 1)
    } catch {}
  }

  async function handleRenameGroup(id: string, name: string, color: string) {
    if (!name.trim()) return
    try {
      await updateInstanceGroup(id, name.trim(), color)
      setGroupsDirty(d => d + 1)
    } catch {}
  }

  async function handleDeleteGroup(id: string) {
    try {
      await deleteInstanceGroup(id)
      if (groupFilter === id) setGroupFilter(null)
      setGroupsDirty(d => d + 1)
      refreshInstances()
    } catch {}
  }

  async function handleAssignGroup(v: ScannedVersion, groupId: string) {
    const inst = getInstanceForVersion(v)
    if (!inst) return
    const cur = inst.customGroupIds ?? []
    const next = cur.includes(groupId) ? cur.filter(g => g !== groupId) : [...cur, groupId]
    try {
      const updated = await updateInstance(inst.id, { customGroupIds: next } as Partial<CreateInstanceRequest>)
      setBackedInstances(prev => prev.map(i => i.id === updated.id ? { ...i, customGroupIds: updated.customGroupIds } : i))
    } catch {}
  }

  return (
      <PageShell className="p-8 space-y-6 overflow-y-auto scroll-fade-mask">
        <PageHeader title={t('instances.title')} subtitle={t('instances.subtitle', { count: scannedLocal.length })}
          actions={
            <Tooltip content={t('instances.refresh')}>
              <button onClick={refreshInstances} className="flex h-8 w-8 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-accent hover:text-foreground">
                <RotateCw className={cn('h-3.5 w-3.5', loading && 'animate-spin')} />
              </button>
            </Tooltip>
          }
        />



      <Dialog open={dirManager} onClose={() => setDirManager(false)} className="w-[600px]">
        <DialogHeader onClose={() => setDirManager(false)}>
          <DialogTitle>{t('instances.dirManagerTitle')}</DialogTitle>
        </DialogHeader>
        <DialogBody>
          {managedDirs.length === 0 ? (
            <div className="flex flex-col items-center gap-2 py-8">
              <Folder className="h-10 w-10 text-muted-foreground/40" />
              <p className="text-sm text-muted-foreground">{t('instances.noDir')}</p>
              <p className="text-xs text-muted-foreground/60">{t('instances.noDirHint')}</p>
            </div>
          ) : (
            <div className="space-y-3">
              <p className="px-1 text-xs text-muted-foreground">{t('instances.dirCount', { count: managedDirs.length })}</p>
              {managedDirs.map((d, i) => {
                const active = currentDir === d.path
                const editing = editingPath === d.path
                const contextItems: ContextMenuItem[] = [
                  { label: t('instances.setCurrent'), onClick: () => switchDir(d.path), disabled: active },
                  { label: t('instances.rename'), onClick: () => startEdit(d) },
                  { label: t('instances.moveUp'), onClick: () => moveDir(i, i - 1), disabled: i === 0 },
                  { label: t('instances.moveDown'), onClick: () => moveDir(i, i + 1), disabled: i === managedDirs.length - 1 },
                  { label: t('instances.openDir'), onClick: () => { openFolder(d.path).catch(() => {}) } },
                  { label: t('instances.remove'), onClick: () => removeDir(d.path), danger: true },
                ]
                return (
                  <div
                    key={d.path}
                    className={cn(
                      'rounded-lg border transition-colors',
                      active ? 'border-primary/40 bg-primary/5' : 'border-border bg-muted/20 hover:bg-muted/40'
                    )}
                  >
                    <ContextMenu items={contextItems}>
                      <div
                        role="button"
                        tabIndex={0}
                        onClick={() => switchDir(d.path)}
                        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); switchDir(d.path) } }}
                        className="cursor-pointer space-y-1 p-3"
                      >
                        <div className="flex items-center gap-2">
                          <Folder className="h-4 w-4 shrink-0 text-muted-foreground" />
                          {editing ? (
                            <Input
                              autoFocus
                              value={editName}
                              onChange={(e) => setEditName(e.target.value)}
                              onBlur={commitEdit}
                              onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Enter') commitEdit(); if (e.key === 'Escape') setEditingPath(null) }}
                              onClick={(e) => e.stopPropagation()}
                              className="h-7 text-sm font-medium"
                            />
                          ) : (
                            <>
                              <span className="min-w-0 flex-1 truncate text-sm font-medium">{d.name || dirName(d.path)}</span>
                              <Tooltip content={t('instances.rename')}>
                                <Button size="icon" variant="ghost" className="h-7 w-7 shrink-0" onClick={(e) => { e.stopPropagation(); startEdit(d) }}>
                                  <Pencil className="h-3 w-3" />
                                </Button>
                              </Tooltip>
                            </>
                          )}
                          {active && (
                            <span className="inline-flex items-center gap-1 shrink-0 rounded-full bg-green-500/10 px-2 py-0.5 text-xs font-medium text-green-600 dark:text-green-400">
                              <Check className="h-3 w-3" />
                              {t('instances.inUse')}
                            </span>
                          )}
                          <Tooltip content={t('instances.openDir')}>
                            <Button size="icon" variant="ghost" className="h-7 w-7 shrink-0" onClick={(e) => { e.stopPropagation(); openFolder(d.path).catch(() => {}) }}>
                              <FolderOpen className="h-3.5 w-3.5" />
                            </Button>
                          </Tooltip>
                          <Tooltip content={t('instances.remove')}>
                            <Button size="icon" variant="ghost" className="h-7 w-7 shrink-0 text-destructive hover:bg-destructive/10 hover:text-destructive" onClick={(e) => { e.stopPropagation(); removeDir(d.path) }}>
                              <Trash2 className="h-3.5 w-3.5" />
                            </Button>
                          </Tooltip>
                        </div>
                        <Tooltip content={d.path}>
                          <p className="truncate pl-6 text-xs text-muted-foreground">{truncateMiddle(d.path, 48)}</p>
                        </Tooltip>
                      </div>
                    </ContextMenu>
                  </div>
                )
              })}
            </div>
          )}
        </DialogBody>
        <DialogFooter className="justify-between">
          <Button variant="link" onClick={addDirManually} className="gap-1.5 px-2"><Plus className="h-4 w-4" />{t('instances.manualAdd')}</Button>
          <Button onClick={() => { handlePickDir(); setDirManager(false) }} className="gap-1.5"><FolderOpen className="h-4 w-4" />{t('instances.browseAdd')}</Button>
        </DialogFooter>
      </Dialog>

      <Dialog open={!!settingsVersion} onClose={handleCloseSettings} className="w-[560px]">
        <DialogHeader onClose={handleCloseSettings}>
          <DialogTitle>{settingsVersion?.name || t('instances.instanceSettings')}</DialogTitle>
        </DialogHeader>
        <DialogBody className="p-0">
          <div className="flex border-b border-border">
            <button
              onClick={() => setSettingsTab('basic')}
              className={`flex-1 px-4 py-2.5 text-sm font-medium transition-colors ${settingsTab === 'basic' ? 'border-b-2 border-primary text-foreground' : 'text-muted-foreground hover:text-foreground'}`}
            >{t('instances.basicInfo')}</button>
            <button
              onClick={() => setSettingsTab('repair')}
              className={`flex-1 px-4 py-2.5 text-sm font-medium transition-colors ${settingsTab === 'repair' ? 'border-b-2 border-primary text-foreground' : 'text-muted-foreground hover:text-foreground'}`}
            >{t('instances.repairFiles')}</button>
          </div>
          <div className="p-6">
            {settingsTab === 'basic' && settingsVersion && (
              <div className="space-y-4">
                <div>
                  <Label className="text-xs text-muted-foreground">{t('instances.versionName')}</Label>
                  <p className="mt-0.5 text-sm font-medium">{settingsVersion.name}</p>
                </div>
                <div>
                  <Label className="text-xs text-muted-foreground">{t('instances.gameVersion')}</Label>
                  <p className="mt-0.5 text-sm font-medium">{settingsVersion.gameVersion}</p>
                </div>
                <div>
                  <Label className="text-xs text-muted-foreground">{t('instances.gameDir')}</Label>
                  <p className="mt-0.5 text-sm text-muted-foreground break-all">{currentDir}</p>
                </div>
                {settingsVersion.loaders && settingsVersion.loaders.length > 0 && (
                  <div>
                    <Label className="text-xs text-muted-foreground">{t('instances.loader')}</Label>
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
              if (!instance) return <p className="py-8 text-center text-sm text-muted-foreground">{t('instances.notCreatedYet')}</p>
              const existingTask = getTasks().find((t) => t.instanceId === instance.id && t.type === 'repair')
              const hasActive = existingTask && (existingTask.status === 'queued' || existingTask.status === 'downloading' || existingTask.status === 'paused')
              const isDone = existingTask?.status === 'completed'
              const isFailed = existingTask?.status === 'failed'
              return (
                <div className="space-y-4">
                  <p className="text-sm text-muted-foreground">{t('instances.repairDesc')}</p>
                  {(repairAdded || hasActive) ? (
                    <div className="rounded-lg border border-primary/30 bg-primary/5 p-3 text-sm text-primary">
                      <Download className="mr-1.5 h-4 w-4" />{t('instances.addedToDownload')}
                      <button onClick={() => navigate('/downloads')} className="ml-2 text-xs underline hover:text-primary/80">{t('instances.goToDownloadCenter')}</button>
                    </div>
                  ) : isDone ? (
                    <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/10 p-3 text-sm text-emerald-400">
                      <Check className="mr-1.5 h-4 w-4" />{t('instances.repairCompleted')}
                    </div>
                  ) : isFailed ? (
                    <div className="space-y-2">
                      <div className="rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">{existingTask.error || t('instances.repairFailed')}</div>
                      <Button variant="outline" size="sm" onClick={handleRepairStart}>{t('instances.retry')}</Button>
                    </div>
                  ) : (
                    <Button onClick={handleRepairStart} className="gap-2">
                      <Hammer className="h-4 w-4" />{t('instances.startRepair')}
                    </Button>
                  )}
                </div>
              )
            })()}
          </div>
        </DialogBody>
      </Dialog>

      <div className="flex items-center gap-3">
        <div className="flex items-center gap-3" ref={popoverRef}>
          <div className="relative">
            <button
              onClick={() => setDirPopover(!dirPopover)}
              className={cn(
                'flex items-center gap-2 rounded-lg border border-input bg-background h-9 px-3 text-xs transition-all hover:bg-accent',
                !currentDir && 'border-dashed text-muted-foreground'
              )}
            >
              <Folder className="h-3.5 w-3.5 text-muted-foreground" />
              <span className="max-w-[140px] truncate">{currentDir ? dirName(currentDir) : t('instances.selectGameDir')}</span>
              <ChevronDown className={cn('h-2.5 w-2.5 text-muted-foreground transition-transform', dirPopover && 'rotate-180')} />
            </button>
            {dirPopover && (
              <div ref={dirPopoverRef} className="absolute left-0 top-full z-50 mt-1 w-96 rounded-xl border bg-popover p-2 shadow-xl">
                <div className="mb-1 flex items-center justify-between px-2 py-1">
                  <span className="text-xs font-medium text-muted-foreground">{t('instances.savedDirs')}</span>
                  <button onClick={() => setDirManager(true)} className="text-xs text-muted-foreground hover:text-foreground">{t('instances.manage')}</button>
                </div>
                {managedDirs.length === 0 ? (
                  <div className="px-3 py-4 text-center text-sm text-muted-foreground">{t('instances.noDirInManager')}</div>
                ) : (
                  <div className="max-h-56 space-y-0.5 overflow-y-auto">
                    {managedDirs.map((d) => (
                      <button key={d.path} onClick={() => switchDir(d.path)} className={cn('flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left transition-colors hover:bg-accent', currentDir === d.path && 'bg-accent/80')}>
                        <div className={cn('flex h-8 w-8 items-center justify-center rounded-lg', currentDir === d.path ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground')}>
                          <Folder className="h-4 w-4" />
                        </div>
                        <div className="flex-1 truncate">
                          <div className="text-sm font-medium">{d.name}</div>
                          <div className="truncate text-xs text-muted-foreground">{d.path}</div>
                        </div>
                        {currentDir === d.path && <Check className="h-3 w-3 text-primary" />}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
          {scanning && <span className="text-xs text-muted-foreground animate-pulse">{t('instances.scanning')}</span>}
        </div>
        <div className="relative max-w-sm flex-1">
          <Search className="absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input placeholder={t('instances.searchPlaceholder')} value={search} onChange={(e) => setSearch(e.target.value)} className="pl-9" />
        </div>
        <Button onClick={gotoNewInstance}>
          <Download className="h-4 w-4" />{t('instances.downloadTitle')}
        </Button>
        <Button variant="outline" onClick={() => setImportOpen(true)}><FileInput className="h-4 w-4" />{t('instances.import')}</Button>
        {currentDir && (
          <Tooltip content={t('instances.openGameDir')}>
            <Button variant="outline" size="icon" className="h-9 w-9" onClick={() => openFolder(`${currentDir.replace(/[/\\]+$/, '')}/versions`).catch(() => {})}>
              <FolderOpen className="h-4 w-4" />
            </Button>
          </Tooltip>
        )}
        <Tooltip content={t('instances.manageGroups')}>
          <Button variant="outline" size="icon" className="h-9 w-9 shrink-0" onClick={() => setManageGroupsOpen(true)}>
            <FolderPlus className="h-3.5 w-3.5" />
          </Button>
        </Tooltip>
        <button onClick={() => setViewMode(viewMode === 'grid' ? 'list' : 'grid')} className={cn('flex h-9 w-9 items-center justify-center rounded-lg border border-input bg-background text-muted-foreground hover:bg-accent hover:text-foreground transition-colors', viewMode === 'grid' ? 'border-primary/30 text-primary' : 'border-input')}>
          <MorphIcon icon={viewMode === 'grid' ? GripData : ListData} className="h-3.5 w-3.5" spring="snappy" reducedMotion="user" />
        </button>
      </div>

      <div className="flex items-center gap-2">
        <Tabs
          tabs={[
            ...FILTER_OPTIONS.map(o => ({ id: o.key, label: t(`instances.loaderFilter.${o.key}`), icon: <o.icon className="h-3 w-3" /> })),
            ...groups.map(g => ({ id: `group:${g.id}`, label: g.name, icon: <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: g.color }} /> })),
          ]}
          activeTab={groupFilter ? `group:${groupFilter}` : filterType}
          onChange={(id) => {
            if (id.startsWith('group:')) {
              setGroupFilter(id.slice(6))
            } else {
              setGroupFilter(null)
              setFilterType(id)
            }
          }}
          className="[&>button]:px-3 [&>button]:py-1.5 [&>button]:text-xs"
        />
      </div>

      {!currentDir ? (
        <div className="flex flex-col items-center gap-3 py-24 text-center text-muted-foreground">
          <Folder className="h-12 w-12 opacity-20" />
          <p className="text-sm font-medium">{t('instances.selectMcDir')}</p>
          <p className="text-xs text-muted-foreground/70">{t('instances.selectMcDirHint')}</p>
          <Button variant="outline" onClick={handlePickDir} className="mt-2 gap-2">
            <FolderOpen className="h-4 w-4" />{t('instances.browseAndSelect')}
          </Button>
        </div>
      ) : null}

      {loading || scanning ? (
        viewMode === 'grid' ? (
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6">
            {Array.from({ length: 6 }).map((_, index) => (
              <div key={index} className="animate-pulse rounded-xl border bg-card p-5 text-center">
                <div className="mx-auto mb-3 h-16 w-16 rounded-2xl bg-muted" />
                <div className="mx-auto h-4 w-2/3 rounded bg-muted" />
                <div className="mx-auto mt-2 h-3 w-1/3 rounded bg-muted" />
              </div>
            ))}
          </div>
        ) : (
          <div className="space-y-3">
            {Array.from({ length: 5 }).map((_, index) => (
              <div key={index} className="animate-pulse flex items-center gap-4 rounded-xl border bg-card px-5 py-4">
                <div className="h-12 w-12 shrink-0 rounded-xl bg-muted" />
                <div className="flex-1 space-y-2">
                  <div className="h-4 w-1/4 rounded bg-muted" />
                  <div className="flex gap-2">
                    <div className="h-3 w-1/6 rounded bg-muted" />
                    <div className="h-3 w-1/8 rounded bg-muted" />
                  </div>
                </div>
              </div>
            ))}
          </div>
        )
      ) : scannedLocal.length === 0 ? (
        <div className="flex flex-col items-center gap-3 py-24 text-center text-muted-foreground">
          <Box className="h-10 w-10 opacity-30" />
          <p className="text-sm">{search ? t('instances.noMatch') : t('instances.noVersionDetected')}</p>
          <p className="text-xs text-muted-foreground/70">{t('instances.needVersionsFolder')}</p>
        </div>
      ) : (
        <div className="space-y-6">
          {scannedLocal.length > 0 && (viewMode === 'grid' ? (
          <div ref={gridAnimRef} className="grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6">
            {filtered.map((v) => (
              <div key={v.name} data-key={v.name} className="group glass-surface relative flex cursor-pointer flex-col items-center rounded-xl border bg-card p-5 text-center transition-all hover:border-primary/30 hover:shadow-lg hover:shadow-primary/5" onClick={() => openVersionSettings(v)}>
                <InstanceIcon icon={getInstanceForVersion(v)?.icon ?? null} iconData={getInstanceForVersion(v)?.iconData ?? null} loader={getLoadersForVersion(v)[0]?.type} className="mb-3 h-16 w-16 rounded-2xl" />
                <h3 className="w-full truncate text-sm font-medium leading-tight">{v.name}</h3>
                <div className="mt-1 flex flex-wrap justify-center gap-1">
                  {getLoadersForVersion(v).length > 0 ? (
                    getLoadersForVersion(v).map((l) => (
                      <span key={l.type} className={cn('inline-flex items-center rounded-full border px-1.5 py-0.5 text-[10px] font-medium', LOADER_COLORS[l.type] || 'text-muted-foreground bg-muted border-border')}>{l.type}</span>
                    ))
                  ) : (
                    <span className={cn('inline-flex items-center rounded-full border px-1.5 py-0.5 text-[10px] font-medium', LOADER_COLORS.Vanilla)}>Vanilla</span>
                  )}
                </div>
                <div className="mt-2 flex items-center gap-1 text-[11px] text-muted-foreground/70">
                  <span className={cn('inline-flex items-center gap-0.5 rounded px-1.5 py-0.5 text-[10px] font-medium', v.state === 'Available' ? 'bg-emerald-500/15 text-emerald-400' : 'bg-amber-500/15 text-amber-400')}>
                    {v.state === 'Available' ? <Check className="h-2.5 w-2.5" /> : <TriangleAlert className="h-2.5 w-2.5" />}
                    {v.state === 'Available' ? t('instances.available') : t('instances.unavailable')}
                  </span>
                </div>
                <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 rounded-xl bg-black/60 opacity-0 backdrop-blur-sm transition-opacity group-hover:opacity-100">
                    <Tooltip content={t('instances.launch')}>
                    <Button className="h-10 w-10 rounded-full bg-primary text-primary-foreground shadow-lg shadow-primary/30 hover:bg-primary/90" onClick={(e) => { e.stopPropagation(); handleLaunch(v) }}>
                      <Play className="h-5 w-5" />
                    </Button>
                  </Tooltip>
                  <div className="flex items-center gap-1">
                    <Tooltip content={t('instances.settings')}>
                      <Button size="icon" variant="ghost" className="h-8 w-8 text-white/70 hover:bg-white/15 hover:text-white" onClick={(e) => { e.stopPropagation(); openVersionSettings(v) }}><Settings className="h-3.5 w-3.5" /></Button>
                    </Tooltip>
                    <Tooltip content={t('instances.groups')}>
                      <Button size="icon" variant="ghost" className="h-8 w-8 text-white/70 hover:bg-white/15 hover:text-white" onClick={(e) => { e.stopPropagation(); setAssignGroupVersion(v) }}><Layers className="h-3.5 w-3.5" /></Button>
                    </Tooltip>
                    {(() => { const inst = getInstanceForVersion(v); return (
                      <Tooltip content={inst && defaultInstanceId === inst.id ? t('instances.unpin') : t('instances.pinToHome')}>
                        <Button size="icon" variant="ghost" className="h-8 w-8 text-white/70 hover:bg-white/15 hover:text-white" onClick={(e) => { e.stopPropagation(); handleToggleDefault(v) }}>
                          <Star className={cn('h-3.5 w-3.5', inst && defaultInstanceId === inst.id && 'text-yellow-400')} />
                        </Button>
                      </Tooltip>
                    )})()}
                    <Tooltip content={t('instances.openFolder')}>
                      <Button size="icon" variant="ghost" className="h-8 w-8 text-white/70 hover:bg-white/15 hover:text-white" onClick={(e) => { e.stopPropagation(); openFolder(`${currentDir.replace(/[/\\]+$/, '').replace(/\\/g, '/')}/versions/${v.name}`).catch(() => {}) }}><FolderOpen className="h-3.5 w-3.5" /></Button>
                    </Tooltip>
                  </div>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div ref={listAnimRef} className="space-y-3">
            {filtered.map((v) => (
              <div key={v.name} data-key={v.name} className="group glass-surface flex items-center gap-4 rounded-xl border bg-card px-5 py-4 transition-all hover:border-primary/30 hover:shadow-sm">
                <InstanceIcon icon={getInstanceForVersion(v)?.icon ?? null} iconData={getInstanceForVersion(v)?.iconData ?? null} loader={getLoadersForVersion(v)[0]?.type} className="h-12 w-12 shrink-0 rounded-xl" />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <h3 className="truncate text-sm font-medium">{v.name}</h3>
                    {getLoadersForVersion(v).length > 0 ? (
                      getLoadersForVersion(v).map((l) => (
                        <span key={l.type} className={cn('inline-flex items-center rounded-full border px-1.5 py-0.5 text-[10px] font-medium shrink-0', LOADER_COLORS[l.type] || 'text-muted-foreground bg-muted border-border')}>{l.type}</span>
                      ))
                    ) : (
                      <span className={cn('inline-flex items-center rounded-full border px-1.5 py-0.5 text-[10px] font-medium shrink-0', LOADER_COLORS.Vanilla)}>Vanilla</span>
                    )}
                    <span className={cn('inline-flex items-center gap-0.5 rounded px-1.5 py-0.5 text-[10px] font-medium', v.state === 'Available' ? 'bg-emerald-500/15 text-emerald-400' : 'bg-amber-500/15 text-amber-400')}>
                      {v.state === 'Available' ? <Check className="h-2.5 w-2.5" /> : <TriangleAlert className="h-2.5 w-2.5" />}
                    {v.state === 'Available' ? t('instances.available') : t('instances.unavailable')}
                    </span>
                    </div>
                    <div className="mt-0.5 flex items-center gap-3 text-xs text-muted-foreground">
                    {getLoadersForVersion(v).filter((l) => l.version).length > 0 && (
                      <span className="flex items-center gap-1">
                        <Tag className="h-3 w-3" />
                        {getLoadersForVersion(v).filter((l) => l.version).map((l) => l.version).join(', ')}
                      </span>
                    )}
                    <span className="flex items-center gap-1">
                      <Calendar className="h-3 w-3" />
                      {v.gameVersion}
                    </span>
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100">
                  <Tooltip content={t('instances.launch')}>
                    <Button size="icon" variant="ghost" className="h-8 w-8" onClick={() => handleLaunch(v)}>
                      <Play className="h-4 w-4" />
                    </Button>
                  </Tooltip>
                  <Tooltip content={t('instances.settings')}>
                    <Button size="icon" variant="ghost" className="h-8 w-8" onClick={() => openVersionSettings(v)}><Settings className="h-3.5 w-3.5" /></Button>
                  </Tooltip>
                  <Tooltip content={t('instances.groups')}>
                    <Button size="icon" variant="ghost" className="h-8 w-8" onClick={() => setAssignGroupVersion(v)}><Layers className="h-3.5 w-3.5" /></Button>
                  </Tooltip>
                  {(() => { const inst = getInstanceForVersion(v); return (
                    <Tooltip content={inst && defaultInstanceId === inst.id ? t('instances.unpin') : t('instances.pinToHome')}>
                      <Button size="icon" variant="ghost" className="h-8 w-8" onClick={() => handleToggleDefault(v)}>
                        <Star className={cn('h-3.5 w-3.5', inst && defaultInstanceId === inst.id && 'text-yellow-400')} />
                      </Button>
                    </Tooltip>
                  )})()}
                   <Tooltip content={t('instances.openFolder')}>
                        <Button size="icon" variant="ghost" className="h-8 w-8" onClick={() => openFolder(`${currentDir.replace(/[/\\]+$/, '').replace(/\\/g, '/')}/versions/${v.name}`).catch(() => {})}><FolderOpen className="h-3.5 w-3.5" /></Button>
                   </Tooltip>
                </div>
              </div>
            ))}
          </div>
        ))}
        </div>
      )}
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
        onReauth={async () => {
          try {
            const list = await getAccounts()
            const def = list.find((a) => a.isDefault)
            if (def) {
              try {
                await deleteAccount(def.uuid)
              } catch (e) {
                // 仅当账号已不存在（确认 404）时忽略；其它失败（网络/临时 API 错误）需上报，
                // 避免过期凭据残留并允许添加重复账号。
                if (e instanceof ApiError && e.status === 404) {
                  /* 账号已不存在，继续重新登录 */
                } else {
                  notify(
                    t('dialogs.common.deleteFailed', {
                      error: e instanceof ApiError ? e.displayMessage : t('dialogs.common.unknownError'),
                    }),
                    'error',
                  )
                  return
                }
              }
            }
          } catch (e) {
            notify(
              t('dialogs.common.deleteFailed', {
                error: e instanceof ApiError ? e.displayMessage : t('dialogs.common.unknownError'),
              }),
              'error',
            )
            return
          }
          navigate('/accounts?add=microsoft')
        }}
      />
      <ImportDialog
        open={importOpen}
        onClose={() => setImportOpen(false)}
        gameDir={loadSettings().gameDir || currentDir}
        versionIsolation={loadSettings().versionIsolation !== false}
      />
      <ManageGroupsDialog
        open={manageGroupsOpen}
        groups={groups}
        colors={GROUP_COLORS}
        onClose={() => setManageGroupsOpen(false)}
        onCreate={handleCreateGroup}
        onRename={handleRenameGroup}
        onDelete={handleDeleteGroup}
      />
      <AssignGroupDialog
        version={assignGroupVersion}
        groups={groups}
        instance={assignGroupVersion ? getInstanceForVersion(assignGroupVersion) : undefined}
        onClose={() => setAssignGroupVersion(null)}
        onToggle={handleAssignGroup}
      />
      </PageShell>
    )
  }

/** 管理自定义分组弹窗：创建 / 重命名 / 改色 / 删除 */
function ManageGroupsDialog({ open, groups, colors, onClose, onCreate, onRename, onDelete }: {
  open: boolean
  groups: InstanceGroup[]
  colors: string[]
  onClose: () => void
  onCreate: (name: string, color: string) => void
  onRename: (id: string, name: string, color: string) => void
  onDelete: (id: string) => void
}) {
  const { t } = useI18n()
  const [name, setName] = useState('')
  const [color, setColor] = useState(colors[0] ?? '#22d3ee')
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editName, setEditName] = useState('')
  const [editColor, setEditColor] = useState('')

  useEffect(() => {
    if (open) { setName(''); setColor(colors[0] ?? '#22d3ee'); setEditingId(null) }
  }, [open, colors])

  function startEdit(g: InstanceGroup) {
    setEditingId(g.id)
    setEditName(g.name)
    setEditColor(g.color)
  }

  return (
    <Dialog open={open} onClose={onClose}>
      <DialogHeader onClose={onClose}>
        <DialogTitle><Layers className="mr-2 h-4 w-4 text-muted-foreground" />{t('instances.manageGroups')}</DialogTitle>
      </DialogHeader>
      <DialogBody className="space-y-4">
        {/* 新建 */}
        <div className="space-y-2 rounded-lg border p-3">
          <div className="flex items-center gap-2">
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder={t('instances.groupNamePlaceholder')} className="flex-1" />
            <div className="flex items-center gap-1">
              {colors.slice(0, 4).map(c => (
                <button key={c} type="button" onClick={() => setColor(c)} className={cn('h-5 w-5 rounded-full border-2 transition-transform', color === c ? 'scale-110 border-primary' : 'border-transparent hover:scale-110')} style={{ backgroundColor: c }} />
              ))}
            </div>
            <Button size="sm" disabled={!name.trim()} onClick={() => { onCreate(name, color); setName('') }}>{t('common.create')}</Button>
          </div>
        </div>

        {/* 列表 */}
        <div className="space-y-2">
          {groups.length === 0 ? (
            <p className="py-6 text-center text-xs text-muted-foreground">{t('instances.noGroups')}</p>
          ) : groups.map((g) => (
            <div key={g.id} className="flex items-center gap-2 rounded-lg border px-3 py-2">
              <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: g.color }} />
              {editingId === g.id ? (
                <>
                  <Input value={editName} onChange={(e) => setEditName(e.target.value)} className="h-8 flex-1 text-sm" autoFocus />
                  <div className="flex items-center gap-1">
                    {colors.slice(0, 4).map(c => (
                      <button key={c} type="button" onClick={() => setEditColor(c)} className={cn('h-4 w-4 rounded-full border-2', editColor === c ? 'border-primary' : 'border-transparent')} style={{ backgroundColor: c }} />
                    ))}
                  </div>
                  <Button size="sm" variant="default" onClick={() => { onRename(g.id, editName, editColor); setEditingId(null) }}><Check className="h-3 w-3" /></Button>
                  <Button size="sm" variant="ghost" onClick={() => setEditingId(null)}>{t('common.cancel')}</Button>
                </>
              ) : (
                <>
                  <span className="flex-1 truncate text-sm">{g.name}</span>
                  <Tooltip content={t('common.edit')}>
                    <Button size="icon" variant="ghost" className="h-7 w-7" onClick={() => startEdit(g)}><Pencil className="h-3 w-3" /></Button>
                  </Tooltip>
                  <Tooltip content={t('common.delete')}>
                    <Button size="icon" variant="ghost" className="h-7 w-7 text-destructive hover:text-destructive" onClick={() => onDelete(g.id)}><Trash2 className="h-3 w-3" /></Button>
                  </Tooltip>
                </>
              )}
            </div>
          ))}
        </div>
      </DialogBody>
    </Dialog>
  )
}

/** 快捷分配分组弹窗：实例可加入多个自定义分组 */
function AssignGroupDialog({ version, groups, instance, onClose, onToggle }: {
  version: ScannedVersion | null
  groups: InstanceGroup[]
  instance: GameInstance | undefined
  onClose: () => void
  onToggle: (v: ScannedVersion, groupId: string) => void
}) {
  const { t } = useI18n()
  const selected = new Set(instance?.customGroupIds ?? [])

  return (
    <Dialog open={!!version} onClose={onClose}>
      <DialogHeader onClose={onClose}>
        <DialogTitle><Layers className="mr-2 h-4 w-4 text-muted-foreground" />{t('instances.groups')}</DialogTitle>
      </DialogHeader>
      <DialogBody className="space-y-3">
        <p className="truncate text-sm font-medium">{version?.name}</p>
        {groups.length === 0 ? (
          <p className="py-4 text-center text-xs text-muted-foreground">{t('instances.noGroups')}</p>
        ) : (
          <div className="flex flex-wrap gap-2">
            {groups.map((g) => {
              const active = selected.has(g.id)
              return (
                <button
                  key={g.id}
                  type="button"
                  onClick={() => version && onToggle(version, g.id)}
                  className={cn('inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-sm transition-colors', active ? 'border-primary text-primary' : 'border-border text-muted-foreground hover:border-muted-foreground/40')}
                >
                  <span className="h-2 w-2 rounded-full" style={{ backgroundColor: g.color }} />
                  {g.name}
                  {active && <Check className="h-3 w-3" />}
                </button>
              )
            })}
          </div>
        )}
        <p className="text-xs text-muted-foreground">{t('instances.groupsHint')}</p>
      </DialogBody>
    </Dialog>
  )
}
