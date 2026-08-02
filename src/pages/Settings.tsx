import { useState, useEffect, useCallback, useRef } from 'react'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import { faRocket, faCoffee, faPalette, faInfoCircle, faFolderOpen, faSliders, faCheck, faMagnifyingGlass, faBolt, faPlus, faMinus, faDownload, faRotate, faFolder, faTrashCan, faArrowUp, faCircleCheck, faTag, faDesktop, faRobot, faBug, faBolt as faLightning, faChevronDown, faChevronRight, faExternalLinkAlt, faGlobe, faHeart, faFileLines, faShieldHalved, faKey, faCopy, faSpinner, faPuzzlePiece } from '@fortawesome/free-solid-svg-icons'
import { faGithub, faJava } from '@fortawesome/free-brands-svg-icons'
import { Button } from '../components/ui'
import { Card, CardHeader, CardTitle, CardContent } from '../components/ui'
import { Input } from '../components/ui'
import { Label } from '../components/ui'
import { Dialog, DialogHeader, DialogTitle, DialogBody, DialogFooter } from '../components/ui'
import { Badge } from '../components/ui'
import { Separator } from '../components/ui'
import { Select, SelectOption } from '../components/ui'
import { Tooltip } from '../components/ui'
import { Tabs, TabContent } from '../components/ui'
import { Checkbox } from '../components/ui'
import { PageHeader } from '../components/PageHeader.tsx'
import { PageShell } from '../components/PageShell.tsx'
import DebugTab from '../components/DebugTab.tsx'
import LogTab from '../components/LogTab.tsx'
import ToolboxTab from '../components/ToolboxTab.tsx'
import { PluginCard } from '../components/PluginCard.tsx'
import { PluginIcon } from '../components/PluginIcon.tsx'
import { usePluginStore } from '../stores/pluginStore.ts'
import { deactivatePlugin } from '../plugins/plugin-loader.tsx'
import { PERMISSION_CATALOG } from '../plugins/types.ts'
import type { PluginInfo } from '../plugins/types.ts'
import LicenseActivationDialog from '../components/LicenseActivationDialog.tsx'
import { fetchLicenseStatus, getCachedLicenseStatus } from '../api/license.ts'
import { check } from '@tauri-apps/plugin-updater'
import type { Update } from '@tauri-apps/plugin-updater'
import type { LicenseStatus } from '../api/license.ts'
import UpdateDialog from '../components/UpdateDialog.tsx'
import { useDebug } from '../components/DebugContext.tsx'
import { useMessageBox } from '../components/ui'
import { cn } from '../lib/utils.ts'
import type { SystemInfo, JavaDownloadVendorInfo, DownloadTask } from '../types/index.ts'
import {
  addCustomJavaRuntime,
  removeCustomJavaRuntime,
  getJavaDownloadCatalog,
  startJavaDownload,
} from '../api/java.ts'
import { getRuntimes, addRuntime, removeRuntime, scanRuntimes, loadCustomRuntimes, subscribe } from '../stores/javaStore.ts'
import { addTask } from '../stores/downloadStore.ts'
import { getSystemInfo } from '../api/system.ts'
import { ApiError, get, API_BASE } from '../api/client.ts'
import { invoke } from '@tauri-apps/api/core'
import { openUrl, revealItemInDir, openPath } from '@tauri-apps/plugin-opener'
import type { JavaRuntime } from '../types/index.ts'
import { DEFAULT_SETTINGS, saveSettings as apiSaveSettings, loadSettings as apiLoadSettings, pingDownloadSources, pingModSources, clearCache, setDataDir } from '../api/settings.ts'
import { setPluginState as apiSetPluginState } from '../api/plugins.ts'
import type { AppSettings, DownloadSourcePing, ModSourcePing } from '../api/settings.ts'
import { APP_INFO, CONTRIBUTORS, DEPENDENCIES, BACKEND_DEPENDENCIES, SERVICES, LICENSE, REPOSITORY_URL, REFERENCE_PROJECTS } from '../constants/credits.ts'

const CATEGORIES = [
  { id: 'launcher', label: '启动器', icon: faRocket },
  { id: 'java', label: 'Java 运行时', icon: faCoffee },
  { id: 'plugins', label: '插件', icon: faPuzzlePiece },
  { id: 'appearance', label: '外观', icon: faPalette },
  { id: 'toolbox', label: '工具箱', icon: faDownload },
  { id: 'logs', label: '日志', icon: faFileLines },
  { id: 'about', label: '关于', icon: faInfoCircle },
  { id: 'debug', label: '调试', icon: faBug },
]

const DOWNLOAD_SOURCES = [
  { value: 0, label: '官方源' },
  { value: 1, label: 'BMCLAPI 镜像' },
]

function saveSettings(settings: AppSettings) {
  apiSaveSettings(settings)
  const enabled = settings.animationsEnabled !== false
  const speed = settings.animationSpeed ?? 1
  const maxFps = settings.maxFrameRate ?? 0
  const fpsScale = maxFps > 0 ? 60 / maxFps : 1
  document.documentElement.dataset.animEnabled = String(enabled)
  document.documentElement.dataset.maxFps = String(maxFps)
  document.documentElement.style.setProperty('--anim-duration-multiplier', String((1 / speed) * fpsScale))
  document.documentElement.style.setProperty('--radius', `${settings.cornerRadius ?? 8}px`)
  window.dispatchEvent(new CustomEvent('qomicex-bg-change'))
}

