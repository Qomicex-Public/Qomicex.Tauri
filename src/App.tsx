import { useEffect, useState } from 'react'
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
import { MessageBoxProvider, useMessageBox } from './components/ui/message-box.tsx'
import TaskCompletionNotifier from './components/TaskCompletionNotifier.tsx'
import useCloseGuard from './hooks/useCloseGuard.ts'
import { loadSettings, onSettingsChange } from './api/settings.ts'
import { RunningProvider, useRunning } from './contexts/RunningContext.tsx'
import LaunchProgressDialog from './components/LaunchProgressDialog.tsx'
import { get } from './api/client.ts'
import { Button } from './components/ui/button.tsx'

function RunningNotifyBridge() {
  const { notify } = useMessageBox()
  const { setNotifyImpl } = useRunning()
  useEffect(() => { setNotifyImpl(notify) }, [notify, setNotifyImpl])
  return null
}

function AppContent() {
  const [backendState, setBackendState] = useState<'loading' | 'ready' | 'error'>('loading')
  const { closeWithGuard, Provider } = useCloseGuard()

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
