import { useState, useEffect, useCallback, useRef } from 'react'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import { faGithub, faJava } from '@fortawesome/free-brands-svg-icons'
import { ArrowUp, Bot, Bug, Check, CheckCircle2, ChevronRight, Coffee, Copy, Database, Download, ExternalLink, FileText, Folder, FolderOpen, Globe, Heart, Image, Info, Key, Loader2, Minus, Monitor, Palette, Plus, Puzzle, Rocket, RotateCw, Scale, Search, Settings as SettingsIcon, ShieldHalf, SlidersHorizontal, Tag, Trash2, TriangleAlert, Zap } from 'lucide-react'
import { ArrowUp as ArrowUpData, ChevronDown as ChevronDownData, ChevronRight as ChevronRightData, RotateCw as RotateCwData, Search as SearchData, Trash2 as Trash2Data, Zap as ZapData } from 'lucide'
import { MorphActionIcon } from '../components/MorphActionIcon.tsx'
import { MorphIcon } from 'morphicons/react'
import { Button } from '../components/ui'
import { Input } from '../components/ui'
import { Label } from '../components/ui'
import { Dialog, DialogHeader, DialogTitle, DialogBody, DialogFooter } from '../components/ui'
import { Badge } from '../components/ui'
import { Separator } from '../components/ui'
import { Select, SelectOption } from '../components/ui'
import { Tooltip } from '../components/ui'
import { Tabs, TabContent } from '../components/ui'
import { Switch } from '../components/ui'
import { PageHeader } from '../components/PageHeader.tsx'
import { PageShell } from '../components/PageShell.tsx'
import { SettingRow, SettingSection } from '../components/settings/SettingRow.tsx'
import DebugTab from '../components/DebugTab.tsx'
import LogTab from '../components/LogTab.tsx'
import ToolboxTab from '../components/ToolboxTab.tsx'
import PluginStoreTab from '../components/PluginStoreTab.tsx'
import LicenseActivationDialog from '../components/LicenseActivationDialog.tsx'
import { fetchLicenseStatus, getCachedLicenseStatus } from '../api/license.ts'
import { check } from '@tauri-apps/plugin-updater'
import type { Update } from '@tauri-apps/plugin-updater'
import { checkRequired } from '../api/update.ts'
import type { LicenseStatus } from '../api/license.ts'
import UpdateDialog from '../components/UpdateDialog.tsx'
import { useDebug } from '../components/DebugContext.tsx'
import { useMessageBox } from '../components/ui'
import { useExpandAnimation, useAnimatedList } from '../hooks/useGsapAnimations.ts'
import { useI18n } from '../i18n/index.tsx'
import { LANGS } from '../i18n/lang.ts'
import type { LangChoice } from '../i18n/lang.ts'
import { cn } from '../lib/utils.ts'
import { normalizeHex, THEME_COLOR_MODE_BACKGROUND } from '../lib/themeColor.ts'
import type { SystemInfo, JavaDownloadVendorInfo, DownloadTask } from '../types/index.ts'
import {
  addCustomJavaRuntime,
  removeCustomJavaRuntime,
  getJavaDownloadCatalog,
  startJavaDownload,
} from '../api/java.ts'
import { getRuntimes, getValidRuntimes, addRuntime, removeRuntime, scanRuntimes, loadCustomRuntimes, subscribe } from '../stores/javaStore.ts'
import { addTask } from '../stores/downloadStore.ts'
import { getSystemInfo } from '../api/system.ts'
import { ApiError, get, API_BASE } from '../api/client.ts'
import { invoke } from '@tauri-apps/api/core'
import { openUrl, revealItemInDir, openPath } from '@tauri-apps/plugin-opener'
import type { JavaRuntime } from '../types/index.ts'
import { DEFAULT_SETTINGS, saveSettings as apiSaveSettings, loadSettings as apiLoadSettings, pingDownloadSources, pingModSources, pingFileDownloadSources, clearCache, clearCurseForgeCache, clearNeoForgeCache, setDataDir, getSystemFonts } from '../api/settings.ts'
import type { AppSettings, DownloadSourcePing, ModSourcePing } from '../api/settings.ts'
import { FILE_NAMING_OPTIONS } from '../lib/download-naming.ts'
import { APP_INFO, CONTRIBUTORS, DEPENDENCIES, BACKEND_DEPENDENCIES, SERVICES, LICENSE, REPOSITORY_URL, REFERENCE_PROJECTS, USER_AGREEMENT_URL } from '../constants/credits.ts'
import { LegalDialog } from '../components/LegalDialog.tsx'
import { PrivacyDialog } from '../components/PrivacyDialog.tsx'

const CATEGORIES = [
  { id: 'launcher', icon: Rocket },
  { id: 'java', icon: Coffee },
  { id: 'plugins', icon: Puzzle },
  { id: 'appearance', icon: Palette },
  { id: 'toolbox', icon: Download },
  { id: 'logs', icon: FileText },
  { id: 'about', icon: Info },
  { id: 'debug', icon: Bug },
] as const

const DOWNLOAD_SOURCES = [
  { value: 0 },
  { value: 1 },
]

/** 主题色默认值（未设置时回落到 CSS 默认绿，仅用于取色器占位显示）。 */
const DEFAULT_THEME_COLOR = '#22c55e'
/** 预设主题色板（默认绿 + Catppuccin Mocha）。 */
const THEME_COLOR_PRESETS: { value: string; label: string }[] = [
  { value: '#22c55e', label: 'Green' },
  { value: '#89b4fa', label: 'Blue' },
  { value: '#cba6f7', label: 'Mauve' },
  { value: '#fab387', label: 'Peach' },
  { value: '#f38ba8', label: 'Red' },
  { value: '#94e2d5', label: 'Teal' },
  { value: '#f5c2e7', label: 'Pink' },
  { value: '#f9e2af', label: 'Yellow' },
]
const THEME_PRESETS: { value: AppSettings['themePreset']; label: string }[] = [
  { value: 'latte', label: 'Catppuccin Latte' },
  { value: 'frappe', label: 'Catppuccin Frappé' },
  { value: 'macchiato', label: 'Catppuccin Macchiato' },
  { value: 'mocha', label: 'Catppuccin Mocha' },
]

