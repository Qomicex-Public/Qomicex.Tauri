import { useEffect, useState, useRef } from 'react'
import type { ReactNode } from 'react'
import { BrowserRouter, Routes, Route } from 'react-router-dom'
import Layout from './components/Layout.tsx'
import Dashboard from './pages/Dashboard.tsx'
import Instances from './pages/Instances.tsx'
import InstanceDetailPage from './pages/InstanceDetail.tsx'
import DownloadCenter from './pages/DownloadCenter.tsx'
import Accounts from './pages/Accounts.tsx'
import AccountDetail from './pages/AccountDetail.tsx'
import ResourceCenter from './pages/ResourceCenter.tsx'
import ResourceDetailPage from './pages/ResourceDetail.tsx'
import Connect from './pages/Connect.tsx'
import Settings from './pages/Settings.tsx'
import RunningInstances from './pages/RunningInstances.tsx'
import PluginPage from './pages/PluginPage.tsx'
import PluginWebviewPage from './pages/PluginWebviewPage.tsx'
import LogAnalysis from './pages/LogAnalysis.tsx'
import GameLogWindow from './pages/GameLogWindow.tsx'
import PluginOverlayManager from './components/PluginOverlayManager.tsx'
import { MessageBoxProvider, useMessageBox } from './components/ui'
import TaskCompletionNotifier from './components/TaskCompletionNotifier.tsx'
import useCloseGuard from './hooks/useCloseGuard.ts'
import ErrorBoundary from './components/ErrorBoundary.tsx'
import { loadSettings, onSettingsChange, getSettings, isSettingsLoaded, DEFAULT_SETTINGS, type AppSettings } from './api/settings.ts'
import { reportFrontendLog } from './api/logs.ts'
import { pushConsole } from './lib/error-report.ts'
import { I18nProvider, useI18n } from './i18n/index.tsx'
import { RunningProvider, useRunning } from './contexts/RunningContext.tsx'
import LaunchProgressDialog from './components/LaunchProgressDialog.tsx'
import { CrashAnalysisDialog } from './components/CrashAnalysisDialog.tsx'
import UpdateDialog from './components/UpdateDialog.tsx'
import { get } from './api/client.ts'
import { initApiTransport, isIpcMode } from './api/ipc.ts'
import { check } from '@tauri-apps/plugin-updater'
import type { Update } from '@tauri-apps/plugin-updater'
import { checkRequired } from './api/update.ts'
import { applyThemeColor } from './lib/themeColor.ts'
import { restoreSavedTheme } from './theme/index.ts'

import { loadCustomRuntimes, scanRuntimes, getRuntimes, hasAnyRuntimes } from './stores/javaStore.ts'
import { SplashScreen } from './components/SplashScreen.tsx'
import { InitialSetupWizard } from './components/InitialSetupWizard.tsx'
import { usePluginStore, collectInstalledPlugins, buildUpdatesMap } from './stores/pluginStore.ts'
import { activatePlugin, deactivatePlugin, sortByDependencies } from './plugins/plugin-loader.tsx'
import { checkStoreUpdates } from './api/pluginStore.ts'
import './plugins/plugin-registry.ts'
import type { PluginState } from './plugins/types.ts'

/** 独立日志窗口模式：`?logWindow=1&instance=<id>`（由「测试游戏」打开的 Tauri 子窗口）。 */
const LOG_WINDOW_INSTANCE: string | null =
  typeof window !== 'undefined'
    ? (() => {
        const p = new URLSearchParams(window.location.search)
        return p.get('logWindow') === '1' ? p.get('instance') || '' : null
      })()
    : null

/** l4 插件独立窗口模式：`?pluginWebview=1&pluginId=<id>`（由 createRemoteWebview 打开）。 */
const PLUGIN_WEBVIEW_PLUGIN_ID: string | null =
  typeof window !== 'undefined'
    ? (() => {
        const p = new URLSearchParams(window.location.search)
        return p.get('pluginWebview') === '1' ? p.get('pluginId') || '' : null
      })()
    : null

function OverlayStoreBridge() {
  const { createOverlay, showOverlay, hideOverlay, destroyOverlay, setOverlayHtml, setOverlayPosition, setOverlaySize } = usePluginStore()
  useEffect(() => {
    (window as any).__pluginOverlayStore = { createOverlay, showOverlay, hideOverlay, destroyOverlay, setOverlayHtml, setOverlayPosition, setOverlaySize }
  }, [createOverlay, showOverlay, hideOverlay, destroyOverlay, setOverlayHtml, setOverlayPosition, setOverlaySize])
  return null
}

