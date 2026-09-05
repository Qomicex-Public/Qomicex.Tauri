import { useEffect, useMemo } from 'react'
import { Pencil } from 'lucide-react'
import { usePluginStore } from '../stores/pluginStore.ts'
import { getSlotContent } from '../plugins/slots.tsx'
import { usePageAnimation } from '../hooks/usePageAnimation.ts'
import { useMessageBox } from '../components/ui'
import { MicrosoftReauthDialog } from '../components/MicrosoftReauthDialog.tsx'
import { AccountSelectDialog } from '../components/AccountSelectDialog.tsx'
import { NoAccountDialog } from '../components/NoAccountDialog.tsx'
import { useI18n } from '../i18n/index.tsx'
import { DashboardProvider, useDashboard, DEFAULT_WIDGETS } from './dashboard/context.tsx'
import type { WidgetId, WidgetLayoutItem } from './dashboard/context.tsx'
import { WidgetGrid, type WidgetEntry } from './dashboard/WidgetGrid.tsx'
import { WatermarkWidget, AccountWidget, InstanceWidget, AnnouncementWidget } from './dashboard/widgets.tsx'

function DashboardContent() {
  const { t } = useI18n()
  const plugins = usePluginStore(s => s.plugins)
  const { layout, setLayout, editing, setEditing, showMicrosoftReauth, setShowMicrosoftReauth, defaultAccount, showNoAccount, showSelectAccount, handleAddAccount, handleGoToAccounts, handleCancelNoAccount, handleCancelSelect, handleSelectAccount } = useDashboard()

  const widgets = useMemo<WidgetEntry[]>(() => {
    const staticEntries: WidgetEntry[] = [
      { id: 'watermark', label: t('dashboard.widget.watermark'), node: <WatermarkWidget /> },
      { id: 'account', label: t('dashboard.widget.account'), node: <AccountWidget /> },
      { id: 'instance', label: t('dashboard.widget.instance'), node: <InstanceWidget /> },
      { id: 'announcements', label: t('dashboard.widget.announcements'), node: <AnnouncementWidget /> },
    ]
    const pluginEntries: WidgetEntry[] = getSlotContent('dashboard:widgets').map((reg, i) => ({
      id: `plugin:${reg.pluginId}:${i}` as WidgetId,
      label: reg.pluginId,
      node: (
        <div className="glass-surface h-full overflow-hidden rounded-xl border border-border/30 bg-card/70 backdrop-blur-md [&>*]:h-full">
          {reg.render()}
        </div>
      ),
    }))
    return [...staticEntries, ...pluginEntries]
  }, [plugins, t])

  useEffect(() => {
    const known = new Set<string>(widgets.map(w => w.id))
    const inLayout = new Set(layout.map(it => it.i))
    const missing = widgets.filter(w => !inLayout.has(w.id))
    const stale = layout.some(it => !known.has(it.i))
    if (missing.length === 0 && !stale) return
    const cleaned = layout.filter(it => known.has(it.i))
    let y = cleaned.reduce((m, it) => Math.max(m, it.y + it.h), 0)
    const appended: WidgetLayoutItem[] = missing.map(w => {
      const def = DEFAULT_WIDGETS.find(d => d.id === w.id)
      const item: WidgetLayoutItem = {
        i: w.id, x: 0, y, w: def?.defaultLayout.w ?? 2, h: def?.defaultLayout.h ?? 1,
      }
      y += item.h
      return item
    })
    setLayout([...cleaned, ...appended])
  }, [widgets, layout, setLayout])

  return (
    <>
      <div className="mb-2 flex justify-end">
        {!editing && (
          <button
            onClick={() => setEditing(true)}
            className="flex h-7 items-center gap-1.5 rounded-md px-2 text-xs text-muted-foreground/50 transition-colors hover:bg-accent hover:text-foreground"
          >
            <Pencil className="h-3.5 w-3.5" />
            {t('dashboard.editLayout')}
          </button>
        )}
      </div>
      <WidgetGrid widgets={widgets} />
      <AccountSelectDialog open={showSelectAccount} onClose={handleCancelSelect} onSelect={handleSelectAccount} />
      <NoAccountDialog open={showNoAccount} onClose={handleCancelNoAccount} onAddAccount={handleAddAccount} onGoToAccounts={handleGoToAccounts} />
      <MicrosoftReauthDialog open={showMicrosoftReauth} onClose={() => setShowMicrosoftReauth(false)} expiredAccountUuid={defaultAccount?.uuid} />
    </>
  )
}

export default function Dashboard() {
  useMessageBox()
  const pageRef = usePageAnimation()

  return (
    <div ref={pageRef} className="relative flex flex-1 min-h-0 flex-col overflow-y-auto scroll-fade-mask p-8">
      <DashboardProvider>
        <DashboardContent />
      </DashboardProvider>
    </div>
  )
}
