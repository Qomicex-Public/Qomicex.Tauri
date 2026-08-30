import { Fragment } from 'react'
import { usePluginStore } from '../stores/pluginStore.ts'
import { getSlotContent } from '../plugins/slots.tsx'
import type { SlotId } from '../plugins/slots.tsx'

/** 渲染指定槽位下全部插件注册的 UI。订阅插件状态：激活/停用后自动增删。 */
export function SlotHost({ slotId, className, trailingSeparator }: {
  slotId: SlotId
  className?: string
  /** 有内容时在末尾渲染一条竖向分割线（用于标题栏等需与相邻 UI 分隔的槽位） */
  trailingSeparator?: boolean
}) {
  usePluginStore(s => s.plugins)
  const items = getSlotContent(slotId)

  if (items.length === 0) return null

  return (
    <div className={className}>
      {items.map((reg, i) => (
        <Fragment key={`${slotId}-${reg.pluginId}-${i}`}>
          {reg.render()}
        </Fragment>
      ))}
      {trailingSeparator && <div className="mx-1.5 h-4 w-px bg-border/50" aria-hidden="true" />}
    </div>
  )
}
