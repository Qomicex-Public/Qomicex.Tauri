import { Check as CheckData, Copy as CopyData } from 'lucide'
import type { IconNode } from 'lucide'
import { MorphIcon } from 'morphicons/react'
import { useEffect, useRef, useState } from 'react'
import { cn } from '../lib/utils.ts'

/**
 * 复制按钮图标：`Copy` 点击后形变为 `Check`（绿色），`flashMs` 后形变复位。
 *
 * 定时器**必须放在 ref 里、且不受 `copied` 变回 false 的影响**：
 * 若把它挂在依赖 `copied` 的 effect 里返回 cleanup，父级按约定在同样时长（默认也是
 * 800ms）把 `copied` 置回 false 时，cleanup 会**恰好清掉那个尚未触发的复位定时器**，
 * 于是图标永久停在勾选态、第二次点击也不再触发动画（第一次点击后 `copied` 已恒为
 * false，没有 false→true 跳变）。
 *
 * 因此这里只在 `copied === true` 时启动/续期定时器，卸载时单独清理。
 */
export function CopyActionIcon({ copied, className, flashMs = 800 }: {
  copied: boolean
  className?: string
  flashMs?: number
}) {
  const [showCheck, setShowCheck] = useState(copied)
  const timerRef = useRef<number | null>(null)

  useEffect(() => {
    if (!copied) return
    setShowCheck(true)
    // 连点续期：清掉上一次尚未触发的复位定时器，避免旧定时器提前抹掉新一次的勾选态。
    if (timerRef.current) window.clearTimeout(timerRef.current)
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null
      setShowCheck(false)
    }, flashMs)
  }, [copied, flashMs])

  // 仅卸载时清理，避免在 `copied` 回落时误清复位定时器（见上方注释）。
  useEffect(() => () => {
    if (timerRef.current) window.clearTimeout(timerRef.current)
  }, [])

  const icon: IconNode = showCheck ? CheckData : CopyData
  return (
    <MorphIcon icon={icon} className={cn(className, showCheck && 'text-emerald-500')} spring="snappy" reducedMotion="user" />
  )
}
