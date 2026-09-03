import type { ReactNode } from 'react'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import { faMicrosoft, faKeycdn } from '@fortawesome/free-brands-svg-icons'
import { CircleUser } from 'lucide-react'

export function getAccountIcon(loginMethod: string): { icon: ReactNode; color: string } {
  if (loginMethod === 'Microsoft') return { icon: <FontAwesomeIcon icon={faMicrosoft} className="h-2.5 w-2.5" />, color: 'text-green-400' }
  if (loginMethod === 'Offline') return { icon: <CircleUser className="h-2.5 w-2.5" />, color: 'text-yellow-400' }
  return { icon: <FontAwesomeIcon icon={faKeycdn} className="h-2.5 w-2.5" />, color: 'text-purple-400' }
}

export function getAccountTypeLabel(loginMethod: string, t: (key: string) => string): string {
  if (loginMethod === 'Microsoft') return 'Microsoft'
  if (loginMethod === 'Offline') return t('accounts.tabOffline')
  if (loginMethod === 'Yggdrasil') return 'Yggdrasil'
  if (loginMethod === '统一通行证') return t('accounts.tabUnified')
  return loginMethod
}
