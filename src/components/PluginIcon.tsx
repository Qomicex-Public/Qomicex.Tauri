import { cn } from '../lib/utils.ts'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import { resolveFaIcon } from './BuiltinIcons.tsx'
import { useIconTheme, type IconThemeEntry } from '../theme/index.ts'

function isImageUrl(s: string): boolean {
  return /^(https?:\/\/|[\w.-]+\/.+\.\w+)/.test(s)
}

function FaIcon({ cls, className }: { cls: string; className?: string }) {
  const icon = resolveFaIcon(cls)
  if (!icon) return null
  return <FontAwesomeIcon icon={icon} className={className} />
}

function ThemeEntryIcon({ entry, className }: { entry: IconThemeEntry; className?: string }) {
  if (entry.type === 'svg') {
    return (
      <svg viewBox="0 0 512 512" fill="currentColor" className={className} aria-hidden="true">
        <path d={entry.path} />
      </svg>
    )
  }
  if (entry.type === 'char') {
    return (
      <span className={className} style={entry.fontFamily ? { fontFamily: entry.fontFamily } : undefined}>
        {entry.codepoint}
      </span>
    )
  }
  return <img src={entry.url} alt="" className={cn('object-contain', className)} />
}

export function PluginIcon({ icon, fallback, className }: { icon?: string; fallback: string; className?: string }) {
  const src = icon || fallback
  const iconTheme = useIconTheme()

  if (iconTheme) {
    const entry = iconTheme.icons[src]
    if (entry) return <ThemeEntryIcon entry={entry} className={className} />
  }

  if (isImageUrl(src)) {
    return <img src={src} alt="" className={cn('object-contain', className)} />
  }

  if (resolveFaIcon(src)) {
    return <FaIcon cls={src} className={className} />
  }

  return null
}
