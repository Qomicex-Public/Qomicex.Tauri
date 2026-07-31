import { useEffect, useRef } from 'react'
import type { SandboxInstance } from './sandbox.ts'

interface PluginSlotProps {
  slotId: string
  sandbox: SandboxInstance
}

export function PluginSlot({ slotId, sandbox }: PluginSlotProps) {
  const containerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    container.appendChild(sandbox.iframe)

    return () => {
      if (sandbox.iframe.parentElement === container) {
        container.removeChild(sandbox.iframe)
      }
    }
  }, [sandbox])

  return <div ref={containerRef} data-slot-id={slotId} className="plugin-slot" />
}
