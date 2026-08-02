import { cn } from '../lib/utils.ts'

function isImageUrl(s: string): boolean {
  return /^(https?:\/\/|[\w.-]+\/.+\.\w+)/.test(s)
}

export function PluginIcon({ icon, fallback, className }: { icon?: string; fallback: string; className?: string }) {
  const src = icon || fallback
  if (isImageUrl(src)) {
    return <img src={src} alt="" className={cn('object-contain', className)} />
  }
  return <span className={cn('text-sm', className)}>{src}</span>
}
