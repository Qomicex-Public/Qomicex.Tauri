import { NavLink } from 'react-router-dom'
import type { ReactNode } from 'react'
import { useEffect, useRef } from 'react'
import gsap from 'gsap'
import { Box, Compass, Download, FileText, Gamepad2, House, Network, Settings, User, type LucideIcon } from 'lucide-react'
import { Tooltip } from './ui'
import { useRunning } from '../contexts/RunningContext.tsx'
import { useI18n } from '../i18n/index.tsx'
import { cn } from '../lib/utils.ts'
import { PluginSidebarItems } from './PluginSidebarItems.tsx'
import { getSettings } from '../api/settings.ts'

interface NavLinkDef {
  to: string
  key: 'home' | 'instances' | 'downloads' | 'accounts' | 'resourceCenter' | 'connect' | 'logAnalysis'
  icon: ReactNode
  end?: boolean
}

const NAV_LINKS: readonly NavLinkDef[] = [
  { to: '/', key: 'home', icon: <House className="h-5 w-5" />, end: true },
  { to: '/instances', key: 'instances', icon: <Box className="h-5 w-5" /> },
  { to: '/downloads', key: 'downloads', icon: <Download className="h-5 w-5" /> },
  { to: '/accounts', key: 'accounts', icon: <User className="h-5 w-5" /> },
  { to: '/resource-center', key: 'resourceCenter', icon: <Compass className="h-5 w-5" /> },
  { to: '/connect', key: 'connect', icon: <Network className="h-5 w-5" />, end: true },
  { to: '/log-analysis', key: 'logAnalysis', icon: <FileText className="h-5 w-5" /> },
]

export function NavItem({ to, label, icon, end }: { to: string; label: string; icon: React.ReactNode; end?: boolean }) {
  return (
    <li className="w-full flex justify-center relative">
      <NavLink to={to} end={end} className="w-full flex justify-center">
        {({ isActive }) => (
          <>
            <div
              className={cn(
                'absolute left-0 top-1/2 h-5 w-0.5 -translate-y-1/2 rounded-r-full bg-primary transition-all duration-200',
                isActive ? 'scale-y-100 opacity-100' : 'scale-y-0 opacity-0'
              )}
            />
            <Tooltip content={label} side="right">
              <div
                className={cn(
                  'flex h-11 w-11 items-center justify-center rounded-lg text-lg transition-all duration-200',
                  isActive
                    ? 'bg-primary/10 text-primary [&>svg]:text-primary'
                    : 'text-muted-foreground hover:bg-accent hover:text-foreground'
                )}
              >
                {icon}
              </div>
            </Tooltip>
          </>
        )}
      </NavLink>
    </li>
  )
}

function BottomNavItem({ to, label, icon: IconComp, showPingDot }: { to: string; label: string; icon: LucideIcon; showPingDot?: boolean }) {
  return (
    <div className="w-full flex justify-center relative">
      <NavLink to={to} className="w-full flex justify-center">
        {({ isActive }) => (
          <>
            <div
              className={cn(
                'absolute left-0 top-1/2 h-4 w-0.5 -translate-y-1/2 rounded-r-full bg-primary transition-all duration-200',
                isActive ? 'scale-y-100 opacity-100' : 'scale-y-0 opacity-0'
              )}
            />
            <Tooltip content={label} side="right">
              <div
                className={cn(
                  'flex h-9 w-9 items-center justify-center rounded-lg text-base transition-all duration-200 relative',
                  isActive
                    ? 'bg-primary/10 text-primary'
                    : showPingDot
                      ? 'text-green-500 hover:bg-green-500/10'
                      : 'text-muted-foreground hover:bg-accent hover:text-foreground'
                )}
              >
                <IconComp className="h-4 w-4" />
                {showPingDot && (
                  <span className="absolute -right-0.5 -top-0.5 h-2 w-2 rounded-full bg-green-500 animate-ping" />
                )}
              </div>
            </Tooltip>
          </>
        )}
      </NavLink>
    </div>
  )
}

export default function Sidebar() {
  const { runningInstances } = useRunning()
  const { t } = useI18n()
  const hasRunning = runningInstances.length > 0
  const links = NAV_LINKS.map(l => ({ ...l, label: t(`layout.sidebar.${l.key}`) }))
  const navRef = useRef<HTMLUListElement>(null)

  // 侧边栏入场动画
  useEffect(() => {
    const el = navRef.current
    if (!el) return

    const settings = getSettings()
    if (!settings.animationsEnabled) return

    const speed = settings.animationSpeed ?? 1
    const children = Array.from(el.querySelectorAll('li'))

    gsap.fromTo(children,
      { opacity: 0, x: -8 },
      {
        opacity: 1,
        x: 0,
        duration: 0.25 / speed,
        stagger: 0.03 / speed,
        ease: 'power3.out',
        force3D: settings.gpuAcceleration !== false
      }
    )
  }, [])

  return (
    <nav className="flex w-16 flex-col items-center border-r border-border/50 bg-card/80 backdrop-blur-xl shadow-xl shadow-black/20">
      <div className="flex w-full flex-col items-center border-b border-border pb-3 pt-[18px]">
        <div className="flex h-8 w-8 items-center justify-center">
          <img src="/logo.svg" alt="Qomicex" className="h-full w-full rounded-lg object-cover" />
        </div>
      </div>

      <ul ref={navRef} className="flex w-full flex-1 flex-col items-center gap-0.5 px-2 py-2">
        {links.map((link) => (
          <NavItem key={link.to} to={link.to} label={link.label} icon={link.icon} end={link.end} />
        ))}
        <PluginSidebarItems />
      </ul>
      <div className="flex w-full flex-col items-center border-t border-border px-2 py-2 pb-4 gap-1">
        <BottomNavItem to="/running" label={t('layout.sidebar.running')} icon={Gamepad2} showPingDot={hasRunning} />
        <BottomNavItem to="/settings" label={t('layout.sidebar.settings')} icon={Settings} />
      </div>
    </nav>
  )
}
