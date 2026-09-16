import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import { Layers, Map as MapIcon, Minus, Plus, RotateCw, TriangleAlert, X } from 'lucide-react'
import { Button, Dialog, DialogBody, DialogFooter, DialogHeader, DialogTitle, Tooltip } from './ui/index.ts'
import { useI18n } from '../i18n/index.tsx'
import {
  openWorld,
  closeWorld,
  tileUrlTemplate,
  worldKeyOf,
  probeBlock,
  WorldApiError,
  DEFAULT_RENDER_FLAGS,
  type RenderFlags,
} from '../api/world-view.ts'
import { CachedTileLayer } from '../lib/world-tile-layer.ts'
import { cn } from '../lib/utils.ts'
import type { WorldInfo, WorldBlockInfo } from '../types/index.ts'

const MIN_ZOOM = 0
const MAX_ZOOM = 4

interface Props {
  open: boolean
  instanceId: string
  /** 存档目录名（API 路径用）。 */
  saveName: string
  /** 存档绝对路径（生成瓦片缓存键）。 */
  savePath: string
  onClose: () => void
}

type Stage = 'loading' | 'ready' | 'error'

/** 路径点/玩家名来自用户文件，弹窗内容是 HTML，必须转义。 */
function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c,
  )
}

/** 某个维度的垂直范围，缺失时回退到原版旧范围。 */
function rangeOf(world: WorldInfo, id: number): { min: number; max: number } {
  const d = world.dimensions.find((x) => x.id === id)
  return { min: d?.minY ?? 0, max: d?.maxY ?? 255 }
}

