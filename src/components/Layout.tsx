import { useEffect, useState } from 'react'
import { Outlet } from 'react-router-dom'
import Sidebar from './Sidebar.tsx'
import { TitleBar } from './TitleBar.tsx'
import { getSettings, onSettingsChange } from '../api/settings.ts'

export default function Layout() {
  const [bg, setBg] = useState(() => getSettings().backgroundImage || '')
  const [opacity, setOpacity] = useState(() => getSettings().bgOverlayOpacity ?? 78)
  const [blur, setBlur] = useState(() => getSettings().bgBlur ?? 0)
  useEffect(() => {
    return onSettingsChange((s) => {
      setBg(s.backgroundImage || '')
      setOpacity(s.bgOverlayOpacity ?? 78)
      setBlur(s.bgBlur ?? 0)
    })
  }, [])

  return (
    <div className="flex h-screen">
      {bg && (
        <>
          <img src={bg} alt="" className="fixed inset-0 z-0 h-full w-full object-cover" style={{ filter: `blur(${blur}px)` }} />
          <div className="fixed inset-0 z-0" style={{ backgroundColor: `rgba(19,19,19,${(opacity / 100).toFixed(2)})` }} />
        </>
      )}
      <div className="relative z-10 flex flex-1">
        <Sidebar />
        <div className="flex flex-1 flex-col">
          <TitleBar />
          <main className="flex-1 overflow-y-auto bg-background/50 backdrop-blur-sm">
            <Outlet />
          </main>
        </div>
      </div>
    </div>
  )
}
