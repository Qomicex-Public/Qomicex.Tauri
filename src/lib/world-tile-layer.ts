import L from 'leaflet'

/** 已解码的瓦片，以及后端标记的「该区域没有已生成区块」。 */
type TileImage = { bitmap: ImageBitmap; isEmpty: boolean }

/**
 * 等待并发槽位的瓦片请求。
 *
 * 除任务本身外还携带瓦片坐标，`pump` 据此优先取距视口中心最近的一项。
 * Leaflet 按行优先顺序请求瓦片，若不带坐标，新视口会先把顶部几行取完，
 * 而用户正看着的中心区域反而排在后面。
 */
type QueuedTile = {
  z: number
  x: number
  y: number
  job: () => void
}

/**
 * 瓦片层：加载过程中不留空洞。
 *
 * 原生 `L.tileLayer` 会一次性请求所有可见瓦片，并在每个瓦片到达前显示空白，
 * 平移/缩放时满屏闪空白方块。本层维护内存缓存，并在瓦片到达前用已加载的父瓦片
 * 缩放裁剪到对应象限作为占位，地图保持连续（只是更糊），直到清晰瓦片到达。
 *
 * Leaflet 可能在某个瓦片请求仍在飞行时再次索要同一瓦片（重建瓦片元素），因此
 * 每个调用方的 `done` 回调必须保留并一起触发，否则该瓦片会永久空白。
 *
 * 移植自 world-viewer 的 `CachedTileLayer`（去掉上游的 `stats()` 诊断接口）。
 */
export class CachedTileLayer extends L.GridLayer {
  private cache = new Map<string, ImageBitmap>()
  /** 后端标记为「无已生成区块」的瓦片。 */
  private empty = new Set<string>()
  /** 同一瓦片的待通知回调；全部一起触发。 */
  private waiting = new Map<string, Array<(img: TileImage | null) => void>>()
  private queue: QueuedTile[] = []
  private active = 0

  /** 键含 `dim|ymax`——任一变化都会作废全部瓦片。 */
  private urlTemplate = ''
  private maxConcurrent: number
  /**
   * 缓存位图上限。一张 256x256 RGBA 位图约 256 KiB，无上限时平移上千张后会到
   * 约 256 MB。前端缓存只是服务端区块缓存之前的快速路径，不必装下整个世界，
   * 只需要视口附近的瓦片。
   */
  private maxCached: number
  private failures = new Set<string>()

  constructor(options?: L.GridLayerOptions & { maxConcurrent?: number; maxCached?: number }) {
    super({ tileSize: 256, ...options })
    this.maxConcurrent = options?.maxConcurrent ?? 6
    this.maxCached = options?.maxCached ?? 512
  }

  /**
   * 把 `key` 移到最近使用端，并丢弃最旧的条目。
   *
   * `Map` 按插入顺序迭代，因此每次使用时重新插入就让迭代顺序等于使用顺序，
   * 淘汰只需取第一个 key——整个 LRU 就这一处，无需额外簿记。
   */
  /**
   * 释放被淘汰位图的 GPU 内存。
   *
   * `ImageBitmap.close()` 立即生效，而位图可能仍被 `createTile` 中排在
   * `setTimeout` 队列里的回调引用（父瓦片占位绘制与清晰瓦片绘制都在那里执行）。
   * 同一轮内关闭会让那次 `drawImage` 抛 `InvalidStateError`，因此关闭延后一个
   * 宏任务，等所有已排队的绘制跑完。
   *
   * 延后又开了一个竞争窗口：同一张位图可能在超时触发前被重新命中并记回缓存。
   * 关闭前复核它是否仍存活，避免把已被缓存重新持有的位图关掉。
   */
  private closeSoon(bitmap: ImageBitmap) {
    setTimeout(() => {
      for (const live of this.cache.values()) {
        if (live === bitmap) return
      }
      bitmap.close()
    }, 0)
  }

  private remember(key: string, bitmap: ImageBitmap) {
    this.cache.delete(key)
    this.cache.set(key, bitmap)
    while (this.cache.size > this.maxCached) {
      const oldest = this.cache.keys().next().value
      if (oldest === undefined) break
      const evicted = this.cache.get(oldest)
      this.cache.delete(oldest)
      if (evicted) this.closeSoon(evicted)
      // 空瓦片集合是缓存的兄弟结构，不能比缓存本身还大。
      this.empty.delete(oldest)
    }
  }

