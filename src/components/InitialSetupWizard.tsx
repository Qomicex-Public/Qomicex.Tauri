import { useEffect, useMemo, useState, useCallback } from 'react'
import { Button } from './ui'
import { Input } from './ui'
import { Label } from './ui'
import { Select, SelectOption } from './ui'
import { useI18n } from '../i18n/index.tsx'
import { LANGS } from '../i18n/lang.ts'
import type { LangChoice } from '../i18n/lang.ts'
import { cn } from '../lib/utils.ts'
import { saveSettings, setDataDir, pingDownloadSources, pingModSources } from '../api/settings.ts'
import type { AppSettings, DownloadSourcePing, ModSourcePing } from '../api/settings.ts'
import { scanRuntimes, getRuntimes, refreshCustomRuntimes } from '../stores/javaStore.ts'
import type { JavaRuntime } from '../types/index.ts'
import { getJavaDownloadCatalog, startJavaDownload, getJavaDownloadProgress } from '../api/java.ts'
import { getSystemInfo } from '../api/system.ts'
import type { SystemInfo } from '../types/index.ts'

/** 向导必需的三档 Java 主版本 */
const REQUIRED_JAVA_VERSIONS = [8, 17, 21]

function detectPlatform(): string {
  const ua = navigator.userAgent
  if (/Windows/i.test(ua)) return 'windows'
  if (/Mac|iPhone|iPad/i.test(ua)) return 'macos'
  return 'linux'
}

function detectArch(): string {
  const ua = navigator.userAgent
  if (/arm64|aarch64/i.test(ua)) return 'arm64'
  return 'x64'
}

interface JavaDownloadState {
  taskId: string
  status: string
  progress: number
}

interface InitialSetupWizardProps {
  /** 向导是否可见（首次启动且未完成初始化时由 App 打开） */
  open: boolean
  /** 当前设置快照（含默认值） */
  settings: AppSettings
  /** 向导完成并保存成功后回调（App 由此进入主界面） */
  onComplete: () => void
}

