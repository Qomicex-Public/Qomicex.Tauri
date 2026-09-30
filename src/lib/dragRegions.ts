import { getCurrentWindow, type Window } from '@tauri-apps/api/window'

/**
 * 触控板 / 触摸交互与窗口拖动区（drag region）策略。
 *
 * 需求（issue #114 及后续）：**双指在触摸板上滑动必须等价于滚轮滚动**——
 * 内容滚动，而窗口框架（标题栏、边框、窗口控制按钮）及其内部 UI 绝不能
 * 整体跟着手指移动。鼠标滚轮行为是基准线：滚轮从来不需要按下任何按键，
 * 也不会拖动窗口。
 *
 * 本文件是三条规则的唯一事实来源（详见 docs/junsi-dev-docs/1-决策记录/ADR-087）：
 *
 * A. 拖动区边界判定（`classifyTarget`）——按 ①→④ 优先级取首个命中：
 *      ① `interactive` 可交互元素（按钮 / 输入框 / 画布 / role 等）
 *      ② `scroll`      可滚动容器（overflow 可滚）
 *      ③ `frame`       框架拖动带（贴顶 FRAME_TOP_PX 内）
 *      ④ `content`     其余一律不可拖
 * B. 双指 / 滚轮手势判定（G1–G5）——任何一条命中即作废本次窗口拖动手势：
 *      G1 wheel 到达且有未决手势 → 立即作废（滚动与拖动互斥）
 *      G2 mousedown 距上次 wheel < WHEEL_BURST_GAP_MS → 拒绝建手势
 *      G3 活动指针 ≥ 2（两指）→ 拒绝 / 作废
 *      G4 非鼠标指针（touch/pen）→ 仅单指针且命中 frame 才允许
 *      G5 原鼠标拖动条件：左键 + detail∈{1,2} + frame + 单键按住 + 位移 ≥ 阈值
 * C. 内容位移：C1 原生滚动容器由引擎消费、我们只做 overscroll 抑制；
 *    C2 指针拖拽内容与 C3 画布相机各自自理（见 ADR-087）。
 *
 * 历史背景：Tauri v2 内置的 `data-tauri-drag-region`（tauri 2.x 的
 * `src/window/scripts/drag.js`）在 mousedown 命中拖动区时**立即**
 * `invoke('plugin:window|start_dragging')`，没有任何位移阈值，也没有滚动信号。
 * 触控板上"按下——拖动"的意图远比鼠标模糊（点两下并拖动、轻点后微移、
 * 三指拖动、按住+双指滑动），于是窗口被误拖动。我们改用
 * `data-qomicex-drag-region` 属性 + 本文件的阈值/手势判定接管：换了属性名，
 * Tauri 内置脚本便不再处理这些区域，"mousedown 即拖窗"的通道被彻底移除。
 */

/** 拖动区属性名。刻意区别于 `data-tauri-drag-region`，见文件头说明。 */
export const DRAG_REGION_ATTR = 'data-qomicex-drag-region'

/** 显式禁止窗口拖动的属性（供调用方精确表达"这里只给内部交互用"）。 */
export const NO_DRAG_ATTR = 'data-qomicex-no-drag'

/** 显式声明"这里是滚动区"的属性（无法从 class 推断时的兜底标记）。 */
export const SCROLL_ATTR = 'data-qomicex-scroll'

/**
 * 位移阈值（px）。触控板轻点后的指尖微移（通常 1~4px）不应拖动窗口；
 * 鼠标拖动超过该值后窗口直接跟手，用户无感知。原生 Windows 的
 * SM_CXDRAG/SM_CYDRAG 为 4px，这里取稍大的 8px 以兼容触控板抖动。
 */
export const DRAG_THRESHOLD_PX = 8
const DRAG_THRESHOLD_SQ = DRAG_THRESHOLD_PX * DRAG_THRESHOLD_PX

/** 点击与拖拽的判定余量（px）：位移不超过它视为点击。 */
export const DRAG_CLICK_SLOP_PX = 4

/**
 * 框架带宽度（px）。横向拖动带的高度，对应 `TitleBar.tsx` / `GameLogWindow.tsx`
 * 的 `h-9` 与 SplashScreen 顶部条。只有"命中点距视口顶 ≤ 该值"的横向拖动带
 * 才会被算作 `frame`（§A③）。
 */
export const FRAME_TOP_PX = 36

