import { useLayoutEffect, useMemo, useRef, useState } from 'react'
import { GridLayout, useContainerWidth, noCompactor } from 'react-grid-layout'
import type { Layout } from 'react-grid-layout'
import { Eye, Pencil, Plus, RotateCcw, X } from 'lucide-react'
import 'react-grid-layout/css/styles.css'
import { cn } from '../../lib/utils.ts'
import { Button, Tooltip } from '../../components/ui'
import { useDashboard, DEFAULT_WIDGETS, WidgetSizeProvider } from './context.tsx'
import type { WidgetId } from './context.tsx'
import { useI18n } from '../../i18n/index.tsx'

const COLS = 4
const ROW_HEIGHT = 72
/** 拖动位移超过该值（px）的 mouseup 不视为 click（与 RGL 3px drag threshold 配合） */
const DRAG_CLICK_SLOP = 4

export interface WidgetEntry {
  id: WidgetId
  label: string
  node: React.ReactNode
}

export function WidgetGrid({ widgets }: { widgets: WidgetEntry[] }) {
  const { t } = useI18n()
  const { layout, setLayout, editing, setEditing, hiddenWidgets, hideWidget, restoreWidget, resetLayout } = useDashboard()
  const [addPanelOpen, setAddPanelOpen] = useState(false)
  const dragStartRef = useRef<{ x: number; y: number; consumed: boolean } | null>(null)
  const { containerRef, width, mounted } = useContainerWidth()
  const [areaH, setAreaH] = useState(0)
  const areaRef = useRef<HTMLDivElement>(null)

  useLayoutEffect(() => {
    const el = areaRef.current
    if (!el) return
    const measure = () => setAreaH(el.clientHeight)
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    measure()
    // 初始布局/动画/字体加载可能改变容器高度，延迟重测兜底
    const t1 = setTimeout(measure, 300)
    const t2 = setTimeout(measure, 1200)
    window.addEventListener('resize', measure)
    return () => {
      ro.disconnect()
      clearTimeout(t1)
      clearTimeout(t2)
      window.removeEventListener('resize', measure)
    }
  }, [])

  const widgetMap = useMemo(() => new Map(widgets.map(w => [w.id, w])), [widgets])

  const gridLayout: Layout = useMemo(
    () => layout
      .filter(it => !it.hidden && widgetMap.has(it.i as WidgetId))
      .map(it => {
        const def = DEFAULT_WIDGETS.find(d => d.id === it.i)
        return {
          i: it.i, x: it.x, y: it.y, w: it.w, h: it.h,
          minW: def?.minW, minH: def?.minH, maxW: def?.maxW, maxH: def?.maxH,
        }
      }),
    [layout, widgetMap]
  )

  const onLayoutChange = (newLayout: Layout) => {
    if (!editing) return
    setLayout(layout.map(it => {
      const upd = newLayout.find(nl => nl.i === it.i)
      return upd ? { ...it, x: upd.x, y: upd.y, w: upd.w, h: upd.h } : it
    }))
  }

  const hiddenEntries = widgets.filter(w => hiddenWidgets.includes(w.id))

  // 行高动态填满可视区：rows 取布局最低边界（至少 8 行，保持细粒度），clamp 64~84px
  const rows = Math.max(8, ...gridLayout.map(it => it.y + it.h))
  const rowHeight = areaH > 0 ? Math.min(84, Math.max(64, Math.floor((areaH - (rows + 1) * 12) / rows))) : ROW_HEIGHT

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {editing && (
        <div className="glass-surface mb-4 flex flex-wrap items-center justify-between gap-2 rounded-xl border border-border/30 bg-card/70 px-4 py-2.5 backdrop-blur-md">
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Pencil className="h-3.5 w-3.5" />
            {t('dashboard.editMode')}
          </div>
          <div className="flex flex-wrap items-center gap-1">
            {hiddenEntries.map(w => (
              <Tooltip key={w.id} content={t(w.label)}>
                <button
                  onClick={() => restoreWidget(w.id)}
                  className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
                >
                  <Eye className="h-3.5 w-3.5" />
                </button>
              </Tooltip>
            ))}
            <Tooltip content={t('dashboard.addWidget')}>
              <Button variant="ghost" size="sm" onClick={() => setAddPanelOpen(v => !v)} className="h-7 w-7 p-0">
                <Plus className="h-3.5 w-3.5" />
              </Button>
            </Tooltip>
            <Tooltip content={t('dashboard.resetLayout')}>
              <Button variant="ghost" size="sm" onClick={() => { resetLayout(); setAddPanelOpen(false) }} className="h-7 w-7 p-0">
                <RotateCcw className="h-3.5 w-3.5" />
              </Button>
            </Tooltip>
            <Button size="sm" onClick={() => { setEditing(false); setAddPanelOpen(false) }} className="ml-1">
              {t('dashboard.done')}
            </Button>
          </div>
        </div>
      )}

      {addPanelOpen && editing && (
        <div className="glass-surface mb-4 rounded-xl border border-border/30 bg-card/70 p-4 backdrop-blur-md">
          <p className="mb-2 text-[10px] font-semibold uppercase tracking-widest text-muted-foreground/60">{t('dashboard.addWidget')}</p>
          <div className="flex flex-wrap gap-2">
            {hiddenEntries.length > 0 ? hiddenEntries.map(w => (
              <button
                key={w.id}
                onClick={() => restoreWidget(w.id)}
                className="rounded-lg border border-border/40 px-3 py-1.5 text-xs hover:bg-accent"
              >
                <Plus className="mr-1 inline h-3 w-3" />
                {t(w.label)}
              </button>
            )) : (
              <p className="text-xs text-muted-foreground/60">{t('dashboard.allWidgetsVisible')}</p>
            )}
          </div>
        </div>
      )}

      <div ref={areaRef} className="flex min-h-0 flex-1 flex-col">
        <div ref={containerRef}>
          {mounted && (
            <GridLayout
              className={cn('dashboard-grid', editing && 'dashboard-editing')}
              width={width}
              layout={gridLayout}
              gridConfig={{ cols: COLS, rowHeight: rowHeight, margin: [12, 12] }}
              dragConfig={{ enabled: editing, cancel: '.no-drag' }}
              resizeConfig={{ enabled: editing, handles: ['se', 'e', 's'] }}
              compactor={noCompactor}
              onLayoutChange={onLayoutChange}
            >
            {gridLayout.map(it => {
              const w = widgetMap.get(it.i as WidgetId)
              if (!w) return null
              return (
                <div
                  key={it.i}
                  className="group relative h-full"
                  onMouseDownCapture={e => { dragStartRef.current = { x: e.clientX, y: e.clientY, consumed: false } }}
                  onClickCapture={e => {
                    const start = dragStartRef.current
                    if (start && !start.consumed) {
                      start.consumed = true
                      if (Math.abs(e.clientX - start.x) > DRAG_CLICK_SLOP || Math.abs(e.clientY - start.y) > DRAG_CLICK_SLOP) {
                        e.stopPropagation()
                        e.preventDefault()
                      }
                    }
                  }}
                >
                  <WidgetSizeProvider size={{ w: it.w, h: it.h }}>
                    {editing && (
                      <button
                        onClick={() => hideWidget(it.i as WidgetId)}
                        className="absolute right-2 top-2 z-20 flex h-6 w-6 items-center justify-center rounded-full bg-destructive/80 text-white opacity-0 transition-opacity group-hover:opacity-100"
                      >
                        <X className="h-3 w-3" />
                      </button>
                    )}
                    {w.node}
                  </WidgetSizeProvider>
                </div>
              )
            })}
            </GridLayout>
          )}
        </div>
      </div>
    </div>
  )
}