function RunningNotifyBridge() {
  const { notify } = useMessageBox()
  const { setNotifyImpl } = useRunning()
  useEffect(() => { setNotifyImpl(notify) }, [notify, setNotifyImpl])
  return null
}

function AppContent() {
  const [backendState, setBackendState] = useState<'loading' | 'ready' | 'error'>('loading')
  const { closeWithGuard, Provider } = useCloseGuard()
  const { alert } = useMessageBox()
  const { t } = useI18n()
  const { crashDialogState, clearCrashDialog } = useRunning()
  const javaChecked = useRef(false)
  const [pendingUpdate, setPendingUpdate] = useState<Update | null>(null)
  const [pendingUpdateRequired, setPendingUpdateRequired] = useState(false)
  const autoCheckDone = useRef(false)
  /** 插件更新静默轮询只做一次（与 autoCheckDone/javaChecked 同模式） */
  const pluginUpdatesChecked = useRef(false)
  const { loadPlugins } = usePluginStore()
  const [showWizard, setShowWizard] = useState(false)
  const [settingsReady, setSettingsReady] = useState(false)
  const [wizardSettings, setWizardSettings] = useState<AppSettings>({ ...DEFAULT_SETTINGS })

  useEffect(() => {
    let cancelled = false
    let attempts = 0
    const poll = async () => {
      while (!cancelled && attempts < 10) {
        // 每轮重试 IPC 端到端探测（非 Tauri 环境立即返回；已解析则跳过）。
        // release 下后端解压/spawn 可能晚于首帧，一次性探测会永久锁错传输。
        await initApiTransport()
        try {
          // 用轻量 /health（不触外部网络 ping），避免就绪判定被慢速诊断端点阻塞
          await get('/health')
          if (!cancelled) setBackendState('ready')
          return
        } catch { attempts++ }
        if (!cancelled) await new Promise(r => setTimeout(r, 1000))
      }
      if (!cancelled && !isIpcMode()) {
        console.error(
          '[app] backend unreachable after 10 attempts (transport=http :5000)。' +
          'release 应走 qomicex:// 管道；dev 需手动启动 src-backend/qomicex-backend（cargo run）。',
        )
      }
      if (!cancelled) setBackendState('error')
    }
    poll()
    return () => { cancelled = true }
  }, [])

  // /health 通过（backend 已监听）后再拉取设置：挂载即拉会输给 release 冷启动的
  // 解压+spawn 时序，失败曾把默认值当成真实设置误触初始化向导。
  useEffect(() => {
    if (backendState !== 'ready') return
    void loadSettings()
  }, [backendState])

  useEffect(() => {
    if (backendState !== 'ready') return
    const onSettings = (s: AppSettings) => {
      setSettingsReady(true)
      if (s.initialized !== true) {
        setWizardSettings(s)
        setShowWizard(true)
      }
    }
    // settings 可能在挂载前已加载完成
    if (isSettingsLoaded()) onSettings(getSettings())
    const unsub = onSettingsChange(onSettings)
    return unsub
  }, [backendState])

  useEffect(() => {
    if (backendState !== 'ready' || !settingsReady || javaChecked.current || showWizard) return
    javaChecked.current = true
    ;(async () => {
      try {
        await loadCustomRuntimes()
        if (!hasAnyRuntimes()) await scanRuntimes('quick')
        if (!getRuntimes().some(r => r.state === 'Valid')) {
          alert(t('common.javaRuntimeRequired'), t('common.javaRuntimeRequiredTitle'))
        }
      } catch {}
    })()
  }, [backendState, settingsReady, showWizard, alert])

  useEffect(() => {
    if (backendState !== 'ready' || autoCheckDone.current) return
    autoCheckDone.current = true
    const timer = setTimeout(async () => {
      try {
        const channel = localStorage.getItem('update-channel') || 'stable'
        const update = await check({
          headers: { 'X-Updater-Channel': channel }
        })
        if (!update) return

        // 强制更新标记：来自后端 /api/update/check（后端镜像 C# 逻辑，按 current 判断）
        let required = false
        try {
          const info = await checkRequired(update.currentVersion, channel)
          required = info.hasUpdate && info.required === true
        } catch {}

        const snooze = localStorage.getItem('snooze-update')
        if (!required && snooze) {
          try {
            const s = JSON.parse(snooze)
            if (s.version === update.version && s.until > Date.now()) return
          } catch {}
        }

        setPendingUpdate(update)
        setPendingUpdateRequired(required)
      } catch (e) {
        console.warn('[updater] background check failed:', e)
      }
    }, 5000)
    return () => clearTimeout(timer)
  }, [backendState])

  useEffect(() => {
    if (backendState !== 'ready') return
    loadPlugins().then(() => {
      const { plugins: loaded } = usePluginStore.getState()
      const ordered = sortByDependencies(loaded)
      for (const p of ordered) {
        if (p.state === 'active') {
          activatePlugin(p)
        } else if (p.state === 'installed') {
          if (p.manifest.layers.every(l => l === 'l3')) continue
          activatePlugin(p)
        }
      }
      // 插件更新静默轮询：一次性、异步不阻塞、失败零影响（不发 toast，仅存全局供管理 tab badge 显示）
      if (pluginUpdatesChecked.current) return
      pluginUpdatesChecked.current = true
      checkStoreUpdates(collectInstalledPlugins(loaded))
        .then((res) => {
          const map = buildUpdatesMap(res.updates ?? [], loaded)
          if (Object.keys(map).length > 0) usePluginStore.getState().setUpdates(map)
        })
        .catch((e) => console.warn('[plugins] silent update check failed:', e))
    })
  }, [backendState, loadPlugins])

  useEffect(() => {
    const onPluginStateChange = async (event: Event) => {
      const { id, state } = (event as CustomEvent<{ id: string; state: PluginState }>).detail
      let plugin = usePluginStore.getState().getPlugin(id)
      if (!plugin) {
        await loadPlugins()
        plugin = usePluginStore.getState().getPlugin(id)
      }
      if (!plugin) return
      if (state === 'active') void activatePlugin({ ...plugin, state: 'active' })
      if (state === 'disabled') deactivatePlugin(id)
    }
    window.addEventListener('plugin:state-change', onPluginStateChange)
    return () => window.removeEventListener('plugin:state-change', onPluginStateChange)
  }, [loadPlugins])

  return (
    <Provider value={closeWithGuard}>
      <BrowserRouter>
        <RunningNotifyBridge />
        <TaskCompletionNotifier />
        <ErrorBoundary>
          <Routes>
            <Route element={<Layout />}>
              {backendState === 'ready' ? (
                <>
                  <Route path="/" element={<Dashboard />} />
                  <Route path="/instances" element={<Instances />} />
                  <Route path="/instances/:id" element={<InstanceDetailPage />} />
                  <Route path="/downloads" element={<DownloadCenter />} />
                  <Route path="/accounts" element={<Accounts />} />
                  <Route path="/accounts/:uuid" element={<AccountDetail />} />
                  <Route path="/resource-center" element={<ResourceCenter />} />
                  <Route path="/resource-center/:resourceId" element={<ResourceDetailPage />} />
                  <Route path="/connect" element={<Connect />} />
                  <Route path="/settings" element={<Settings />} />
                  <Route path="/running" element={<RunningInstances />} />
                  <Route path="/log-analysis" element={<LogAnalysis />} />
                  <Route path="/plugins/p/:pluginId" element={<PluginPage />} />
                </>
              ) : (
                <Route path="*" element={<div />} />
              )}
            </Route>
          </Routes>
        </ErrorBoundary>
      </BrowserRouter>
      <SplashScreen state={backendState} onRetry={() => window.location.reload()} />
      <InitialSetupWizard
        open={showWizard && backendState === 'ready'}
        settings={wizardSettings}
        onComplete={() => setShowWizard(false)}
      />
      <LaunchProgressDialog />
      <OverlayStoreBridge />
      <PluginOverlayManager />
      <CrashAnalysisDialog
        open={!!crashDialogState}
        title={crashDialogState?.title || ''}
        message={crashDialogState?.message || ''}
        detail={crashDialogState?.detail}
        args={crashDialogState?.args}
        crashReport={crashDialogState?.crashReport}
        analysis={crashDialogState?.analysis}
        analysisLoading={crashDialogState?.loading}
        error={crashDialogState?.error}
        mcloGsUrl={crashDialogState?.mcloGsUrl}
        qrCodeBase64={crashDialogState?.qrCodeBase64}
        instanceId={crashDialogState?.instanceId}
        onClose={clearCrashDialog}
      />
      <UpdateDialog
        open={pendingUpdate !== null}
        update={pendingUpdate}
        required={pendingUpdateRequired}
        onClose={() => {
          if (pendingUpdate && !pendingUpdateRequired) {
            localStorage.setItem('snooze-update', JSON.stringify({ version: pendingUpdate.version, until: Date.now() + 86400000 }))
          }
          setPendingUpdate(null)
          setPendingUpdateRequired(false)
        }}
      />
    </Provider>
  )
}

