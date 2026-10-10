import { NavLink } from 'react-router-dom'
import type { ReactNode } from 'react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import gsap from 'gsap'
import { Box, Compass, Download, FileText, Gamepad2, House, Menu, Network, Settings, User, type LucideIcon } from 'lucide-react'
import { Button, Tooltip } from './ui'
import { useRunning } from '../contexts/RunningContext.tsx'
import { useI18n } from '../i18n/index.tsx'
import { cn } from '../lib/utils.ts'
import { PluginSidebarItems } from './PluginSidebarItems.tsx'
import { getSettings } from '../api/settings.ts'
import { SidebarExpansionContext, loadSidebarExpanded, saveSidebarExpanded, useSidebarExpanded } from './sidebarExpansion.tsx'

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

/** 主导航列表 id；开关按钮的 aria-controls 指向它 */
const NAV_LIST_ID = 'sidebar-nav'

/** 行内图标槽宽度：与收起态行宽一致，保证两种状态下图标 x 不变 */
const ICON_SLOT = 'flex h-11 w-11 shrink-0 items-center justify-center'

/** 行文字：收起时被行宽裁掉，展开时占满剩余宽度 */
const ROW_LABEL = 'min-w-0 flex-1 truncate whitespace-nowrap text-sm transition-opacity duration-200 anim-transition'

/** 行选中指示条 */
const ROW_INDICATOR = 'absolute left-0 top-1/2 w-0.5 -translate-y-1/2 rounded-r-full bg-primary transition-all duration-200 anim-transition'

export function NavItem({ to, label, icon, end }: { to: string; label: string; icon: React.ReactNode; end?: boolean }) {
  const { expanded } = useSidebarExpanded()

  const link = (
    <NavLink
      to={to}
      end={end}
      aria-label={label}
      className={({ isActive }) =>
        cn(
          'relative flex h-11 items-center overflow-hidden rounded-lg transition-colors duration-200 anim-transition focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
          expanded ? 'w-full' : 'w-11',
          isActive
            ? 'bg-primary/10 text-primary'
            : 'text-muted-foreground hover:bg-accent hover:text-foreground'
        )
      }
    >
      {({ isActive }) => (
        <>
          <span className={cn(ROW_INDICATOR, 'h-5', isActive ? 'scale-y-100 opacity-100' : 'scale-y-0 opacity-0')} />
          <span className={ICON_SLOT}>{icon}</span>
          <span aria-hidden className={cn(ROW_LABEL, expanded ? 'opacity-100' : 'opacity-0')}>
            {label}
          </span>
        </>
      )}
    </NavLink>
  )

  return (
    <li className="relative flex w-full justify-center">
      {expanded ? link : <Tooltip content={label} side="right">{link}</Tooltip>}
    </li>
  )
}

function BottomNavItem({ to, label, icon: IconComp, showPingDot }: { to: string; label: string; icon: LucideIcon; showPingDot?: boolean }) {
  const { expanded } = useSidebarExpanded()

  const link = (
    <NavLink
      to={to}
      aria-label={label}
      className={({ isActive }) =>
        cn(
          'relative flex h-9 items-center overflow-hidden rounded-lg transition-colors duration-200 anim-transition focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
          expanded ? 'w-full' : 'w-11',
          isActive
            ? 'bg-primary/10 text-primary'
            : showPingDot
              ? 'text-green-500 hover:bg-green-500/10'
              : 'text-muted-foreground hover:bg-accent hover:text-foreground'
        )
      }
    >
      {({ isActive }) => (
        <>
          <span className={cn(ROW_INDICATOR, 'h-4', isActive ? 'scale-y-100 opacity-100' : 'scale-y-0 opacity-0')} />
          <span className="flex h-9 w-11 shrink-0 items-center justify-center">
            <span className="relative flex items-center justify-center">
              <IconComp className="h-4 w-4" />
              {showPingDot && (
                <span className="absolute -right-1 -top-1 h-2 w-2 rounded-full bg-green-500 animate-ping" />
              )}
            </span>
          </span>
          <span aria-hidden className={cn(ROW_LABEL, expanded ? 'opacity-100' : 'opacity-0')}>
            {label}
          </span>
        </>
      )}
    </NavLink>
  )

  return (
    <div className="relative flex w-full justify-center">
      {expanded ? link : <Tooltip content={label} side="right">{link}</Tooltip>}
    </div>
  )
}

export default function Sidebar() {
  const { runningInstances } = useRunning()
  const { t } = useI18n()
  const [expanded, setExpanded] = useState(() => loadSidebarExpanded())
  const hasRunning = runningInstances.length > 0
  const links = NAV_LINKS.map(l => ({ ...l, label: t(`layout.sidebar.${l.key}`) }))
  const navRef = useRef<HTMLUListElement>(null)

  // 切换回调同时更新 state 与 localStorage；不在 mount effect 里写入。
  const applyExpanded = useCallback((next: boolean) => {
    setExpanded(next)
    saveSidebarExpanded(next)
  }, [])

  const expansionValue = useMemo(
    () => ({ expanded, setExpanded: applyExpanded }),
    [expanded, applyExpanded]
  )

  const toggleLabel = expanded ? t('layout.sidebar.collapse') : t('layout.sidebar.expand')

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
    <nav
      className={cn(
        'anim-transition sidebar-expand-transition flex shrink-0 flex-col items-center overflow-x-hidden border-r border-border/50 bg-card/80 backdrop-blur-xl shadow-xl shadow-black/20',
        expanded ? 'w-52' : 'w-16'
      )}
    >
      <div className="flex w-full flex-col items-center border-b border-border pb-3 pt-[18px]">
        <div className="flex h-8 w-8 items-center justify-center">
          <img src="/logo.svg" alt="Qomicex" className="h-full w-full rounded-lg object-cover" />
        </div>
      </div>

      <SidebarExpansionContext.Provider value={expansionValue}>
        <div className="flex w-full justify-start px-2.5 py-2">
          <span className={ICON_SLOT}>
            <Tooltip content={toggleLabel} side="right">
              <Button
                type="button"
                variant="ghost"
                size="icon"
                onClick={() => applyExpanded(!expanded)}
                aria-label={toggleLabel}
                aria-expanded={expanded}
                aria-controls={NAV_LIST_ID}
              >
                <Menu className="h-4 w-4" />
              </Button>
            </Tooltip>
          </span>
        </div>

        <ul id={NAV_LIST_ID} ref={navRef} className="flex w-full flex-1 flex-col items-center gap-0.5 px-2.5 py-2">
          {links.map((link) => (
            <NavItem key={link.to} to={link.to} label={link.label} icon={link.icon} end={link.end} />
          ))}
          <PluginSidebarItems />
        </ul>

        <div className="flex w-full flex-col items-center border-t border-border px-2.5 py-2 pb-4 gap-1">
          <BottomNavItem to="/running" label={t('layout.sidebar.running')} icon={Gamepad2} showPingDot={hasRunning} />
          <BottomNavItem to="/settings" label={t('layout.sidebar.settings')} icon={Settings} />
        </div>
      </SidebarExpansionContext.Provider>
    </nav>
  )
}
