import { useEffect } from 'react'
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
import { loadSettings, onSettingsChange } from './api/settings.ts'
import { RunningProvider, useRunning } from './contexts/RunningContext.tsx'
import LaunchProgressDialog from './components/LaunchProgressDialog.tsx'

function RunningNotifyBridge() {
  const { notify } = useMessageBox()
  const { setNotifyImpl } = useRunning()
  useEffect(() => { setNotifyImpl(notify) }, [notify, setNotifyImpl])
  return null
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
        <BrowserRouter>
          <RunningNotifyBridge />
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
      </MessageBoxProvider>
    </RunningProvider>
  )
}

export default App
