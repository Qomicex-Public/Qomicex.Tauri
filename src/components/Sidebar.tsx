import { NavLink } from 'react-router-dom'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import { faHouse, faCube, faDownload, faUser, faGear, faCompass, faGamepad, faNetworkWired } from '@fortawesome/free-solid-svg-icons'
import { Tooltip } from './ui/tooltip.tsx'
import { useRunning } from '../contexts/RunningContext.tsx'
import { cn } from '../lib/utils.ts'

const links = [
  { to: '/', label: '首页', icon: faHouse },
  { to: '/instances', label: '实例', icon: faCube },
  { to: '/downloads', label: '下载', icon: faDownload },
  { to: '/accounts', label: '账户', icon: faUser },
  { to: '/resource-center', label: '资源中心', icon: faCompass },
  { to: '/connect', label: '联机', icon: faNetworkWired },
]

export default function Sidebar() {
  const { runningInstances } = useRunning()
  const hasRunning = runningInstances.length > 0

  return (
    <nav className="flex w-16 flex-col items-center border-r border-border/50 bg-card/80 backdrop-blur-xl shadow-xl shadow-black/20">
      <div className="flex w-full flex-col items-center border-b border-border pb-3 pt-[18px]">
        <div className="flex h-8 w-8 items-center justify-center">
          <img src="/icon.png" alt="Qomicex" className="h-full w-full rounded-lg object-cover" />
        </div>
      </div>

      <ul className="flex w-full flex-1 flex-col items-center gap-0.5 px-2 py-2">
        {links.map((link) => (
          <li key={link.to} className="w-full flex justify-center">
            <Tooltip content={link.label} side="right">
              <NavLink
                to={link.to}
                end={link.to === '/'}
                className={({ isActive }) =>
                  `flex h-11 w-11 items-center justify-center rounded-lg text-lg transition-colors ${
                    isActive
                      ? 'bg-primary/10 text-primary [&>svg]:text-primary'
                      : 'text-muted-foreground hover:bg-accent hover:text-foreground'
                  }`
                }
              >
                <FontAwesomeIcon icon={link.icon} className="h-5 w-5" />
              </NavLink>
            </Tooltip>
          </li>
        ))}
      </ul>

      <div className="flex w-full flex-col items-center border-t border-border px-2 py-2 pb-4 gap-1">
        <Tooltip content="运行中" side="right">
          <NavLink
            to="/running"
            className={({ isActive }) =>
              cn(
                'flex h-9 w-9 items-center justify-center rounded-lg text-base transition-colors relative',
                isActive
                  ? 'bg-primary/10 text-primary'
                  : hasRunning
                    ? 'text-green-500 hover:bg-green-500/10'
                    : 'text-muted-foreground hover:bg-accent hover:text-foreground'
              )
            }
          >
            <div className="relative">
              <FontAwesomeIcon icon={faGamepad} className="h-4 w-4" />
              {hasRunning && (
                <span className="absolute -right-0.5 -top-0.5 h-2 w-2 rounded-full bg-green-500 animate-ping" />
              )}
            </div>
          </NavLink>
        </Tooltip>
        <Tooltip content="设置" side="right">
          <NavLink
            to="/settings"
            className={({ isActive }) =>
              `flex h-9 w-9 items-center justify-center rounded-lg text-base transition-colors ${
                isActive
                  ? 'bg-primary/10 text-primary'
                  : 'text-muted-foreground hover:bg-accent hover:text-foreground'
              }`
            }
          >
            <FontAwesomeIcon icon={faGear} className="h-4 w-4" />
          </NavLink>
        </Tooltip>
      </div>
    </nav>
  )
}
