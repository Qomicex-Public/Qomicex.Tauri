import { useEffect, useRef, useState, useCallback, type ReactNode } from 'react'
import { Box, Copy, RotateCw, TriangleAlert, WandSparkles, X } from 'lucide-react'
import { Dialog, DialogHeader, DialogTitle, DialogBody, DialogFooter, Button, Tooltip } from './ui/index.ts'
import { useI18n } from '../i18n/index.tsx'
import { getSchematicBytes, getSchematicAssets } from '../api/instance-files.ts'
import { parseLitematic, type LitematicFile } from '../lib/litematic.ts'
import { buildResources, SchematicViewer, computeWorldBox } from '../lib/schematic-viewer.ts'
import { cn } from '../lib/utils.ts'
import { ApiError } from '../api/client.ts'
import type { SchematicAssetsBundle } from '../types/index.ts'

const WARN_BLOCK_CAP = 500_000
const HARD_BLOCK_CAP = 2_000_000

interface Props {
  open: boolean
  instanceId: string
  fileName: string
  onClose: () => void
}

type Stage = 'loading' | 'rendering' | 'ready' | 'error'

export default function SchematicPreviewDialog({ open, instanceId, fileName, onClose }: Props) {
  const { t } = useI18n()
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const viewerRef = useRef<SchematicViewer | null>(null)
  const litematicRef = useRef<LitematicFile | null>(null)
  const [stage, setStage] = useState<Stage>('loading')
  const [error, setError] = useState<string | null>(null)
  const [litematic, setLitematic] = useState<LitematicFile | null>(null)
  const [missing, setMissing] = useState<string[]>([])
  const [overCap, setOverCap] = useState(false)
  const [yMin, setYMin] = useState(0)
  const [yMax, setYMax] = useState(0)
  const [height, setHeight] = useState(1)
  const [materialsOpen, setMaterialsOpen] = useState(false)
  const [sensitivity, setSensitivity] = useState(1)
  const [moveSpeed, setMoveSpeed] = useState(1)
  const rebuildTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => { viewerRef.current?.setSensitivity(sensitivity) }, [sensitivity])
  useEffect(() => { viewerRef.current?.setMoveSpeed(moveSpeed) }, [moveSpeed])

  const load = useCallback(async () => {
    setStage('loading')
    setError(null)
    setLitematic(null)
    setMissing([])
    setOverCap(false)
    setSensitivity(1)
    setMoveSpeed(1)
    viewerRef.current?.dispose()
    viewerRef.current = null
    try {
      const bytes = await getSchematicBytes(instanceId, fileName)
      const parsed = parseLitematic(bytes)
      setLitematic(parsed)
      litematicRef.current = parsed
      const total = parsed.metadata.totalBlocks || parsed.materials.reduce((s, m) => s + m.count, 0)
      const cap = total > HARD_BLOCK_CAP
      setOverCap(cap)
      const box = computeWorldBox(parsed)
      setHeight(Math.max(1, box.height))
      setYMin(0)
      setYMax(Math.max(0, box.height - 1))
      if (cap) {
        setStage('ready')
        return
      }
      setStage('rendering')
      const bundle: SchematicAssetsBundle = await getSchematicAssets(instanceId, parsed.paletteNames)
      const resources = await buildResources(bundle)
      if (!canvasRef.current) return
      const viewer = new SchematicViewer(canvasRef.current, parsed, bundle, resources)
      viewerRef.current = viewer
      setMissing(viewer.getMissingBlocks())
      setStage('ready')
    } catch (e) {
      setStage('error')
      setError(
        e instanceof ApiError
          ? e.displayMessage
          : e instanceof Error
            ? e.message
            : String(e),
      )
    }
  }, [instanceId, fileName])

  const applyYRange = useCallback((viewer: SchematicViewer | null, min: number, max: number) => {
    if (!viewer) return
    if (rebuildTimer.current) clearTimeout(rebuildTimer.current)
    rebuildTimer.current = setTimeout(() => {
      viewer.setYRange(min, max)
    }, 120)
  }, [])

  useEffect(() => {
    if (!open) return
    load()
    return () => {
      viewerRef.current?.dispose()
      viewerRef.current = null
      if (rebuildTimer.current) clearTimeout(rebuildTimer.current)
    }
  }, [open, load])

  // Canvas sizing when rendering starts. The render area keeps a FIXED size
  // (proportional to the window), so opening/closing the material list never
  // reshapes the render and stretches it. Whenever the buffer does change we
  // re-apply the viewport so the projection matches (no distortion).
  useEffect(() => {
    if (stage === 'rendering' || stage === 'ready') {
      const canvas = canvasRef.current
      if (!canvas) return
      const resize = () => {
        if (!canvas || !canvas.parentElement) return
        const parent = canvas.parentElement
        canvas.width = parent.clientWidth
        canvas.height = parent.clientHeight
        viewerRef.current?.resize()
      }
      resize()
      const observer = new ResizeObserver(resize)
      if (canvas.parentElement) observer.observe(canvas.parentElement)
      return () => observer.disconnect()
    }
  }, [stage])

  useEffect(() => {
    applyYRange(viewerRef.current, yMin, yMax)
  }, [yMin, yMax, applyYRange])

  if (!open) return null

  const totalBlocks = litematic?.metadata.totalBlocks || litematic?.materials.reduce((s, m) => s + m.count, 0) || 0
  const warnSize = totalBlocks > WARN_BLOCK_CAP && totalBlocks <= HARD_BLOCK_CAP

  const copyMaterials = async () => {
    if (!litematic) return
    const text = litematic.materials
      .map((m) => `${m.name.replace('minecraft:', '')}\t${m.count}`)
      .join('\n')
    try {
      await navigator.clipboard.writeText(text)
    } catch { /* ignore */ }
  }

  return (
    <Dialog open={open} onClose={onClose} className="max-w-5xl">
      <DialogHeader onClose={onClose}>
        <DialogTitle className="flex items-center gap-2">
          <WandSparkles className="h-4 w-4 text-primary" />
          {t('instanceDetail.schematics.previewTitle', { name: fileName })}
        </DialogTitle>
      </DialogHeader>
      <DialogBody className="p-0">
        {stage === 'loading' ? (
          <div className="flex h-72 flex-col items-center justify-center gap-3 text-sm text-muted-foreground">
            <RotateCw className="h-5 w-5 animate-spin" />
            {t('instanceDetail.schematics.parsing')}
          </div>
        ) : stage === 'error' ? (
          <div className="flex h-72 flex-col items-center justify-center gap-3 px-6 text-center">
            <TriangleAlert className="h-6 w-6 text-destructive" />
            <p className="text-sm text-destructive">{error}</p>
            <Button size="sm" variant="outline" onClick={load}>重试</Button>
          </div>
        ) : (
          <div className="flex flex-col">
            {overCap && (
              <div className="flex items-center gap-2 border-b border-border bg-destructive/10 px-4 py-2 text-xs text-destructive">
                <TriangleAlert className="h-3.5 w-3.5" />
                {t('instanceDetail.schematics.overCap')}
              </div>
            )}
            {warnSize && (
              <div className="flex items-center gap-2 border-b border-border bg-amber-500/10 px-4 py-2 text-xs text-amber-600">
                <TriangleAlert className="h-3.5 w-3.5" />
                {t('instanceDetail.schematics.largeSize', { count: totalBlocks })}
              </div>
            )}
            {litematic && (
              <div className="flex items-center gap-3 border-b border-border px-4 py-2 text-xs text-muted-foreground">
                <span className="font-medium text-foreground">{litematic.metadata.name}</span>
                {litematic.metadata.author && <span>{t('instanceDetail.schematics.byAuthor', { author: litematic.metadata.author })}</span>}
                <span>[{litematic.regions.map((r) => `${r.size.x}×${r.size.y}×${r.size.z}`).join(', ')}]</span>
                <span>{t('instanceDetail.schematics.totalBlocks', { count: totalBlocks })}</span>
                {overCap && <span className="text-muted-foreground/60">{t('instanceDetail.schematics.materialsOnly')}</span>}
                {missing.length > 0 && (
                  <span className="text-amber-600/80">{t('instanceDetail.schematics.missingBlocks', { count: missing.length })}</span>
                )}
              </div>
            )}
            {/* Fixed render size proportional to the window — the material list
                panel scrolls within this height instead of reshaping the render. */}
            <div className="flex h-[60vh] min-h-[24rem]">
              {/* Canvas is mounted during BOTH rendering and ready so the
                  viewer can attach its WebGL context as soon as resources are built. */}
              <div className="relative flex-1">
                <canvas ref={canvasRef} className={cn('absolute inset-0 h-full w-full', overCap && 'hidden')} />
                {stage === 'rendering' && (
                  <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-background/60 text-sm text-muted-foreground">
                    <RotateCw className="h-5 w-5 animate-spin" />
                    {t('instanceDetail.schematics.buildingPreview')}
                  </div>
                )}
                {overCap && (
                  <div className="flex h-full w-full items-center justify-center text-sm text-muted-foreground">
                    <Box className="mr-2 h-5 w-5" />
                    {t('instanceDetail.schematics.overCapHint')}
                  </div>
                )}
                {!overCap && stage === 'ready' && (
                  <div className="pointer-events-none absolute bottom-2 left-2 rounded bg-background/80 px-2 py-1 text-[10px] text-muted-foreground backdrop-blur">
                    {t('instanceDetail.schematics.controlsHint')}
                  </div>
                )}
              </div>
              <div className="flex w-60 flex-col border-l border-border">
                {!overCap && litematic && (
                  <div className="space-y-3 border-b border-border p-3">
                    <div>
                      <Label className="text-[11px]">{t('instanceDetail.schematics.minY')}</Label>
                      <input
                        type="range"
                        min={0}
                        max={Math.max(0, height - 1)}
                        value={yMin}
                        onChange={(e) => setYMin(Math.min(Number(e.target.value), yMax))}
                        className="w-full"
                      />
                    </div>
                    <div>
                      <Label className="text-[11px]">{t('instanceDetail.schematics.maxY')}</Label>
                      <input
                        type="range"
                        min={0}
                        max={Math.max(0, height - 1)}
                        value={yMax}
                        onChange={(e) => setYMax(Math.max(Number(e.target.value), yMin))}
                        className="w-full"
                      />
                    </div>
                    <div>
                      <Label className="text-[11px]">{t('instanceDetail.schematics.mouseSensitivity')}<span className="ml-1 text-muted-foreground/60">{sensitivity.toFixed(1)}x</span></Label>
                      <input
                        type="range"
                        min={0.1}
                        max={5}
                        step={0.1}
                        value={sensitivity}
                        onChange={(e) => setSensitivity(Number(e.target.value))}
                        className="w-full"
                      />
                    </div>
                    <div>
                      <Label className="text-[11px]">{t('instanceDetail.schematics.moveSpeed')}<span className="ml-1 text-muted-foreground/60">{moveSpeed.toFixed(1)}x</span></Label>
                      <input
                        type="range"
                        min={0.2}
                        max={5}
                        step={0.1}
                        value={moveSpeed}
                        onChange={(e) => setMoveSpeed(Number(e.target.value))}
                        className="w-full"
                      />
                    </div>
                  </div>
                )}
                {litematic && (
                  <div className="flex flex-1 flex-col overflow-hidden">
                    <div className="flex items-center justify-between px-3 py-2">
                      <button
                        className="text-xs font-medium text-foreground/80 hover:text-foreground"
                        onClick={() => setMaterialsOpen((v) => !v)}
                      >
                        {t('instanceDetail.schematics.materials', { count: litematic.materials.length })}
                      </button>
                      <Tooltip content={t('instanceDetail.schematics.copy')}>
                        <button onClick={copyMaterials} className="text-muted-foreground hover:text-foreground">
                          <Copy className="h-3.5 w-3.5" />
                        </button>
                      </Tooltip>
                    </div>
                    {materialsOpen && (
                      <div className="flex-1 overflow-y-auto px-1 pb-2">
                        {litematic.materials.map((m) => (
                          <div
                            key={m.name}
                            className="flex items-center justify-between gap-2 rounded px-2 py-1 text-xs hover:bg-accent/50"
                          >
                            <span className="truncate">{m.name.replace('minecraft:', '')}</span>
                            <span className="tabular-nums text-muted-foreground">{m.count}</span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>
          </div>
        )}
      </DialogBody>
      <DialogFooter>
        <Button size="sm" variant="outline" onClick={onClose}>
          <X className="h-3.5 w-3.5" />
          {t('instanceDetail.confirm.cancel')}
        </Button>
      </DialogFooter>
    </Dialog>
  )
}

function Label({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={`text-muted-foreground ${className ?? ''}`}>{children}</div>
}