export function InitialSetupWizard({ open, settings, onComplete }: InitialSetupWizardProps) {
  const { t, setLanguage } = useI18n()
  const [mode, setMode] = useState<'quick' | 'custom' | null>(null)
  const [step, setStep] = useState(0)
  const [lang, setLang] = useState<LangChoice>((settings.language === 'en' ? 'en-US' : settings.language) as LangChoice)
  const [theme, setTheme] = useState<'dark' | 'light'>(settings.theme === 'light' ? 'light' : 'dark')
  const [dataDir, setDataDirState] = useState(settings.dataDir || '')
  const [gameDir, setGameDir] = useState(settings.gameDir || '.minecraft')
  const [downloadSource, setDownloadSource] = useState(settings.downloadSource)
  const [modMirror, setModMirror] = useState(settings.modMirror)
  const [memoryMode, setMemoryMode] = useState<'auto' | 'custom'>(settings.memoryMode || 'auto')
  const [defaultMaxMemory, setDefaultMaxMemory] = useState(settings.defaultMaxMemory)
  const [javaRuntimes, setJavaRuntimes] = useState<JavaRuntime[]>(() => getRuntimes())
  const [javaScanning, setJavaScanning] = useState(false)
  const [javaDownloads, setJavaDownloads] = useState<Record<number, JavaDownloadState>>({})
  const [sourcePings, setSourcePings] = useState<DownloadSourcePing[]>([])
  const [modPings, setModPings] = useState<ModSourcePing[]>([])
  const [pingLoading, setPingLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState('')
  const [sysInfo, setSysInfo] = useState<SystemInfo | null>(null)

  // 步骤序列：quick 6 步（模式/语言/主题/Java/内存/完成），custom 9 步
  const stepCount = mode === 'custom' ? 9 : 6

  const isJavaStep = mode === 'quick' ? step === 3 : step === 6
  const isDownloadStep = mode === 'custom' && step === 5
  const isDoneStep = step === stepCount - 1

  // 主题即时生效（与 App.tsx setTheme 保持一致）
  useEffect(() => {
    if (!open) return
    document.documentElement.classList.toggle('dark', theme === 'dark')
    document.documentElement.classList.toggle('light', theme === 'light')
    localStorage.setItem('qomicex-theme', theme)
  }, [theme, open])

  // Java 步骤：深度扫描
  useEffect(() => {
    if (!open || !isJavaStep) return
    let cancelled = false
    setJavaScanning(true)
    scanRuntimes('deep')
      .then((list) => {
        if (!cancelled) setJavaRuntimes([...list])
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setJavaScanning(false)
      })
    return () => { cancelled = true }
  }, [open, isJavaStep])

  function rescanJava() {
    setJavaRuntimes([])
    setJavaScanning(true)
    scanRuntimes('deep')
      .then((list) => setJavaRuntimes([...list]))
      .catch(() => {})
      .finally(() => setJavaScanning(false))
  }

  // 下载源步骤：测速
  useEffect(() => {
    if (!open || !isDownloadStep) return
    let cancelled = false
    setPingLoading(true)
    Promise.all([pingDownloadSources(), pingModSources()])
      .then(([src, mod]) => {
        if (cancelled) return
        setSourcePings(src)
        setModPings(mod)
        const bestSrc = src.filter((p) => p.ok).sort((a, b) => a.latency - b.latency)[0]
        const bestMod = mod.filter((p) => p.ok).sort((a, b) => a.latency - b.latency)[0]
        if (bestSrc) setDownloadSource(bestSrc.id)
        if (bestMod) setModMirror(bestMod.id)
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setPingLoading(false)
      })
    return () => { cancelled = true }
  }, [open, isDownloadStep])

  // 系统信息：内存步骤的滑块上界与占用条
  useEffect(() => {
    if (!open) return
    let cancelled = false
    getSystemInfo()
      .then((info) => {
        if (!cancelled) setSysInfo(info)
      })
      .catch(() => {})
    return () => { cancelled = true }
  }, [open])

  // auto 内存模式：同步为系统可用内存的 70%（与设置页一致）
  useEffect(() => {
    if (!open || memoryMode !== 'auto' || !sysInfo) return
    const autoVal = Math.max(512, Math.floor(sysInfo.availableMemory * 0.7))
    setDefaultMaxMemory((cur) => (cur === autoVal ? cur : autoVal))
  }, [open, memoryMode, sysInfo])

  const byVersion = useCallback(
    (v: number) => javaRuntimes.find((r) => (r.majorVersion ?? r.versionID) === v && r.state === 'Valid'),
    [javaRuntimes]
  )
  const javaReady = useMemo(
    () => REQUIRED_JAVA_VERSIONS.every((v) => !!byVersion(v)),
    [byVersion]
  )

  const applyTheme = useCallback((next: 'dark' | 'light') => {
    setTheme(next)
  }, [])

  function pickFolder(): Promise<string | null> {
    return import('@tauri-apps/plugin-dialog').then(({ open }) =>
      open({ directory: true, multiple: false })
    )
  }

  async function handlePickDataDir() {
    try {
      const result = await pickFolder()
      if (result) setDataDirState(result)
    } catch { /* 非 Tauri 环境忽略 */ }
  }

  async function handlePickGameDir() {
    try {
      const result = await pickFolder()
      if (result) setGameDir(result)
    } catch { /* 非 Tauri 环境忽略 */ }
  }

  function canNext(): boolean {
    if (step === 1) return !!mode
    if (isJavaStep) return javaReady && !javaScanning
    return true
  }

  function handleNext() {
    if (isJavaStep && !javaReady) return
    setSaveError('')
    setStep((s) => Math.min(stepCount - 1, s + 1))
  }

  function handleBack() {
    setSaveError('')
    setStep((s) => Math.max(0, s - 1))
  }

  async function downloadJava(version: number) {
    if (javaDownloads[version]?.status === 'downloading' || javaDownloads[version]?.status === 'queued') return
    try {
      const catalog = await getJavaDownloadCatalog()
      const vendor = catalog.vendors.find((v) => v.versions.includes(version)) ?? catalog.vendors[0]
      if (!vendor) return
      const res = await startJavaDownload({
        vendor: vendor.id,
        version,
        platform: detectPlatform(),
        architecture: detectArch(),
      })
      setJavaDownloads((d) => ({ ...d, [version]: { taskId: res.taskId, status: 'queued', progress: 0 } }))
      void pollJavaDownload(res.taskId, version)
    } catch { /* 下载启动失败，保持未下载状态 */ }
  }

  async function pollJavaDownload(taskId: string, version: number) {
    for (;;) {
      await new Promise((r) => setTimeout(r, 1200))
      try {
        const p = await getJavaDownloadProgress(taskId)
        if (!p) {
          setJavaDownloads((d) => ({ ...d, [version]: { taskId, status: 'failed', progress: 0 } }))
          return
        }
        setJavaDownloads((d) => ({ ...d, [version]: { taskId, status: p.status, progress: p.progress } }))
        if (p.status === 'completed') {
          await refreshCustomRuntimes()
          setJavaRuntimes([...getRuntimes()])
          return
        }
        if (p.status === 'failed' || p.status === 'cancelled') return
      } catch {
        setJavaDownloads((d) => ({ ...d, [version]: { taskId, status: 'failed', progress: 0 } }))
        return
      }
    }
  }

  async function handleFinish() {
    setSaving(true)
    setSaveError('')
    try {
      const next: AppSettings = {
        ...settings,
        language: lang,
        theme,
        memoryMode,
        defaultMaxMemory,
        initialized: true,
      }
      if (mode === 'custom') {
        next.gameDir = gameDir
        next.downloadSource = downloadSource
        next.modMirror = modMirror
        if (dataDir && dataDir !== settings.dataDir) {
          const normalized = dataDir.replace(/\\/g, '/')
          try {
            const result = await setDataDir(normalized)
            next.dataDir = result
          } catch { /* 数据目录写入失败时保留原值 */ }
        }
      }
      await saveSettings(next)
      onComplete()
    } catch {
      setSaveError(t('wizard.saveFailed'))
    } finally {
      setSaving(false)
    }
  }

  if (!open) return null

  const stepTitle =
    step === 0
      ? t('wizard.languageTitle')
      : step === 1
        ? t('wizard.modeTitle')
        : step === 2
          ? t('wizard.themeTitle')
          : step === 3 && mode === 'custom'
            ? t('wizard.dirTitle')
            : step === 3 && mode === 'quick'
              ? t('wizard.javaTitle')
              : step === 4 && mode === 'custom'
                ? t('wizard.dirTitle')
                : step === 5 && mode === 'custom'
                  ? t('wizard.downloadTitle')
                  : step === 6 && mode === 'custom'
                    ? t('wizard.javaTitle')
                    : step === 7 && mode === 'custom'
                      ? t('wizard.memoryTitle')
                      : step === 4 && mode === 'quick'
                        ? t('wizard.memoryTitle')
                        : t('wizard.doneTitle')

  const stepDesc =
    step === 0
      ? t('wizard.languageDesc')
      : step === 1
        ? t('wizard.modeDesc')
        : step === 2
          ? t('wizard.themeDesc')
          : step === 3 && mode === 'custom'
            ? t('wizard.dirDesc')
            : step === 3 && mode === 'quick'
              ? t('wizard.javaDesc')
              : step === 4 && mode === 'custom'
                ? t('wizard.dirDesc')
                : step === 5 && mode === 'custom'
                  ? t('wizard.downloadDesc')
                  : step === 6 && mode === 'custom'
                    ? t('wizard.javaDesc')
                    : step === 7 && mode === 'custom'
                      ? t('wizard.memoryDesc')
                      : step === 4 && mode === 'quick'
                        ? t('wizard.memoryDesc')
                        : t('wizard.doneDesc')

  return (
    <div
      data-tauri-drag-region
      className="fixed inset-0 z-[9998] flex flex-col bg-background cursor-default select-none overflow-hidden"
    >
      {/* 顶部品牌栏 */}
      <div className="flex items-center gap-3 px-8 pt-6">
        <img src="/logo.svg" alt="Qomicex" className="h-10 w-10" />
        <div className="flex flex-col">
          <span className="text-base font-semibold">{t('wizard.title')}</span>
          <span className="text-xs text-muted-foreground">{t('wizard.subtitle')}</span>
        </div>
      </div>

      {/* 步骤进度 */}
      <div className="px-8 pt-4">
        <div className="flex items-center gap-1">
          {Array.from({ length: stepCount }, (_, i) => (
            <div
              key={i}
              className={cn(
                'h-1 flex-1 rounded-full transition-colors',
                i <= step ? 'bg-primary' : 'bg-muted'
              )}
            />
          ))}
        </div>
        <div className="mt-2 text-xs text-muted-foreground">
          {t('wizard.stepLabel', { current: String(step + 1), total: String(stepCount) })}
        </div>
      </div>

      {/* 内容区 */}
      <div className="flex flex-1 min-h-0 items-center justify-center px-8 py-6">
        <div className="w-full max-w-lg space-y-5 animate-in slide-up">
          <div>
            <h2 className="text-xl font-semibold">{stepTitle}</h2>
            <p className="mt-1 text-sm text-muted-foreground">{stepDesc}</p>
          </div>

          {/* 步骤 0：语言 */}
          {step === 0 && (
            <div className="space-y-2">
              <Label>{t('settings.appearance.language')}</Label>
              <Select
                value={lang}
                onChange={(v) => {
                  const next = v as LangChoice
                  setLang(next)
                  setLanguage(next)
                }}
                className="w-48"
              >
                {LANGS.map((l) => (
                  <SelectOption key={l.value} value={l.value}>{l.label}</SelectOption>
                ))}
                <SelectOption value="system">{t('settings.appearance.followSystem')}</SelectOption>
              </Select>
            </div>
          )}

          {/* 步骤 1：模式选择 */}
          {step === 1 && (
            <div className="grid grid-cols-2 gap-3">
              <button
                type="button"
                onClick={() => { setMode('quick'); setStep(2) }}
                className={cn(
                  'rounded-xl border p-5 text-left transition-colors hover:border-primary hover:bg-accent/50',
                  mode === 'quick' && 'border-primary bg-primary/5'
                )}
              >
                <div className="text-base font-semibold">{t('wizard.quickTitle')}</div>
                <div className="mt-1 text-xs text-muted-foreground leading-relaxed">{t('wizard.quickDesc')}</div>
              </button>
              <button
                type="button"
                onClick={() => { setMode('custom'); setStep(2) }}
                className={cn(
                  'rounded-xl border p-5 text-left transition-colors hover:border-primary hover:bg-accent/50',
                  mode === 'custom' && 'border-primary bg-primary/5'
                )}
              >
                <div className="text-base font-semibold">{t('wizard.customTitle')}</div>
                <div className="mt-1 text-xs text-muted-foreground leading-relaxed">{t('wizard.customDesc')}</div>
              </button>
            </div>
          )}

          {/* 步骤 2：主题 */}
          {step === 2 && (
            <div className="grid grid-cols-2 gap-3">
              {(['dark', 'light'] as const).map((t2) => (
                <button
                  key={t2}
                  type="button"
                  onClick={() => applyTheme(t2)}
                  className={cn(
                    'rounded-xl border p-4 text-left transition-colors hover:border-primary',
                    theme === t2 ? 'border-primary bg-primary/5' : 'hover:bg-accent/50'
                  )}
                >
                  <div className="flex items-center gap-2">
                    <span
                      className={cn(
                        'h-4 w-4 rounded-full border',
                        theme === t2 && 'border-primary bg-primary ring-2 ring-primary/30'
                      )}
                    />
                    <span className="text-sm font-medium">{t(t2 === 'dark' ? 'wizard.dark' : 'wizard.light')}</span>
                  </div>
                </button>
              ))}
            </div>
          )}

          {/* 步骤 3（自定义）：数据目录 */}
          {mode === 'custom' && step === 3 && (
            <div className="space-y-3">
              <div className="space-y-2">
                <Label>{t('wizard.dataDir')}</Label>
                <div className="flex items-center gap-2">
                  <Input
                    value={dataDir}
                    onChange={(e) => setDataDirState(e.target.value)}
                    placeholder="%LocalAppData%/qomicex-launcher"
                    className="font-mono text-xs"
                  />
                  <Button variant="outline" size="icon" className="h-9 w-9 shrink-0" onClick={handlePickDataDir}>
                    <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>
                  </Button>
                </div>
                <p className="text-xs text-muted-foreground">{t('wizard.dataDirDesc')}</p>
              </div>
            </div>
          )}

          {/* 步骤 4（自定义）：游戏目录 */}
          {mode === 'custom' && step === 4 && (
            <div className="space-y-3">
              <div className="space-y-2">
                <Label>{t('wizard.gameDir')}</Label>
                <div className="flex items-center gap-2">
                  <Input
                    value={gameDir}
                    onChange={(e) => setGameDir(e.target.value)}
                    placeholder=".minecraft"
                    className="font-mono text-xs"
                  />
                  <Button variant="outline" size="icon" className="h-9 w-9 shrink-0" onClick={handlePickGameDir}>
                    <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>
                  </Button>
                </div>
                <p className="text-xs text-muted-foreground">{t('wizard.gameDirDesc')}</p>
              </div>
            </div>
          )}

          {/* 步骤 5（自定义）：下载源 */}
          {mode === 'custom' && step === 5 && (
            <div className="space-y-4">
              <div className="space-y-2">
                <Label>{t('wizard.downloadSource')}</Label>
                {pingLoading ? (
                  <p className="text-xs text-muted-foreground">{t('wizard.pinging')}...</p>
                ) : (
                  <div className="space-y-1.5">
                    {sourcePings.map((p) => (
                      <button
                        key={p.id}
                        type="button"
                        onClick={() => setDownloadSource(p.id)}
                        className={cn(
                          'flex w-full items-center justify-between rounded-lg border px-3 py-2 text-sm transition-colors',
                          downloadSource === p.id ? 'border-primary bg-primary/5' : 'hover:bg-accent/50'
                        )}
                      >
                        <span>{p.name}</span>
                        <span className={cn('text-xs', p.ok ? 'text-muted-foreground' : 'text-destructive')}>
                          {p.ok ? `${p.latency} ms` : t('wizard.pingFailed')}
                        </span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
              <div className="space-y-2">
                <Label>{t('wizard.modSource')}</Label>
                {pingLoading ? (
                  <p className="text-xs text-muted-foreground">{t('wizard.pinging')}...</p>
                ) : (
                  <div className="space-y-1.5">
                    {modPings.map((p) => (
                      <button
                        key={p.id}
                        type="button"
                        onClick={() => setModMirror(p.id)}
                        className={cn(
                          'flex w-full items-center justify-between rounded-lg border px-3 py-2 text-sm transition-colors',
                          modMirror === p.id ? 'border-primary bg-primary/5' : 'hover:bg-accent/50'
                        )}
                      >
                        <span>{p.name}</span>
                        <span className={cn('text-xs', p.ok ? 'text-muted-foreground' : 'text-destructive')}>
                          {p.ok ? `${p.latency} ms` : t('wizard.pingFailed')}
                        </span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Java 步骤 */}
          {isJavaStep && (
            <div className="space-y-3">
              {javaScanning ? (
                <div className="flex items-center gap-3 rounded-lg border px-4 py-3 text-sm text-muted-foreground">
                  <svg className="h-4 w-4 animate-spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg>
                  {t('wizard.javaScanning')}
                </div>
              ) : (
                <div className="space-y-2">
                  {REQUIRED_JAVA_VERSIONS.map((v) => {
                    const found = byVersion(v)
                    const dl = javaDownloads[v]
                    return (
                      <div key={v} className="flex items-center gap-3 rounded-lg border px-4 py-3">
                        <div className="flex-1 min-w-0">
                          <div className="text-sm font-medium">{t(`wizard.javaVersion${v}`)}</div>
                          <div className="truncate text-xs text-muted-foreground font-mono">
                            {found ? found.path : dl ? dl.status : t('wizard.javaMissing')}
                          </div>
                        </div>
                        {found ? (
                          <span className="flex items-center gap-1 rounded-full bg-primary/10 px-2.5 py-1 text-xs text-primary">
                            <svg className="h-3 w-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M20 6L9 17l-5-5"/></svg>
                            {t('wizard.javaFound')}
                          </span>
                        ) : dl && (dl.status === 'downloading' || dl.status === 'queued') ? (
                          <div className="flex items-center gap-2">
                            <div className="h-1.5 w-24 overflow-hidden rounded-full bg-muted">
                              <div className="h-full rounded-full bg-primary transition-all" style={{ width: `${Math.max(0, Math.min(100, dl.progress))}%` }} />
                            </div>
                            <span className="text-xs text-muted-foreground">{t('wizard.javaDownloading', { progress: String(Math.round(dl.progress)) })}</span>
                          </div>
                        ) : dl && dl.status === 'completed' ? (
                          <span className="flex items-center gap-1 rounded-full bg-primary/10 px-2.5 py-1 text-xs text-primary">
                            <svg className="h-3 w-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M20 6L9 17l-5-5"/></svg>
                            {t('wizard.javaDownloaded')}
                          </span>
                        ) : (
                          <Button size="sm" variant="outline" onClick={() => downloadJava(v)} className="gap-1">
                            <svg className="h-3 w-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="M7 10l5 5 5-5"/><path d="M12 15V3"/></svg>
                            {t('wizard.javaDownload')}
                          </Button>
                        )}
                      </div>
                    )
                  })}
                </div>
              )}
              {!javaScanning && (
                <div className="flex items-center justify-between">
                  <span className={cn('text-xs', javaReady ? 'text-primary' : 'text-muted-foreground')}>
                    {javaReady ? t('wizard.javaReady') : t('wizard.javaRequired')}
                  </span>
                  <Button size="sm" variant="ghost" onClick={rescanJava}>
                    {t('wizard.javaScanAgain')}
                  </Button>
                </div>
              )}
            </div>
          )}

          {/* 内存步骤 */}
          {(mode === 'quick' ? step === 4 : step === 7) && !isDoneStep && (
            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-3">
                <button
                  type="button"
                  onClick={() => setMemoryMode('auto')}
                  className={cn(
                    'rounded-xl border p-4 text-left transition-colors hover:border-primary',
                    memoryMode === 'auto' ? 'border-primary bg-primary/5' : 'hover:bg-accent/50'
                  )}
                >
                  <div className="text-sm font-medium">{t('wizard.memoryAuto')}</div>
                  <div className="mt-1 text-xs text-muted-foreground leading-relaxed">{t('wizard.memoryAutoDesc')}</div>
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setMemoryMode('custom')
                    // 对齐到 step=256 网格，保证滑块与输入框初始数值一致
                    setDefaultMaxMemory((cur) => Math.max(512, Math.round(cur / 256) * 256))
                  }}
                  className={cn(
                    'rounded-xl border p-4 text-left transition-colors hover:border-primary',
                    memoryMode === 'custom' ? 'border-primary bg-primary/5' : 'hover:bg-accent/50'
                  )}
                >
                  <div className="text-sm font-medium">{t('wizard.memoryCustom')}</div>
                  <div className="mt-1 text-xs text-muted-foreground leading-relaxed">{t('wizard.memoryCustomDesc')}</div>
                </button>
              </div>
              {memoryMode === 'custom' && (
                <div className="space-y-3">
                  {/* 滑块 + 输入框（数值双向同步；上界=总内存，允许分配超过可用内存） */}
                  <div className="flex items-center gap-3">
                    <input
                      type="range"
                      min={512}
                      max={sysInfo ? Math.max(512, Math.floor(sysInfo.memory)) : 16384}
                      step={256}
                      value={defaultMaxMemory}
                      onChange={(e) => setDefaultMaxMemory(parseInt(e.target.value) || 4096)}
                      className="flex-1"
                    />
                    <Input
                      type="number"
                      min={512}
                      max={sysInfo ? Math.max(512, Math.floor(sysInfo.memory)) : 16384}
                      step={256}
                      value={defaultMaxMemory}
                      onChange={(e) => setDefaultMaxMemory(parseInt(e.target.value) || 4096)}
                      className="w-24 text-center tabular-nums"
                    />
                    <span className="w-24 shrink-0 text-right text-sm tabular-nums text-muted-foreground">
                      {defaultMaxMemory >= 1024 ? `${(defaultMaxMemory / 1024).toFixed(1)} GiB` : `${defaultMaxMemory} MiB`}
                    </span>
                  </div>
                  {/* 内存占用进度条（与设置页一致） */}
                  {sysInfo && (() => {
                    const totalMb = sysInfo.memory
                    const availMb = sysInfo.availableMemory
                    const usedMb = Math.max(0, totalMb - availMb)
                    const gameMb = Math.min(defaultMaxMemory, availMb)
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
                </div>
              )}
              {memoryMode === 'auto' && (
                <div className="rounded-lg bg-muted px-4 py-3 text-xs text-muted-foreground">
                  {sysInfo
                    ? `${t('wizard.memoryAutoDesc')}：${Math.max(512, Math.floor(sysInfo.availableMemory * 0.7))} ${t('wizard.memoryMb')}`
                    : t('common.loading')}
                </div>
              )}
            </div>
          )}

          {/* 完成步骤 */}
          {isDoneStep && (
            <div className="space-y-4">
              <div className="flex items-center gap-3 rounded-xl border border-primary/20 bg-primary/5 px-4 py-3">
                <svg className="h-6 w-6 shrink-0 text-primary" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><path d="M22 4L12 14.01l-3-3"/></svg>
                <div>
                  <div className="text-sm font-medium">{t('wizard.doneTitle')}</div>
                  <div className="text-xs text-muted-foreground">{t('wizard.doneDesc')}</div>
                </div>
              </div>
              <div className="rounded-lg border px-4 py-3 text-sm space-y-1.5">
                <div className="flex justify-between"><span className="text-muted-foreground">{t('wizard.stepLanguage')}</span><span>{lang === 'system' ? t('settings.appearance.followSystem') : LANGS.find((l) => l.value === lang)?.label ?? lang}</span></div>
                <div className="flex justify-between"><span className="text-muted-foreground">{t('wizard.stepTheme')}</span><span>{t(theme === 'dark' ? 'wizard.dark' : 'wizard.light')}</span></div>
                <div className="flex justify-between"><span className="text-muted-foreground">{t('wizard.stepJava')}</span><span>{REQUIRED_JAVA_VERSIONS.filter((v) => byVersion(v)).length}/{REQUIRED_JAVA_VERSIONS.length}</span></div>
                <div className="flex justify-between"><span className="text-muted-foreground">{t('wizard.stepMemory')}</span><span>{memoryMode === 'auto' ? t('wizard.memoryAuto') : `${defaultMaxMemory} ${t('wizard.memoryMb')}`}</span></div>
                {mode === 'custom' && (
                  <>
                    <div className="flex justify-between gap-4"><span className="shrink-0 text-muted-foreground">{t('wizard.stepDirectories')}</span><span className="truncate text-right font-mono text-xs">{dataDir || t('wizard.default')}</span></div>
                    <div className="flex justify-between gap-4"><span className="shrink-0 text-muted-foreground">{t('wizard.stepDownloadSource')}</span><span className="truncate text-right font-mono text-xs">{sourcePings.find((p) => p.id === downloadSource)?.name || downloadSource}</span></div>
                  </>
                )}
              </div>
              {saveError && (
                <p className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">{saveError}</p>
              )}
            </div>
          )}
        </div>
      </div>

      {/* 底部操作栏 */}
      <div className="flex items-center justify-between px-8 pb-6">
        <Button variant="ghost" onClick={handleBack} disabled={step === 0 || saving} className="gap-1">
          <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M19 12H5"/><path d="M12 19l-7-7 7-7"/></svg>
          {t('common.back')}
        </Button>
        {isDoneStep ? (
          <Button onClick={handleFinish} disabled={saving} className="gap-1.5 min-w-28">
            {saving && <svg className="h-3.5 w-3.5 animate-spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg>}
            {saving ? t('wizard.saving') : t('wizard.finish')}
          </Button>
        ) : (
          <Button onClick={handleNext} disabled={!canNext()} className="gap-1 min-w-24">
            {t('common.next')}
            <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M5 12h14"/><path d="M12 5l7 7-7 7"/></svg>
          </Button>
        )}
      </div>
    </div>
  )
}
