import { Check as CheckData, Copy as CopyData } from 'lucide'
import type { IconNode } from 'lucide'
import { MorphIcon } from 'morphicons/react'
import { useEffect, useRef, useState } from 'react'
import { cn } from '../lib/utils.ts'

export function CopyActionIcon({ copied, className, flashMs = 800 }: {
  copied: boolean
  className?: string
  flashMs?: number
}) {
  const [showCheck, setShowCheck] = useState(copied)
  const prev = useRef(copied)

  useEffect(() => {
    if (copied === prev.current) return
    prev.current = copied
    if (copied) {
      setShowCheck(true)
      const t = setTimeout(() => setShowCheck(false), flashMs)
      return () => clearTimeout(t)
    }
  }, [copied, flashMs])

  const icon: IconNode = showCheck ? CheckData : CopyData
  return (
    <MorphIcon icon={icon} className={cn(className, showCheck && 'text-emerald-500')} spring="snappy" reducedMotion="user" />
  )
}