// 关于页 credits 数据 → i18n key 映射（credits.ts 数据对象保持中文，渲染处查表翻译）
const SERVICE_DESC_KEYS: Record<string, string> = {
  Modrinth: 'settings.about.serviceModrinth',
  CurseForge: 'settings.about.serviceModrinth',
  FTB: 'settings.about.serviceModpack',
  bangbang93: 'settings.about.serviceBmclapi',
  mcmod: 'settings.about.serviceMcmod',
  'Minecraft官网': 'settings.about.serviceMinecraft',
}
const SERVICE_NAME_KEYS: Record<string, string> = {
  Modrinth: 'settings.about.serviceModrinthName',
  CurseForge: 'settings.about.serviceCurseForgeName',
  FTB: 'settings.about.serviceFtbName',
  bangbang93: 'settings.about.serviceBmclapiName',
  mcmod: 'settings.about.serviceMcmodName',
  'Minecraft官网': 'settings.about.serviceMinecraftName',
}
const REF_DESC_KEYS: Record<string, string> = {
  HMCL: 'settings.about.refVersionCheck',
  ProjBobcat: 'settings.about.refModloaderInstaller',
  'PCL-CE': 'settings.about.refModCnData',
}
const DEP_CATEGORY_KEYS: Record<string, string> = {
  'Rust 后端运行时': 'settings.about.depBackendRuntime',
  '核心库': 'settings.about.depCoreLibraries',
  '核心框架': 'settings.about.depCoreFramework',
  'UI 组件': 'settings.about.depUiComponents',
  '样式与工具': 'settings.about.depStylesTools',
  '动画': 'settings.about.depAnimation',
  '渲染与展示': 'settings.about.depRendering',
}

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
  // 组件材质：与 App.tsx onSettingsChange 的 applyGlassMaterial 同步，
  // 确保设置页修改后立即生效（apiSaveSettings 的监听器链是异步的）。
  document.documentElement.dataset.material = settings.componentMaterial ?? 'default'
  document.documentElement.style.setProperty('--glass-blur', `${Math.max(0, settings.glassBlur ?? 18)}px`)
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
  const [pendingRequired, setPendingRequired] = useState(false)
  const [legalDialogOpen, setLegalDialogOpen] = useState(false)
  const [privacyDialogOpen, setPrivacyDialogOpen] = useState(false)
  const { t } = useI18n()

  const isPreRelease = /-/.test(APP_INFO.version)
  const versionType = isPreRelease ? t('settings.about.beta') : t('settings.about.stable')

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
      let required = false
      try {
        const info = await checkRequired(update.currentVersion, channel)
        required = info.hasUpdate && info.required === true
      } catch {}
      setPendingUpdate(update)
      setPendingRequired(required)
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
      <SettingSection title={t('settings.about.aboutApp', { name: APP_INFO.name })} icon={<Info className="h-4 w-4" />}>
        <div className="space-y-4 p-4">
          <div className="flex items-center gap-4">
            <img src="/logo.svg" alt={APP_INFO.name} className="h-14 w-14 rounded-2xl" />
            <div className="flex-1 min-w-0">
              <div className="text-lg font-semibold">{APP_INFO.name}</div>
              <div className="flex items-center gap-2">
                <span className="text-sm text-muted-foreground">{t('common.version')} {APP_INFO.version}</span>
                <span className="rounded-full border px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wider text-muted-foreground bg-muted">{versionType}</span>
              </div>
            </div>
            <div className="flex items-center gap-1 shrink-0">
              <Button size="sm" variant="ghost" onClick={() => openUrl('https://github.com/Qomicex-Public/Qomicex.Tauri/issues').catch(() => window.open('https://github.com/Qomicex-Public/Qomicex.Tauri/issues', '_blank'))} className="gap-1.5 h-7 text-xs">
                <Bug className="h-3 w-3" />{t('settings.about.feedback')}
              </Button>
              <Button size="sm" variant="ghost" onClick={() => openUrl(REPOSITORY_URL).catch(() => window.open(REPOSITORY_URL, '_blank'))} className="gap-1.5 h-7 text-xs">
                <FontAwesomeIcon icon={faGithub} className="h-3 w-3" />{t('settings.about.viewRepository')}
              </Button>
            </div>
          </div>
          <p className="text-sm leading-relaxed text-muted-foreground">{t('settings.about.appDescription')}</p>
        </div>
      </SettingSection>

      {/* Version Info */}
      <SettingSection title={t('settings.about.versionInfo')}>
        <div className="p-4">
          <div className="rounded-lg bg-background p-4 text-sm">
            <div className="grid grid-cols-2 gap-3">
              <div><div className="text-xs text-muted-foreground">{t('settings.about.appVersion')}</div><div className="mt-0.5 flex items-center gap-2 font-medium">{APP_INFO.version}<span className="rounded-full border px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wider text-muted-foreground bg-muted">{versionType}</span></div></div>
              <div><div className="text-xs text-muted-foreground">{t('settings.about.versionHash')}</div><div className="mt-0.5 font-medium text-xs font-mono">{sysInfo?.gitCommit && sysInfo.gitCommit !== 'unknown' ? sysInfo.gitCommit : __GIT_SHA__}</div></div>
              <div><div className="text-xs text-muted-foreground">{t('settings.about.os')}</div><div className="mt-0.5 font-medium">{sysInfo?.osDisplayName || (sysInfo ? `${sysInfo.osName} ${sysInfo.osVersion}` : t('common.loading'))}</div></div>
              <div><div className="text-xs text-muted-foreground">{t('settings.about.architecture')}</div><div className="mt-0.5 font-medium">{sysInfo?.architecture ?? t('common.loading')}</div></div>
              <div><div className="text-xs text-muted-foreground">{t('settings.about.memory')}</div><div className="mt-0.5 font-medium">{sysInfo ? `${(sysInfo.memory / 1024).toFixed(1)} GB` : t('common.loading')}</div></div>
            </div>
          </div>
        </div>
      </SettingSection>

      {licenseStatus && !(licenseStatus.valid && !licenseStatus.licenseId) && (
      <SettingSection title={t('settings.about.license')} icon={<ShieldHalf className="h-4 w-4" />}>
        <div className="space-y-3 p-4">
          <div className="flex items-center gap-3">
            {licenseStatus.valid ? (
              <Badge variant="default" className="gap-1">
                <Check className="h-3 w-3" />
                {t('settings.about.licenseActivated')}
              </Badge>
            ) : (
              <Badge variant="destructive" className="gap-1">
                {licenseStatus.error === 'LICENSE_NOT_FOUND' ? t('settings.about.licenseNotActivated') : t('settings.about.licenseInvalid')}
              </Badge>
            )}
            {licenseStatus.licenseId && (
              <span className="text-sm text-muted-foreground">ID: {licenseStatus.licenseId}</span>
            )}
          </div>
          <div className="rounded-lg bg-muted p-3 text-sm space-y-1.5">
            <div className="flex justify-between text-xs">
              <span className="text-muted-foreground">{t('settings.about.channel')}</span>
              <span>{licenseStatus.channel || '-'}</span>
            </div>
            <div className="flex justify-between text-xs">
              <span className="text-muted-foreground">{t('settings.about.expiry')}</span>
              <span>{licenseStatus.isPermanent ? t('settings.about.permanent') : (licenseStatus.expireAt || '-')}</span>
            </div>
            <div className="flex justify-between text-xs">
              <span className="text-muted-foreground">{t('settings.about.machineCode')}</span>
              <span className="font-mono text-[10px] max-w-[200px] truncate select-all">{licenseStatus.machineCode || '-'}</span>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Button size="sm" variant="outline" onClick={onOpenLicenseDialog} className="gap-1.5">
              <Key className="h-3 w-3" />
              {licenseStatus.valid ? t('settings.about.changeLicense') : t('settings.about.activateLicense')}
            </Button>
            <Tooltip content={licenseCopied ? t('common.copied') : t('settings.about.copyMachineCode')}>
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
                {licenseCopied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
              </Button>
            </Tooltip>
          </div>
        </div>
      </SettingSection>
      )}

      {/* Update */}
      <SettingSection title={t('settings.about.update')} icon={<ArrowUp className="h-4 w-4" />}>
        <div className="space-y-3 p-4">
          <div className="flex items-center gap-3">
<Select value={channel} onChange={setChannelAndSave} className="w-28">
  <SelectOption value="stable">{t('settings.about.stable')}</SelectOption>
  <SelectOption value="beta">{t('settings.about.beta')}</SelectOption>
  <SelectOption value="alpha">Alpha</SelectOption>
</Select>
            <Button size="sm" onClick={checkForUpdate} disabled={updateState === 'checking' || updateState === 'downloading'}>
              <MorphActionIcon active={updateState === 'checking'} busy={RotateCwData} rest={ArrowUpData} className="mr-1 h-3 w-3" />
              {updateState === 'checking' ? t('settings.about.checking') : t('settings.about.checkUpdate')}
            </Button>
            {updateState === 'uptodate' && (
              <span className="flex items-center gap-1 text-sm text-muted-foreground">
                <CheckCircle2 className="h-3.5 w-3.5 text-primary" />
                {t('settings.about.upToDate')}
              </span>
            )}
            {updateState === 'error' && (
              <Tooltip content={updateError}>
                <span className="text-sm text-destructive cursor-help">{t('settings.about.checkUpdateFailed')}</span>
              </Tooltip>
            )}
          </div>

        </div>
      </SettingSection>

      <UpdateDialog
        open={updateDialogOpen}
        update={pendingUpdate}
        required={pendingRequired}
        onClose={() => {
          setUpdateDialogOpen(false)
          setPendingRequired(false)
        }}
      />

      {/* Contributors */}
      <SettingSection title={t('settings.about.developers')}>
        <div className="p-2">
          <div className="space-y-3">
            {CONTRIBUTORS.map((c) => (
                <div key={c.name} className="flex items-center gap-3 px-2 py-1">
                  {c.avatar ? (
                    <img src={c.avatar} alt={c.name} className="h-10 w-10 rounded-full object-cover" />
                  ) : (
                    <div className="flex h-10 w-10 items-center justify-center rounded-full bg-primary/10 text-sm font-bold text-primary">
                      {c.name.slice(0, 1).toUpperCase()}
                    </div>
                  )}
                  <div className="flex-1 min-w-0">
                    <div className="font-medium text-sm">{c.name}</div>
                    <div className="text-xs text-muted-foreground">{t('settings.about.roleProjectLead')}</div>
                  </div>
                  <Button size="sm" variant="ghost" onClick={() => openUrl(c.url).catch(() => window.open(c.url, '_blank'))} className="gap-1.5 h-7 text-xs">
                    <FontAwesomeIcon icon={faGithub} className="h-3 w-3" />GitHub
                  </Button>
                </div>
                ))}
          </div>
        </div>
      </SettingSection>

      {/* Services Credits */}
      <SettingSection title={t('settings.about.acknowledgements')} icon={<Heart className="h-4 w-4 text-destructive" />}>
        <div className="p-4">
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
                  <Globe className="h-4 w-4 shrink-0 text-muted-foreground" />
                )}
                <div className="min-w-0 flex-1">
                  <div className="font-medium">{t(SERVICE_NAME_KEYS[svc.name] ?? svc.name)}</div>
                  <div className="truncate text-xs text-muted-foreground">{t(SERVICE_DESC_KEYS[svc.name] ?? svc.description)}</div>
                </div>
                <ExternalLink className="h-3 w-3 shrink-0 text-muted-foreground/50" />
              </button>
            ))}
          </div>
        </div>
      </SettingSection>

      {/* Reference Projects */}
      <SettingSection title={t('settings.about.referenceProjects')}>
        <div className="p-2">
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
                  <div className="truncate text-xs text-muted-foreground">{t(REF_DESC_KEYS[proj.name] ?? proj.description)}</div>
                </div>
                <ExternalLink className="h-3 w-3 shrink-0 text-muted-foreground/50" />
              </button>
            ))}
          </div>
        </div>
      </SettingSection>

      {/* Backend Dependencies */}
      <SettingSection title={t('settings.about.backendDependencies')}>
        <div className="p-2">
          <div className="space-y-1">
            {Object.entries(BACKEND_DEPENDENCIES).map(([category, deps]) => {
              const expandRef = useExpandAnimation(expandedDep === category)
              return (
              <div key={category}>
                <button
                  onClick={() => setExpandedDep(expandedDep === category ? null : category)}
                  className="flex w-full items-center justify-between rounded-lg px-3 py-2 text-sm font-medium hover:bg-accent"
                >
                  <span>{t(DEP_CATEGORY_KEYS[category] ?? category)}</span>
                  <div className="flex items-center gap-2">
                    <Badge variant="secondary" className="h-5 text-[10px]">{deps.length}</Badge>
                    <MorphIcon icon={expandedDep === category ? ChevronDownData : ChevronRightData} className="h-3 w-3 text-muted-foreground" spring="snappy" reducedMotion="user" />
                  </div>
                </button>
                <div ref={expandRef} className="mt-1 space-y-1 pl-2">
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
                          {dep.license === '自研' && <Badge variant="outline" className="h-4 px-1 text-[9px] border-primary/30 text-primary">{t('settings.about.depInHouse')}</Badge>}
                        </div>
                        {dep.url.startsWith('http') ? (
                          <ExternalLink className="h-2.5 w-2.5 text-muted-foreground/50 cursor-pointer" onClick={() => openUrl(dep.url).catch(() => window.open(dep.url, '_blank'))} />
                        ) : null}
                      </div>
                    ))}
                </div>
                <Separator className="my-1" />
              </div>
              )
            })}
          </div>
        </div>
      </SettingSection>

      {/* Frontend Dependencies */}
      <SettingSection title={t('settings.about.frontendDependencies')}>
        <div className="p-2">
          <div className="space-y-1">
            {Object.entries(DEPENDENCIES).map(([category, deps]) => {
              const expandRef = useExpandAnimation(expandedDep === category)
              return (
              <div key={category}>
                <button
                  onClick={() => setExpandedDep(expandedDep === category ? null : category)}
                  className="flex w-full items-center justify-between rounded-lg px-3 py-2 text-sm font-medium hover:bg-accent"
                >
                  <span>{t(DEP_CATEGORY_KEYS[category] ?? category)}</span>
                  <div className="flex items-center gap-2">
                    <Badge variant="secondary" className="h-5 text-[10px]">{deps.length}</Badge>
                    <MorphIcon icon={expandedDep === category ? ChevronDownData : ChevronRightData} className="h-3 w-3 text-muted-foreground" spring="snappy" reducedMotion="user" />
                  </div>
                </button>
                <div ref={expandRef} className="mt-1 space-y-1 pl-2">
                    {deps.map((dep) => (
                      <button
                        key={dep.name}
                        onClick={() => openUrl(dep.url).catch(() => window.open(dep.url, '_blank'))}
                        className="flex w-full items-center justify-between rounded-lg px-3 py-1.5 text-xs hover:bg-accent"
                      >
                        <span className="text-muted-foreground">{dep.name}</span>
                        <div className="flex items-center gap-2">
                          <span className="text-muted-foreground/70">{dep.license}</span>
                          <ExternalLink className="h-2.5 w-2.5 text-muted-foreground/50" />
                        </div>
                      </button>
                    ))}
                </div>
                <Separator className="my-1" />
              </div>
              )
            })}
          </div>
        </div>
      </SettingSection>

      {/* License */}
      <SettingSection title={t('settings.about.openSourceLicense')}>
        <div className="p-4">
          <div className="flex items-center justify-between">
            <div>
              <div className="text-sm font-medium">{LICENSE.name}</div>
              <div className="text-xs text-muted-foreground">{t('settings.about.licenseNotice', { name: LICENSE.name })}</div>
            </div>
            <Button size="sm" variant="outline" onClick={() => openUrl(LICENSE.url).catch(() => window.open(LICENSE.url, '_blank'))} className="gap-1.5 h-8 text-xs">
              <ExternalLink className="h-3 w-3" />{t('settings.about.viewLicense')}
            </Button>
          </div>
        </div>
      </SettingSection>

      {/* 版权与隐私 */}
      <SettingSection title={t('settings.about.copyrightPrivacy')} icon={<Scale className="h-4 w-4" />}>
        <SettingRow
          label={t('settings.about.copyrightStatement')}
          description={t('settings.about.copyrightStatementDesc')}
          onClick={() => setLegalDialogOpen(true)}
          control={<ChevronRight className="h-3 w-3 text-muted-foreground/50" />}
        />
        <SettingRow
          label={t('settings.about.userAgreement')}
          description="qomicex.top/legal/user-agreement"
          onClick={() => openUrl(USER_AGREEMENT_URL).catch(() => window.open(USER_AGREEMENT_URL, '_blank'))}
          control={<ExternalLink className="h-3 w-3 text-muted-foreground/50" />}
        />
        <SettingRow
          label={t('settings.about.privacyPolicy')}
          description={t('settings.about.privacyPolicy')}
          onClick={() => setPrivacyDialogOpen(true)}
          control={<ChevronRight className="h-3 w-3 text-muted-foreground/50" />}
        />
      </SettingSection>

      <LegalDialog open={legalDialogOpen} onClose={() => setLegalDialogOpen(false)} />
      <PrivacyDialog open={privacyDialogOpen} onClose={() => setPrivacyDialogOpen(false)} />
    </div>
  )
}

