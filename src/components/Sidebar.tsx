import { NavLink } from 'react-router-dom'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import { faHouse, faCube, faDownload, faUser, faFileLines, faGear, faCompass } from '@fortawesome/free-solid-svg-icons'
import { Tooltip } from './ui/tooltip.tsx'

const links = [
  { to: '/', label: '首页', icon: faHouse },
  { to: '/instances', label: '实例', icon: faCube },
  { to: '/downloads', label: '下载', icon: faDownload },
  { to: '/accounts', label: '账户', icon: faUser },
  { to: '/resource-center', label: '资源中心', icon: faCompass },
  { to: '/log-analysis', label: '日志', icon: faFileLines },
]

export default function Sidebar() {
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

      <div className="flex w-full flex-col items-center border-t border-border px-2 py-2 pb-4">
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
