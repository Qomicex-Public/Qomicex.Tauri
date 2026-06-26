import { BrowserRouter, Routes, Route } from 'react-router-dom'
import Layout from './components/Layout.tsx'
import Dashboard from './pages/Dashboard.tsx'
import Instances from './pages/Instances.tsx'
import DownloadCenter from './pages/DownloadCenter.tsx'
import Accounts from './pages/Accounts.tsx'
import LogAnalysis from './pages/LogAnalysis.tsx'
import ResourceCenter from './pages/ResourceCenter.tsx'
import ResourceDetailPage from './pages/ResourceDetail.tsx'
import Settings from './pages/Settings.tsx'
import { MessageBoxProvider } from './components/ui/message-box.tsx'

function App() {
  return (
    <MessageBoxProvider>
      <BrowserRouter>
        <Routes>
          <Route element={<Layout />}>
            <Route path="/" element={<Dashboard />} />
            <Route path="/instances" element={<Instances />} />
            <Route path="/downloads" element={<DownloadCenter />} />
            <Route path="/accounts" element={<Accounts />} />
            <Route path="/log-analysis" element={<LogAnalysis />} />
            <Route path="/resource-center" element={<ResourceCenter />} />
            <Route path="/resource-center/:resourceId" element={<ResourceDetailPage />} />
            <Route path="/settings" element={<Settings />} />
          </Route>
        </Routes>
      </BrowserRouter>
    </MessageBoxProvider>
  )
}

export default App
