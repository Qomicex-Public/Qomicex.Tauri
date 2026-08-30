import { useEffect, useRef } from 'react'
import type { SandboxInstance } from './sandbox.ts'

interface PluginSlotProps {
  slotId: string
  sandbox: SandboxInstance
  /** 可选固定尺寸（px）：用于标题栏等高/宽受控槽位；缺省铺满容器 */
  width?: number
  height?: number
}

export function PluginSlot({ slotId, sandbox, width, height }: PluginSlotProps) {
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

  const style = width != null || height != null
    ? { width: width != null ? `${width}px` : undefined, height: height != null ? `${height}px` : undefined }
    : undefined

  return <div ref={containerRef} data-slot-id={slotId} className="plugin-slot" style={style} />
}
