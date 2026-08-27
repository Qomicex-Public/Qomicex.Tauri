import { cn } from '../lib/utils.ts'
import { Check as CheckData } from 'lucide'
import type { IconNode } from 'lucide'
import { MorphIcon } from 'morphicons/react'
import { useEffect, useRef, useState } from 'react'

type Phase = 'idle' | 'busy' | 'success'

export function MorphActionIcon({ active, busy, rest, className, flashMs = 800 }: {
  active: boolean
  busy: IconNode
  rest: IconNode
  className?: string
  flashMs?: number
}) {
  const [phase, setPhase] = useState<Phase>(active ? 'busy' : 'idle')
  const prev = useRef(active)

  useEffect(() => {
    if (active === prev.current) return
    prev.current = active
    if (active) {
      setPhase('busy')
    } else {
      setPhase('success')
      const t = setTimeout(() => setPhase('idle'), flashMs)
      return () => clearTimeout(t)
    }
  }, [active, flashMs])

  const icon = phase === 'busy' ? busy : phase === 'success' ? CheckData : rest
  return (
    <MorphIcon icon={icon} className={cn(className, phase === 'busy' && 'animate-spin')} spring="snappy" reducedMotion="user" />
  )
}