/** 左右 / 底部边框厚度（px）。当前 `decorations:false` 下没有原生缩放边框，故为 0：边框即固定。 */
export const FRAME_LEFT_PX = 0
export const FRAME_RIGHT_PX = 0
export const FRAME_BOTTOM_PX = 0

/**
 * 滚轮突发判定窗口（ms）。一次双指滑动会连续产生多个 wheel 事件，间隔通常
 * 远小于该值；mousedown 落在这个窗口内即认为"这次按下属于同一串滚轮突发"，
 * 拒绝建立拖动手势。取小值以免误伤"刚滚完立刻用鼠标拖标题栏"的用户。
 */
export const WHEEL_BURST_GAP_MS = 100

/** `MutationObserver` 的滚动容器重扫防抖（ms）。 */
const CONTAINMENT_RESCAN_DEBOUNCE_MS = 200

/** 是否启运"内层滚动抑制"（`overscroll-behavior: contain`）。总开关，便于回退。 */
export const ENABLE_SCROLL_CONTAINMENT = true

/** §A① 可交互标签：裸命中即禁止窗口拖动（与 tauri/src/window/scripts/drag.js 一致 + 媒体/嵌入内容）。 */
const CLICKABLE_TAGS = new Set([
  'A',
  'BUTTON',
  'INPUT',
  'SELECT',
  'TEXTAREA',
  'LABEL',
  'SUMMARY',
  'AREA',
  'CANVAS',
  'VIDEO',
  'IFRAME',
])
const INTERACTIVE_ROLES = new Set([
  'button',
  'link',
  'menuitem',
  'tab',
  'checkbox',
  'radio',
  'switch',
  'option',
])

/** §A② 滚动容器判定：computed overflow ∈ 该集合。 */
const OVERFLOW_VALUES = new Set(['auto', 'scroll', 'overlay'])

/** §A 的四个类别。 */
export type HitCategory = 'interactive' | 'scroll' | 'frame' | 'content'

function isClickableElement(el: HTMLElement): boolean {
  return (
    CLICKABLE_TAGS.has(el.tagName) ||
    (el.hasAttribute('contenteditable') && el.getAttribute('contenteditable') !== 'false') ||
    (el.hasAttribute('tabindex') && el.getAttribute('tabindex') !== '-1') ||
    INTERACTIVE_ROLES.has(el.getAttribute('role') ?? '')
  )
}

/** 元素自身是否带 `data-qomicex-drag-region="false"`（或其祖先带 NO_DRAG_ATTR）。 */
function carriesNoDrag(el: HTMLElement): boolean {
  if (el.hasAttribute(NO_DRAG_ATTR)) return true
  if (el.getAttribute(DRAG_REGION_ATTR) === 'false') return true
  return !!el.closest(`[${NO_DRAG_ATTR}]`)
}

/** 元素自身是否带滚动标记 `[data-qomicex-scroll]`（含祖先）。 */
function carriesScrollMark(el: HTMLElement): boolean {
  return !!el.closest(`[${SCROLL_ATTR}]`)
}

/** computed overflow 是否为可滚动关键字。 */
function overflowIsScrollable(style: CSSStyleDeclaration, prop: 'overflowX' | 'overflowY'): boolean {
  return OVERFLOW_VALUES.has(style[prop])
}

/** 某滚动容器在给定轴上是否实际可滚（留 1px 容差吸收亚像素）。 */
function isActuallyScrollable(
  el: HTMLElement,
  style: CSSStyleDeclaration,
  horizontal: boolean,
): boolean {
  if (horizontal) {
    if (!overflowIsScrollable(style, 'overflowX')) return false
    return el.scrollWidth > el.clientWidth + 1
  }
  if (!overflowIsScrollable(style, 'overflowY')) return false
  return el.scrollHeight > el.clientHeight + 1
}

/** 元素自身是否带 `data-qomicex-drag-region`（任意合法值）。 */
function dragAttrOf(el: HTMLElement): string | null {
  return el.getAttribute(DRAG_REGION_ATTR)
}

/**
 * §A 拖动区边界判定：由事件路径自底向上按 ①→④ 优先级取首个命中类别。
 *
 * 语义与 Tauri 内置脚本保持一致的取值规则（只在 ③ frame 里生效）：
 * 空 / `"true"` = 仅元素自身被直接命中；`"deep"` = 子树内任意命中；
 * `"false"` = 禁用（落到 ①）。
 *
 * @param target 事件目标（`e.target`），允许为 null/非 Element。
 * @param clientX/Y 命中点视口坐标，用于 ③ 的框架带几何判定。
 */
