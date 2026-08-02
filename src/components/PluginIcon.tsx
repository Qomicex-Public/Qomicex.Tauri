import { cn } from '../lib/utils.ts'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import { resolveFaIcon } from './BuiltinIcons.tsx'

function isImageUrl(s: string): boolean {
  return /^(https?:\/\/|[\w.-]+\/.+\.\w+)/.test(s)
}

function FaIcon({ cls, className }: { cls: string; className?: string }) {
  const icon = resolveFaIcon(cls)
  if (!icon) return null
  return <FontAwesomeIcon icon={icon} className={className} />
}

export function PluginIcon({ icon, fallback, className }: { icon?: string; fallback: string; className?: string }) {
  const src = icon || fallback

  if (isImageUrl(src)) {
    return <img src={src} alt="" className={cn('object-contain', className)} />
  }

  if (resolveFaIcon(src)) {
    return <FaIcon cls={src} className={className} />
  }

  return <span className={cn('text-sm', className)}>{src}</span>
}
