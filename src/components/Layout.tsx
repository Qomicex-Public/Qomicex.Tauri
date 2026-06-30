import { useEffect, useState, useRef } from 'react'
import { Outlet } from 'react-router-dom'
import Sidebar from './Sidebar.tsx'
import { TitleBar } from './TitleBar.tsx'
import { getSettings, onSettingsChange } from '../api/settings.ts'
import { get } from '../api/client.ts'
import { useMessageBox } from './ui/message-box.tsx'
import { openUrl } from '@tauri-apps/plugin-opener'

export default function Layout() {
  const [bg, setBg] = useState('')
  const [opacity, setOpacity] = useState(() => getSettings().bgOverlayOpacity ?? 78)
  const [blur, setBlur] = useState(() => getSettings().bgBlur ?? 0)
  const randomBgRef = useRef('')
  const prevBgRef = useRef({ image: '', random: false })
  const { confirm: msgConfirm } = useMessageBox()

  async function resolveBg(s = getSettings()) {
    let filename = s.backgroundImage || randomBgRef.current || ''
    if (s.backgroundRandom && !randomBgRef.current) {
      try {
        const list = await get<string[]>('/settings/backgrounds')
        if (list.length > 0) {
          filename = list[Math.floor(Math.random() * list.length)]
          randomBgRef.current = filename
        }
      } catch { filename = '' }
    }
    setBg(filename ? `/api/settings/backgrounds/${encodeURIComponent(filename)}` : '')
  }

  useEffect(() => {
    const s = getSettings()
    prevBgRef.current = { image: s.backgroundImage, random: s.backgroundRandom }
    resolveBg()
    return onSettingsChange((s) => {
      setOpacity(s.bgOverlayOpacity ?? 78)
      setBlur(s.bgBlur ?? 0)
      const prev = prevBgRef.current
      if (s.backgroundImage !== prev.image || s.backgroundRandom !== prev.random) {
        prevBgRef.current = { image: s.backgroundImage, random: s.backgroundRandom }
        resolveBg(s)
      }
    })
  }, [])

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      const a = (e.target as HTMLElement).closest('a')
      if (!a?.href) return
      try {
        const url = new URL(a.href)
        if (url.protocol === 'http:' || url.protocol === 'https:') {
          if (url.origin !== window.location.origin) {
            e.preventDefault()
            msgConfirm(`即将打开外部链接：\n${url.href}\n\n是否继续？`).then(ok => {
              if (ok) openUrl(url.href).catch(() => window.open(url.href, '_blank'))
            })
          }
        }
      } catch { /* ignore invalid URLs */ }
    }
    document.addEventListener('click', handleClick)
    return () => document.removeEventListener('click', handleClick)
  }, [msgConfirm])

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
