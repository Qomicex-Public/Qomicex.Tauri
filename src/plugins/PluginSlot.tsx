// Copyright (C) 2026 Qomicex Launcher Contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { useLayoutEffect, useRef } from 'react'
import { mountSandbox, unmountSandbox } from './sandbox.ts'
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

  useLayoutEffect(() => {
    const container = containerRef.current
    if (!container) return

    const stopTracking = mountSandbox(sandbox, container)

    return () => {
      // 槽位/设置页沙箱卸载即脱离文档（它们只服务当前可见 UI），由持有者在插件
      // 停用时销毁；常驻主沙箱则退回隐藏位置，见 unmountSandbox。
      stopTracking()
      unmountSandbox(sandbox)
    }
  }, [sandbox])

  const style = width != null || height != null
    ? { width: width != null ? `${width}px` : undefined, height: height != null ? `${height}px` : undefined }
    : undefined

  return <div ref={containerRef} data-slot-id={slotId} className="plugin-slot" style={style} />
}
