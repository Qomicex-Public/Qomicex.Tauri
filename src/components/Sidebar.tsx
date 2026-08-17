import { NavLink } from 'react-router-dom'
import type { ReactNode } from 'react'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import { faHouse, faCube, faDownload, faUser, faGear, faCompass, faGamepad, faNetworkWired, faFileLines } from '@fortawesome/free-solid-svg-icons'
import { Tooltip } from './ui'
import { useRunning } from '../contexts/RunningContext.tsx'
import { useI18n } from '../i18n/index.tsx'
import { cn } from '../lib/utils.ts'
import { PluginSidebarItems } from './PluginSidebarItems.tsx'

interface NavLinkDef {
  to: string
  key: 'home' | 'instances' | 'downloads' | 'accounts' | 'resourceCenter' | 'connect' | 'logAnalysis'
  icon: ReactNode
  end?: boolean
}

const NAV_LINKS: readonly NavLinkDef[] = [
  { to: '/', key: 'home', icon: <FontAwesomeIcon icon={faHouse} className="h-5 w-5" />, end: true },
  { to: '/instances', key: 'instances', icon: <FontAwesomeIcon icon={faCube} className="h-5 w-5" /> },
  { to: '/downloads', key: 'downloads', icon: <FontAwesomeIcon icon={faDownload} className="h-5 w-5" /> },
  { to: '/accounts', key: 'accounts', icon: <FontAwesomeIcon icon={faUser} className="h-5 w-5" /> },
  { to: '/resource-center', key: 'resourceCenter', icon: <FontAwesomeIcon icon={faCompass} className="h-5 w-5" /> },
  { to: '/connect', key: 'connect', icon: <FontAwesomeIcon icon={faNetworkWired} className="h-5 w-5" />, end: true },
  { to: '/log-analysis', key: 'logAnalysis', icon: <FontAwesomeIcon icon={faFileLines} className="h-5 w-5" /> },
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

function BottomNavItem({ to, label, icon, showPingDot }: { to: string; label: string; icon: typeof faGamepad; showPingDot?: boolean }) {
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
                <FontAwesomeIcon icon={icon} className="h-4 w-4" />
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

  return (
    <nav className="flex w-16 flex-col items-center border-r border-border/50 bg-card/80 backdrop-blur-xl shadow-xl shadow-black/20">
      <div className="flex w-full flex-col items-center border-b border-border pb-3 pt-[18px]">
        <div className="flex h-8 w-8 items-center justify-center">
          <img src="/logo.svg" alt="Qomicex" className="h-full w-full rounded-lg object-cover" />
        </div>
      </div>

      <ul className="flex w-full flex-1 flex-col items-center gap-0.5 px-2 py-2">
        {links.map((link) => (
          <NavItem key={link.to} to={link.to} label={link.label} icon={link.icon} end={link.end} />
        ))}
        <PluginSidebarItems />
      </ul>
      <div className="flex w-full flex-col items-center border-t border-border px-2 py-2 pb-4 gap-1">
        <BottomNavItem to="/running" label={t('layout.sidebar.running')} icon={faGamepad} showPingDot={hasRunning} />
        <BottomNavItem to="/settings" label={t('layout.sidebar.settings')} icon={faGear} />
      </div>
    </nav>
  )
}