  private recall(key: string): ImageBitmap | undefined {
    const bitmap = this.cache.get(key)
    if (bitmap) {
      this.cache.delete(key)
      this.cache.set(key, bitmap)
    }
    return bitmap
  }

  setUrlTemplate(template: string) {
    if (this.urlTemplate === template) return
    this.urlTemplate = template
    this.failures.clear()
    this.empty.clear()
    // 队列里的任务捕获的是旧模板的 URL，而 redraw() 马上会移除所有等待它们的
    // 瓦片元素。只丢任务不清等待者会留下永远等不到回调的 key（用户切回同一高度
    // 时命中该 key，瓦片永久空白）；不丢任务则拖动高度滑块会堆积上千个过期请求，
    // 地图要黑几十秒直到积压排空。
    this.queue.length = 0
    this.waiting.clear()
    this.redraw()
  }

  getUrlTemplate() {
    return this.urlTemplate
  }

  /**
   * Leaflet 的 `_setView` 会先对 zoom 取整再钳位，但 `redraw()` 与 `_update()`
   * 直接把地图 zoom 透传。地图启用 `zoomSnap: 0.25`，滚轮缩放可能停在小数
   * zoom（2.5）；这两条路径随后会把 `_tileZoom` 设为 2.5，并请求 z=2.5 的瓦片。
   * 后端按整数解析 zoom 并返回 400/404，于是所有瓦片失败、地图保持全黑，直到
   * 下一次整数 zoom 事件才恢复。
   *
   * 在这三个调用方共用的唯一收口处取整，保证 `_tileZoom` 始终是整数，同时保留
   * 0.25 的平滑缩放粒度。
   */
  protected _clampZoom(zoom: number): number {
    const base = L.GridLayer.prototype as unknown as {
      _clampZoom(zoom: number): number
    }
    return base._clampZoom.call(this, Math.round(zoom))
  }

  /** 丢弃上一个存档/高度的缓存，不触碰地图。 */
  clearCache() {
    for (const bitmap of this.cache.values()) {
      this.closeSoon(bitmap)
    }
    this.cache.clear()
    this.waiting.clear()
    this.failures.clear()
    this.empty.clear()
  }

  private urlFor(coords: { z: number; x: number; y: number }): string {
    return L.Util.template(this.urlTemplate, {
      z: coords.z,
      x: coords.x,
      y: coords.y,
    })
  }

  /**
   * 视口中心所在的瓦片坐标；无地图时返回 null。
   *
   * 用于给队列按距离排序，让视口中心下方的瓦片先加载。Leaflet 自身的请求
   * 顺序是行优先的，新视口会先把顶部几行填满，而用户正看的中心反而靠后。
   */
  private centerTile(): { z: number; x: number; y: number } | null {
    const map = (this as unknown as { _map?: L.Map })._map
    const zoom = (this as unknown as { _tileZoom?: number })._tileZoom
    if (!map || zoom === undefined || zoom === null) return null
    const size = this.getTileSize()
    const center = map.project(map.getCenter(), zoom).divideBy(size.x)
    return { z: zoom, x: center.x, y: center.y }
  }

  /**
   * 取队列中距视口中心最近的一项。
   *
   * 刻意用线性扫描：队列最多装一个视口的瓦片数（几十张，快速平移时偶尔几百张），
   * 每个槽位做一次 O(n) 挑选比维护有序结构更便宜，且到中心的距离会随地图移动而变化。
   *
   * 只对当前 `_tileZoom` 的项排序。缩放过程中队列会短暂混入两个 z，
   * 跨坐标系算出的距离没有意义；其它 zoom 的项保持到达顺序。
   */
  private pump() {
    while (this.active < this.maxConcurrent && this.queue.length > 0) {
      let pick = 0
      const center = this.centerTile()
      if (center && this.queue.length > 1) {
        let best = Infinity
        for (let i = 0; i < this.queue.length; i++) {
          const t = this.queue[i]
          if (t.z !== center.z) continue
          const dx = t.x + 0.5 - center.x
          const dy = t.y + 0.5 - center.y
          const d = dx * dx + dy * dy
          if (d < best) {
            best = d
            pick = i
          }
        }
      }
      const [entry] = this.queue.splice(pick, 1)
      this.active++
      entry.job()
    }
  }

  private enqueue(z: number, x: number, y: number, job: () => void) {
    this.queue.push({ z, x, y, job })
    this.pump()
  }