const LOG_LEVELS = ['trace', 'debug', 'info', 'warn', 'error'] as const

const _console = {
  log: console.log.bind(console),
  warn: console.warn.bind(console),
  error: console.error.bind(console),
  debug: console.debug.bind(console),
  trace: console.trace.bind(console),
}

function setConsoleLevel(level: string) {
  const idx = LOG_LEVELS.indexOf(level as typeof LOG_LEVELS[number])
  if (idx < 0) return
  // LOG_LEVELS 由低到高：trace(0) debug(1) info(2) warn(3) error(4)。
  // tracing 语义：EnvFilter "info" 显示 >= info 级别（info/warn/error），
  // 设置级别越高显示越少。shouldLog(lvlIdx) = lvlIdx >= idx。
  const shouldLog = (lvlIdx: number) => lvlIdx >= idx

  // 包装 console 方法：按 logLevel 决定是否显示，同时上报后端日志体系
  // （构建版 Tauri 无控制台，前端日志靠 POST /logs/frontend 落盘可查），
  // 并填充前端环形缓冲（严重错误上报时作为上下文附带）。
  function wrap(method: 'log' | 'warn' | 'error' | 'debug' | 'trace', enabled: boolean) {
    const orig = _console[method]
    return (...args: unknown[]) => {
      if (enabled) {
        orig(...args)
        reportFrontendLog(method, args.map(fmtConsoleArg).join(' '))
      }
      pushConsole(method, args.map(fmtConsoleArg).join(' '))
    }
  }

  // console 方法级别映射：trace=0 debug=1 log=2(info) warn=3 error=4
  console.log = wrap('log', shouldLog(2))
  console.warn = wrap('warn', shouldLog(3))
  // console.error is never suppressed（始终显示 + 上报）
  console.error = wrap('error', true)
  console.debug = wrap('debug', shouldLog(1))
  console.trace = wrap('trace', shouldLog(0))
}

