import { useEffect, useState, useRef, useMemo } from 'react'
import { Outlet, useNavigate, useLocation } from 'react-router-dom'
import gsap from 'gsap'
import Sidebar from './Sidebar.tsx'
import { TitleBar } from './TitleBar.tsx'
import ScrollToTop from './ScrollToTop.tsx'
import { getSettings, onSettingsChange } from '../api/settings.ts'
import { get, API_BASE } from '../api/client.ts'
import { useMessageBox } from './ui'
import { DebugProvider, useDebug } from './DebugContext.tsx'
import LogOverlay from './LogOverlay.tsx'
import FpsOverlay from './FpsOverlay.tsx'
import { openUrl } from '@tauri-apps/plugin-opener'
import { PluginEventBridge } from './PluginEventBridge.tsx'
import GlobalDropInstaller from './GlobalDropInstaller.tsx'
import { useI18n } from '../i18n/index.tsx'
import { setThemeBackground } from '../lib/themeColor.ts'

function DebugEffects() {
  const { state, unlock } = useDebug()
  const navigate = useNavigate()

  useEffect(() => {
    let count = 0
    let timer: ReturnType<typeof setTimeout> | null = null
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'F8') {
        e.preventDefault()
        count++
        if (count >= 8) {
          count = 0
          if (timer) clearTimeout(timer)
          unlock()
          navigate('/settings?tab=debug')
          return
        }
        if (timer) clearTimeout(timer)
        timer = setTimeout(() => { count = 0 }, 2000)
      }
    }
    document.addEventListener('keydown', handler)
    return () => {
      document.removeEventListener('keydown', handler)
      if (timer) clearTimeout(timer)
    }
  }, [navigate, unlock])

  useEffect(() => {
    document.documentElement.style.setProperty(
      '--anim-duration-multiplier',
      state.disableAnimations ? '0' : ''
    )
  }, [state.disableAnimations])

  useEffect(() => {
    const id = 'debug-component-boundaries'
    if (state.showComponentBoundaries) {
      if (!document.getElementById(id)) {
        const style = document.createElement('style')
        style.id = id
        style.textContent = '* { outline: 1px solid rgba(255,0,0,0.3) !important }'
        document.head.appendChild(style)
      }
    } else {
      const el = document.getElementById(id)
      if (el) el.remove()
    }
  }, [state.showComponentBoundaries])

  return (
    <>
      {state.logOverlay && <LogOverlay />}
      {state.showFps && <FpsOverlay />}
    </>
  )
}

export default function Layout() {
  const [bg, setBg] = useState('')
  const [opacity, setOpacity] = useState(() => getSettings().bgOverlayOpacity ?? 78)
  const [blur, setBlur] = useState(() => getSettings().bgBlur ?? 0)
  const randomBgRef = useRef('')
  const prevBgRef = useRef({ image: '', random: false })
  const { confirm: msgConfirm } = useMessageBox()
  const { t } = useI18n()
  const location = useLocation()
  const mainRef = useRef<HTMLElement>(null)
  const prevPathRef = useRef(location.pathname)

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
    const url = filename ? `${API_BASE}/settings/backgrounds/${encodeURIComponent(filename)}` : ''
    setBg(url)
    setThemeBackground(url)
  }

  useEffect(() => {
    const s = getSettings()
    document.documentElement.style.setProperty('--radius', `${s.cornerRadius ?? 8}px`)
    prevBgRef.current = { image: s.backgroundImage, random: s.backgroundRandom }
    resolveBg()
    return onSettingsChange((s) => {
      setOpacity(s.bgOverlayOpacity ?? 78)
      setBlur(s.bgBlur ?? 0)
      document.documentElement.style.setProperty('--radius', `${s.cornerRadius ?? 8}px`)
      const prev = prevBgRef.current
      if (s.backgroundImage !== prev.image || s.backgroundRandom !== prev.random) {
        prevBgRef.current = { image: s.backgroundImage, random: s.backgroundRandom }
        resolveBg(s)
      }
    })
  }, [])

  // 页面切换动画
  useEffect(() => {
    if (location.pathname === prevPathRef.current) return
    prevPathRef.current = location.pathname

    const el = mainRef.current
    if (!el) return

    const settings = getSettings()
    if (!settings.animationsEnabled) return

    const speed = settings.animationSpeed ?? 1

    // 立即设置 opacity: 0，避免内容闪现
    gsap.set(el, { opacity: 0, y: 8 })

    // 等待 DOM 更新后执行动画
    requestAnimationFrame(() => {
      gsap.to(el,
        { opacity: 1, y: 0, duration: 0.25 / speed, ease: 'power2.out' }
      )
    })
  }, [location.pathname])

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      const a = (e.target as HTMLElement).closest('a')
      if (!a?.href) return
      try {
        const url = new URL(a.href)
        if (url.protocol === 'http:' || url.protocol === 'https:') {
          if (url.origin !== window.location.origin) {
            e.preventDefault()
            msgConfirm(t('layout.externalLinkConfirm', { url: url.href })).then(ok => {
              if (ok) openUrl(url.href).catch(() => window.open(url.href, '_blank'))
            })
          }
        }
      } catch { /* ignore invalid URLs */ }
    }
    document.addEventListener('click', handleClick)
    return () => document.removeEventListener('click', handleClick)
  }, [msgConfirm, t])

  const isLinux = useMemo(() => navigator.userAgent.includes('Linux'), [])
  const isMacos = useMemo(() => navigator.userAgent.includes('Mac'), [])

  return (
    <DebugProvider>
    <div className="flex h-screen">
      <DebugEffects />
      <PluginEventBridge />
      <GlobalDropInstaller />
      {bg && (
        <>
          <img src={bg} alt="" className="fixed inset-0 z-0 h-full w-full object-cover" style={{ filter: blur > 0 ? `blur(${blur}px)` : 'none' }} />
          <div className="fixed inset-0 z-0" style={{ backgroundColor: `hsl(var(--background)/${(opacity / 100).toFixed(2)})` }} />
        </>
      )}
      <div className="relative z-10 flex flex-1 min-w-0">
        <Sidebar />
        <div className="flex flex-1 flex-col min-w-0">
          {!isLinux && !isMacos && <TitleBar />}
          <div className="relative flex flex-1 min-w-0 overflow-hidden">
            <div className="absolute inset-0 bg-background/50" style={{ backdropFilter: blur > 0 ? `blur(${blur}px)` : 'none' }} />
            <main ref={mainRef} className="relative z-10 flex min-h-0 overflow-hidden flex-1">
              <Outlet />
            </main>
          </div>
        </div>
      </div>
      <ScrollToTop />
    </div>
    </DebugProvider>
  )
}