export default function WorldPreviewDialog({ open, instanceId, saveName, savePath, onClose }: Props) {
  const { t } = useI18n()
  const mapDivRef = useRef<HTMLDivElement | null>(null)
  const mapRef = useRef<L.Map | null>(null)
  const layerRef = useRef<CachedTileLayer | null>(null)
  const markersRef = useRef<L.LayerGroup | null>(null)
  const worldKeyRef = useRef('')

  const [stage, setStage] = useState<Stage>('loading')
  const [error, setError] = useState<string | null>(null)
  const [info, setInfo] = useState<WorldInfo | null>(null)
  const [dim, setDim] = useState(0)
  const [ymax, setYmax] = useState(255)
  const [mouse, setMouse] = useState<{ x: number; z: number } | null>(null)
  const [block, setBlock] = useState<WorldBlockInfo | null>(null)
  const [zoom, setZoom] = useState(1)
  const [flags, setFlags] = useState<RenderFlags>(DEFAULT_RENDER_FLAGS)

  const activeDim = useMemo(
    () => info?.dimensions.find((d) => d.id === dim) ?? null,
    [info, dim],
  )
  // 当前维度的垂直范围。1.20+ 主世界到 Y=319，旧存档 0..255，模组数据包还能
  // 改动两端，因此滑块范围与「全高」判定都跟随世界自身，而不是固定 255。
  const range = { min: activeDim?.minY ?? 0, max: activeDim?.maxY ?? 255 }
  const atFullHeight = ymax >= range.max

  // 悬停探测：150ms 节流 + 递增序号丢弃过期响应（慢回包不得覆盖新结果）。
  // mousemove 只注册一次，故通过 ref 读取当前的 dim/ymax/是否已加载。
  const probeSeqRef = useRef(0)
  const probeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const latestRef = useRef({ loaded: false, dim: 0, ymax: 255, maxY: 255, key: '' })
  latestRef.current = {
    loaded: !!info,
    dim,
    ymax,
    maxY: range.max,
    key: worldKeyRef.current,
  }
  const lastProbeRef = useRef<{ x: number; z: number } | null>(null)

  const runProbe = useCallback(async (x: number, z: number) => {
    lastProbeRef.current = { x, z }
    const cur = latestRef.current
    if (!cur.loaded) {
      setBlock(null)
      return
    }
    const seq = ++probeSeqRef.current
    try {
      const r = await probeBlock(instanceId, cur.key, cur.dim, x, z, cur.ymax, cur.maxY)
      if (seq === probeSeqRef.current) setBlock(r)
    } catch {
      if (seq === probeSeqRef.current) setBlock(null)
    }
  }, [instanceId])

  const scheduleProbe = useCallback(
    (x: number, z: number) => {
      lastProbeRef.current = { x, z }
      if (probeTimerRef.current !== null) return
      probeTimerRef.current = setTimeout(() => {
        probeTimerRef.current = null
        const p = lastProbeRef.current
        if (p) void runProbe(p.x, p.z)
      }, 150)
    },
    [runProbe],
  )

  useEffect(() => {
    return () => {
      if (probeTimerRef.current !== null) clearTimeout(probeTimerRef.current)
    }
  }, [])

  // --- 地图生命周期 ---

  const ensureMap = useCallback((): L.Map | null => {
    if (mapRef.current) return mapRef.current
    if (!mapDivRef.current) return null
    const map = L.map(mapDivRef.current, {
      crs: L.CRS.Simple,
      minZoom: MIN_ZOOM,
      maxZoom: MAX_ZOOM,
      // 用启动器 Button 组件自绘缩放控件（Leaflet 原生的是白色方块 + 粗体字符，
      // 与启动器的圆角/暗色/图标风格不搭）。见下方 overlay。
      zoomControl: false,
      attributionControl: false,
      zoomSnap: 0.25,
    })
    map.setView([0, 0], 1)
    setZoom(map.getZoom())
    // CRS.Simple：lat = -worldZ，lng = worldX（zoom 0 时 1 单位 = 1 方块）
    map.on('mousemove', (e: L.LeafletMouseEvent) => {
      const x = Math.round(e.latlng.lng)
      const z = Math.round(-e.latlng.lat)
      setMouse({ x, z })
      scheduleProbe(x, z)
    })
    map.on('zoomend', () => setZoom(map.getZoom()))
    mapRef.current = map
    return map
  }, [scheduleProbe])

  const buildTileLayer = useCallback(
    (map: L.Map, dimension: number, height: number, maxY: number, flags: RenderFlags) => {
      const template = tileUrlTemplate(
        instanceId,
        worldKeyRef.current,
        dimension,
        height,
        maxY,
        flags,
      )
      const existing = layerRef.current
      if (existing) {
        // 复用图层（连同缓存），除非世界、高度切层或渲染开关变化。三者都在
        // URL 里，因此切换存档会在这里被识别并丢弃上一个世界的瓦片。
        if (existing.getUrlTemplate() !== template) existing.clearCache()
        existing.setUrlTemplate(template)
        existing.redraw()
        return
      }
      const layer = new CachedTileLayer({
        minZoom: MIN_ZOOM,
        maxZoom: MAX_ZOOM,
        noWrap: true,
        maxConcurrent: 6,
        keepBuffer: 3,
        updateWhenIdle: false,
        updateWhenZooming: true,
      })
      layer.setUrlTemplate(template)
      layer.addTo(map)
      layerRef.current = layer
    },
    [instanceId],
  )

  const drawMarkers = useCallback((map: L.Map, world: WorldInfo, dimension: number) => {
    if (markersRef.current) map.removeLayer(markersRef.current)
    const group = L.layerGroup()
    for (const wp of world.waypoints.filter((w) => w.dimension === dimension)) {
      L.circleMarker([-wp.z, wp.x], {
        radius: 7,
        color: '#000',
        weight: 1.5,
        fillColor: wp.color,
        fillOpacity: 0.95,
      })
        .bindPopup(
          `<b>${esc(wp.name)}</b><br/>${esc(wp.kind)} · ${esc(wp.source)}<br/>` +
            `X=${wp.x} Y=${wp.y} Z=${wp.z}`,
        )
        .addTo(group)
    }
    const p = world.player
    if (p && p.dimension === dimension) {
      L.circleMarker([-p.z, p.x], {
        radius: 9,
        color: '#fff',
        weight: 3,
        fillColor: '#e33',
        fillOpacity: 1,
      })
        .bindPopup(
          `<b>${esc(p.name)}</b><br/>X=${p.x.toFixed(1)} Y=${p.y.toFixed(1)} Z=${p.z.toFixed(1)}`,
        )
        .addTo(group)
    }
    group.addTo(map)
    markersRef.current = group
  }, [])

  // --- 加载存档 ---

  const load = useCallback(async () => {
    setStage('loading')
    setError(null)
    setInfo(null)
    setMouse(null)
    layerRef.current?.clearCache()
    const key = worldKeyOf(savePath)
    worldKeyRef.current = key
    try {
      const res = await openWorld(instanceId, saveName, key)
      const world = res.info
      setInfo(world)
      const map = ensureMap()
      // 优先打开第一个真正有区块的维度，避免存档第一个列出的维度是空的、
      // 打开后看到一张空白地图。
      const first =
        world.dimensions.find((d) => d.hasData)?.id ?? world.dimensions[0]?.id ?? 0
      const firstRange = rangeOf(world, first)
      setDim(first)
      setYmax(firstRange.max)
      setStage('ready')
      if (map) {
        buildTileLayer(map, first, firstRange.max, firstRange.max, flags)
        drawMarkers(map, world, first)
        const p = world.player
        if (p) map.setView([-p.z, p.x], 2)
        else map.setView([0, 0], 1)
        layerRef.current?.redraw()
      }
    } catch (e) {
      setStage('error')
      setError(e instanceof WorldApiError ? e.message : String(e))
    }
  }, [instanceId, saveName, savePath, ensureMap, buildTileLayer, drawMarkers])

  useEffect(() => {
    if (!open) return
    load()
    return () => {
      mapRef.current?.remove()
      mapRef.current = null
      layerRef.current = null
      markersRef.current = null
      closeWorld(instanceId).catch(() => {})
    }
  }, [open, load, instanceId])

  // 地图容器尺寸变化（对话框动画/窗口缩放）时刷新 Leaflet 内部尺寸，
  // 否则瓦片网格会错位。
  useEffect(() => {
    if (stage !== 'ready') return
    const el = mapDivRef.current
    if (!el) return
    const observer = new ResizeObserver(() => mapRef.current?.invalidateSize())
    observer.observe(el)
    return () => observer.disconnect()
  }, [stage])

  const switchDim = useCallback(
    (id: number) => {
      setDim(id)
      setBlock(null)
      const map = mapRef.current
      if (!map || !info) return
      // 每个维度有各自的垂直范围，因此高度过滤重置到新维度的天花板，
      // 而不是把旧值带过去（那会越界或误截断）。
      const nextRange = rangeOf(info, id)
      const nextYmax = Math.min(ymax, nextRange.max)
      setYmax(nextYmax)
      buildTileLayer(map, id, nextYmax, nextRange.max, flags)
      drawMarkers(map, info, id)
      // 飞到该维度的玩家位置，否则首个路径点，否则原点。
      const p = info.player && info.player.dimension === id ? info.player : null
      const wp = info.waypoints.find((w) => w.dimension === id)
      if (p) map.setView([-p.z, p.x], 2)
      else if (wp) map.setView([-wp.z, wp.x], 2)
      else map.setView([0, 0], 1)
    },
    [info, ymax, flags, buildTileLayer, drawMarkers],
  )

  const applyYmax = useCallback(
    (v: number) => {
      setYmax(v)
      const map = mapRef.current
      if (map) buildTileLayer(map, dim, v, range.max, flags)
    },
    [dim, range.max, buildTileLayer, flags],
  )

  /**
   * 切换一个渲染开关。立即以新值重建瓦片图层，而不是依赖 React 状态更新时序
   * （`buildTileLayer` 需要拿到新值，`setFlags` 后同一轮里 `flags` 还是旧的）。
   */
  const toggleFlag = (key: keyof RenderFlags) => {
    const next = { ...flags, [key]: !flags[key] }
    setFlags(next)
    const map = mapRef.current
    if (!map) return
    buildTileLayer(map, dim, ymax, range.max, next)
  }

  /** 自绘缩放控件：步进与 Leaflet 原生一致（zoomDelta 默认 1）。 */
  const zoomBy = useCallback((delta: number) => {
    const map = mapRef.current
    if (!map) return
    map.setZoom(Math.round(map.getZoom()) + delta)
  }, [])

  if (!open) return null

  const waypointSources = (() => {
    if (!info) return [] as Array<[string, number]>
    const counts = new Map<string, number>()
    for (const w of info.waypoints) {
      if (w.dimension !== dim) continue
      counts.set(w.source, (counts.get(w.source) ?? 0) + 1)
    }
    return [...counts.entries()]
  })()

  return (
    <Dialog open={open} onClose={onClose} className="max-w-6xl">
      <DialogHeader onClose={onClose}>
        <DialogTitle className="flex items-center gap-2">
          <MapIcon className="h-4 w-4 text-primary" />
          {t('instanceDetail.worldPreview.title', { name: saveName })}
        </DialogTitle>
      </DialogHeader>
      <DialogBody className="p-0">
        {/* 地图容器必须始终挂载（即使正在加载/报错）：`load()` 在解析成功后立刻
            创建 Leaflet 实例，若此时容器还没渲染，地图会挂到 null 上。加载/错误
            提示以覆盖层形式叠在上面。 */}
        <div className="relative">
          <div className={cn('flex flex-col', stage !== 'ready' && 'invisible')}>
            {info && (
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-border px-4 py-2 text-xs text-muted-foreground">
                <span className="font-medium text-foreground">{info.levelName || saveName}</span>
                <span>
                  {t('instanceDetail.worldPreview.dimensionCount', {
                    count: info.dimensions.length,
                  })}
                </span>
                <span>
                  {t('instanceDetail.worldPreview.mappedBlocks', {
                    count: info.paletteMappedBlocks,
                  })}
                </span>
              </div>
            )}
            <div className="flex h-[70vh] min-h-[26rem]">
              <div className="relative flex-1">
                <div ref={mapDivRef} className="absolute inset-0 z-0" />
                {/* 缩放控件：用启动器 Button + Tooltip 自绘，替代 Leaflet 原生控件
                    （原生的是白色方块 + 粗体字符，与启动器风格不搭）。位置与原生
                    一致（左上角）。 */}
                <div className="absolute left-3 top-3 z-[500] flex flex-col gap-1">
                  <Tooltip content={t('instanceDetail.worldPreview.zoomIn')}>
                    <Button
                      size="sm"
                      variant="outline"
                      aria-label={t('instanceDetail.worldPreview.zoomIn')}
                      disabled={zoom >= MAX_ZOOM}
                      onClick={() => zoomBy(1)}
                      className="h-7 w-7 bg-background/80 p-0 backdrop-blur"
                    >
                      <Plus className="h-3.5 w-3.5" />
                    </Button>
                  </Tooltip>
                  <Tooltip content={t('instanceDetail.worldPreview.zoomOut')}>
                    <Button
                      size="sm"
                      variant="outline"
                      aria-label={t('instanceDetail.worldPreview.zoomOut')}
                      disabled={zoom <= MIN_ZOOM}
                      onClick={() => zoomBy(-1)}
                      className="h-7 w-7 bg-background/80 p-0 backdrop-blur"
                    >
                      <Minus className="h-3.5 w-3.5" />
                    </Button>
                  </Tooltip>
                </div>
                <div className="pointer-events-none absolute bottom-2 left-2 z-[500] rounded bg-background/80 px-2 py-1 text-[10px] text-muted-foreground backdrop-blur">
                  {t('instanceDetail.worldPreview.controlsHint')}
                </div>
              </div>
              <div className="flex w-60 flex-col overflow-y-auto border-l border-border">
                <div className="border-b border-border p-3">
                  <div className="mb-2 flex items-center gap-1.5 text-xs font-medium text-foreground/80">
                    <Layers className="h-3.5 w-3.5" />
                    {t('instanceDetail.worldPreview.dimensions')}
                  </div>
                  <ul className="space-y-0.5">
                    {(info?.dimensions ?? []).map((d) => (
                      <li key={d.id}>
                        <button
                          onClick={() => switchDim(d.id)}
                          className={cn(
                            'flex w-full items-center justify-between gap-2 rounded px-2 py-1 text-left text-xs transition-colors',
                            d.id === dim
                              ? 'bg-primary/10 text-primary'
                              : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground',
                          )}
                        >
                          <span className="truncate">{d.name}</span>
                          <span className="shrink-0 tabular-nums opacity-70">
                            {t('instanceDetail.worldPreview.chunks', { count: d.chunkCount })}
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
                <div className="space-y-2 border-b border-border p-3">
                  <div className="flex items-center justify-between text-xs font-medium text-foreground/80">
                    <span>{t('instanceDetail.worldPreview.heightSlice')}</span>
                    <span className="tabular-nums text-muted-foreground">
                      {atFullHeight
                        ? t('instanceDetail.worldPreview.fullHeight')
                        : t('instanceDetail.worldPreview.ymaxValue', { value: ymax })}
                    </span>
                  </div>
                  <input
                    type="range"
                    min={range.min}
                    max={range.max}
                    value={ymax}
                    onChange={(e) => applyYmax(Number(e.target.value))}
                    className="w-full"
                  />
                  <p className="text-[10px] leading-snug text-muted-foreground">
                    {t('instanceDetail.worldPreview.heightRange', {
                      min: range.min,
                      max: range.max,
                    })}
                  </p>
                  <p className="text-[10px] leading-snug text-muted-foreground">
                    {t('instanceDetail.worldPreview.heightHint')}
                  </p>
                </div>
                <div className="space-y-2 border-b border-border p-3">
                  <div className="mb-2 text-xs font-medium text-foreground/80">
                    {t('instanceDetail.worldPreview.render')}
                  </div>
                  <ul className="space-y-1.5 text-xs text-muted-foreground">
                    <li>
                      <label className="flex cursor-pointer items-center gap-2">
                        <input
                          type="checkbox"
                          checked={flags.water}
                          disabled={!info}
                          onChange={() => toggleFlag('water')}
                        />
                        {t('instanceDetail.worldPreview.waterToggle')}
                      </label>
                    </li>
                    <li>
                      <label className="flex cursor-pointer items-center gap-2">
                        <input
                          type="checkbox"
                          checked={flags.shading}
                          disabled={!info}
                          onChange={() => toggleFlag('shading')}
                        />
                        {t('instanceDetail.worldPreview.shadingToggle')}
                      </label>
                    </li>
                    <li>
                      <label
                        className={cn(
                          'flex items-center gap-2',
                          flags.shading ? 'cursor-pointer' : 'cursor-not-allowed opacity-50',
                        )}
                      >
                        <input
                          type="checkbox"
                          checked={flags.altitude}
                          disabled={!info || !flags.shading}
                          onChange={() => toggleFlag('altitude')}
                        />
                        {t('instanceDetail.worldPreview.altitudeToggle')}
                      </label>
                    </li>
                  </ul>
                </div>
                <div className="border-b border-border p-3">
                  <div className="mb-2 text-xs font-medium text-foreground/80">
                    {t('instanceDetail.worldPreview.legend')}
                  </div>
                  <ul className="space-y-1.5 text-xs text-muted-foreground">
                    <li className="flex items-center gap-2">
                      <span className="h-2.5 w-2.5 shrink-0 rounded-full border-2 border-white bg-red-600" />
                      {t('instanceDetail.worldPreview.legendPlayer')}
                    </li>
                    <li className="flex items-center gap-2">
                      <span className="h-2.5 w-2.5 shrink-0 rounded-full border border-black bg-emerald-500" />
                      {t('instanceDetail.worldPreview.legendWaypoint')}
                    </li>
                  </ul>
                  <div className="mt-2 space-y-0.5 text-[11px] text-muted-foreground/80">
                    {waypointSources.length === 0 ? (
                      <p>{t('instanceDetail.worldPreview.noWaypoints')}</p>
                    ) : (
                      waypointSources.map(([src, n]) => (
                        <div key={src} className="flex items-center justify-between">
                          <span>{t(`instanceDetail.worldPreview.source.${src}`)}</span>
                          <span className="tabular-nums">{n}</span>
                        </div>
                      ))
                    )}
                  </div>
                </div>
                {info && (
                  <div className="space-y-1 p-3 text-[11px] text-muted-foreground">
                    <div className="flex items-center justify-between gap-2">
                      <span>{t('instanceDetail.worldPreview.seed')}</span>
                      <Tooltip content={info.worldSeed || t('instanceDetail.worldPreview.seedUnknown')}>
                        <span className="truncate font-mono tabular-nums text-foreground/80">
                          {info.worldSeed || '—'}
                        </span>
                      </Tooltip>
                    </div>
                    <div className="flex items-center justify-between gap-2">
                      <span>{t('instanceDetail.worldPreview.playerPos')}</span>
                      <span className="truncate tabular-nums text-foreground/80">
                        {info.player
                          ? `${info.player.x.toFixed(0)}, ${info.player.y.toFixed(0)}, ${info.player.z.toFixed(0)}`
                          : '—'}
                      </span>
                    </div>
                  </div>
                )}
              </div>
            </div>
            <div className="flex items-center gap-4 border-t border-border px-4 py-2 text-[11px] text-muted-foreground">
              <span className="truncate">
                {t('instanceDetail.worldPreview.coords')}:{' '}
                {mouse
                  ? `X=${mouse.x}${block?.y != null ? ` Y=${block.y}` : ''} Z=${mouse.z}`
                  : '—'}
              </span>
              <span className="min-w-0 flex-1 truncate">
                {t('instanceDetail.worldPreview.block')}:{' '}
                {block?.name
                  ? `${block.name}${block.id && block.id !== block.name ? ` (${block.id})` : ''}`
                  : '—'}
              </span>
              <span className="shrink-0">
                {t('instanceDetail.worldPreview.dimension')}: {activeDim?.name ?? '—'}
              </span>
              <span className="shrink-0">
                {t('instanceDetail.worldPreview.layer')}:{' '}
                {atFullHeight
                  ? t('instanceDetail.worldPreview.fullHeight')
                  : t('instanceDetail.worldPreview.ymaxValue', { value: ymax })}
              </span>
            </div>
          </div>
          {stage === 'loading' && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-background/60 text-sm text-muted-foreground">
              <RotateCw className="h-5 w-5 animate-spin" />
              {t('instanceDetail.worldPreview.parsing')}
            </div>
          )}
          {stage === 'error' && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 px-6 text-center">
              <TriangleAlert className="h-6 w-6 text-destructive" />
              <p className="text-sm text-destructive">{error}</p>
              <Button size="sm" variant="outline" onClick={load}>
                {t('instanceDetail.worldPreview.retry')}
              </Button>
            </div>
          )}
        </div>
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