export function classifyTarget(
  target: EventTarget | null,
  clientX = 0,
  clientY = 0,
): HitCategory {
  if (!(target instanceof Element)) return 'content'

  // ① interactive：命中路径上任何可交互元素（含 target 自身）
  for (let el: Element | null = target; el; el = el.parentElement) {
    if (el instanceof HTMLElement && isClickableElement(el)) return 'interactive'
    if (el instanceof HTMLElement && carriesNoDrag(el)) return 'interactive'
  }

  // ② scroll：命中路径上存在可滚动容器（或带滚动标记）
  for (const el of ancestorChain(target)) {
    if (el instanceof HTMLElement) {
      if (carriesScrollMark(el)) return 'scroll'
      const style = getComputedStyle(el)
      if (isActuallyScrollable(el, style, true) || isActuallyScrollable(el, style, false)) {
        return 'scroll'
      }
    }
  }

  // ③ frame：命中点落在框架拖动带内
  const direct = (target instanceof HTMLElement ? target : null) ?? target.closest<HTMLElement>(`[${DRAG_REGION_ATTR}]`)
  for (const el of ancestorChain(target)) {
    if (!(el instanceof HTMLElement)) continue
    const attr = dragAttrOf(el)
    if (attr === null || attr === 'false') continue
    // 取值语义："deep" 子树命中即可；空 / "true" 只认元素自身被直接命中
    const selfHit = attr === 'deep' || el === direct
    if (!selfHit) continue
    // 几何边界：横向拖动带要求命中点距视口顶 ≤ FRAME_TOP_PX；
    // 左右 / 下边框常量当前为 0（见常量注释），因此不构成拖动面。
    if (!isPointInFrameBand(el, clientX, clientY)) continue
    return 'frame'
  }

  // ④ content：其余一律不可拖，内部拖拽由各自监听器自理
  return 'content'
}

/** 从 target 向上的祖先链（含自身），不含 document。 */
function ancestorChain(target: Element): Element[] {
  const chain: Element[] = []
  for (let el: Element | null = target; el; el = el.parentElement) chain.push(el)
  return chain
}

/** 命中点是否落在该元素的框架带内。 */
function isPointInFrameBand(el: HTMLElement, clientX: number, clientY: number): boolean {
  const r = el.getBoundingClientRect()
  const offsetTop = clientY - r.top
  if (offsetTop >= 0 && offsetTop <= FRAME_TOP_PX) return true
  const offsetBottom = r.bottom - clientY
  if (offsetBottom >= 0 && offsetBottom <= FRAME_BOTTOM_PX) return true
  const offsetLeft = clientX - r.left
  if (offsetLeft >= 0 && offsetLeft <= FRAME_LEFT_PX) return true
  const offsetRight = r.right - clientX
  if (offsetRight >= 0 && offsetRight <= FRAME_RIGHT_PX) return true
  return false
}

/** 一次待定手势：已按下主键、命中拖动区，但还没攒够位移。 */
interface PendingGesture {
  x: number
  y: number
  /** 是否第二次点击（detail===2）：无显著位移时还原成"双击最大化"。 */
  double: boolean
}

let pending: PendingGesture | null = null

/** 最近一次 wheel 的时间戳（ms，`performance.now()`），用于 G2。 */
let lastWheelAt = Number.NEGATIVE_INFINITY

/** 活动指针表：pointerId → 最近坐标。用于 G3（≥2 指）判定。 */
const activePointers = new Map<number, { x: number; y: number }>()

function clearPending(): void {
  pending = null
}

/** 完整清空一次手势周期（pending + 指针表）。 */
function resetGestureState(): void {
  pending = null
  activePointers.clear()
}

/** 对当前窗口执行一次动作；同步取窗口失败 / 动作 reject 都静默吞掉。 */
function dragWindow(action: (win: Window) => Promise<unknown>): void {
  try {
    action(getCurrentWindow()).catch(() => {})
  } catch {
    /* 非 Tauri 环境或 internals 尚未就绪：忽略 */
  }
}

// ---------------------------------------------------------------------------
// B. 手势判定 G1–G5
// ---------------------------------------------------------------------------

function onPointerDown(e: PointerEvent): void {
  activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY })
}