export default function Settings() {
  const { error: msgError, confirm: msgConfirm, notify } = useMessageBox()
  const { t, setLanguage } = useI18n()
  const [clearingCache, setClearingCache] = useState(false)
  const [clearingCurseForgeCache, setClearingCurseForgeCache] = useState(false)
  const [clearingNeoForgeCache, setClearingNeoForgeCache] = useState(false)
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
  const [showInvalid, setShowInvalid] = useState(false)
  const listRuntimes = showInvalid ? getRuntimes() : getValidRuntimes()
  const [scanning, setScanning] = useState<'idle' | 'quick' | 'deep'>('idle')
  const javaAnimRef = useAnimatedList<HTMLDivElement>([listRuntimes.length, scanning], { y: 12, scale: 0.95 })
  const [javaStatus, setJavaStatus] = useState(() => t('settings.java.ready'))
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
  const [fontList, setFontList] = useState<string[]>([])
  const [sourcePings, setSourcePings] = useState<DownloadSourcePing[]>([])
  const [pingLoading, setPingLoading] = useState(false)
  const [modPings, setModPings] = useState<ModSourcePing[]>([])
  const [modPingLoading, setModPingLoading] = useState(false)
  const [filePings, setFilePings] = useState<DownloadSourcePing[]>([])
  const [filePingLoading, setFilePingLoading] = useState(false)

  useEffect(() => {
    apiLoadSettings().then((s) => {
      setSettings(s)
      loadedRef.current = true
      pingDownloadSources().then(setSourcePings).catch(() => {})
      pingModSources().then(setModPings).catch(() => {})
      pingFileDownloadSources().then(setFilePings).catch(() => {})
    }).catch(() => {})
    get<string[]>('/settings/backgrounds').then(setBackgrounds).catch(() => {})
    getSystemFonts().then(setFontList).catch(() => {})
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
    if (!loadedRef.current) return
    refreshFilePings()
  }, [settings.autoSelectFileDownloadSource])

  useEffect(() => {
    if (category === 'about') {
      fetchLicenseStatus().then(setLicenseStatus).catch(() => {})
    }
  }, [category])

  function update<K extends keyof AppSettings>(key: K, value: AppSettings[K]) {
    const next = { ...settings, [key]: value }
    setSettings(next)
    saveSettings(next)
    if (key === 'themePreset') {
      localStorage.setItem('qomicex-theme-preset', value as string)
    }
    notify(t('settings.saved'), 'success')
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
    setJavaStatus(mode === 'quick' ? t('settings.java.scanningQuick') : t('settings.java.scanningDeep'))
    try {
      const prev = getRuntimes()
      const result = await scanRuntimes(mode)
      const newCount = prev.length === 0 ? result.length : result.filter((r) => !prev.some((m) => m.path === r.path)).length
      setJavaStatus(newCount > 0 ? t('settings.java.scanDoneFound', { count: newCount }) : t('settings.java.scanDoneNone'))
    } catch (e) {
      setJavaStatus(t('settings.java.scanFailed'))
      console.error(e)
    } finally {
      setScanning('idle')
    }
  }, [t])

  function handleRefresh() {
    setJavaStatus(t('settings.java.refreshing'))
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
        const best = pings.filter(p => p.ok).sort((a, b) => a.latency - b.latency)[0]
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
        const best = pings.filter(p => p.ok).sort((a, b) => a.latency - b.latency)[0]
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

  async function refreshFilePings() {
    setFilePingLoading(true)
    try {
      const pings = await pingFileDownloadSources()
      setFilePings(pings)
      if (settings.autoSelectFileDownloadSource) {
        const best = pings.filter(p => p.ok).sort((a, b) => a.latency - b.latency)[0]
        if (best && best.id !== settings.fileDownloadSource) {
          update('fileDownloadSource', best.id)
        }
      }
    } catch {
      setFilePings([])
    } finally {
      setFilePingLoading(false)
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
          title: t('settings.java.pickJavaExecutable'),
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
      setJavaStatus(t('settings.java.added', { name: result.name, version: result.version }))
      setAddDialogOpen(false)
    } catch (e: unknown) {
      setJavaStatus(e instanceof ApiError ? e.displayMessage : t('settings.java.unrecognizedPath'))
      await msgError(e instanceof ApiError ? e.displayMessage : e instanceof Error ? e.message : t('settings.java.unrecognizedPath'))
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
      await msgError(e instanceof ApiError ? e.displayMessage : e instanceof Error ? e.message : t('settings.java.loadCatalogFailed'))
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
      setJavaStatus(t('settings.java.addedToDownload', { name: dlTask.name }))
    } catch (e: unknown) {
      await msgError(e instanceof ApiError ? e.displayMessage : e instanceof Error ? e.message : t('settings.java.downloadFailed'))
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
      notify(t('settings.launcher.cacheCleared', { count: deleted }), 'success')
    } catch (e) {
      await msgError(e instanceof ApiError ? e.displayMessage : e instanceof Error ? e.message : t('settings.launcher.cacheClearFailed'))
    } finally {
      setClearingCache(false)
    }
  }

  async function handleClearCurseForgeCache() {
    setClearingCurseForgeCache(true)
    try {
      await clearCurseForgeCache()
      notify(t('settings.launcher.curseforgeCacheCleared'), 'success')
    } catch (e) {
      await msgError(e instanceof ApiError ? e.displayMessage : e instanceof Error ? e.message : t('settings.launcher.curseforgeCacheClearFailed'))
    } finally {
      setClearingCurseForgeCache(false)
    }
  }

  async function handleClearNeoForgeCache() {
    setClearingNeoForgeCache(true)
    try {
      const { deleted } = await clearNeoForgeCache()
      notify(t('settings.launcher.neoforgeCacheCleared', { count: deleted }), 'success')
    } catch (e) {
      await msgError(e instanceof ApiError ? e.displayMessage : e instanceof Error ? e.message : t('settings.launcher.neoforgeCacheClearFailed'))
    } finally {
      setClearingNeoForgeCache(false)
    }
  }

  async function handleDelete(path: string) {
    const name = runtimes.find((j) => j.path === path)?.name || ''
    const ok = await msgConfirm(t('settings.java.deleteConfirm', { name }), t('settings.java.deleteTitle'))
    if (!ok) return
    setRemovingPath(path)
    try {
      await removeCustomJavaRuntime(path)
      removeRuntime(path)
      if (settings.defaultJavaPath === path) {
        update('defaultJavaPath', '')
      }
      setJavaStatus(t('settings.java.deleted', { name }))
    } catch {
      setJavaStatus(t('settings.java.deleteFailed'))
    } finally {
      setRemovingPath(null)
    }
  }

  return (
    <PageShell className="p-8 space-y-6 overflow-y-auto scroll-fade-mask">
      <PageHeader title={t('layout.sidebar.settings')} />

      <div className="flex gap-4">
        <div className="sticky top-0 self-start flex w-48 shrink-0 flex-col">
          <Tabs
            tabs={CATEGORIES.filter(cat => cat.id !== 'debug' || debugState.unlocked).map(cat => ({ id: cat.id, label: t(`settings.category.${cat.id}`), icon: <cat.icon className="h-4 w-4" /> }))}
            activeTab={category}
            onChange={(id) => setCategory(id)}
            orientation="vertical"
          />
        </div>

        <div className="flex-1 min-w-0 space-y-4">
          <TabContent activeTab={category} tabId="launcher">
            <div className="space-y-6">
            <SettingSection title={t('settings.category.basic')} icon={<SettingsIcon className="h-4 w-4" />}>
              <SettingRow
                label={t('settings.appearance.language')}
                control={
                  <Select
                    value={settings.language}
                    onChange={(v) => {
                      update('language', v)
                      setLanguage(v as LangChoice)
                    }}
                    className="w-48"
                  >
                    {LANGS.map((l) => (
                      <SelectOption key={l.value} value={l.value}>{l.label}</SelectOption>
                    ))}
                    <SelectOption value="system">{t('settings.appearance.followSystem')}</SelectOption>
                  </Select>
                }
              />
              <SettingRow
                label={t('settings.launcher.translationProvider')}
                description={t('settings.launcher.translationProviderDesc')}
                control={
                  <Select
                    value={settings.translationProvider}
                    onChange={(v) => update('translationProvider', v)}
                    className="w-48"
                  >
                    <SelectOption value="mymemory">{t('settings.launcher.translationDefault')}</SelectOption>
                    <SelectOption value="google">{t('settings.launcher.translationGoogle')}</SelectOption>
                    <SelectOption value="bing">Bing Translator</SelectOption>
                  </Select>
                }
              />
              {settings.translationProvider === 'bing' && (
                <div className="space-y-2 px-4 py-3">
                  <Label htmlFor="bingApiKey">Bing API Key</Label>
                  <Input
                    id="bingApiKey"
                    type="password"
                    value={settings.bingApiKey || ''}
                    onChange={(e) => update('bingApiKey', e.target.value)}
                    placeholder={t('settings.launcher.bingApiKeyPlaceholder')}
                    className="max-w-sm"
                  />
                  <p className="text-xs text-muted-foreground">
                    {t('settings.launcher.bingApiKeyDesc')}
                  </p>
                </div>
              )}
              <SettingRow
                label={t('settings.launcher.autoReportErrors')}
                description={t('settings.launcher.autoReportErrorsDesc')}
                control={
                  <Switch
                    checked={settings.autoReportErrors !== false}
                    onCheckedChange={(c) => update('autoReportErrors', c === true)}
                  />
                }
              />
              <SettingRow
                label={t('settings.launcher.telemetry')}
                description={t('settings.launcher.telemetryDesc')}
                control={
                  <Switch
                    checked={settings.telemetryEnabled === true}
                    onCheckedChange={(c) => update('telemetryEnabled', c === true)}
                  />
                }
              />
              <SettingRow
                label={t('settings.launcher.logLevelLabel')}
                description={t('settings.launcher.logLevelDesc')}
                control={
                  <Select
                    value={settings.logLevel}
                    onChange={(v) => update('logLevel', v)}
                    className="w-48"
                  >
                    <SelectOption value="error">{t('settings.launcher.logLevel.error')}</SelectOption>
                    <SelectOption value="warn">{t('settings.launcher.logLevel.warn')}</SelectOption>
                    <SelectOption value="info">{t('settings.launcher.logLevel.info')}</SelectOption>
                    <SelectOption value="debug">{t('settings.launcher.logLevel.debug')}</SelectOption>
                    <SelectOption value="trace">{t('settings.launcher.logLevel.trace')}</SelectOption>
                  </Select>
                }
              />
            </SettingSection>

            <SettingSection title={t('settings.category.launch')} icon={<Rocket className="h-4 w-4" />}>
              <SettingRow
                label={t('settings.launcher.versionIsolation')}
                description={t('settings.launcher.versionIsolationDesc')}
                control={
                  <Switch
                    checked={settings.versionIsolation}
                    onCheckedChange={(c) => update('versionIsolation', c === true)}
                  />
                }
              />
              <SettingRow
                label={t('settings.launcher.closeAfterLaunch')}
                description={t('settings.launcher.closeAfterLaunchDesc')}
                control={
                  <Switch
                    checked={settings.closeAfterLaunch}
                    onCheckedChange={(c) => update('closeAfterLaunch', c === true)}
                  />
                }
              />
            </SettingSection>

            <SettingSection title={t('settings.category.download')} icon={<Download className="h-4 w-4" />}>
              <SettingRow
                label={t('settings.launcher.downloadThreads')}
                description={t('settings.launcher.downloadThreadsDesc')}
                control={
                  <div className="flex items-center gap-2">
                    <Button variant="outline" size="icon" className="h-9 w-9 shrink-0" onClick={() => update('downloadThreads', Math.max(1, settings.downloadThreads - 1))} disabled={settings.downloadThreads <= 1}>
                      <Minus className="h-3.5 w-3.5" />
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
                      <Plus className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                }
              />
              <SettingRow
                label={t('settings.launcher.fileChunkThreads')}
                description={t('settings.launcher.fileChunkThreadsDesc')}
                control={
                  <Select
                    value={String(settings.fileChunkThreads)}
                    onChange={(v) => update('fileChunkThreads', Number(v))}
                    className="w-48"
                  >
                    <SelectOption value="-1">{t('settings.launcher.fileChunkThreadsOff')}</SelectOption>
                    <SelectOption value="0">{t('settings.launcher.fileChunkThreadsAuto')}</SelectOption>
                    {Array.from({ length: 16 }, (_, i) => i + 1).map((n) => (
                      <SelectOption key={n} value={String(n)}>{n}</SelectOption>
                    ))}
                  </Select>
                }
              />
              <SettingRow
                label={t('settings.launcher.downloadTimeout')}
                description={t('settings.launcher.downloadTimeoutDesc')}
                control={
                  <div className="flex items-center gap-2">
                    <Button variant="outline" size="icon" className="h-9 w-9 shrink-0" onClick={() => update('downloadTimeout', Math.max(0, settings.downloadTimeout - 5))} disabled={settings.downloadTimeout <= 0}>
                      <Minus className="h-3.5 w-3.5" />
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
                      <Plus className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                }
              />
              <SettingRow
                label={t('settings.launcher.enableHttp3')}
                description={t('settings.launcher.enableHttp3Desc')}
                control={
                  <Switch
                    checked={settings.enableHttp3 === true}
                    onCheckedChange={(c) => update('enableHttp3', c === true)}
                  />
                }
              />
              <SettingRow
                label={t('settings.launcher.http1Parallel')}
                description={t('settings.launcher.http1ParallelDesc')}
                control={
                  <Switch
                    checked={settings.http1Parallel === true}
                    onCheckedChange={(c) => update('http1Parallel', c === true)}
                  />
                }
              />
              <SettingRow
                label={t('settings.launcher.fileNaming')}
                description={t('settings.launcher.fileNamingDesc')}
                control={
                  <Select
                    value={settings.fileNaming || (settings.language.startsWith('zh') ? '[{cn}]{name}-{version}' : '{name}-{version}')}
                    onChange={(v) => update('fileNaming', v)}
                    className="w-56"
                  >
                    {(settings.language.startsWith('zh') ? FILE_NAMING_OPTIONS : FILE_NAMING_OPTIONS.filter(o => o.key === '{name}-{version}' || o.key === '{name}')).map((opt) => (
                      <SelectOption key={opt.key} value={opt.key}>{t(`settings.launcher.${opt.label}`)}</SelectOption>
                    ))}
                  </Select>
                }
              />
            </SettingSection>

            <SettingSection title={t('settings.launcher.downloadSource')} icon={<Globe className="h-4 w-4" />}>
                <div className="space-y-2 px-4 py-3">
                  <Label>{t('settings.launcher.downloadSource')}</Label>
                  <div className="flex flex-wrap items-center gap-2">
                    {DOWNLOAD_SOURCES.map((s) => {
                      const ping = sourcePings.find(p => p.id === s.value)
                      const showLatency = ping && ping.latency >= 0
                      const latencyColor = !ping?.ok ? 'text-destructive'
                        : ping.latency < 200 ? 'text-emerald-400'
                        : ping.latency < 400 ? 'text-amber-400'
                        : 'text-destructive'
                      return (
                        <button
                          key={s.value}
                          disabled={settings.autoSelectDownloadSource}
                          onClick={() => update('downloadSource', s.value)}
                          className={cn(
                            'flex items-center gap-1.5 rounded-lg border px-4 py-2 text-sm transition-colors',
                            settings.autoSelectDownloadSource && settings.downloadSource !== s.value && 'pointer-events-none opacity-60',
                            settings.autoSelectDownloadSource && settings.downloadSource === s.value && 'pointer-events-none',
                            settings.downloadSource === s.value
                              ? 'border-primary bg-primary/10 font-medium text-primary'
                              : 'border-border hover:border-muted-foreground/30'
                          )}
                        >
                          {t(`settings.launcher.downloadSourceName.${s.value}`)}
                          {pingLoading && <RotateCw className="h-3 w-3 animate-spin text-muted-foreground" />}
                          {!pingLoading && showLatency && (
                            <span className={cn('text-xs tabular-nums', latencyColor)}>
                              {ping.latency}ms
                            </span>
                          )}
                          {!pingLoading && !showLatency && (
                            <span className="text-xs text-muted-foreground">--</span>
                          )}
                        </button>
                      )
                    })}
                    <Tooltip content={t('settings.launcher.refreshLatency')}>
                      <Button variant="ghost" size="icon" className="h-9 w-9 shrink-0" onClick={refreshPings} disabled={pingLoading}>
                        <RotateCw className={cn('h-3.5 w-3.5', pingLoading && 'animate-spin')} />
                      </Button>
                    </Tooltip>
                  </div>
                  <label className="flex items-center gap-3 cursor-pointer">
                    <Switch
                      checked={settings.autoSelectDownloadSource}
                      onCheckedChange={(c) => update('autoSelectDownloadSource', c === true)}
                    />
                    <div className="flex items-center gap-1.5">
                      <Zap className="h-3.5 w-3.5 text-amber-400" />
                      <span className="text-sm font-medium">{t('settings.launcher.autoSelectDownloadSource')}</span>
                    </div>
                  </label>
                  <p className="text-xs text-muted-foreground">{t('settings.launcher.autoSelectDownloadSourceDesc')}</p>
                </div>

                <div className="space-y-2 px-4 py-3">
                  <Label>{t('settings.launcher.resourceDownloadSource')}</Label>
                  <div className="flex flex-wrap items-center gap-2">
                    {[0, 1, 2].map((s) => {
                      const ping = filePings.find(p => p.id === s)
                      const showLatency = ping && ping.latency >= 0
                      const latencyColor = !ping?.ok ? 'text-destructive'
                        : ping.latency < 200 ? 'text-emerald-400'
                        : ping.latency < 400 ? 'text-amber-400'
                        : 'text-destructive'
                      return (
                        <button
                          key={s}
                          disabled={settings.autoSelectFileDownloadSource}
                          onClick={() => update('fileDownloadSource', s)}
                          className={cn(
                            'flex items-center gap-1.5 rounded-lg border px-4 py-2 text-sm transition-colors',
                            settings.autoSelectFileDownloadSource && settings.fileDownloadSource !== s && 'pointer-events-none opacity-60',
                            settings.autoSelectFileDownloadSource && settings.fileDownloadSource === s && 'pointer-events-none',
                            settings.fileDownloadSource === s
                              ? 'border-primary bg-primary/10 font-medium text-primary'
                              : 'border-border hover:border-muted-foreground/30'
                          )}
                        >
                          {t(`settings.launcher.resourceDownloadSourceName.${s}`)}
                          {filePingLoading && <RotateCw className="h-3 w-3 animate-spin text-muted-foreground" />}
                          {!filePingLoading && showLatency && (
                            <span className={cn('text-xs tabular-nums', latencyColor)}>
                              {ping.latency}ms
                            </span>
                          )}
                          {!filePingLoading && !showLatency && (
                            <span className="text-xs text-muted-foreground">--</span>
                          )}
                        </button>
                      )
                    })}
                    <Tooltip content={t('settings.launcher.refreshLatency')}>
                      <Button variant="ghost" size="icon" className="h-9 w-9 shrink-0" onClick={refreshFilePings} disabled={filePingLoading}>
                        <RotateCw className={cn('h-3.5 w-3.5', filePingLoading && 'animate-spin')} />
                      </Button>
                    </Tooltip>
                  </div>
                  <label className="flex items-center gap-3 cursor-pointer">
                    <Switch
                      checked={settings.autoSelectFileDownloadSource}
                      onCheckedChange={(c) => update('autoSelectFileDownloadSource', c === true)}
                    />
                    <div className="flex items-center gap-1.5">
                      <Zap className="h-3.5 w-3.5 text-amber-400" />
                      <span className="text-sm font-medium">{t('settings.launcher.autoSelectFileDownloadSource')}</span>
                    </div>
                  </label>
                  <p className="text-xs text-muted-foreground">{t('settings.launcher.resourceDownloadSourceDesc')}</p>
                </div>

                <div className="space-y-2 px-4 py-3">
                  <Label>{t('settings.launcher.modSource')}</Label>
                  <div className="flex flex-wrap items-center gap-2">
                    {[
                      { value: 0 },
                      { value: 1 },
                    ].map((s) => {
                      const ping = modPings.find(p => p.id === s.value)
                      const showLatency = ping && ping.latency >= 0
                      const latencyColor = !ping?.ok ? 'text-destructive'
                        : ping.latency < 200 ? 'text-emerald-400'
                        : ping.latency < 400 ? 'text-amber-400'
                        : 'text-destructive'
                      return (
                        <button
                          key={s.value}
                          disabled={settings.autoSelectModMirror}
                          onClick={() => update('modMirror', s.value)}
                          className={cn(
                            'flex items-center gap-1.5 rounded-lg border px-4 py-2 text-sm transition-colors',
                            settings.autoSelectModMirror && settings.modMirror !== s.value && 'pointer-events-none opacity-60',
                            settings.autoSelectModMirror && settings.modMirror === s.value && 'pointer-events-none',
                            settings.modMirror === s.value
                              ? 'border-primary bg-primary/10 font-medium text-primary'
                              : 'border-border hover:border-muted-foreground/30'
                          )}
                        >
                          {t(`settings.launcher.modSourceName.${s.value}`)}
                          {modPingLoading && <RotateCw className="h-3 w-3 animate-spin text-muted-foreground" />}
                          {!modPingLoading && showLatency && (
                            <span className={cn('text-xs tabular-nums', latencyColor)}>
                              {ping.latency}ms
                            </span>
                          )}
                          {!modPingLoading && !showLatency && (
                            <span className="text-xs text-muted-foreground">--</span>
                          )}
                        </button>
                      )
                    })}
                    <Tooltip content={t('settings.launcher.refreshLatency')}>
                      <Button variant="ghost" size="icon" className="h-9 w-9 shrink-0" onClick={refreshModPings} disabled={modPingLoading}>
                        <RotateCw className={cn('h-3.5 w-3.5', modPingLoading && 'animate-spin')} />
                      </Button>
                    </Tooltip>
                  </div>
                  <label className="flex items-center gap-3 cursor-pointer">
                    <Switch
                      checked={settings.autoSelectModMirror}
                      onCheckedChange={(c) => update('autoSelectModMirror', c === true)}
                    />
                    <div className="flex items-center gap-1.5">
                      <Zap className="h-3.5 w-3.5 text-amber-400" />
                      <span className="text-sm font-medium">{t('settings.launcher.autoSelectModSource')}</span>
                    </div>
                  </label>
                  <p className="text-xs text-muted-foreground">{t('settings.launcher.autoSelectModSourceDesc')}</p>
                </div>
            </SettingSection>

            <SettingSection title={t('settings.network.proxy')} icon={<Globe className="h-4 w-4" />}>
              <SettingRow
                label={t('settings.network.proxyMode')}
                description={t('settings.network.proxyModeDesc')}
                control={
                  <Select
                    value={settings.proxyMode}
                    onChange={(v) => update('proxyMode', v as AppSettings['proxyMode'])}
                    className="w-48"
                  >
                    <SelectOption value="off">{t('settings.network.proxyOff')}</SelectOption>
                    <SelectOption value="system">{t('settings.network.proxySystem')}</SelectOption>
                    <SelectOption value="http">HTTP(S)</SelectOption>
                    <SelectOption value="socks5">SOCKS5</SelectOption>
                  </Select>
                }
              />
              {(settings.proxyMode === 'http' || settings.proxyMode === 'socks5') && (
                <SettingRow
                  label={t('settings.network.proxyHost')}
                  description={t('settings.network.proxyHostDesc')}
                  control={
                    <Input
                      id="proxyHost"
                      value={settings.proxyHost}
                      onChange={(e) => update('proxyHost', e.target.value)}
                      placeholder={t('settings.network.proxyHostPlaceholder')}
                      className="max-w-sm font-mono"
                    />
                  }
                />
              )}
              <SettingRow
                label={t('settings.network.ignoreSslCert')}
                description={t('settings.network.ignoreSslCertDesc')}
                control={
                  <Switch
                    checked={settings.ignoreSslCert === true}
                    onCheckedChange={(c) => update('ignoreSslCert', c === true)}
                  />
                }
              />
            </SettingSection>

            <SettingSection title={t('settings.category.storage')} icon={<Database className="h-4 w-4" />}>
              <SettingRow
                label={t('settings.launcher.dataDir')}
                description={t('settings.launcher.dataDirDesc')}
                control={
                  <div className="flex items-center gap-2">
                    <Input value={settings.dataDir} readOnly className="font-mono text-xs" />
                    <Button variant="outline" size="icon" className="h-9 w-9 shrink-0" onClick={async () => {
                      const { open } = await import('@tauri-apps/plugin-dialog')
                      const result = await open({ directory: true, multiple: false })
                      if (result) {
                        try {
                          const newPath = await setDataDir(result)
                          update('dataDir', newPath)
                          notify(t('settings.launcher.dataDirChanged'), 'success')
                        } catch {
                          notify(t('settings.launcher.saveFailed'), 'error')
                        }
                      }
                    }}>
                      <FolderOpen className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                }
              />
              <SettingRow
                label={t('settings.launcher.versionListCache')}
                description={t('settings.launcher.versionListCacheDesc')}
                control={
                  <Button size="sm" variant="outline" onClick={handleClearCache} disabled={clearingCache}>
                    <MorphActionIcon active={clearingCache} busy={RotateCwData} rest={Trash2Data} className="h-4 w-4" />
                    {t('settings.launcher.clearCache')}
                  </Button>
                }
              />
              <SettingRow
                label={t('settings.launcher.curseforgeConcurrency')}
                description={t('settings.launcher.curseforgeConcurrencyDesc')}
                control={
                  <div className="flex items-center gap-2">
                    <Button variant="outline" size="icon" className="h-9 w-9 shrink-0" onClick={() => update('curseforgeVersionFetchConcurrency', Math.max(1, Math.min(20, settings.curseforgeVersionFetchConcurrency - 1)))} disabled={settings.curseforgeVersionFetchConcurrency <= 1}>
                      <Minus className="h-3.5 w-3.5" />
                    </Button>
                    <Input
                      id="curseforgeVersionFetchConcurrency"
                      type="number"
                      min={1}
                      max={20}
                      value={settings.curseforgeVersionFetchConcurrency}
                      onChange={(e) => update('curseforgeVersionFetchConcurrency', Math.max(1, Math.min(20, parseInt(e.target.value) || 1)))}
                      className="w-20 text-center [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
                    />
                    <Button variant="outline" size="icon" className="h-9 w-9 shrink-0" onClick={() => update('curseforgeVersionFetchConcurrency', Math.min(20, settings.curseforgeVersionFetchConcurrency + 1))} disabled={settings.curseforgeVersionFetchConcurrency >= 20}>
                      <Plus className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                }
              />
              <SettingRow
                label={t('settings.launcher.curseforgeTtl')}
                description={t('settings.launcher.curseforgeTtlDesc')}
                control={
                  <div className="flex items-center gap-2">
                    <Button variant="outline" size="icon" className="h-9 w-9 shrink-0" onClick={() => update('curseforgeVersionCacheTtlSeconds', Math.max(0, settings.curseforgeVersionCacheTtlSeconds - 10))} disabled={settings.curseforgeVersionCacheTtlSeconds <= 0}>
                      <Minus className="h-3.5 w-3.5" />
                    </Button>
                    <Input
                      id="curseforgeVersionCacheTtlSeconds"
                      type="number"
                      min={0}
                      max={3600}
                      value={settings.curseforgeVersionCacheTtlSeconds}
                      onChange={(e) => update('curseforgeVersionCacheTtlSeconds', Math.max(0, Math.min(3600, parseInt(e.target.value) || 0)))}
                      className="w-20 text-center [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
                    />
                    <Button variant="outline" size="icon" className="h-9 w-9 shrink-0" onClick={() => update('curseforgeVersionCacheTtlSeconds', Math.min(3600, settings.curseforgeVersionCacheTtlSeconds + 10))} disabled={settings.curseforgeVersionCacheTtlSeconds >= 3600}>
                      <Plus className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                }
              />
              <SettingRow
                label={t('settings.launcher.curseforgeCache')}
                description={t('settings.launcher.curseforgeCacheDesc')}
                control={
                  <Button size="sm" variant="outline" onClick={handleClearCurseForgeCache} disabled={clearingCurseForgeCache}>
                    <MorphActionIcon active={clearingCurseForgeCache} busy={RotateCwData} rest={Trash2Data} className="h-4 w-4" />
                    {t('settings.launcher.clearCurseforgeCache')}
                  </Button>
                }
              />
              <SettingRow
                label={t('settings.launcher.neoforgeCache')}
                description={t('settings.launcher.neoforgeCacheDesc')}
                control={
                  <Button size="sm" variant="outline" onClick={handleClearNeoForgeCache} disabled={clearingNeoForgeCache}>
                    <MorphActionIcon active={clearingNeoForgeCache} busy={RotateCwData} rest={Trash2Data} className="h-4 w-4" />
                    {t('settings.launcher.clearNeoforgeCache')}
                  </Button>
                }
              />
            </SettingSection>

            </div>
          </TabContent>
          <TabContent activeTab={category} tabId="java">
            <div className="space-y-6">
              <SettingSection title={t('settings.java.title')} icon={<Coffee className="h-4 w-4" />}>
                <div className="flex items-center justify-between gap-4 px-4 py-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <Button size="sm" onClick={() => handleScan('quick')} disabled={scanning !== 'idle'}>
                      <MorphActionIcon active={scanning === 'quick'} busy={RotateCwData} rest={SearchData} className="h-4 w-4" />
                      {t('settings.java.quickScan')}
                    </Button>
                    <Button size="sm" variant="secondary" onClick={() => handleScan('deep')} disabled={scanning !== 'idle'}>
                      <MorphActionIcon active={scanning === 'deep'} busy={RotateCwData} rest={ZapData} className="h-4 w-4" />
                      {t('settings.java.deepScan')}
                    </Button>
                    <Button size="sm" variant="outline" onClick={handleManualAdd} disabled={scanning !== 'idle'}>
                      <Plus className="h-4 w-4" />
                      {t('settings.java.manualAdd')}
                    </Button>
                    <Button size="sm" variant="ghost" onClick={handleOpenJavaDownload} disabled={downloadLoading}>
                      <Download className="h-4 w-4" />
                      {t('settings.java.downloadJava')}
                    </Button>
                    <Tooltip content={t('settings.java.refreshList')}>
                      <Button size="sm" variant="ghost" onClick={handleRefresh} disabled={scanning !== 'idle'}>
                        <RotateCw className={cn('h-4 w-4', scanning !== 'idle' && 'animate-spin')} />
                      </Button>
                    </Tooltip>
                    <label className="flex items-center gap-2 text-sm text-muted-foreground">
                      <Switch checked={showInvalid} onCheckedChange={(v) => setShowInvalid(v === true)} />
                      {t('settings.java.showInvalid')}
                    </label>
                  </div>
                  <div className="flex shrink-0 items-center gap-3 text-sm">
                    <span className="text-muted-foreground">{t('settings.java.detected')} <span className="font-medium text-foreground">{runtimes.length}</span></span>
                    <span className="text-muted-foreground">{t('settings.java.available')} <span className="font-medium text-primary">{validCount}</span></span>
                  </div>
                </div>

                  {scanning !== 'idle' && (
                    <div className="flex items-center gap-3 rounded-lg bg-muted px-4 py-3">
                      <RotateCw className="h-4 w-4 animate-spin text-primary" />
                      <span className="text-sm text-muted-foreground">{t('settings.java.scanningRuntime')}</span>
                    </div>
                  )}

                  {scanning === 'idle' && listRuntimes.length === 0 && (
                    <div className="flex flex-col items-center gap-4 py-12 text-center">
                      <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-muted">
                        <Coffee className="h-7 w-7 text-muted-foreground" />
                      </div>
                      <div>
                        <p className="text-sm font-medium text-foreground">{t('settings.java.noRuntimeDetected')}</p>
                        <p className="mt-1 text-xs text-muted-foreground">{t('settings.java.noRuntimeHint')}</p>
                      </div>
                      <Button size="sm" onClick={() => handleScan('quick')}>
                        <Search className="h-4 w-4" />
                        {t('settings.java.startScan')}
                      </Button>
                    </div>
                  )}

                  {scanning === 'idle' && listRuntimes.length > 0 && (
                    <div ref={javaAnimRef} className="space-y-1 p-4">
                      {listRuntimes.map((j, i) => (
                        <div
                          key={i}
                          data-key={j.path}
                          className="flex items-center gap-3 rounded-lg border border-border bg-background px-4 py-3 transition-colors hover:border-muted-foreground/30"
                        >
                          <div className={cn('flex h-9 w-9 shrink-0 items-center justify-center rounded-lg', j.state === 'Valid' ? 'bg-green-500/10 text-green-600' : 'bg-destructive/15 text-destructive')}>
                            <FontAwesomeIcon icon={faJava} className="h-5 w-5" />
                          </div>

                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-2 min-w-0">
                              <Tooltip content={j.name}><span className="min-w-0 truncate text-sm font-medium">{j.name}</span></Tooltip>
                              <Badge variant="outline" className="h-5 px-1.5 text-[10px]">{j.type}</Badge>
                              {j.discoveredBy === 'Custom' && <Badge variant="secondary" className="h-5 px-1.5 text-[10px]">{t('settings.java.manualAdd')}</Badge>}
                              {j.state === 'Valid' ? (
                                <span className="rounded-full bg-primary/10 px-2 py-0.5 text-[10px] font-medium text-primary">{t('settings.java.usable')}</span>
                              ) : (
                                <span className="rounded-full bg-destructive/10 px-2 py-0.5 text-[10px] font-medium text-destructive">{t('settings.java.unusable')}</span>
                              )}
                            </div>
                            <div className="mt-0.5 flex items-center gap-3 text-xs text-muted-foreground">
                              <span className="flex items-center gap-1">
                                <Tag className="h-3 w-3" />
                                {t('common.version')} {j.version}
                              </span>
                              <span className="flex items-center gap-1">
                                <Monitor className="h-3 w-3" />
                                {j.arch}
                              </span>
                            </div>
                            <div className="mt-1 flex items-center gap-1.5 text-xs text-muted-foreground/60">
                              <Folder className="h-3 w-3 shrink-0" />
                              <span className="truncate">{j.path}</span>
                            </div>
                          </div>

                          <div className="flex shrink-0 items-center gap-0.5">
                            <Tooltip content={t('settings.java.openFolder')}>
                              <Button size="icon" variant="ghost" className="h-8 w-8" onClick={() => handleOpenFolder(j.path)}>
                                <FolderOpen className="h-3.5 w-3.5" />
                              </Button>
                            </Tooltip>
                            {j.discoveredBy === 'Custom' && (
                              <Tooltip content={t('common.delete')}>
                                <Button size="icon" variant="ghost" className="h-8 w-8 text-destructive/70 hover:text-destructive" onClick={() => handleDelete(j.path)} disabled={removingPath === j.path}>
                                  <Trash2 className="h-3.5 w-3.5" />
                                </Button>
                              </Tooltip>
                            )}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}

                  <div className="mx-4 mb-4 flex items-center gap-2 rounded-lg bg-muted/50 px-4 py-2.5 text-xs text-muted-foreground">
                    <Info className="h-3.5 w-3.5 text-primary" />
                    <span>{javaStatus}</span>
                    <span className="ml-auto">
                      {runtimes.length > 0 && t('settings.java.availableCount', { valid: validCount, total: runtimes.length })}
                    </span>
                  </div>
              </SettingSection>

              <SettingSection title={t('settings.java.defaultConfig')}>
                <SettingRow
                  label={t('settings.java.defaultRuntime')}
                  description={t('settings.java.defaultRuntimeDesc')}
                  control={
                    <Select value={settings.defaultJavaPath} onChange={(v) => update('defaultJavaPath', v)}>
                      <SelectOption value="">{t('settings.java.autoSelect')}</SelectOption>
                      {getValidRuntimes().map((j, i) => (
                        <SelectOption key={i} value={j.path}>{j.name} - {j.version} ({j.arch})</SelectOption>
                      ))}
                    </Select>
                  }
                />
                <div className="space-y-2 px-4 py-3">
                  <Label>{t('settings.java.memoryAllocation')}</Label>
                    <div className="flex items-center gap-2">
                      <button onClick={() => {
                        const next = { ...settings, memoryMode: 'auto' as const }
                        if (sysInfo) next.defaultMaxMemory = Math.max(512, Math.floor(sysInfo.availableMemory * 0.7))
                        setSettings(next)
                        saveSettings(next)
                        notify(t('settings.saved'), 'success')
                      }} className={cn('inline-flex items-center gap-1.5 h-9 rounded-lg border px-3.5 text-sm transition-colors', settings.memoryMode === 'auto' ? 'border-primary bg-primary/10 font-medium text-primary' : 'border-border hover:border-muted-foreground/30')}>
                        <Bot className="h-3.5 w-3.5" />{t('settings.java.memoryAuto')}
                      </button>
                      <button onClick={() => update('memoryMode', 'custom')} className={cn('inline-flex items-center gap-1.5 h-9 rounded-lg border px-3.5 text-sm transition-colors', settings.memoryMode === 'custom' ? 'border-primary bg-primary/10 font-medium text-primary' : 'border-border hover:border-muted-foreground/30')}>
                        <SlidersHorizontal className="h-3.5 w-3.5" />{t('settings.java.memoryCustom')}
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
                                <span>{t('settings.java.totalMemory', { value: (totalMb / 1024).toFixed(1) })}</span>
                                <span>{t('settings.java.usedMemory', { value: (usedMb / 1024).toFixed(1) })}</span>
                                <span>{t('settings.java.gameMemory', { value: (gameMb / 1024).toFixed(1) })}</span>
                                <span>{t('settings.java.remainingMemory', { value: ((availMb - gameMb) / 1024).toFixed(1) })}</span>
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

                <div className="px-4 py-3">
                  <div className="mb-2 flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 p-2.5 text-xs text-amber-600 dark:text-amber-400">
                    <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                    <span>{t('settings.java.jvmArgsWarning')}</span>
                  </div>
                  <textarea
                    value={settings.jvmArgs}
                    onChange={(e) => update('jvmArgs', e.target.value)}
                    placeholder="-Xmx2G -XX:+UseG1GC"
                    rows={4}
                    className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring resize-y font-mono"
                  />
                </div>
              </SettingSection>
            </div>
          </TabContent>

          <TabContent activeTab={category} tabId="appearance">
            <div className="space-y-6">
              <SettingSection title={t('settings.appearance.title')} icon={<Palette className="h-4 w-4" />}>
                <SettingRow
                  label={t('settings.appearance.themePreset')}
                  control={
                    <Select value={settings.themePreset} onChange={(v) => update('themePreset', v as AppSettings['themePreset'])} className="w-56">
                      <SelectOption value="default">Qomicex Default</SelectOption>
                      {THEME_PRESETS.map((preset) => <SelectOption key={preset.value} value={preset.value}>{preset.label}</SelectOption>)}
                    </Select>
                  }
                />

                <SettingRow
                  label={t('settings.appearance.themeColor')}
                  description={t('settings.appearance.themeColorDesc')}
                  control={
                    <div className="flex flex-wrap items-center justify-end gap-2">
                      <Tooltip content={t('settings.appearance.themeColorBackground')}>
                        <button
                          type="button"
                          onClick={() => update('themeColor', THEME_COLOR_MODE_BACKGROUND)}
                          className={cn(
                            'flex h-7 w-7 items-center justify-center rounded-full border-2 transition',
                            settings.themeColor === THEME_COLOR_MODE_BACKGROUND
                              ? 'border-foreground ring-2 ring-primary/40'
                              : 'border-border/60 hover:border-foreground/50'
                          )}
                          style={{ background: 'conic-gradient(#f87171,#fbbf24,#34d399,#60a5fa,#a78bfa,#f87171)' }}
                        >
                          <Image className="h-3 w-3 text-foreground" />
                        </button>
                      </Tooltip>
                        {THEME_COLOR_PRESETS.map((p) => (
                          <Tooltip key={p.value} content={p.label}>
                            <button
                              type="button"
                              onClick={() => update('themeColor', p.value)}
                              className={cn(
                                'h-7 w-7 rounded-full border-2 transition',
                                (settings.themeColor && settings.themeColor.toLowerCase() === p.value)
                                  ? 'border-foreground ring-2 ring-primary/40'
                                  : 'border-border/60 hover:border-foreground/50'
                              )}
                              style={{ backgroundColor: p.value }}
                            />
                          </Tooltip>
                        ))}
                      <Tooltip content={t('settings.appearance.themeColorCustom')}>
                        <div className="relative h-7 w-7 overflow-hidden rounded-full border border-border/60">
                          <input
                            type="color"
                            value={(settings.themeColor && normalizeHex(settings.themeColor)) || DEFAULT_THEME_COLOR}
                            onChange={(e) => update('themeColor', e.target.value)}
                            className="absolute -inset-2 h-12 w-12 cursor-pointer"
                          />
                        </div>
                      </Tooltip>
                      <Tooltip content={t('settings.appearance.themeColorReset')}>
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-7 px-2 text-xs"
                          onClick={() => update('themeColor', '')}
                        >
                          {t('settings.appearance.themeColorReset')}
                        </Button>
                      </Tooltip>
                    </div>
                  }
                />

                <SettingRow
                  label={t('settings.appearance.animations')}
                  description={t('settings.appearance.animationsDesc')}
                  control={
                    <Switch
                      checked={settings.animationsEnabled}
                      onCheckedChange={(c) => update('animationsEnabled', c === true)}
                    />
                  }
                />
                {settings.animationsEnabled && (
                  <div className="space-y-2 px-4 py-3">
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
                      <span>{t('settings.appearance.slow')}</span>
                      <span>{t('settings.appearance.normal')}</span>
                      <span>{t('settings.appearance.fast')}</span>
                    </div>
                  </div>
                )}

                <SettingRow
                  label={t('settings.appearance.maxFrameRate')}
                  description={t('settings.appearance.maxFrameRateDesc')}
                  control={
                    <Select value={String(settings.maxFrameRate)} onChange={(v) => update('maxFrameRate', Number(v))} className="w-48">
                      <SelectOption value="0">{t('settings.appearance.maxFrameRateUnlimited')}</SelectOption>
                      <SelectOption value="30">30 FPS</SelectOption>
                      <SelectOption value="60">60 FPS</SelectOption>
                      <SelectOption value="120">120 FPS</SelectOption>
                      <SelectOption value="144">144 FPS</SelectOption>
                    </Select>
                  }
                />
              </SettingSection>
              <SettingSection title={t('settings.appearance.themeMode')}>
                <SettingRow
                  label={t('settings.appearance.themeMode')}
                  control={
                    <Select value={settings.theme} onChange={(v) => update('theme', v as 'dark' | 'light')} className="w-48">
                      <SelectOption value="dark">{t('settings.appearance.dark')}</SelectOption>
                      <SelectOption value="light">{t('settings.appearance.light')}</SelectOption>
                    </Select>
                  }
                />
              </SettingSection>

              <SettingSection title={t('settings.appearance.componentMaterial')} icon={<SlidersHorizontal className="h-4 w-4" />}>
                <SettingRow
                  label={t('settings.appearance.componentMaterial')}
                  control={
                    <Select
                      value={settings.componentMaterial ?? 'default'}
                      onChange={(v) => {
                        if (v === 'liquid') {
                          msgConfirm(t('settings.appearance.componentMaterialLiquidConfirmBody'), t('settings.appearance.componentMaterialLiquidConfirmTitle')).then((ok) => {
                            if (ok) update('componentMaterial', v as 'default' | 'frosted' | 'acrylic' | 'aero' | 'liquid')
                          })
                        } else {
                          update('componentMaterial', v as 'default' | 'frosted' | 'acrylic' | 'aero' | 'liquid')
                        }
                      }}
                      className="w-48"
                    >
                      <SelectOption value="default">{t('settings.appearance.componentMaterialDefault')}</SelectOption>
                      <SelectOption value="frosted">{t('settings.appearance.componentMaterialFrosted')}</SelectOption>
                      <SelectOption value="acrylic">{t('settings.appearance.componentMaterialAcrylic')}</SelectOption>
                      <SelectOption value="aero">{t('settings.appearance.componentMaterialAero')}</SelectOption>
                      <SelectOption value="liquid">{t('settings.appearance.componentMaterialLiquidPreview')}</SelectOption>
                    </Select>
                  }
                />
                {settings.componentMaterial === 'liquid' && (
                  <div className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-xs text-amber-600 dark:text-amber-400">
                    <TriangleAlert className="mt-0.5 h-3 w-3 shrink-0" />
                    <span>{t('settings.appearance.componentMaterialLiquidWarning')}</span>
                  </div>
                )}
                {settings.componentMaterial !== 'default' && (
                  <div className="space-y-2 px-4 py-3">
                    <div className="flex items-center gap-3">
                      <input
                        type="range"
                        min={2}
                        max={40}
                        step={1}
                        value={settings.glassBlur ?? 18}
                        onChange={(e) => update('glassBlur', parseInt(e.target.value))}
                        className="flex-1"
                      />
                      <span className="w-12 shrink-0 text-sm tabular-nums text-muted-foreground">{settings.glassBlur ?? 18}px</span>
                    </div>
                    <div className="flex justify-between text-[11px] text-muted-foreground">
                      <span>{t('settings.appearance.glassBlurLow')}</span>
                      <span>{t('settings.appearance.glassBlurHigh')}</span>
                    </div>
                  </div>
                )}
              </SettingSection>

              <SettingSection title={t('settings.appearance.cornerRadius')} icon={<Monitor className="h-4 w-4" />}>
                <SettingRow
                  label={t('settings.appearance.windowCorners')}
                  description={t('settings.appearance.windowCornersDesc')}
                  control={
                    <Switch
                      checked={settings.windowCorners}
                      onCheckedChange={(c) => update('windowCorners', c === true)}
                    />
                  }
                />
                <SettingRow
                  label={t('settings.appearance.cornerRadius')}
                  control={
                    <div className="w-44 space-y-1">
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
                        <span className="w-10 shrink-0 text-right text-sm tabular-nums text-muted-foreground">{settings.cornerRadius}px</span>
                      </div>
                      <div className="flex justify-between text-[11px] text-muted-foreground">
                        <span>{t('settings.appearance.cornerSharp')}</span>
                        <span>{t('settings.appearance.cornerDefault')}</span>
                        <span>{t('settings.appearance.cornerLarge')}</span>
                      </div>
                    </div>
                  }
                />
              </SettingSection>

              <SettingSection title={t('settings.appearance.font')} icon={<Palette className="h-4 w-4" />}>
                <SettingRow
                  label={t('settings.appearance.fontFamily')}
                  description={t('settings.appearance.fontDesc')}
                  control={
                    <Select
                      value={settings.fontFamily || ''}
                      onChange={(v) => update('fontFamily', v || '')}
                      placeholder={t('settings.appearance.fontDefault')}
                      className="w-full max-w-sm"
                    >
                      {fontList.length === 0 ? (
                        <SelectOption value="" disabled>{t('common.loading')}</SelectOption>
                      ) : (
                        fontList.map((f) => (
                          <SelectOption key={f} value={f}>{f}</SelectOption>
                        ))
                      )}
                    </Select>
                  }
                />
                <div className="mx-4 my-3 rounded-lg border px-4 py-3"
                  style={{ fontFamily: settings.fontFamily ? `'${settings.fontFamily.replace(/['"]/g, '')}', sans-serif` : undefined }}
                >
                  <div className="text-sm font-medium">{t('settings.appearance.fontPreviewTitle')}</div>
                  <div className="text-xs text-muted-foreground">{t('settings.appearance.fontPreviewText')}</div>
                </div>
                <div className="flex items-center gap-2 px-4 py-3">
                  {settings.fontFamily && (
                    <Button variant="outline" size="sm" onClick={() => update('fontFamily', '')} className="gap-1">
                      <RotateCw className="h-3 w-3" />
                      {t('settings.appearance.fontReset')}
                    </Button>
                  )}
                </div>
              </SettingSection>

              <SettingSection title={t('settings.appearance.background')} icon={<Palette className="h-4 w-4" />}>
                <div className="space-y-2 px-4 py-3">
                  <div className="flex items-center justify-between">
                    <Label>{t('settings.appearance.backgroundImage')}</Label>
                    <Button variant="ghost" size="sm" onClick={() => get<string[]>('/settings/backgrounds').then(setBackgrounds).catch(() => {})}>
                      <RotateCw className="h-3 w-3" />
                    </Button>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {backgrounds.length === 0 ? (
                      <p className="w-full text-xs text-muted-foreground">{t('settings.appearance.noBackgrounds')}</p>
                    ) : (
                      backgrounds.map((name) => (
                        <button
                          key={name}
                          onClick={() => {
                            const next = { ...settings, backgroundImage: name, backgroundRandom: false }
                            setSettings(next)
                            saveSettings(next)
                            notify(t('settings.saved'), 'success')
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
                      <FolderOpen className="mr-1 h-3 w-3" /> {t('settings.appearance.openFolder')}
                    </Button>
                    <p className="text-xs text-muted-foreground">{t('settings.appearance.backgroundsHint')}</p>
                  </div>
                </div>

                <SettingRow
                  label={t('settings.appearance.backgroundRandom')}
                  description={t('settings.appearance.backgroundRandomDesc')}
                  control={
                    <Switch
                      checked={settings.backgroundRandom}
                      onCheckedChange={(c) => {
                        update('backgroundRandom', c === true)
                        if (c && !settings.backgroundImage) update('backgroundImage', 'random')
                      }}
                    />
                  }
                />

                {settings.backgroundImage && (
                  <div className="px-4 py-3">
                    <>
                      {!settings.backgroundRandom && (
                        <Button variant="ghost" size="sm" onClick={() => update('backgroundImage', '')}>
                          <Trash2 className="mr-1 h-3 w-3" /> {t('settings.appearance.clearBackground')}
                        </Button>
                      )}
                      <div className="grid grid-cols-2 gap-4 pt-1">
                        <div className="space-y-1.5">
                          <div className="flex items-center justify-between">
                            <Label>{t('settings.appearance.opacity')}</Label>
                            <span className="text-xs tabular-nums text-muted-foreground">{settings.bgOverlayOpacity}%</span>
                          </div>
                          <input type="range" min={0} max={100} value={settings.bgOverlayOpacity} onChange={(e) => update('bgOverlayOpacity', parseInt(e.target.value))} className="w-full" />
                          <div className="flex justify-between text-[11px] text-muted-foreground">
                            <span>{t('settings.appearance.transparent')}</span>
                            <span>{t('settings.appearance.opaque')}</span>
                          </div>
                        </div>
                        <div className="space-y-1.5">
                          <div className="flex items-center justify-between">
                            <Label>{t('settings.appearance.blur')}</Label>
                            <span className="text-xs tabular-nums text-muted-foreground">{settings.bgBlur}px</span>
                          </div>
                          <input type="range" min={0} max={20} step={0.5} value={settings.bgBlur} onChange={(e) => update('bgBlur', parseFloat(e.target.value))} className="w-full" />
                          <div className="flex justify-between text-[11px] text-muted-foreground">
                            <span>{t('settings.appearance.sharp')}</span>
                            <span>{t('settings.appearance.blur')}</span>
                          </div>
                        </div>
                      </div>
                    </>
                  </div>
                )}
              </SettingSection>

              <SettingSection title={t('settings.appearance.watermark')} icon={<Palette className="h-4 w-4" />}>
                <SettingRow
                  label={t('settings.appearance.watermarkEnabled')}
                  description={t('settings.appearance.watermarkEnabledDesc')}
                  control={
                    <Switch
                      checked={settings.watermarkEnabled}
                      onCheckedChange={(c) => update('watermarkEnabled', c === true)}
                    />
                  }
                />
                {settings.watermarkEnabled && (
                  <div className="space-y-2 px-4 py-3">
                    <Label htmlFor="watermarkText">{t('settings.appearance.watermarkText')}</Label>
                    <Input id="watermarkText" value={settings.watermarkText} onChange={(e) => update('watermarkText', e.target.value)} placeholder="Qomicex" />
                    <Label htmlFor="watermarkSubtext">{t('settings.appearance.watermarkSubtext')}</Label>
                    <Input id="watermarkSubtext" value={settings.watermarkSubtext} onChange={(e) => update('watermarkSubtext', e.target.value)} placeholder={t('settings.appearance.watermarkSubtextPlaceholder')} />
                  </div>
                )}
              </SettingSection>
            </div>
          </TabContent>

          <TabContent activeTab={category} tabId="toolbox"><ToolboxTab /></TabContent>
          <TabContent activeTab={category} tabId="plugins"><PluginStoreTab /></TabContent>
          <TabContent activeTab={category} tabId="about"><AboutTab sysInfo={sysInfo} licenseStatus={licenseStatus} onOpenLicenseDialog={() => setLicenseDialogOpen(true)} /></TabContent>
          <TabContent activeTab={category} tabId="logs"><LogTab /></TabContent>
          <TabContent activeTab={category} tabId="debug"><DebugTab /></TabContent>

          <Dialog open={addDialogOpen} onClose={() => setAddDialogOpen(false)}>
            <DialogHeader onClose={() => setAddDialogOpen(false)}>
              <DialogTitle>{t('settings.java.manualAddTitle')}</DialogTitle>
            </DialogHeader>
            <DialogBody className="space-y-3">
              <div className="space-y-1.5">
                <Label>{t('settings.java.executablePath')}</Label>
                <div className="flex gap-2">
                  <Input value={addPath} onChange={(e) => setAddPath(e.target.value)} placeholder={navigator.platform?.includes('Win') ? 'C:\\Program Files\\Java\\jdk-17\\bin\\java.exe' : '/usr/lib/jvm/java-17-openjdk/bin/java'} className="flex-1" />
                  <Button variant="outline" onClick={handleBrowseJava}>{t('settings.java.browse')}</Button>
                </div>
                <p className="text-xs text-muted-foreground">{t('settings.java.executablePathDesc')}</p>
              </div>
            </DialogBody>
            <DialogFooter>
              <Button variant="ghost" onClick={() => setAddDialogOpen(false)}>{t('common.cancel')}</Button>
              <Button onClick={confirmAddJava} disabled={!addPath || adding}>
                {adding ? t('settings.java.verifying') : t('settings.java.add')}
              </Button>
            </DialogFooter>
          </Dialog>

          <Dialog open={downloadDialogOpen} onClose={() => setDownloadDialogOpen(false)}>
            <DialogHeader onClose={() => setDownloadDialogOpen(false)}>
              <DialogTitle>{t('settings.java.downloadJava')}</DialogTitle>
            </DialogHeader>
            <DialogBody className="space-y-4">
              <div className="space-y-2">
                <Label>{t('settings.java.distribution')}</Label>
                <Select value={downloadVendor} onChange={setDownloadVendor} placeholder={t('common.select')}>
                  {downloadVendors.map((vendor) => (
                    <SelectOption key={vendor.id} value={vendor.id}>
                      {vendor.name}{vendor.isRecommended ? ` ${t('settings.java.recommended')}` : ''}
                    </SelectOption>
                  ))}
                </Select>
              </div>
              <div className="space-y-2">
                <Label>{t('settings.java.mainVersion')}</Label>
                <Select value={downloadVersion} onChange={setDownloadVersion} placeholder={t('common.select')}>
                  {(selectedVendor?.versions ?? []).map((version) => (
                    <SelectOption key={version} value={String(version)}>{version}</SelectOption>
                  ))}
                </Select>
              </div>
              <div className="space-y-2">
                <Label>{t('settings.java.platform')}</Label>
                <Select value={downloadPlatform} onChange={setDownloadPlatform} placeholder={t('common.select')}>
                  {(selectedVendor?.platforms ?? []).map((platform) => (
                    <SelectOption key={platform} value={platform}>{platform}</SelectOption>
                  ))}
                </Select>
              </div>
              <div className="space-y-2">
                <Label>{t('settings.java.architecture')}</Label>
                <Select value={downloadArch} onChange={setDownloadArch} placeholder={t('common.select')}>
                  {(selectedVendor?.architectures ?? []).map((arch) => (
                    <SelectOption key={arch} value={arch}>{arch}</SelectOption>
                  ))}
                </Select>
              </div>
              <div className="space-y-2">
                <Label>{t('settings.java.targetDir')}</Label>
                <Input value="QML/Runtime/Java" disabled />
              </div>
            </DialogBody>
            <DialogFooter>
              <Button onClick={handleStartJavaDownload} disabled={!selectedVendor || startDownloadLoading}>
                {startDownloadLoading ? <><Loader2 className="h-4 w-4 animate-spin mr-2" />{t('settings.java.resolving')}</> : t('settings.java.startDownload')}
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
        </div>
      </div>
    </PageShell>
  )
}







