import type { ReactNode } from 'react'

export type SlotId =
  | 'sidebar:bottom'
  | 'settings:pages'
  | 'instance:actions'
  | 'header:right'
  | 'dashboard:widgets'

interface SlotRegistration {
  slotId: SlotId
  pluginId: string
  render: () => ReactNode
}

const slotRegistry = new Map<SlotId, SlotRegistration[]>()

export function registerSlot(
  pluginId: string,
  slotId: SlotId,
  render: () => ReactNode
) {
  if (!slotRegistry.has(slotId)) {
    slotRegistry.set(slotId, [])
  }
  slotRegistry.get(slotId)!.push({ slotId, pluginId, render })
}

export function getSlotContent(slotId: SlotId): SlotRegistration[] {
  return slotRegistry.get(slotId) || []
}

export function unregisterPluginSlots(pluginId: string) {
  for (const [slotId, registrations] of slotRegistry.entries()) {
    const filtered = registrations.filter(r => r.pluginId !== pluginId)
    if (filtered.length === 0) {
      slotRegistry.delete(slotId)
    } else {
      slotRegistry.set(slotId, filtered)
    }
  }
}
