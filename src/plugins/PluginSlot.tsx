// Copyright (C) 2026 Qomicex Launcher Contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { useLayoutEffect, useRef } from 'react'
import { mountSandbox, unmountSandbox } from './sandbox.ts'
import type { SandboxInstance } from './sandbox.ts'

interface PluginSlotProps {
  slotId: string
  sandbox: SandboxInstance
  /** 可选固定尺寸：number 视作 px，也可传 CSS 长度（如 `clamp(420px,70vh,720px)`）；缺省铺满容器 */
  width?: number | string
  height?: number | string
}

const toLength = (value: number | string) => (typeof value === 'number' ? `${value}px` : value)

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
    ? { width: width != null ? toLength(width) : undefined, height: height != null ? toLength(height) : undefined }
    : undefined

  return <div ref={containerRef} data-slot-id={slotId} className="plugin-slot" style={style} />
}