function onPointerMove(e: PointerEvent): void {
  if (activePointers.has(e.pointerId)) {
    activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY })
  }
}

/** 指针抬起 / 被取消（触摸中断、系统抢走手势等）→ 移出活动表。 */
function onPointerEnd(e: PointerEvent): void {
  activePointers.delete(e.pointerId)
}

/**
 * G1：滚轮到达即作废本次未决手势。双指滑动在浏览器里必然表现为 wheel 事件流，
 * 因此"滚动"优先于"拖动"：一旦识别到滚动，本次按压周期内不再起拖。
 * 监听器为 passive，绝不 preventDefault（不破坏页面滚动或预览器的相机操作）。
 */
function onWheel(): void {
  lastWheelAt = now()
  if (pending) {
    pending = null
    // 双指滑动常伴随一次鼠标按下；滚动意图已明确，作废即可
  }
}

/** `performance.now()` 的包装，便于测试注入。 */
function now(): number {
  return typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now()
}

function onMouseDown(e: MouseEvent): void {
  // 无论本次是否命中拖动区，先丢掉上一次未决手势：mouseup 有可能在窗口外发生
  // （页面收不到），残留的 pending 会让下一次"按住 + 移动"误触发拖窗
  clearPending()

  // 与 Tauri 内置脚本一致：只处理主键的单击/双击，忽略其它按键与三连击
  if (e.button !== 0) return
  if (e.detail !== 1 && e.detail !== 2) return

  // G3：两指（或多指）同时触摸 → 手势作废，双指滑动不可能拖动窗口
  if (activePointers.size >= 2) return

  // G4：非鼠标指针（touch/pen）需要落在框架带上才允许拖动
  //     触摸场景多见于单指平板操作；两指已被 G3 拦掉
  const category = classifyTarget(e.target, e.clientX, e.clientY)
  if (activePointers.size === 1 && category !== 'frame') return
  if (activePointers.size === 1) {
    const first = activePointers.values().next().value as { x: number; y: number } | undefined
    if (!first) return
    // 单指针必须就是本次按下的位置附近（±1px）才算"刚发生的触摸"
    if (Math.abs(first.x - e.clientX) > 1 || Math.abs(first.y - e.clientY) > 1) return
  }

  // G2：按下发生在滚轮突发窗口内 → 本次按压属于同一串双指滚动，不建手势
  if (now() - lastWheelAt < WHEEL_BURST_GAP_MS) return

  // G5：只有命中框架带才建立待定手势；仅记账、不动窗口、不阻止传播
  if (category !== 'frame') return
  pending = { x: e.clientX, y: e.clientY, double: e.detail === 2 }
}

function onMouseMove(e: MouseEvent): void {
  const gesture = pending
  if (!gesture) return
  // 主键已松开（含在窗口外松手后回到窗口内收到的事件）→ 放弃这次手势
  if (e.buttons !== 1) {
    pending = null
    return
  }
  // G3 兜底：手势进行中若出现第二个指针（极少见，但两指同时初始触摸可能
  // pointerdown 顺序晚于 mousedown），立即作废
  if (activePointers.size >= 2) {
    pending = null
    return
  }
  const dx = e.clientX - gesture.x
  const dy = e.clientY - gesture.y
  if (dx * dx + dy * dy < DRAG_THRESHOLD_SQ) return
  pending = null
  // 位移够了，才把窗口拖动交给原生消息循环（Windows WM_NCLBUTTONDOWN(HTCAPTION) /
  // macOS performWindowDragWithEvent / GTK begin_move_drag）
  dragWindow(w => w.startDragging())
}

function onMouseUp(e: MouseEvent): void {
  const gesture = pending
  if (!gesture) return
  pending = null
  if (!gesture.double || e.button !== 0) return
  // 双击且未产生显著位移 → 最大化/还原（macOS 原生行为；触控板"点两下并拖动"
  // 攒够位移会走上面的 startDragging，不会被误判成双击）
  if (
    Math.abs(e.clientX - gesture.x) > DRAG_THRESHOLD_PX ||
    Math.abs(e.clientY - gesture.y) > DRAG_THRESHOLD_PX
  ) {
    return
  }
  dragWindow(w => w.toggleMaximize())
}

/** 手势周期结束：清空 pending 与指针表。 */
function onGestureEnd(): void {
  resetGestureState()
}

// ---------------------------------------------------------------------------
// C1. 内层滚动抑制（overscroll 不外溢）
// ---------------------------------------------------------------------------