  private done() {
    this.active = Math.max(0, this.active - 1)
    this.pump()
  }

  private resolveWaiters(key: string, img: TileImage | null) {
    const list = this.waiting.get(key)
    if (!list) return
    this.waiting.delete(key)
    for (const cb of list) cb(img)
  }

  private load(
    key: string,
    coords: L.Coords,
    url: string,
    onReady: (img: TileImage | null) => void,
  ) {
    const cached = this.recall(key)
    if (cached) {
      onReady({ bitmap: cached, isEmpty: this.empty.has(key) })
      return
    }

    // 已在请求中：追加回调，不能丢弃。
    const pending = this.waiting.get(key)
    if (pending) {
      pending.push(onReady)
      return
    }

    if (this.failures.has(key)) {
      onReady(null)
      return
    }

    this.waiting.set(key, [onReady])
    this.enqueue(coords.z, coords.x, coords.y, () => {
      // 用 fetch 而非 <img>，才能读到 X-Tile-Empty 响应头。
      fetch(url)
        .then(async (resp) => {
          if (!resp.ok) throw new Error(String(resp.status))
          const isEmpty = resp.headers.get('X-Tile-Empty') === '1'
          const blob = await resp.blob()
          const bitmap = await createImageBitmap(blob)
          this.remember(key, bitmap)
          this.done()
          if (isEmpty) this.empty.add(key)
          else this.empty.delete(key)
          this.resolveWaiters(key, { bitmap, isEmpty })
        })
        .catch(() => {
          this.failures.add(key)
          this.done()
          this.resolveWaiters(key, null)
        })
    })
  }

  /** 画一层很淡的棋盘格：「这块区域从未生成过」。 */
  private drawEmptyPattern(ctx: CanvasRenderingContext2D, size: L.Point) {
    const cell = 16
    for (let y = 0; y < size.y; y += cell) {
      for (let x = 0; x < size.x; x += cell) {
        const odd = (x / cell + y / cell) % 2 === 0
        ctx.fillStyle = odd ? 'rgba(255,255,255,0.035)' : 'rgba(255,255,255,0.07)'
        ctx.fillRect(x, y, cell, cell)
      }
    }
  }

  createTile(coords: L.Coords, done: L.DoneCallback): HTMLElement {
    const canvas = document.createElement('canvas')
    const size = this.getTileSize()
    canvas.width = size.x
    canvas.height = size.y
    canvas.style.opacity = '0'
    canvas.style.transition = 'opacity 180ms ease-out'
    const ctx = canvas.getContext('2d')!

    const key = this.urlFor(coords)

    // 立刻画父瓦片（放大 2 倍并裁到本象限），加载期间不留空洞。
    if (coords.z > 0) {
      const px = Math.floor(coords.x / 2)
      const py = Math.floor(coords.y / 2)
      const qx = coords.x - px * 2
      const qy = coords.y - py * 2
      const parentKey = this.urlFor({ ...coords, z: coords.z - 1, x: px, y: py })
      const parent = this.recall(parentKey)
      if (parent) {
        ctx.imageSmoothingEnabled = true
        ctx.drawImage(parent, -qx * size.x, -qy * size.y, size.x * 2, size.y * 2)
        canvas.style.opacity = '1'
      }
    }

    // Leaflet 在 createTile 返回之后才写入 `this._tiles[key]`。命中缓存时
    // load() 会同步回调，done() 就发生在写入之前，`_tileReady` 查不到该 key、
    // 不会加 'leaflet-tile-loaded'，瓦片永久 visibility:hidden（缩放到已缓存
    // 瓦片时整屏变黑的根因）。延后一个任务让写入先完成。
    this.load(key, coords, this.urlFor(coords), (img) => {
      setTimeout(() => {
        if (!img) {
          // 保留父瓦片占位（可能什么都没有），并告知 Leaflet 请求已结束。
          done(undefined, canvas)
          return
        }
        ctx.imageSmoothingEnabled = false
        ctx.clearRect(0, 0, size.x, size.y)
        if (img.isEmpty) {
          // 该区域在存档里存在但从未生成：画棋盘格，避免与「仍在加载」混淆。
          this.drawEmptyPattern(ctx, size)
        } else {
          ctx.drawImage(img.bitmap, 0, 0, size.x, size.y)
        }
        canvas.style.opacity = '1'
        done(undefined, canvas)
      }, 0)
    })

    return canvas
  }
}
