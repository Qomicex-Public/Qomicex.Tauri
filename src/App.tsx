import { useEffect, useState, useRef } from 'react'
import { BrowserRouter, Routes, Route } from 'react-router-dom'
import { invoke } from '@tauri-apps/api/core'
import { Update } from '@tauri-apps/plugin-updater'
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
import { MessageBoxProvider, useMessageBox } from './components/ui/message-box.tsx'
import TaskCompletionNotifier from './components/TaskCompletionNotifier.tsx'
import useCloseGuard from './hooks/useCloseGuard.ts'
import { loadSettings, onSettingsChange } from './api/settings.ts'
import { RunningProvider, useRunning } from './contexts/RunningContext.tsx'
import LaunchProgressDialog from './components/LaunchProgressDialog.tsx'
import UpdateDialog from './components/UpdateDialog.tsx'
import { get } from './api/client.ts'
import { Button } from './components/ui/button.tsx'
import { loadCustomRuntimes, scanRuntimes, getRuntimes, hasAnyRuntimes } from './stores/javaStore.ts'

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
  const javaChecked = useRef(false)
  const [pendingUpdate, setPendingUpdate] = useState<{ version: string; body: string; required: boolean; update: Update } | null>(null)
  const autoCheckDone = useRef(false)

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
        let endpoint: string
        if (channel === 'stable') {
          endpoint = 'https://github.com/Qomicex-Public/Qomicex.Tauri/releases/latest/download/latest.json'
        } else {
          const res = await fetch('https://api.github.com/repos/Qomicex-Public/Qomicex.Tauri/releases?per_page=5')
          if (!res.ok) return
          const releases: any[] = await res.json()
          const pre = releases.find(r => r.prerelease && !r.draft)
          if (!pre) return
          const asset = pre.assets.find((a: any) => a.name === 'beta.json')
          if (!asset) return
          endpoint = asset.browser_download_url
        }
        const metadata: any = await invoke('check_update_with_endpoint', { endpoint })
        if (!metadata) return
        const required = !!(metadata.rawJson?.required)
        const snooze = localStorage.getItem('snooze-update')
        if (snooze) {
          try {
            const s = JSON.parse(snooze)
            if (s.version === metadata.version && s.until > Date.now()) return
          } catch {}
        }
        setPendingUpdate({ version: metadata.version, body: metadata.body ?? '', required, update: new Update(metadata) })
      } catch {}
    }, 5000)
    return () => clearTimeout(timer)
  }, [backendState])

  if (backendState !== 'ready') {
    return (
      <div className="flex h-screen items-center justify-center bg-background">
        <div className="text-center">
          {backendState === 'loading' ? (
            <>
              <div className="mx-auto h-8 w-8 animate-spin rounded-full border-2 border-primary border-t-transparent" />
              <p className="mt-4 text-sm text-muted-foreground">启动后端服务...</p>
            </>
          ) : (
            <>
              <p className="text-destructive font-medium">后端启动失败</p>
              <p className="mt-2 max-w-sm text-sm text-muted-foreground">
                请确保已安装 .NET 10 Runtime 和 ASP.NET Core Runtime 10.0，然后重启启动器。
              </p>
              <p className="mt-1">
                <a href="https://dotnet.microsoft.com/download/dotnet/10.0" target="_blank" className="text-xs text-primary underline">下载 .NET 10</a>
              </p>
              <Button className="mt-4" onClick={() => window.location.reload()}>重试</Button>
            </>
          )}
        </div>
      </div>
    )
  }

  return (
    <Provider value={closeWithGuard}>
      <BrowserRouter>
        <RunningNotifyBridge />
        <TaskCompletionNotifier />
        <Routes>
          <Route element={<Layout />}>
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
          </Route>
        </Routes>
      </BrowserRouter>
      <LaunchProgressDialog />
      <UpdateDialog
        open={pendingUpdate !== null}
        version={pendingUpdate?.version ?? ''}
        body={pendingUpdate?.body ?? ''}
        required={pendingUpdate?.required ?? false}
        update={pendingUpdate?.update ?? null}
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

function App() {
  useEffect(() => {
    loadSettings()
    const unsub = onSettingsChange((s) => {
      const enabled = s.animationsEnabled !== false
      const speed = s.animationSpeed ?? 1
      document.documentElement.dataset.animEnabled = String(enabled)
      document.documentElement.style.setProperty('--anim-duration-multiplier', String(1 / speed))
      window.dispatchEvent(new CustomEvent('qomicex-bg-change'))
    })
    return unsub
  }, [])

  return (
    <RunningProvider>
      <MessageBoxProvider>
        <AppContent />
      </MessageBoxProvider>
    </RunningProvider>
  )
}

export default App