const CONTAINMENT_ATTR = 'data-qomicex-scroll-contained'

/** 已处理元素集合（用于幂等跳过，避免重复计算 computed style）。 */
const containedElements = new WeakSet<Element>()

/**
 * 给窗口内所有滚动容器设置 `overscroll-behavior: contain`。
 * 双指滑动（等价滚轮）在滚动到边界时不会继续把滚动"链式冒泡"到根容器，
 * 视觉上便是"整块内容被推动"的缺陷来源；CSS 侧已对 html/body 用
 * `overscroll-behavior: none`，这里覆盖业务里约 40 处 `overflow-*-auto` 容器。
 *
 * 幂等：已标记的元素直接跳过。不改动任何 className，不改 40 处调用点。
 */
export function applyScrollContainment(): void {
  if (!ENABLE_SCROLL_CONTAINMENT) return
  if (typeof document === 'undefined') return
  // 只遍历当前 DOM 树里的元素；已处理过的记入 WeakSet，避免重复计算 computed style
  for (const el of document.querySelectorAll<HTMLElement>('*')) {
    if (containedElements.has(el)) continue
    containedElements.add(el)
    const style = getComputedStyle(el)
    if (!overflowIsScrollable(style, 'overflowY') && !overflowIsScrollable(style, 'overflowX')) {
      continue
    }
    el.style.overscrollBehavior = 'contain'
    el.setAttribute(CONTAINMENT_ATTR, '')
  }
}



let containmentTimer: ReturnType<typeof setTimeout> | null = null

/** 防抖重扫：覆盖后挂载的 Dialog / 菜单 / 列表 / 异步内容。 */
function scheduleContainmentRescan(): void {
  if (!ENABLE_SCROLL_CONTAINMENT) return
  if (containmentTimer) clearTimeout(containmentTimer)
  containmentTimer = setTimeout(() => {
    containmentTimer = null
    applyScrollContainment()
  }, CONTAINMENT_RESCAN_DEBOUNCE_MS)
}

// ---------------------------------------------------------------------------
// 安装
// ---------------------------------------------------------------------------

const INSTALLED_FLAG = '__qomicexDragRegionsInstalled'

/**
 * 安装拖动区 / 滚动手势 / 滚动抑制。在 `src/main.tsx` 调用一次即可覆盖所有
 * 加载本 SPA 的窗口（主窗口、game-log-window、plugin-webview-*）。
 * 纯浏览器 dev（无 `__TAURI_INTERNALS__`）时直接跳过——那种环境下
 * `data-tauri-drag-region` 本来也不生效。
 */
export function installDragRegions(): void {
  if (typeof window === 'undefined' || typeof document === 'undefined') return
  const globalScope = globalThis as unknown as Record<string, unknown>
  if (globalScope[INSTALLED_FLAG]) return
  globalScope[INSTALLED_FLAG] = true
  if (!('__TAURI_INTERNALS__' in window)) return

  // B：鼠标事件（拖动判定 + 双击最大化）
  document.addEventListener('mousedown', onMouseDown)
  document.addEventListener('mousemove', onMouseMove)
  document.addEventListener('mouseup', onMouseUp)
  // 指针表：pointerdown 登记，up/cancel 移除；pointerleave 复用 onPointerEnd
  // （只删该指针本身，不清空整表——多指时单个指针滑出窗口不应影响其它指针计数）
  document.addEventListener('pointerdown', onPointerDown)
  document.addEventListener('pointermove', onPointerMove)
  document.addEventListener('pointerup', onPointerEnd)
  document.addEventListener('pointercancel', onPointerEnd)
  document.addEventListener('pointerleave', onPointerEnd)
  // G1：滚轮必须 passive，绝不拦截默认滚动
  document.addEventListener('wheel', onWheel, { passive: true })
  // 周期结束清理：失焦 / 切后台 / 右键菜单 / 左键抬起
  window.addEventListener('blur', onGestureEnd)
  document.addEventListener('visibilitychange', onGestureEnd)
  document.addEventListener('contextmenu', onGestureEnd)
  document.addEventListener('mouseup', onGestureEnd)

  // C1：滚动抑制 + 后挂载内容重扫
  applyScrollContainment()
  if (typeof MutationObserver !== 'undefined') {
    const observer = new MutationObserver(scheduleContainmentRescan)
    observer.observe(document.body, { childList: true, subtree: true })
  }
}