/** 把 console 参数转成可读字符串（对象序列化，Error 取 stack/message）。 */
function fmtConsoleArg(arg: unknown): string {
  if (arg instanceof Error) return arg.stack || arg.message || String(arg)
  if (typeof arg === 'object' && arg !== null) {
    try { return JSON.stringify(arg) } catch { return String(arg) }
  }
  return String(arg)
}

const savedTheme = localStorage.getItem('qomicex-theme')
if (savedTheme === 'light' || savedTheme === 'dark') {
  document.documentElement.classList.toggle('dark', savedTheme === 'dark')
  document.documentElement.classList.toggle('light', savedTheme === 'light')
}

function I18nMessageBoxProvider({ children }: { children: ReactNode }) {
  const { t } = useI18n()
  return (
    <MessageBoxProvider
      messages={{
        ok: t('common.ok'),
        cancel: t('common.cancel'),
        error: t('common.error'),
        warning: t('common.warning'),
        success: t('common.success'),
        info: t('common.info'),
        input: t('common.input'),
        inputPlaceholder: t('common.inputPlaceholder'),
      }}
    >
      {children}
    </MessageBoxProvider>
  )
}

function App() {
  useEffect(() => {
    console.log(`
 ██████╗   ██████╗  ███╗   ███╗ ██╗  ██████╗ ███████╗ ██╗    ██╗
██╔═══██╗ ██╔═══██╗ ████╗ ████║ ██║ ██╔════╝ ██╔════╝  ╚██╗ ██╔╝
██║   ██║ ██║   ██║ ██╔████╔██║ ██║ ██║      █████╗      ╚██╔╝
██║ █╗██║ ██║   ██║ ██║╚██╔╝██║ ██║ ██║      ██╔══╝      █╔ █╗
██║ ╚██╔╝ ██║   ██║ ██║ ╚═╝ ██║ ██║ ██║      ██║       ██╔╝  ██╗
╚█████╔█╗ ╚██████╔╝ ██║     ██║ ██║ ╚██████╗ ███████╗ ██╔╝    ██╗
 ╚════╝╚╝  ╚═════╝  ╚═╝     ╚═╝ ╚═╝  ╚═════╝  ╚═════╝ ╚═╝     ╚═╝
Console - Qomicex Launcher ======================================`)
  }, [])

  useEffect(() => {
    async function setTheme(theme: 'dark' | 'light') {
      document.documentElement.classList.toggle('dark', theme === 'dark')
      document.documentElement.classList.toggle('light', theme === 'light')
      localStorage.setItem('qomicex-theme', theme)
      try {
        const { getCurrentWindow } = await import('@tauri-apps/api/window')
        void getCurrentWindow().setTheme(theme)
      } catch { /* 非 Tauri 环境忽略 */ }
    }
    function applyFont(family: string | undefined) {
      const root = document.documentElement
      if (family && family.trim()) {
        root.style.setProperty('--app-font', `'${family.replace(/['"]/g, '')}', sans-serif`)
      } else {
        root.style.removeProperty('--app-font')
      }
    }
    function applyThemePreset(preset: AppSettings['themePreset'] | undefined) {
      const root = document.documentElement
      // 后端缺 themePreset（旧后端丢弃该字段）时回退到前端本地存储，避免切页即回默认。
      const effective = preset ?? (localStorage.getItem('qomicex-theme-preset') as AppSettings['themePreset'] | null) ?? 'default'
      if (effective && effective !== 'default') root.dataset.theme = effective
      else delete root.dataset.theme
    }
    function applyGlassMaterial(material: string | undefined, blur: number | undefined) {
      const root = document.documentElement
      root.dataset.material = material ?? 'default'
      root.style.setProperty('--glass-blur', `${Math.max(0, blur ?? 18)}px`)
    }
    // 初始设置不在这里加载：backend 可能尚未监听（Tauri release 冷启动要先解压
    // + spawn），fetch 失败会让 UI 用默认值渲染。加载移到 AppContent 中
    // backendState==='ready' 之后；首次加载成功会触发下方 listener 完成初始应用。
    const unsub = onSettingsChange((s: AppSettings) => {
      const enabled = s.animationsEnabled !== false
      const speed = s.animationSpeed ?? 1
      const maxFps = s.maxFrameRate ?? 0
      const fpsScale = maxFps > 0 ? 60 / maxFps : 1
      document.documentElement.dataset.animEnabled = String(enabled)
      document.documentElement.dataset.animGpu = String(s.gpuAcceleration !== false)
      document.documentElement.dataset.maxFps = String(maxFps)
      document.documentElement.style.setProperty('--anim-duration-multiplier', String((1 / speed) * fpsScale))
      window.dispatchEvent(new CustomEvent('qomicex-bg-change'))
      setConsoleLevel(s.logLevel ?? 'info')
      setTheme(s.theme ?? 'dark')
      applyThemePreset(s.themePreset)
      applyFont(s.fontFamily)
      applyThemeColor(s.themeColor)
      applyGlassMaterial(s.componentMaterial, s.glassBlur)
    })
    return unsub
  }, [])

  // 恢复持久化的自定义 .qtheme（无已保存主题时 no-op，不影响既有 light/dark/预设流）。
  useEffect(() => {
    restoreSavedTheme()
  }, [])

  useEffect(() => {
    const handler = (event: PromiseRejectionEvent) => {
      console.error('[GLOBAL] Unhandled Promise Rejection:', event.reason)
    }
    window.addEventListener('unhandledrejection', handler)
    return () => window.removeEventListener('unhandledrejection', handler)
  }, [])

  useEffect(() => {
    const handler = (event: ErrorEvent) => {
      console.error('[GLOBAL] Uncaught Error:', event.error ?? event.message)
    }
    window.addEventListener('error', handler)
    return () => window.removeEventListener('error', handler)
  }, [])

  // 独立日志窗口：直接渲染日志页（仍用 I18nProvider 供翻译），
  // 不加载主 Layout / 路由 / 后台健康轮询等重逻辑。
  if (LOG_WINDOW_INSTANCE !== null) {
    return (
      <I18nProvider>
        <GameLogWindow instanceId={LOG_WINDOW_INSTANCE} />
      </I18nProvider>
    )
  }

  // l4 插件独立窗口：轻量启动，只渲染插件页 + 跨窗口桥（见 PluginWebviewPage）。
  if (PLUGIN_WEBVIEW_PLUGIN_ID !== null) {
    return (
      <I18nProvider>
        <PluginWebviewPage pluginId={PLUGIN_WEBVIEW_PLUGIN_ID} />
      </I18nProvider>
    )
  }

  return (
    <I18nProvider>
      <RunningProvider>
        <I18nMessageBoxProvider>
          <ErrorBoundary>
            <AppContent />
          </ErrorBoundary>
        </I18nMessageBoxProvider>
      </RunningProvider>
    </I18nProvider>
  )
}

export default App