function AboutTab({ sysInfo, licenseStatus, onOpenLicenseDialog }: {
  sysInfo: SystemInfo | null
  licenseStatus: LicenseStatus | null
  onOpenLicenseDialog: () => void
}) {
  const [expandedDep, setExpandedDep] = useState<string | null>(null)
  const [updateState, setUpdateState] = useState<'idle' | 'checking' | 'available' | 'downloading' | 'installing' | 'uptodate' | 'error'>('idle')
  const [pendingUpdate, setPendingUpdate] = useState<Update | null>(null)
  const [updateError, setUpdateError] = useState<string>()
  const [channel, setChannel] = useState(() => localStorage.getItem('update-channel') || 'stable')
  const channelTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const [licenseCopied, setLicenseCopied] = useState(false)
  const [updateDialogOpen, setUpdateDialogOpen] = useState(false)

  const isPreRelease = /-/.test(APP_INFO.version)
  const versionType = isPreRelease ? '测试版' : '稳定版'

  useEffect(() => {
    if (licenseStatus?.valid && licenseStatus?.channel === 'alpha') {
      setChannelAndSave('alpha')
    }
  }, [licenseStatus?.valid, licenseStatus?.channel])

  function setChannelAndSave(v: string) {
    setChannel(v)
    if (channelTimerRef.current) clearTimeout(channelTimerRef.current)
    channelTimerRef.current = setTimeout(() => localStorage.setItem('update-channel', v), 500)
  }

  async function checkForUpdate() {
    setUpdateState('checking')
    setUpdateError(undefined)
    try {
      const update = await check({
        headers: { 'X-Updater-Channel': channel }
      })
      if (!update) {
        setUpdateState('uptodate')
        return
      }
      setPendingUpdate(update)
      setUpdateState('available')
      setUpdateDialogOpen(true)
    } catch (e) {
      setUpdateState('error')
      setUpdateError(String(e instanceof Error ? e.message : e))
    }
  }

  return (
    <div key="about" className="animate-in slide-up space-y-4">
      {/* Header */}
      <Card>
        <CardHeader>
          <CardTitle>
            <FontAwesomeIcon icon={faInfoCircle} className="mr-2 h-4 w-4 text-muted-foreground" />
            关于 {APP_INFO.name}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center gap-4">
            <img src="/logo.svg" alt={APP_INFO.name} className="h-14 w-14 rounded-2xl" />
            <div className="flex-1 min-w-0">
              <div className="text-lg font-semibold">{APP_INFO.name}</div>
              <div className="flex items-center gap-2">
                <span className="text-sm text-muted-foreground">版本 {APP_INFO.version}</span>
                <span className="rounded-full border px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wider text-muted-foreground bg-muted">{versionType}</span>
              </div>
            </div>
            <div className="flex items-center gap-1 shrink-0">
              <Button size="sm" variant="ghost" onClick={() => openUrl('https://github.com/Qomicex-Public/Qomicex.Tauri/issues').catch(() => window.open('https://github.com/Qomicex-Public/Qomicex.Tauri/issues', '_blank'))} className="gap-1.5 h-7 text-xs">
                <FontAwesomeIcon icon={faBug} className="h-3 w-3" />反馈
              </Button>
              <Button size="sm" variant="ghost" onClick={() => openUrl(REPOSITORY_URL).catch(() => window.open(REPOSITORY_URL, '_blank'))} className="gap-1.5 h-7 text-xs">
                <FontAwesomeIcon icon={faGithub} className="h-3 w-3" />查看仓库
              </Button>
            </div>
          </div>
          <p className="text-sm leading-relaxed text-muted-foreground">{APP_INFO.description}</p>
        </CardContent>
      </Card>

      {/* Version Info */}
      <Card>
        <CardHeader><CardTitle>版本信息</CardTitle></CardHeader>
        <CardContent>
          <div className="rounded-lg bg-background p-4 text-sm">
            <div className="grid grid-cols-2 gap-3">
              <div><div className="text-xs text-muted-foreground">应用版本</div><div className="mt-0.5 flex items-center gap-2 font-medium">{APP_INFO.version}<span className="rounded-full border px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wider text-muted-foreground bg-muted">{versionType}</span></div></div>
              <div><div className="text-xs text-muted-foreground">版本哈希</div><div className="mt-0.5 font-medium text-xs font-mono">{sysInfo?.gitCommit && sysInfo.gitCommit !== 'unknown' ? sysInfo.gitCommit : __GIT_SHA__}</div></div>
              <div><div className="text-xs text-muted-foreground">操作系统</div><div className="mt-0.5 font-medium">{sysInfo?.osDisplayName || (sysInfo ? `${sysInfo.osName} ${sysInfo.osVersion}` : '加载中...')}</div></div>
              <div><div className="text-xs text-muted-foreground">系统架构</div><div className="mt-0.5 font-medium">{sysInfo?.architecture ?? '加载中...'}</div></div>
              <div><div className="text-xs text-muted-foreground">内存</div><div className="mt-0.5 font-medium">{sysInfo ? `${(sysInfo.memory / 1024).toFixed(1)} GB` : '加载中...'}</div></div>
            </div>
          </div>
        </CardContent>
      </Card>

      {licenseStatus && !(licenseStatus.valid && !licenseStatus.licenseId) && (
      <Card>
        <CardHeader><CardTitle>
          <FontAwesomeIcon icon={faShieldHalved} className="mr-2 h-4 w-4 text-muted-foreground" />
          许可证
        </CardTitle></CardHeader>
        <CardContent className="space-y-3">
          <div className="flex items-center gap-3">
            {licenseStatus.valid ? (
              <Badge variant="default" className="gap-1">
                <FontAwesomeIcon icon={faCheck} className="h-3 w-3" />
                已激活
              </Badge>
            ) : (
              <Badge variant="destructive" className="gap-1">
                {licenseStatus.error === 'LICENSE_NOT_FOUND' ? '未激活' : '无效'}
              </Badge>
            )}
            {licenseStatus.licenseId && (
              <span className="text-sm text-muted-foreground">ID: {licenseStatus.licenseId}</span>
            )}
          </div>
          <div className="rounded-lg bg-muted p-3 text-sm space-y-1.5">
            <div className="flex justify-between text-xs">
              <span className="text-muted-foreground">频道</span>
              <span>{licenseStatus.channel || '-'}</span>
            </div>
            <div className="flex justify-between text-xs">
              <span className="text-muted-foreground">到期</span>
              <span>{licenseStatus.isPermanent ? '永久有效' : (licenseStatus.expireAt || '-')}</span>
            </div>
            <div className="flex justify-between text-xs">
              <span className="text-muted-foreground">机器码</span>
              <span className="font-mono text-[10px] max-w-[200px] truncate select-all">{licenseStatus.machineCode || '-'}</span>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Button size="sm" variant="outline" onClick={onOpenLicenseDialog} className="gap-1.5">
              <FontAwesomeIcon icon={faKey} className="h-3 w-3" />
              {licenseStatus.valid ? '更换许可证' : '激活许可证'}
            </Button>
            <Tooltip content={licenseCopied ? '已复制' : '复制机器码'}>
              <Button
                size="sm"
                variant="ghost"
                className="h-8 px-2"
                onClick={async () => {
                  if (!licenseStatus.machineCode) return
                  await navigator.clipboard.writeText(licenseStatus.machineCode)
                  setLicenseCopied(true)
                  setTimeout(() => setLicenseCopied(false), 2000)
                }}
              >
                <FontAwesomeIcon icon={licenseCopied ? faCheck : faCopy} className="h-3 w-3" />
              </Button>
            </Tooltip>
          </div>
        </CardContent>
      </Card>
      )}

      {/* Update */}
      <Card>
        <CardHeader><CardTitle>
          <FontAwesomeIcon icon={faArrowUp} className="mr-2 h-4 w-4 text-muted-foreground" />
          更新
        </CardTitle></CardHeader>
        <CardContent className="space-y-3">
          <div className="flex items-center gap-3">
            <Select value={channel} onChange={setChannelAndSave} className="w-28">
              {licenseStatus?.valid && licenseStatus?.channel === 'alpha' ? (
                <SelectOption value="alpha">Alpha</SelectOption>
              ) : (
                <>
                  <SelectOption value="stable">稳定版</SelectOption>
                  <SelectOption value="beta">测试版</SelectOption>
                </>
              )}
            </Select>
            <Button size="sm" onClick={checkForUpdate} disabled={updateState === 'checking' || updateState === 'downloading'}>
              <FontAwesomeIcon icon={updateState === 'checking' ? faRotate : faArrowUp} className={cn('mr-1 h-3 w-3', updateState === 'checking' && 'animate-spin')} />
              {updateState === 'checking' ? '检查中...' : '检查更新'}
            </Button>
            {updateState === 'uptodate' && (
              <span className="flex items-center gap-1 text-sm text-muted-foreground">
                <FontAwesomeIcon icon={faCircleCheck} className="h-3.5 w-3.5 text-primary" />
                已是最新版本
              </span>
            )}
            {updateState === 'error' && (
              <Tooltip content={updateError}>
                <span className="text-sm text-destructive cursor-help">检查更新失败</span>
              </Tooltip>
            )}
          </div>

        </CardContent>
      </Card>

      <UpdateDialog
        open={updateDialogOpen}
        update={pendingUpdate}
        onClose={() => setUpdateDialogOpen(false)}
      />

      {/* Contributors */}
      <Card>
        <CardHeader><CardTitle>开发者</CardTitle></CardHeader>
        <CardContent>
          <div className="space-y-3">
            {CONTRIBUTORS.map((c) => (
                <div key={c.name} className="flex items-center gap-3">
                  {c.avatar ? (
                    <img src={c.avatar} alt={c.name} className="h-10 w-10 rounded-full object-cover" />
                  ) : (
                    <div className="flex h-10 w-10 items-center justify-center rounded-full bg-primary/10 text-sm font-bold text-primary">
                      {c.name.slice(0, 1).toUpperCase()}
                    </div>
                  )}
                  <div className="flex-1 min-w-0">
                    <div className="font-medium text-sm">{c.name}</div>
                    <div className="text-xs text-muted-foreground">{c.role}</div>
                  </div>
                  <Button size="sm" variant="ghost" onClick={() => openUrl(c.url).catch(() => window.open(c.url, '_blank'))} className="gap-1.5 h-7 text-xs">
                    <FontAwesomeIcon icon={faGithub} className="h-3 w-3" />GitHub
                  </Button>
                </div>
                ))}
          </div>
        </CardContent>
      </Card>

      {/* Services Credits */}
      <Card>
        <CardHeader><CardTitle><FontAwesomeIcon icon={faHeart} className="mr-2 h-4 w-4 text-destructive" />鸣谢</CardTitle></CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            {SERVICES.map((svc) => (
              <button
                key={svc.name}
                onClick={() => openUrl(svc.url).catch(() => window.open(svc.url, '_blank'))}
                className="flex items-center gap-3 rounded-lg px-3 py-2.5 text-left text-sm hover:bg-accent"
              >
                {svc.icon ? (
                  <img src={svc.icon} alt={svc.name} className="h-6 w-6 shrink-0 rounded object-contain" />
                ) : (
                  <FontAwesomeIcon icon={faGlobe} className="h-4 w-4 shrink-0 text-muted-foreground" />
                )}
                <div className="min-w-0 flex-1">
                  <div className="font-medium">{svc.name}</div>
                  <div className="truncate text-xs text-muted-foreground">{svc.description}</div>
                </div>
                <FontAwesomeIcon icon={faExternalLinkAlt} className="h-3 w-3 shrink-0 text-muted-foreground/50" />
              </button>
            ))}
          </div>
        </CardContent>
      </Card>

      {/* Reference Projects */}
      <Card>
        <CardHeader><CardTitle>参考项目</CardTitle></CardHeader>
        <CardContent>
          <div className="space-y-2">
            {REFERENCE_PROJECTS.map((proj) => (
              <button
                key={proj.name}
                onClick={() => openUrl(proj.url).catch(() => window.open(proj.url, '_blank'))}
                className="flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left text-sm hover:bg-accent"
              >
                <FontAwesomeIcon icon={faGithub} className="h-4 w-4 shrink-0 text-muted-foreground" />
                <div className="flex-1 min-w-0">
                  <div className="font-medium">{proj.name}</div>
                  <div className="truncate text-xs text-muted-foreground">{proj.description}</div>
                </div>
                <FontAwesomeIcon icon={faExternalLinkAlt} className="h-3 w-3 shrink-0 text-muted-foreground/50" />
              </button>
            ))}
          </div>
        </CardContent>
      </Card>

      {/* Backend Dependencies */}
      <Card>
        <CardHeader><CardTitle>后端依赖</CardTitle></CardHeader>
        <CardContent>
          <div className="space-y-1">
            {Object.entries(BACKEND_DEPENDENCIES).map(([category, deps]) => (
              <div key={category}>
                <button
                  onClick={() => setExpandedDep(expandedDep === category ? null : category)}
                  className="flex w-full items-center justify-between rounded-lg px-3 py-2 text-sm font-medium hover:bg-accent"
                >
                  <span>{category}</span>
                  <div className="flex items-center gap-2">
                    <Badge variant="secondary" className="h-5 text-[10px]">{deps.length}</Badge>
                    <FontAwesomeIcon icon={expandedDep === category ? faChevronDown : faChevronRight} className="h-3 w-3 text-muted-foreground" />
                  </div>
                </button>
                {expandedDep === category && (
                  <div className="mt-1 space-y-1 pl-2">
                    {deps.map((dep) => (
                      <div
                        key={dep.name}
                        className={cn(
                          'flex w-full items-center justify-between rounded-lg px-3 py-1.5 text-xs',
                          dep.license === '自研' ? 'bg-primary/5' : 'hover:bg-accent'
                        )}
                      >
                        <div className="flex items-center gap-2">
                          <span className="text-muted-foreground">{dep.name}</span>
                          {dep.license === '自研' && <Badge variant="outline" className="h-4 px-1 text-[9px] border-primary/30 text-primary">自研</Badge>}
                        </div>
                        {dep.url.startsWith('http') ? (
                          <FontAwesomeIcon icon={faExternalLinkAlt} className="h-2.5 w-2.5 text-muted-foreground/50 cursor-pointer" onClick={() => openUrl(dep.url).catch(() => window.open(dep.url, '_blank'))} />
                        ) : null}
                      </div>
                    ))}
                  </div>
                )}
                <Separator className="my-1" />
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      {/* Frontend Dependencies */}
      <Card>
        <CardHeader><CardTitle>前端依赖</CardTitle></CardHeader>
        <CardContent>
          <div className="space-y-1">
            {Object.entries(DEPENDENCIES).map(([category, deps]) => (
              <div key={category}>
                <button
                  onClick={() => setExpandedDep(expandedDep === category ? null : category)}
                  className="flex w-full items-center justify-between rounded-lg px-3 py-2 text-sm font-medium hover:bg-accent"
                >
                  <span>{category}</span>
                  <div className="flex items-center gap-2">
                    <Badge variant="secondary" className="h-5 text-[10px]">{deps.length}</Badge>
                    <FontAwesomeIcon icon={expandedDep === category ? faChevronDown : faChevronRight} className="h-3 w-3 text-muted-foreground" />
                  </div>
                </button>
                {expandedDep === category && (
                  <div className="mt-1 space-y-1 pl-2">
                    {deps.map((dep) => (
                      <button
                        key={dep.name}
                        onClick={() => openUrl(dep.url).catch(() => window.open(dep.url, '_blank'))}
                        className="flex w-full items-center justify-between rounded-lg px-3 py-1.5 text-xs hover:bg-accent"
                      >
                        <span className="text-muted-foreground">{dep.name}</span>
                        <div className="flex items-center gap-2">
                          <span className="text-muted-foreground/70">{dep.license}</span>
                          <FontAwesomeIcon icon={faExternalLinkAlt} className="h-2.5 w-2.5 text-muted-foreground/50" />
                        </div>
                      </button>
                    ))}
                  </div>
                )}
                <Separator className="my-1" />
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      {/* License */}
      <Card>
        <CardHeader><CardTitle>开源协议</CardTitle></CardHeader>
        <CardContent>
          <div className="flex items-center justify-between">
            <div>
              <div className="text-sm font-medium">{LICENSE.name}</div>
              <div className="text-xs text-muted-foreground">本程序基于 {LICENSE.name} 开源协议发布</div>
            </div>
            <Button size="sm" variant="outline" onClick={() => openUrl(LICENSE.url).catch(() => window.open(LICENSE.url, '_blank'))} className="gap-1.5 h-8 text-xs">
              <FontAwesomeIcon icon={faExternalLinkAlt} className="h-3 w-3" />查看协议
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}

export default function Settings() {
  const { error: msgError, confirm: msgConfirm, notify } = useMessageBox()
  const [clearingCache, setClearingCache] = useState(false)
  const { state: debugState } = useDebug()
  const [category, setCategory] = useState(() => {
    const params = new URLSearchParams(window.location.search)
    return params.get('tab') ?? 'launcher'
  })
  const [settings, setSettings] = useState<AppSettings>({ ...DEFAULT_SETTINGS })
  const settingsRef = useRef(settings)
  settingsRef.current = settings
  const [sysInfo, setSysInfo] = useState<SystemInfo | null>(null)
  const [runtimes, setRuntimesState] = useState<JavaRuntime[]>(() => getRuntimes())
  const [scanning, setScanning] = useState<'idle' | 'quick' | 'deep'>('idle')
  const [javaStatus, setJavaStatus] = useState('就绪')
  const [addDialogOpen, setAddDialogOpen] = useState(false)
  const [addPath, setAddPath] = useState('')
  const [adding, setAdding] = useState(false)
  const [downloadDialogOpen, setDownloadDialogOpen] = useState(false)
  const [licenseDialogOpen, setLicenseDialogOpen] = useState(false)
  const [licenseStatus, setLicenseStatus] = useState<LicenseStatus | null>(() => getCachedLicenseStatus())
  const [downloadVendors, setDownloadVendors] = useState<JavaDownloadVendorInfo[]>([])
  const [downloadLoading, setDownloadLoading] = useState(false)
  const [startDownloadLoading, setStartDownloadLoading] = useState(false)
  const [downloadVendor, setDownloadVendor] = useState('temurin')
  const [downloadVersion, setDownloadVersion] = useState('17')
  const [downloadPlatform, setDownloadPlatform] = useState('windows')
  const [downloadArch, setDownloadArch] = useState('x64')
  const selectedVendor = downloadVendors.find((vendor) => vendor.id === downloadVendor)
  const [removingPath, setRemovingPath] = useState<string | null>(null)
  const autoScanRef = useRef(false)
  const loadedRef = useRef(false)
  const [backgrounds, setBackgrounds] = useState<string[]>([])
  const [sourcePings, setSourcePings] = useState<DownloadSourcePing[]>([])
  const [pingLoading, setPingLoading] = useState(false)
  const [modPings, setModPings] = useState<ModSourcePing[]>([])
  const [modPingLoading, setModPingLoading] = useState(false)
  const { plugins, loading, loadPlugins } = usePluginStore()
  const [pluginsMsg, setPluginsMsg] = useState<string | null>(null)
  const [pluginDetail, setPluginDetail] = useState<PluginInfo | null>(null)
  const [pluginInstalling, setPluginInstalling] = useState(false)
  const [pluginQuery, setPluginQuery] = useState('')

  useEffect(() => {
    apiLoadSettings().then((s) => {
      setSettings(s)
      loadedRef.current = true
      pingDownloadSources().then(setSourcePings).catch(() => {})
      pingModSources().then(setModPings).catch(() => {})
    }).catch(() => {})
    get<string[]>('/settings/backgrounds').then(setBackgrounds).catch(() => {})
  }, [])

  useEffect(() => {
    const unsub = subscribe(() => setRuntimesState([...getRuntimes()]))
    return unsub
  }, [])

  useEffect(() => {
    if (!loadedRef.current) return
    refreshPings()
  }, [settings.autoSelectDownloadSource])

  useEffect(() => {
    if (!loadedRef.current) return
    refreshModPings()
  }, [settings.autoSelectModMirror])

  useEffect(() => {
    if (category === 'about') {
      fetchLicenseStatus().then(setLicenseStatus).catch(() => {})
    }
  }, [category])

  const handlePluginToggle = useCallback(async (id: string, active: boolean) => {
    try {
      await apiSetPluginState(id, active ? 'active' : 'disabled')
      await loadPlugins()
      setPluginsMsg('更改已生效')
      setTimeout(() => setPluginsMsg(null), 3000)
    } catch {
      setPluginsMsg('保存失败')
    }
  }, [loadPlugins])

  const handlePluginUninstall = useCallback(async (id: string) => {
    if (!(await msgConfirm('确定卸载此插件？'))) return
    deactivatePlugin(id)
    try {
      const res = await fetch(`${API_BASE}/plugins/${id}`, { method: 'DELETE' })
      if (!res.ok) throw new Error('Uninstall failed')
      setPluginsMsg('插件已卸载')
      await loadPlugins()
    } catch {
      setPluginsMsg('卸载失败')
    }
  }, [loadPlugins, msgConfirm])

  const handlePluginInstall = () => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = '.qplugin,.zip'
    input.onchange = async () => {
      const file = input.files?.[0]
      if (!file) return
      const form = new FormData()
      form.append('plugin', file)
      setPluginInstalling(true)
      try {
        const res = await fetch(`${API_BASE}/plugins/upload`, { method: 'POST', body: form })
        if (!res.ok) throw new Error(`Upload failed (${res.status})`)
        setPluginsMsg('插件安装成功')
        setPluginDetail(null)
        await loadPlugins()
        notify('插件安装成功', 'success')
      } catch (e) {
        notify('安装失败: ' + (e instanceof Error ? e.message : 'Unknown'), 'error')
      } finally {
        setPluginInstalling(false)
      }
    }
    input.click()
  }

  const handlePluginRefresh = async () => {
    setPluginsMsg(null)
    await usePluginStore.getState().rescan()
  }

  useEffect(() => {
    if (!pluginsMsg) return
    const t = setTimeout(() => setPluginsMsg(null), 3000)
    return () => clearTimeout(t)
  }, [pluginsMsg])

  function update<K extends keyof AppSettings>(key: K, value: AppSettings[K]) {
    const next = { ...settings, [key]: value }
    setSettings(next)
    saveSettings(next)
    notify('设置已保存', 'success')
  }

  const validCount = runtimes.filter((j) => j.state === 'Valid').length

  useEffect(() => {
    let timer: ReturnType<typeof setInterval>
    function refresh() {
      if (!loadedRef.current) return
      getSystemInfo().then((info) => {
        setSysInfo(info)
        const cur = settingsRef.current
        if (cur.memoryMode === 'auto') {
          const autoVal = Math.max(512, Math.floor(info.availableMemory * 0.7))
          if (autoVal !== cur.defaultMaxMemory) {
            const next = { ...cur, defaultMaxMemory: autoVal }
            setSettings(next)
            saveSettings(next)
          }
        }
      }).catch(() => {})
    }
    refresh()
    timer = setInterval(refresh, 5000)
    return () => clearInterval(timer)
  }, [])

  useEffect(() => {
    if (!loadedRef.current) return
    if (settings.memoryMode === 'auto') {
      const autoVal = Math.max(512, Math.floor((sysInfo?.availableMemory ?? 0) * 0.7))
      if (autoVal !== settings.defaultMaxMemory) {
        const next = { ...settings, defaultMaxMemory: autoVal }
        setSettings(next)
        saveSettings(next)
      }
    }
  }, [settings.memoryMode])

  useEffect(() => {
    if (category === 'java' && !autoScanRef.current) {
      autoScanRef.current = true
      loadCustomRuntimes().catch(() => {})
      if (getRuntimes().length === 0) {
        handleScan('quick')
      }
    }
  }, [category])

  const handleScan = useCallback(async (mode: 'quick' | 'deep') => {
    setScanning(mode)
    setJavaStatus(mode === 'quick' ? '正在快速扫描...' : '正在深度扫描...')
    try {
      const prev = getRuntimes()
      const result = await scanRuntimes(mode)
      const newCount = prev.length === 0 ? result.length : result.filter((r) => !prev.some((m) => m.path === r.path)).length
      setJavaStatus(newCount > 0 ? `扫描完成，发现 ${newCount} 个新版` : '扫描完成，无新版')
    } catch (e) {
      setJavaStatus('扫描失败')
      console.error(e)
    } finally {
      setScanning('idle')
    }
  }, [])

  function handleRefresh() {
    setJavaStatus('正在刷新...')
    handleScan('quick')
  }

  function handleOpenFolder(path: string) {
    revealItemInDir(path).catch(() => {
      const dir = path.replace(/[/\\][^/\\]+$/i, '')
      openPath(dir).catch(() => {})
    })
  }

  async function refreshPings() {
    setPingLoading(true)
    try {
      const pings = await pingDownloadSources()
      setSourcePings(pings)
      if (settings.autoSelectDownloadSource) {
        const best = pings.filter(p => p.available).sort((a, b) => a.latencyMs - b.latencyMs)[0]
        if (best && best.id !== settings.downloadSource) {
          update('downloadSource', best.id)
        }
      }
    } catch {
      setSourcePings([])
    } finally {
      setPingLoading(false)
    }
  }

  async function refreshModPings() {
    setModPingLoading(true)
    try {
      const pings = await pingModSources()
      setModPings(pings)
      if (settings.autoSelectModMirror) {
        const best = pings.filter(p => p.available).sort((a, b) => a.modrinthLatency - b.modrinthLatency)[0]
        if (best && best.id !== settings.modMirror) {
          update('modMirror', best.id)
        }
      }
    } catch {
      setModPings([])
    } finally {
      setModPingLoading(false)
    }
  }

  async function handleOpenBackgrounds() {
    try {
      await fetch(`${API_BASE}/settings/open-backgrounds`, { method: 'POST' })
    } catch {}
  }

  function handleManualAdd() {
    setAddPath('')
    setAddDialogOpen(true)
  }

  async function handleBrowseJava() {
    try {
      const selected = await invoke<string | null>('pick_dialog', {
        options: {
          title: '选择 Java 可执行文件',
          filters: navigator.platform?.includes('Win')
            ? [{ name: 'Java', extensions: ['exe'] }]
            : undefined,
        },
      })
      if (selected) setAddPath(selected)
    } catch {}
  }

  async function confirmAddJava() {
    if (!addPath) return
    setAdding(true)
    try {
      const result = await addCustomJavaRuntime(addPath)
      addRuntime(result)
      setJavaStatus(`已添加 ${result.name} ${result.version}`)
      setAddDialogOpen(false)
    } catch (e: unknown) {
      setJavaStatus(e instanceof ApiError ? e.displayMessage : '无法识别该路径下的 Java 运行时')
      await msgError(e instanceof ApiError ? e.displayMessage : e instanceof Error ? e.message : '无法识别该路径下的 Java 运行时')
    } finally {
      setAdding(false)
    }
  }

  async function handleOpenJavaDownload() {
    setDownloadLoading(true)
    try {
      const catalog = await getJavaDownloadCatalog()
      setDownloadVendors(catalog.vendors)
      const preferred = catalog.vendors.find(v => v.isRecommended) ?? catalog.vendors[0]
      if (preferred) {
        setDownloadVendor(preferred.id)
        setDownloadVersion(String(preferred.versions[0] ?? 17))
        setDownloadPlatform(preferred.platforms[0] ?? 'windows')
        setDownloadArch(preferred.architectures[0] ?? 'x64')
      }
      setDownloadDialogOpen(true)
    } catch (e: unknown) {
      await msgError(e instanceof ApiError ? e.displayMessage : e instanceof Error ? e.message : '加载 Java 下载目录失败')
    } finally {
      setDownloadLoading(false)
    }
  }

  async function handleStartJavaDownload() {
    if (!selectedVendor || startDownloadLoading) return
    setStartDownloadLoading(true)
    try {
      const task = await startJavaDownload({
        vendor: downloadVendor,
        version: parseInt(downloadVersion, 10),
        platform: downloadPlatform,
        architecture: downloadArch,
      })
      const dlTask: DownloadTask = {
        id: task.taskId,
        name: `${selectedVendor.name} ${downloadVersion} (${downloadPlatform}-${downloadArch})`,
        type: 'java',
        gameVersion: downloadVersion,
        status: 'queued',
        progress: 0,
        createdAt: new Date().toISOString(),
        taskId: task.taskId,
      }
      addTask(dlTask)
      setDownloadDialogOpen(false)
      setJavaStatus(`已加入下载中心: ${dlTask.name}`)
    } catch (e: unknown) {
      await msgError(e instanceof ApiError ? e.displayMessage : e instanceof Error ? e.message : '启动 Java 下载失败')
    } finally {
      setStartDownloadLoading(false)
    }
  }



  useEffect(() => {
    if (!selectedVendor) return

    setDownloadVersion(String(selectedVendor.versions[0] ?? 17))
    setDownloadPlatform(selectedVendor.platforms[0] ?? 'windows')
    setDownloadArch(selectedVendor.architectures[0] ?? 'x64')
  }, [selectedVendor])

  async function handleClearCache() {
    setClearingCache(true)
    try {
      const { deleted } = await clearCache()
      notify(`已清理缓存，删除 ${deleted} 个文件`, 'success')
    } catch (e) {
      await msgError(e instanceof ApiError ? e.displayMessage : e instanceof Error ? e.message : '清理缓存失败')
    } finally {
      setClearingCache(false)
    }
  }

  async function handleDelete(path: string) {
    const name = runtimes.find((j) => j.path === path)?.name || ''
    const ok = await msgConfirm(`确定要删除 "${name}" 吗？`, '删除 Java')
    if (!ok) return
    setRemovingPath(path)
    try {
      await removeCustomJavaRuntime(path)
      removeRuntime(path)
      if (settings.defaultJavaPath === path) {
        update('defaultJavaPath', '')
      }
      setJavaStatus(`已删除 ${name}`)
    } catch {
      setJavaStatus('删除失败')
    } finally {
      setRemovingPath(null)
    }
  }

  return (
    <PageShell className="p-8 space-y-6 overflow-y-auto scroll-fade-mask">
      <PageHeader title="设置" />

      <div className="flex gap-4">
        <div className="sticky top-0 self-start flex w-48 shrink-0 flex-col">
          <Tabs
            tabs={CATEGORIES.filter(cat => cat.id !== 'debug' || debugState.unlocked).map(cat => ({ id: cat.id, label: cat.label, icon: <FontAwesomeIcon icon={cat.icon} className="h-4 w-4" /> }))}
            activeTab={category}
            onChange={(id) => setCategory(id)}
            orientation="vertical"
          />
        </div>

        <div className="flex-1 min-w-0 space-y-4">
          <TabContent activeTab={category} tabId="launcher">
            <div className="space-y-6">
            <Card>
              <CardHeader>
                <CardTitle>
                  <FontAwesomeIcon icon={faRocket} className="mr-2 h-4 w-4 text-muted-foreground" />
                  启动器设置
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-5">
                <div className="space-y-2">
                  <Label>数据目录</Label>
                  <div className="flex items-center gap-2">
                    <Input value={settings.dataDir} readOnly className="font-mono text-xs" />
                    <Button variant="outline" size="icon" className="h-9 w-9 shrink-0" onClick={async () => {
                      const { open } = await import('@tauri-apps/plugin-dialog')
                      const result = await open({ directory: true, multiple: false })
                      if (result) {
                        try {
                          const newPath = await setDataDir(result)
                          update('dataDir', newPath)
                          notify('数据目录已更改，重启启动器后生效', 'success')
                        } catch {
                          notify('设置失败', 'error')
                        }
                      }
                    }}>
                      <FontAwesomeIcon icon={faFolderOpen} className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                  <p className="text-xs text-muted-foreground">启动器数据存储位置，更改后需重启启动器生效</p>
                </div>

                <div className="space-y-2">
                  <Label htmlFor="downloadThreads">下载线程数</Label>
                  <div className="flex items-center gap-2">
                    <Button variant="outline" size="icon" className="h-9 w-9 shrink-0" onClick={() => update('downloadThreads', Math.max(1, settings.downloadThreads - 1))} disabled={settings.downloadThreads <= 1}>
                      <FontAwesomeIcon icon={faMinus} className="h-3.5 w-3.5" />
                    </Button>
                    <Input
                      id="downloadThreads"
                      type="number"
                      min={1}
                      max={512}
                      value={settings.downloadThreads}
                      onChange={(e) => update('downloadThreads', Math.max(1, Math.min(512, parseInt(e.target.value) || 1)))}
                      className="w-20 text-center [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
                    />
                    <Button variant="outline" size="icon" className="h-9 w-9 shrink-0" onClick={() => update('downloadThreads', Math.min(512, settings.downloadThreads + 1))} disabled={settings.downloadThreads >= 512}>
                      <FontAwesomeIcon icon={faPlus} className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                  <p className="text-xs text-muted-foreground">同时下载的文件数量（1-512），数值越大下载越快但占用带宽越多</p>
                </div>

                <div className="space-y-2">
                  <Label htmlFor="fileChunkThreads">分片线程数</Label>
                  <div className="flex items-center gap-2">
                    <Button variant="outline" size="icon" className="h-9 w-9 shrink-0" onClick={() => update('fileChunkThreads', Math.max(0, settings.fileChunkThreads - 1))} disabled={settings.fileChunkThreads <= 0}>
                      <FontAwesomeIcon icon={faMinus} className="h-3.5 w-3.5" />
                    </Button>
                    <Input
                      id="fileChunkThreads"
                      type="number"
                      min={0}
                      max={16}
                      value={settings.fileChunkThreads}
                      onChange={(e) => update('fileChunkThreads', Math.max(0, Math.min(16, parseInt(e.target.value) || 0)))}
                      className="w-20 text-center [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
                    />
                    <Button variant="outline" size="icon" className="h-9 w-9 shrink-0" onClick={() => update('fileChunkThreads', Math.min(16, settings.fileChunkThreads + 1))} disabled={settings.fileChunkThreads >= 16}>
                      <FontAwesomeIcon icon={faPlus} className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                  <p className="text-xs text-muted-foreground">单文件分片下载线程数（0=自动，最大 16），数值越大单文件下载越快</p>
                </div>

                <div className="space-y-2">
                  <Label htmlFor="maxConnectionsPerServer">最大连接数</Label>
                  <div className="flex items-center gap-2">
                    <Button variant="outline" size="icon" className="h-9 w-9 shrink-0" onClick={() => update('maxConnectionsPerServer', Math.max(8, settings.maxConnectionsPerServer - 8))} disabled={settings.maxConnectionsPerServer <= 8}>
                      <FontAwesomeIcon icon={faMinus} className="h-3.5 w-3.5" />
                    </Button>
                    <Input
                      id="maxConnectionsPerServer"
                      type="number"
                      min={8}
                      max={256}
                      step={8}
                      value={settings.maxConnectionsPerServer}
                      onChange={(e) => update('maxConnectionsPerServer', Math.max(8, Math.min(256, parseInt(e.target.value) || 8)))}
                      className="w-20 text-center [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
                    />
                    <Button variant="outline" size="icon" className="h-9 w-9 shrink-0" onClick={() => update('maxConnectionsPerServer', Math.min(256, settings.maxConnectionsPerServer + 8))} disabled={settings.maxConnectionsPerServer >= 256}>
                      <FontAwesomeIcon icon={faPlus} className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                  <p className="text-xs text-muted-foreground">每个服务器的最大连接数（8-256），重启后生效</p>
                </div>

                <label className="flex items-center gap-3 cursor-pointer">
                  <Checkbox
                    checked={settings.versionIsolation}
                    onCheckedChange={(c) => update('versionIsolation', c === true)}
                  />
                  <div>
                    <div className="text-sm font-medium">版本隔离</div>
                    <div className="text-xs text-muted-foreground">每个版本使用独立的 mods/config/saves 目录，推荐保持开启</div>
                  </div>
                </label>

                <label className="flex items-center gap-3 cursor-pointer">
                  <Checkbox
                    checked={settings.closeAfterLaunch}
                    onCheckedChange={(c) => update('closeAfterLaunch', c === true)}
                  />
                  <div>
                    <div className="text-sm font-medium">启动游戏后关闭启动器</div>
                    <div className="text-xs text-muted-foreground">游戏启动后自动关闭本启动器</div>
                  </div>
                </label>

                <div className="space-y-2">
                  <Label>下载源</Label>
                  <div className="flex flex-wrap items-center gap-2">
                    {DOWNLOAD_SOURCES.map((s) => {
                      const ping = sourcePings.find(p => p.id === s.value)
                      const showLatency = ping && ping.latencyMs >= 0
                      const latencyColor = !ping?.available ? 'text-destructive'
                        : ping.latencyMs < 200 ? 'text-emerald-400'
                        : ping.latencyMs < 400 ? 'text-amber-400'
                        : 'text-destructive'
                      return (
                        <button
                          key={s.value}
                          disabled={settings.autoSelectDownloadSource}
                          onClick={() => update('downloadSource', s.value)}
                          className={cn(
                            'flex items-center gap-1.5 rounded-lg border px-4 py-2 text-sm transition-colors',
                            settings.autoSelectDownloadSource && 'pointer-events-none opacity-60',
                            settings.downloadSource === s.value && !settings.autoSelectDownloadSource
                              ? 'border-primary bg-primary/10 font-medium text-primary'
                              : 'border-border hover:border-muted-foreground/30'
                          )}
                        >
                          {s.label}
                          {pingLoading && <FontAwesomeIcon icon={faRotate} className="h-3 w-3 animate-spin text-muted-foreground" />}
                          {!pingLoading && showLatency && (
                            <span className={cn('text-xs tabular-nums', latencyColor)}>
                              {ping.latencyMs}ms
                            </span>
                          )}
                          {!pingLoading && !showLatency && (
                            <span className="text-xs text-muted-foreground">--</span>
                          )}
                        </button>
                      )
                    })}
                    <Tooltip content="刷新延迟">
                      <Button variant="ghost" size="icon" className="h-9 w-9 shrink-0" onClick={refreshPings} disabled={pingLoading}>
                        <FontAwesomeIcon icon={faRotate} className={cn('h-3.5 w-3.5', pingLoading && 'animate-spin')} />
                      </Button>
                    </Tooltip>
                  </div>
                  <label className="flex items-center gap-3 cursor-pointer">
                    <Checkbox
                      checked={settings.autoSelectDownloadSource}
                      onCheckedChange={(c) => update('autoSelectDownloadSource', c === true)}
                    />
                    <div className="flex items-center gap-1.5">
                      <FontAwesomeIcon icon={faLightning} className="h-3.5 w-3.5 text-amber-400" />
                      <span className="text-sm font-medium">自动选择最快下载源</span>
                    </div>
                  </label>
                  <p className="text-xs text-muted-foreground">启动时和每次安装前自动检测并选择延迟最低的下载源</p>
                </div>

                <div className="space-y-2">
                  <Label>资源下载源</Label>
                  <div className="flex flex-wrap items-center gap-2">
                    {[
                      { value: 0, label: 'Modrinth/CurseForge 官方' },
                      { value: 1, label: 'MCIM 镜像' },
                    ].map((s) => {
                      const ping = modPings.find(p => p.id === s.value)
                      const showLatency = ping && ping.modrinthLatency >= 0
                      const latencyColor = !ping?.available ? 'text-destructive'
                        : ping.modrinthLatency < 200 ? 'text-emerald-400'
                        : ping.modrinthLatency < 400 ? 'text-amber-400'
                        : 'text-destructive'
                      return (
                        <button
                          key={s.value}
                          disabled={settings.autoSelectModMirror}
                          onClick={() => update('modMirror', s.value)}
                          className={cn(
                            'flex items-center gap-1.5 rounded-lg border px-4 py-2 text-sm transition-colors',
                            settings.autoSelectModMirror && 'pointer-events-none opacity-60',
                            settings.modMirror === s.value && !settings.autoSelectModMirror
                              ? 'border-primary bg-primary/10 font-medium text-primary'
                              : 'border-border hover:border-muted-foreground/30'
                          )}
                        >
                          {s.label}
                          {modPingLoading && <FontAwesomeIcon icon={faRotate} className="h-3 w-3 animate-spin text-muted-foreground" />}
                          {!modPingLoading && showLatency && (
                            <span className={cn('text-xs tabular-nums', latencyColor)}>
                              {ping.modrinthLatency}ms
                            </span>
                          )}
                          {!modPingLoading && !showLatency && (
                            <span className="text-xs text-muted-foreground">--</span>
                          )}
                        </button>
                      )
                    })}
                    <Tooltip content="刷新延迟">
                      <Button variant="ghost" size="icon" className="h-9 w-9 shrink-0" onClick={refreshModPings} disabled={modPingLoading}>
                        <FontAwesomeIcon icon={faRotate} className={cn('h-3.5 w-3.5', modPingLoading && 'animate-spin')} />
                      </Button>
                    </Tooltip>
                  </div>
                  <label className="flex items-center gap-3 cursor-pointer">
                    <Checkbox
                      checked={settings.autoSelectModMirror}
                      onCheckedChange={(c) => update('autoSelectModMirror', c === true)}
                    />
                    <div className="flex items-center gap-1.5">
                      <FontAwesomeIcon icon={faLightning} className="h-3.5 w-3.5 text-amber-400" />
                      <span className="text-sm font-medium">自动选择最快资源下载源</span>
                    </div>
                  </label>
                  <p className="text-xs text-muted-foreground">自动检测 Modrinth/CurseForge API 镜像并选择延迟最低的</p>
                </div>

                <div className="space-y-2">
                  <Label>翻译接口</Label>
                  <Select
                    value={settings.translationProvider}
                    onChange={(v) => update('translationProvider', v)}
                    className="w-48"
                  >
                    <SelectOption value="mymemory">MyMemory (默认)</SelectOption>
                    <SelectOption value="google">Google Translate (需梯子)</SelectOption>
                    <SelectOption value="bing">Bing Translator</SelectOption>
                  </Select>
                  <p className="text-xs text-muted-foreground">选择翻译资源详细介绍和简介时使用的翻译服务</p>
                  {settings.translationProvider === 'bing' && (
                    <div className="mt-3">
                      <Label htmlFor="bingApiKey">Bing API Key</Label>
                      <Input
                        id="bingApiKey"
                        type="password"
                        value={settings.bingApiKey || ''}
                        onChange={(e) => update('bingApiKey', e.target.value)}
                        placeholder="输入 Azure Translator API Key"
                        className="mt-1 max-w-sm"
                      />
                      <p className="text-xs text-muted-foreground mt-1">
                        在 Azure Portal 创建 Translator 资源获取 Key，区域需设为 global
                      </p>
                    </div>
                  )}
                </div>

                <div className="space-y-2">
                  <Label htmlFor="downloadTimeout">下载超时 (秒)</Label>
                  <div className="flex items-center gap-2">
                    <Button variant="outline" size="icon" className="h-9 w-9 shrink-0" onClick={() => update('downloadTimeout', Math.max(0, settings.downloadTimeout - 5))} disabled={settings.downloadTimeout <= 0}>
                      <FontAwesomeIcon icon={faMinus} className="h-3.5 w-3.5" />
                    </Button>
                    <Input
                      id="downloadTimeout"
                      type="number"
                      min={0}
                      max={120}
                      value={settings.downloadTimeout}
                      onChange={(e) => update('downloadTimeout', Math.max(0, Math.min(120, parseInt(e.target.value) || 15)))}
                      className="w-20 text-center [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
                    />
                    <Button variant="outline" size="icon" className="h-9 w-9 shrink-0" onClick={() => update('downloadTimeout', Math.min(120, settings.downloadTimeout + 5))} disabled={settings.downloadTimeout >= 120}>
                      <FontAwesomeIcon icon={faPlus} className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                  <p className="text-xs text-muted-foreground">单个文件下载无响应超过此时间则自动重试（0=不超时，1-120 秒）</p>
                </div>

                <div className="space-y-2">
                  <Label>日志等级</Label>
                  <Select
                    value={settings.logLevel}
                    onChange={(v) => update('logLevel', v)}
                    className="w-48"
                  >
                    <SelectOption value="error">错误</SelectOption>
                    <SelectOption value="warn">警告</SelectOption>
                    <SelectOption value="info">信息</SelectOption>
                    <SelectOption value="debug">调试</SelectOption>
                    <SelectOption value="trace">跟踪</SelectOption>
                  </Select>
                  <p className="text-xs text-muted-foreground">控制控制台和日志文件的输出详细程度，信息等级为默认</p>
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>
                  <FontAwesomeIcon icon={faTrashCan} className="mr-2 h-4 w-4 text-muted-foreground" />
                  存储与缓存
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="flex items-center justify-between gap-4">
                  <div className="space-y-1">
                    <Label>版本列表缓存</Label>
                    <p className="text-xs text-muted-foreground">清理 Forge 版本列表的 HTML 缓存文件</p>
                  </div>
                  <Button size="sm" variant="outline" onClick={handleClearCache} disabled={clearingCache}>
                    <FontAwesomeIcon icon={clearingCache ? faRotate : faTrashCan} className={cn('h-4 w-4', clearingCache && 'animate-spin')} />
                    清理缓存
                  </Button>
                </div>
              </CardContent>
            </Card>
            </div>
          </TabContent>

          <TabContent activeTab={category} tabId="java">
            <div className="space-y-6">
              <Card>
                <CardHeader className="flex-row items-center justify-between">
                  <div>
                    <CardTitle>
                      <FontAwesomeIcon icon={faCoffee} className="mr-2 h-4 w-4 text-muted-foreground" />
                      Java 运行时
                    </CardTitle>
                  </div>
                  <div className="flex items-center gap-3 text-sm">
                    <span className="text-muted-foreground">已检测 <span className="font-medium text-foreground">{runtimes.length}</span></span>
                    <span className="text-muted-foreground">可用 <span className="font-medium text-primary">{validCount}</span></span>
                  </div>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="flex flex-wrap items-center gap-2">
                    <Button size="sm" onClick={() => handleScan('quick')} disabled={scanning !== 'idle'}>
                      <FontAwesomeIcon icon={scanning === 'quick' ? faRotate : faMagnifyingGlass} className={cn('h-4 w-4', scanning === 'quick' && 'animate-spin')} />
                      快速扫描
                    </Button>
                    <Button size="sm" variant="secondary" onClick={() => handleScan('deep')} disabled={scanning !== 'idle'}>
                      <FontAwesomeIcon icon={scanning === 'deep' ? faRotate : faBolt} className={cn('h-4 w-4', scanning === 'deep' && 'animate-spin')} />
                      深度扫描
                    </Button>
                    <Button size="sm" variant="outline" onClick={handleManualAdd} disabled={scanning !== 'idle'}>
                      <FontAwesomeIcon icon={faPlus} className="h-4 w-4" />
                      手动添加
                    </Button>
                    <Button size="sm" variant="ghost" onClick={handleOpenJavaDownload} disabled={downloadLoading}>
                      <FontAwesomeIcon icon={faDownload} className="h-4 w-4" />
                      下载 Java
                    </Button>
                    <Tooltip content="刷新列表">
                      <Button size="sm" variant="ghost" onClick={handleRefresh} disabled={scanning !== 'idle'}>
                        <FontAwesomeIcon icon={faRotate} className={cn('h-4 w-4', scanning !== 'idle' && 'animate-spin')} />
                      </Button>
                    </Tooltip>
                  </div>

                  {scanning !== 'idle' && (
                    <div className="flex items-center gap-3 rounded-lg bg-muted px-4 py-3">
                      <FontAwesomeIcon icon={faRotate} className="h-4 w-4 animate-spin text-primary" />
                      <span className="text-sm text-muted-foreground">正在扫描 Java 运行时...</span>
                    </div>
                  )}

                  {scanning === 'idle' && runtimes.length === 0 && (
                    <div className="flex flex-col items-center gap-4 py-12 text-center">
                      <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-muted">
                        <FontAwesomeIcon icon={faCoffee} className="h-7 w-7 text-muted-foreground" />
                      </div>
                      <div>
                        <p className="text-sm font-medium text-foreground">尚未检测到 Java 运行时</p>
                        <p className="mt-1 text-xs text-muted-foreground">点击"快速扫描"自动检测系统中的 Java，或手动添加</p>
                      </div>
                      <Button size="sm" onClick={() => handleScan('quick')}>
                        <FontAwesomeIcon icon={faMagnifyingGlass} className="h-4 w-4" />
                        开始扫描
                      </Button>
                    </div>
                  )}

                  {scanning === 'idle' && runtimes.length > 0 && (
                    <div className="space-y-1">
                      {runtimes.map((j, i) => (
                        <div
                          key={i}
                          className="flex items-center gap-3 rounded-lg border border-border bg-background px-4 py-3 transition-colors hover:border-muted-foreground/30"
                        >
                          <div className={cn('flex h-9 w-9 shrink-0 items-center justify-center rounded-lg', j.state === 'Valid' ? 'bg-green-500/10 text-green-600' : 'bg-destructive/15 text-destructive')}>
                            <FontAwesomeIcon icon={faJava} className="h-5 w-5" />
                          </div>

                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-2 min-w-0">
                              <Tooltip content={j.name}><span className="min-w-0 truncate text-sm font-medium">{j.name}</span></Tooltip>
                              <Badge variant="outline" className="h-5 px-1.5 text-[10px]">{j.type}</Badge>
                              {j.discoveredBy === 'Custom' && <Badge variant="secondary" className="h-5 px-1.5 text-[10px]">手动添加</Badge>}
                              {j.state === 'Valid' ? (
                                <span className="rounded-full bg-primary/10 px-2 py-0.5 text-[10px] font-medium text-primary">可用</span>
                              ) : (
                                <span className="rounded-full bg-destructive/10 px-2 py-0.5 text-[10px] font-medium text-destructive">不可用</span>
                              )}
                            </div>
                            <div className="mt-0.5 flex items-center gap-3 text-xs text-muted-foreground">
                              <span className="flex items-center gap-1">
                                <FontAwesomeIcon icon={faTag} className="h-3 w-3" />
                                版本 {j.version}
                              </span>
                              <span className="flex items-center gap-1">
                                <FontAwesomeIcon icon={faDesktop} className="h-3 w-3" />
                                {j.arch}
                              </span>
                            </div>
                            <div className="mt-1 flex items-center gap-1.5 text-xs text-muted-foreground/60">
                              <FontAwesomeIcon icon={faFolder} className="h-3 w-3 shrink-0" />
                              <span className="truncate">{j.path}</span>
                            </div>
                          </div>

                          <div className="flex shrink-0 items-center gap-0.5">
                            <Tooltip content="打开文件夹">
                              <Button size="icon" variant="ghost" className="h-8 w-8" onClick={() => handleOpenFolder(j.path)}>
                                <FontAwesomeIcon icon={faFolderOpen} className="h-3.5 w-3.5" />
                              </Button>
                            </Tooltip>
                            {j.discoveredBy === 'Custom' && (
                              <Tooltip content="删除">
                                <Button size="icon" variant="ghost" className="h-8 w-8 text-destructive/70 hover:text-destructive" onClick={() => handleDelete(j.path)} disabled={removingPath === j.path}>
                                  <FontAwesomeIcon icon={faTrashCan} className="h-3.5 w-3.5" />
                                </Button>
                              </Tooltip>
                            )}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}

                  <div className="flex items-center gap-2 rounded-lg bg-muted/50 px-4 py-2.5 text-xs text-muted-foreground">
                    <FontAwesomeIcon icon={faInfoCircle} className="h-3.5 w-3.5 text-primary" />
                    <span>{javaStatus}</span>
                    <span className="ml-auto">
                      {runtimes.length > 0 && `${validCount} / ${runtimes.length} 可用`}
                    </span>
                  </div>
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle>默认配置</CardTitle>
                </CardHeader>
                <CardContent className="space-y-5">
                  <div className="space-y-2">
                    <Label>默认 Java 运行时</Label>
                    <Select value={settings.defaultJavaPath} onChange={(v) => update('defaultJavaPath', v)}>
                      <SelectOption value="">自动选择</SelectOption>
                      {runtimes.filter((j) => j.state === 'Valid').map((j, i) => (
                        <SelectOption key={i} value={j.path}>{j.name} - {j.version} ({j.arch})</SelectOption>
                      ))}
                    </Select>
                    <p className="text-xs text-muted-foreground">
                      推荐使用自动选择，启动器会为每个游戏版本自动匹配最佳 Java 运行时
                    </p>
                  </div>

                  <div className="space-y-2">
                    <Label>内存分配</Label>
                    <div className="flex items-center gap-2">
                      <button onClick={() => {
                        const next = { ...settings, memoryMode: 'auto' as const }
                        if (sysInfo) next.defaultMaxMemory = Math.max(512, Math.floor(sysInfo.availableMemory * 0.7))
                        setSettings(next)
                        saveSettings(next)
                        notify('设置已保存', 'success')
                      }} className={cn('h-9 rounded-lg border px-3.5 text-sm transition-colors', settings.memoryMode === 'auto' ? 'border-primary bg-primary/10 font-medium text-primary' : 'border-border hover:border-muted-foreground/30')}>
                        <FontAwesomeIcon icon={faRobot} className="mr-1.5 h-3.5 w-3.5" />自动
                      </button>
                      <button onClick={() => update('memoryMode', 'custom')} className={cn('h-9 rounded-lg border px-3.5 text-sm transition-colors', settings.memoryMode === 'custom' ? 'border-primary bg-primary/10 font-medium text-primary' : 'border-border hover:border-muted-foreground/30')}>
                        <FontAwesomeIcon icon={faSliders} className="mr-1.5 h-3.5 w-3.5" />自定义
                      </button>
                    </div>

                    {sysInfo ? (
                      <>
                        <div className="flex items-center gap-3 py-1">
                          <input
                            type="range"
                            min={512}
                            max={Math.max(512, Math.floor(sysInfo.availableMemory))}
                            step={256}
                            value={settings.defaultMaxMemory}
                            disabled={settings.memoryMode === 'auto'}
                            onChange={(e) => update('defaultMaxMemory', parseInt(e.target.value))}
                            className={cn('flex-1', settings.memoryMode === 'auto' && 'pointer-events-none opacity-60')}
                          />
                          <span className="w-28 shrink-0 text-right text-sm tabular-nums text-muted-foreground">
                            {settings.defaultMaxMemory >= 1024 ? `${(settings.defaultMaxMemory / 1024).toFixed(1)} GiB` : `${settings.defaultMaxMemory} MiB`}
                          </span>
                        </div>

                        {(() => {
                          const totalMb = sysInfo.memory
                          const availMb = sysInfo.availableMemory
                          const usedMb = Math.max(0, totalMb - availMb)
                          const gameMb = Math.min(settings.defaultMaxMemory, availMb)
                          const totalPx = totalMb
                          const usedPct = (usedMb / totalPx) * 100
                          const gamePct = (gameMb / totalPx) * 100
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
                      </>
                    ) : (
                      <div className="flex items-center gap-3">
                        <input
                          type="range"
                          min={512}
                          max={16384}
                          step={256}
                          value={settings.defaultMaxMemory}
                          disabled={settings.memoryMode === 'auto'}
                          onChange={(e) => update('defaultMaxMemory', parseInt(e.target.value))}
                          className={cn('flex-1', settings.memoryMode === 'auto' && 'pointer-events-none opacity-60')}
                        />
                        <span className="w-28 shrink-0 text-right text-sm tabular-nums text-muted-foreground">
                          {settings.defaultMaxMemory >= 1024 ? `${(settings.defaultMaxMemory / 1024).toFixed(1)} GiB` : `${settings.defaultMaxMemory} MiB`}
                        </span>
                      </div>
                    )}
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="jvmArgs">额外 JVM 参数</Label>
                    <Input id="jvmArgs" value={settings.jvmArgs} onChange={(e) => update('jvmArgs', e.target.value)} placeholder="-XX:+UseG1GC -Dfml.ignoreInvalidMinecraftCertificates=true" />
                    <p className="text-xs text-muted-foreground">启动 Minecraft 时附加的 JVM 参数</p>
                  </div>
                </CardContent>
              </Card>
            </div>
          </TabContent>

          <TabContent activeTab={category} tabId="appearance">
            <div className="space-y-6">
              <Card>
                <CardHeader>
                  <CardTitle>
                    <FontAwesomeIcon icon={faPalette} className="mr-2 h-4 w-4 text-muted-foreground" />
                    界面
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-5">
                  <div className="space-y-2">
                    <Label>界面语言</Label>
                    <Select value={settings.language} onChange={(v) => update('language', v)} className="w-48">
                      <SelectOption value="zh-CN">简体中文</SelectOption>
                      <SelectOption value="en">English</SelectOption>
                    </Select>
                  </div>

                  <div className="space-y-2">
                    <Label>主题</Label>
                    <Select value={settings.theme} onChange={(v) => update('theme', v as 'dark' | 'light')} className="w-48">
                      <SelectOption value="dark">深色</SelectOption>
                      <SelectOption value="light">亮色</SelectOption>
                    </Select>
                  </div>

                  <div className="space-y-3">
                    <Label>页面动画</Label>
                    <label className="flex items-center gap-3 cursor-pointer">
                      <Checkbox
                        checked={settings.animationsEnabled}
                        onCheckedChange={(c) => update('animationsEnabled', c === true)}
                      />
                      <div>
                        <div className="text-sm font-medium">启用页面动画</div>
                        <div className="text-xs text-muted-foreground">开启后页面切换、弹窗等带有过渡动画效果</div>
                      </div>
                    </label>
                    {settings.animationsEnabled && (
                      <div className="space-y-2 pl-7">
                        <div className="flex items-center gap-3">
                          <input
                            type="range"
                            min={0.25}
                            max={2}
                            step={0.25}
                            value={settings.animationSpeed}
                            onChange={(e) => update('animationSpeed', parseFloat(e.target.value))}
                            className="flex-1"
                          />
                          <span className="w-12 shrink-0 text-sm tabular-nums text-muted-foreground">{settings.animationSpeed}x</span>
                        </div>
                        <div className="flex justify-between text-[11px] text-muted-foreground">
                          <span>慢</span>
                          <span>正常</span>
                          <span>快</span>
                        </div>
                      </div>
                    )}
                  </div>

                  <div className="space-y-2 pt-3 border-t border-border/50">
                    <Label>帧率上限</Label>
                    <Select value={String(settings.maxFrameRate)} onChange={(v) => update('maxFrameRate', Number(v))} className="w-48">
                      <SelectOption value="0">不限</SelectOption>
                      <SelectOption value="30">30 FPS</SelectOption>
                      <SelectOption value="60">60 FPS</SelectOption>
                      <SelectOption value="120">120 FPS</SelectOption>
                      <SelectOption value="144">144 FPS</SelectOption>
                    </Select>
                    <p className="text-xs text-muted-foreground">限制启动器界面的渲染帧率，降低资源占用。设为不限则使用显示器的原始刷新率。</p>
                  </div>
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle>
                    <FontAwesomeIcon icon={faDesktop} className="mr-2 h-4 w-4 text-muted-foreground" />
                    圆角
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-3">
                  <label className="flex items-center gap-3 cursor-pointer">
                    <Checkbox
                      checked={settings.windowCorners}
                      onCheckedChange={(c) => update('windowCorners', c === true)}
                    />
                    <div>
                      <div className="text-sm font-medium">窗口圆角</div>
                      <div className="text-xs text-muted-foreground">仅在不使用系统框架时生效</div>
                    </div>
                  </label>
                  <Separator />
                  <div className="space-y-2">
                    <div className="flex items-center gap-3">
                      <input
                        type="range"
                        min={0}
                        max={16}
                        step={1}
                        value={settings.cornerRadius}
                        onChange={(e) => update('cornerRadius', parseInt(e.target.value))}
                        className="flex-1"
                      />
                      <span className="w-10 shrink-0 text-sm tabular-nums text-muted-foreground">{settings.cornerRadius}px</span>
                    </div>
                    <div className="flex justify-between text-[11px] text-muted-foreground">
                      <span>直角</span>
                      <span>默认（8px）</span>
                      <span>大圆角</span>
                    </div>

                  </div>
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle>
                    <FontAwesomeIcon icon={faPalette} className="mr-2 h-4 w-4 text-muted-foreground" />
                    背景
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="space-y-2">
                    <div className="flex items-center justify-between">
                      <Label>背景图片</Label>
                      <Button variant="ghost" size="sm" onClick={() => get<string[]>('/settings/backgrounds').then(setBackgrounds).catch(() => {})}>
                        <FontAwesomeIcon icon={faRotate} className="h-3 w-3" />
                      </Button>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      {backgrounds.length === 0 ? (
                        <p className="w-full text-xs text-muted-foreground">暂无背景图片</p>
                      ) : (
                        backgrounds.map((name) => (
                          <button
                            key={name}
                            onClick={() => {
                              const next = { ...settings, backgroundImage: name, backgroundRandom: false }
                              setSettings(next)
                              saveSettings(next)
                              notify('设置已保存', 'success')
                            }}
                            className={cn(
                              'group relative h-16 w-28 overflow-hidden rounded-lg border-2 transition-colors',
                              !settings.backgroundRandom && settings.backgroundImage === name
                                ? 'border-primary'
                                : 'border-border hover:border-muted-foreground/30'
                            )}
                          >
                            <img
                              src={`${API_BASE}/settings/backgrounds/${encodeURIComponent(name)}`}
                              alt={name}
                              className="h-full w-full object-cover transition-opacity group-hover:opacity-80"
                            />
                            <span className="absolute inset-x-0 bottom-0 truncate bg-gradient-to-t from-black/60 to-transparent px-1 pb-0.5 pt-3 text-[10px] leading-tight text-white">
                              {name}
                            </span>
                          </button>
                        ))
                      )}
                    </div>
                    <div className="flex items-center gap-2 pt-0.5">
                      <Button variant="outline" size="sm" onClick={handleOpenBackgrounds}>
                        <FontAwesomeIcon icon={faFolderOpen} className="mr-1 h-3 w-3" /> 打开文件夹
                      </Button>
                      <p className="text-xs text-muted-foreground">放入图片即可出现在上方列表中</p>
                    </div>
                  </div>

                  <label className="flex items-center gap-3 cursor-pointer">
                    <Checkbox
                      checked={settings.backgroundRandom}
                      onCheckedChange={(c) => {
                        update('backgroundRandom', c === true)
                        if (c && !settings.backgroundImage) update('backgroundImage', 'random')
                      }}
                    />
                    <div>
                      <div className="text-sm font-medium">每次启动随机挑选</div>
                      <div className="text-xs text-muted-foreground">从背景文件夹中随机选择一张图片</div>
                    </div>
                  </label>

                  {settings.backgroundImage && (
                    <>
                      {!settings.backgroundRandom && (
                        <Button variant="ghost" size="sm" onClick={() => update('backgroundImage', '')}>
                          <FontAwesomeIcon icon={faTrashCan} className="mr-1 h-3 w-3" /> 清除背景
                        </Button>
                      )}
                      <div className="grid grid-cols-2 gap-4 pt-1">
                        <div className="space-y-1.5">
                          <div className="flex items-center justify-between">
                            <Label>不透明度</Label>
                            <span className="text-xs tabular-nums text-muted-foreground">{settings.bgOverlayOpacity}%</span>
                          </div>
                          <input type="range" min={0} max={100} value={settings.bgOverlayOpacity} onChange={(e) => update('bgOverlayOpacity', parseInt(e.target.value))} className="w-full" />
                          <div className="flex justify-between text-[11px] text-muted-foreground">
                            <span>透明</span>
                            <span>不透明</span>
                          </div>
                        </div>
                        <div className="space-y-1.5">
                          <div className="flex items-center justify-between">
                            <Label>模糊</Label>
                            <span className="text-xs tabular-nums text-muted-foreground">{settings.bgBlur}px</span>
                          </div>
                          <input type="range" min={0} max={20} step={0.5} value={settings.bgBlur} onChange={(e) => update('bgBlur', parseFloat(e.target.value))} className="w-full" />
                          <div className="flex justify-between text-[11px] text-muted-foreground">
                            <span>清晰</span>
                            <span>模糊</span>
                          </div>
                        </div>
                      </div>
                    </>
                  )}
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle>
                    <FontAwesomeIcon icon={faPalette} className="mr-2 h-4 w-4 text-muted-foreground" />
                    水印
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-4">
                  <label className="flex items-center gap-3 cursor-pointer">
                    <Checkbox
                      checked={settings.watermarkEnabled}
                      onCheckedChange={(c) => update('watermarkEnabled', c === true)}
                    />
                    <div>
                      <div className="text-sm font-medium">显示主页水印文字</div>
                      <div className="text-xs text-muted-foreground">在主页中央显示可自定义的文字</div>
                    </div>
                  </label>
                  {settings.watermarkEnabled && (
                    <div className="space-y-2 pl-7">
                      <Label htmlFor="watermarkText">水印内容</Label>
                      <Input id="watermarkText" value={settings.watermarkText} onChange={(e) => update('watermarkText', e.target.value)} placeholder="Qomicex" />
                      <Label htmlFor="watermarkSubtext">副标题</Label>
                      <Input id="watermarkSubtext" value={settings.watermarkSubtext} onChange={(e) => update('watermarkSubtext', e.target.value)} placeholder="启动器" />
                    </div>
                  )}
                </CardContent>
              </Card>
            </div>
          </TabContent>

          <TabContent activeTab={category} tabId="toolbox"><ToolboxTab /></TabContent>
          <TabContent activeTab={category} tabId="plugins">
            <div className="space-y-6">
              <Card>
                <CardHeader>
                  <CardTitle>
                    <FontAwesomeIcon icon={faPuzzlePiece} className="mr-2 h-4 w-4 text-muted-foreground" />
                    插件管理
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="mb-4 flex flex-wrap items-center gap-2">
                    <span className="text-sm text-muted-foreground">{plugins.length} 个已安装</span>
                    <div className="ml-auto flex items-center gap-2">
                      <Input
                        value={pluginQuery}
                        onChange={(e) => setPluginQuery(e.target.value)}
                        placeholder="搜索插件..."
                        className="h-8 w-52"
                      />
                      <Button onClick={handlePluginRefresh} size="sm" variant="outline" disabled={loading}>刷新</Button>
                      <Button onClick={handlePluginInstall} size="sm" disabled={pluginInstalling}>
                        {pluginInstalling ? '安装中...' : '安装插件'}
                      </Button>
                    </div>
                  </div>
                  {pluginsMsg && (
                    <div className="rounded bg-primary/10 text-primary px-4 py-2 text-sm mb-4">{pluginsMsg}</div>
                  )}
                  {loading ? (
                    <p className="text-muted-foreground">加载中...</p>
                  ) : plugins.length === 0 ? (
                    <div className="flex items-center justify-center min-h-[200px]">
                      <p className="text-muted-foreground">尚未安装任何插件</p>
                    </div>
                  ) : (
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                      {plugins
                        .filter(p => p.manifest.name.toLowerCase().includes(pluginQuery.trim().toLowerCase()))
                        .map(p => (
                          <PluginCard key={p.manifest.id} plugin={p} onToggle={handlePluginToggle} onUninstall={handlePluginUninstall} onClick={() => setPluginDetail(p)} />
                        ))}
                    </div>
                  )}
                  {plugins.length > 0 && plugins.filter(p => p.manifest.name.toLowerCase().includes(pluginQuery.trim().toLowerCase())).length === 0 && (
                    <p className="text-muted-foreground text-sm text-center py-6">无匹配的插件</p>
                  )}
                </CardContent>
              </Card>
            </div>
          </TabContent>
          <TabContent activeTab={category} tabId="about"><AboutTab sysInfo={sysInfo} licenseStatus={licenseStatus} onOpenLicenseDialog={() => setLicenseDialogOpen(true)} /></TabContent>
          <TabContent activeTab={category} tabId="logs"><LogTab /></TabContent>
          <TabContent activeTab={category} tabId="debug"><DebugTab /></TabContent>

          <Dialog open={addDialogOpen} onClose={() => setAddDialogOpen(false)}>
            <DialogHeader onClose={() => setAddDialogOpen(false)}>
              <DialogTitle>手动添加 Java</DialogTitle>
            </DialogHeader>
            <DialogBody className="space-y-3">
              <div className="space-y-1.5">
                <Label>Java 可执行文件路径</Label>
                <div className="flex gap-2">
                  <Input value={addPath} onChange={(e) => setAddPath(e.target.value)} placeholder={navigator.platform?.includes('Win') ? 'C:\\Program Files\\Java\\jdk-17\\bin\\java.exe' : '/usr/lib/jvm/java-17-openjdk/bin/java'} className="flex-1" />
                  <Button variant="outline" onClick={handleBrowseJava}>浏览</Button>
                </div>
                <p className="text-xs text-muted-foreground">选择或输入 Java 可执行文件的完整路径</p>
              </div>
            </DialogBody>
            <DialogFooter>
              <Button variant="ghost" onClick={() => setAddDialogOpen(false)}>取消</Button>
              <Button onClick={confirmAddJava} disabled={!addPath || adding}>
                {adding ? '验证中...' : '添加'}
              </Button>
            </DialogFooter>
          </Dialog>

          <Dialog open={downloadDialogOpen} onClose={() => setDownloadDialogOpen(false)}>
            <DialogHeader onClose={() => setDownloadDialogOpen(false)}>
              <DialogTitle>下载 Java</DialogTitle>
            </DialogHeader>
            <DialogBody className="space-y-4">
              <div className="space-y-2">
                <Label>发行版</Label>
                <Select value={downloadVendor} onChange={setDownloadVendor}>
                  {downloadVendors.map((vendor) => (
                    <SelectOption key={vendor.id} value={vendor.id}>
                      {vendor.name}{vendor.isRecommended ? ' (推荐)' : ''}
                    </SelectOption>
                  ))}
                </Select>
              </div>
              <div className="space-y-2">
                <Label>Java 主版本</Label>
                <Select value={downloadVersion} onChange={setDownloadVersion}>
                  {(selectedVendor?.versions ?? []).map((version) => (
                    <SelectOption key={version} value={String(version)}>{version}</SelectOption>
                  ))}
                </Select>
              </div>
              <div className="space-y-2">
                <Label>平台</Label>
                <Select value={downloadPlatform} onChange={setDownloadPlatform}>
                  {(selectedVendor?.platforms ?? []).map((platform) => (
                    <SelectOption key={platform} value={platform}>{platform}</SelectOption>
                  ))}
                </Select>
              </div>
              <div className="space-y-2">
                <Label>架构</Label>
                <Select value={downloadArch} onChange={setDownloadArch}>
                  {(selectedVendor?.architectures ?? []).map((arch) => (
                    <SelectOption key={arch} value={arch}>{arch}</SelectOption>
                  ))}
                </Select>
              </div>
              <div className="space-y-2">
                <Label>目标目录</Label>
                <Input value="QML/Runtime/Java" disabled />
              </div>
            </DialogBody>
            <DialogFooter>
              <Button onClick={handleStartJavaDownload} disabled={!selectedVendor || startDownloadLoading}>
                {startDownloadLoading ? <><FontAwesomeIcon icon={faSpinner} className="h-4 w-4 animate-spin mr-2" />解析中...</> : '开始下载'}
              </Button>
            </DialogFooter>
          </Dialog>

          <LicenseActivationDialog
            open={licenseDialogOpen}
            onActivated={() => {
              setLicenseDialogOpen(false)
              fetchLicenseStatus().then(setLicenseStatus).catch(() => {})
            }}
            onClose={() => setLicenseDialogOpen(false)}
          />

          <Dialog open={pluginDetail !== null} onClose={() => setPluginDetail(null)}>
            <DialogHeader onClose={() => setPluginDetail(null)}>
              <DialogTitle>{pluginDetail?.manifest.name ?? ''}</DialogTitle>
            </DialogHeader>
            <DialogBody className="space-y-4">
              {pluginDetail && (
                <>
                  <div className="text-sm text-muted-foreground">
                    {pluginDetail.manifest.id}@{pluginDetail.manifest.version}
                  </div>
                  <div className="flex flex-wrap gap-1">
                    {pluginDetail.manifest.layers.map(layer => (
                      <span key={layer} className="text-xs px-1.5 py-0.5 rounded border border-border text-muted-foreground">{layer.toUpperCase()}</span>
                    ))}
                  </div>
                  <Separator />
                  {pluginDetail.manifest.permissions.length > 0 && (
                    <div className="space-y-1">
                      <p className="text-sm text-muted-foreground">权限 ({pluginDetail.manifest.permissions.length})</p>
                      {pluginDetail.manifest.permissions.map(p => {
                        const info = PERMISSION_CATALOG[p]
                        const colors: Record<string, string> = {
                          normal: 'border-blue-500/30 text-blue-400',
                          warning: 'border-yellow-500/30 text-yellow-400',
                          danger: 'border-red-500/30 text-red-400',
                        }
                        return (
                          <div key={p} className="flex items-center gap-2 text-sm">
                            <span className={`text-xs px-1.5 py-0.5 rounded border ${colors[info?.risk ?? 'normal'] ?? ''}`}>
                              {info?.risk ?? 'normal'}
                            </span>
                            <span>{info?.label ?? p}</span>
                          </div>
                        )
                      })}
                    </div>
                  )}
                  {pluginDetail.manifest.contributes?.menuItems && pluginDetail.manifest.contributes.menuItems.length > 0 && (
                    <div className="space-y-1">
                      <p className="text-sm text-muted-foreground">扩展点</p>
                      {pluginDetail.manifest.contributes.menuItems.map(item => (
                        <div key={item.path} className="flex items-center gap-2 text-sm">
                          <PluginIcon icon={item.icon} fallback="" />
                          <span>{item.label}</span>
                          <span className="text-xs text-muted-foreground">{item.path}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </>
              )}
            </DialogBody>
            <DialogFooter>
              <Button variant="secondary" onClick={() => setPluginDetail(null)}>关闭</Button>
            </DialogFooter>
          </Dialog>
        </div>
      </div>
    </PageShell>
  )
}
