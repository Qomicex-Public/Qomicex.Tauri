import { useEffect, useState, useRef } from 'react'
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
import PluginOverlayManager from './components/PluginOverlayManager.tsx'
import { MessageBoxProvider, useMessageBox } from './components/ui'
import TaskCompletionNotifier from './components/TaskCompletionNotifier.tsx'
import useCloseGuard from './hooks/useCloseGuard.ts'
import ErrorBoundary from './components/ErrorBoundary.tsx'
import { loadSettings, onSettingsChange, type AppSettings } from './api/settings.ts'
import { RunningProvider, useRunning } from './contexts/RunningContext.tsx'
import LaunchProgressDialog from './components/LaunchProgressDialog.tsx'
import { CrashAnalysisDialog } from './components/CrashAnalysisDialog.tsx'
import UpdateDialog from './components/UpdateDialog.tsx'
import { get } from './api/client.ts'
import { check } from '@tauri-apps/plugin-updater'
import type { Update } from '@tauri-apps/plugin-updater'

import { loadCustomRuntimes, scanRuntimes, getRuntimes, hasAnyRuntimes } from './stores/javaStore.ts'
import { SplashScreen } from './components/SplashScreen.tsx'
import { usePluginStore } from './stores/pluginStore.ts'
import { activatePlugin, sortByDependencies } from './plugins/plugin-loader.tsx'
import './plugins/plugin-registry.ts'

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
  const { crashDialogState, clearCrashDialog } = useRunning()
  const javaChecked = useRef(false)
  const [pendingUpdate, setPendingUpdate] = useState<Update | null>(null)
  const autoCheckDone = useRef(false)
  const { loadPlugins } = usePluginStore()

  useEffect(() => {
    let cancelled = false
    let attempts = 0
    const poll = async () => {
      while (!cancelled && attempts < 10) {
        try {
          await get('/diagnostics/health')
          if (!cancelled) setBackendState('ready')
          return
        } catch { attempts++ }
        if (!cancelled) await new Promise(r => setTimeout(r, 1000))
      }
      if (!cancelled) setBackendState('error')
    }
    poll()
    return () => { cancelled = true }
  }, [])

  useEffect(() => {
    if (backendState !== 'ready' || javaChecked.current) return
    javaChecked.current = true
    ;(async () => {
      try {
        await loadCustomRuntimes()
        if (!hasAnyRuntimes()) await scanRuntimes('quick')
        if (!getRuntimes().some(r => r.state === 'Valid')) {
          alert('启动 Minecraft 需要 Java 运行时环境。\n\n你可以使用「设置 → Java → 下载 Java」功能快速安装，或手动添加已安装的 Java 路径。', '未检测到 Java 运行时')
        }
      } catch {}
    })()
  }, [backendState, alert])

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

        const snooze = localStorage.getItem('snooze-update')
        if (snooze) {
          try {
            const s = JSON.parse(snooze)
            if (s.version === update.version && s.until > Date.now()) return
          } catch {}
        }

        setPendingUpdate(update)
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
    })
  }, [backendState, loadPlugins])

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
        onClose={() => {
          if (pendingUpdate) {
            localStorage.setItem('snooze-update', JSON.stringify({ version: pendingUpdate.version, until: Date.now() + 86400000 }))
          }
          setPendingUpdate(null)
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
  const shouldLog = (minIdx: number) => idx >= minIdx
  console.log = shouldLog(2) ? _console.log : () => {}
  console.warn = shouldLog(3) ? _console.warn : () => {}
  // console.error is never suppressed
  console.debug = shouldLog(1) ? _console.debug : () => {}
  console.trace = shouldLog(0) ? _console.trace : () => {}
}

const savedTheme = localStorage.getItem('qomicex-theme')
if (savedTheme === 'light' || savedTheme === 'dark') {
  document.documentElement.classList.toggle('dark', savedTheme === 'dark')
  document.documentElement.classList.toggle('light', savedTheme === 'light')
}

function App() {
  useEffect(() => {
    function setTheme(theme: 'dark' | 'light') {
      document.documentElement.classList.toggle('dark', theme === 'dark')
      document.documentElement.classList.toggle('light', theme === 'light')
      localStorage.setItem('qomicex-theme', theme)
    }
    loadSettings().then(s => {
      setConsoleLevel(s.logLevel ?? 'info')
      setTheme(s.theme ?? 'dark')
    })
    const unsub = onSettingsChange((s: AppSettings) => {
      const enabled = s.animationsEnabled !== false
      const speed = s.animationSpeed ?? 1
      const maxFps = s.maxFrameRate ?? 0
      const fpsScale = maxFps > 0 ? 60 / maxFps : 1
      document.documentElement.dataset.animEnabled = String(enabled)
      document.documentElement.dataset.maxFps = String(maxFps)
      document.documentElement.style.setProperty('--anim-duration-multiplier', String((1 / speed) * fpsScale))
      window.dispatchEvent(new CustomEvent('qomicex-bg-change'))
      setConsoleLevel(s.logLevel ?? 'info')
      setTheme(s.theme ?? 'dark')
    })
    return unsub
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

  return (
    <RunningProvider>
      <MessageBoxProvider>
        <ErrorBoundary>
          <AppContent />
        </ErrorBoundary>
      </MessageBoxProvider>
    </RunningProvider>
  )
}

export default App
