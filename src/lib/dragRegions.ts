import { getCurrentWindow, type Window } from '@tauri-apps/api/window'

/**
 * 触控板友好的窗口拖动区（drag region）。
 *
 * 背景：Tauri v2 内置的 `data-tauri-drag-region`（tauri 2.x 的
 * `src/window/scripts/drag.js`）在 mousedown 命中拖动区时**立即**
 * `invoke('plugin:window|start_dragging')`，没有任何位移阈值。触控板上
 * "按下——拖动"的意图远比鼠标模糊：Windows 精确式触控板默认开启的
 * "点两下并拖动"、轻点单击后指尖的自然微移、macOS 默认开启的"三指拖动"，
 * 都会产生一次 mousedown 加少量 mousemove，于是窗口被误拖动
 * （issue #114：触控板拖动时整个启动器 UI 被拖动）。
 *
 * 做法：把 Tauri 的拖动区判定语义原样移植到前端，再加上位移阈值与
 * "主键仍按住"校验：
 *  - mousedown 命中拖动区 → 只记录起点，**不**启动拖动；不阻止事件传播，
 *    页面点击/按钮/文本等其余行为与之前完全一致；
 *  - mousemove 位移超过 `DRAG_THRESHOLD_PX` 且主键仍按住 → 才真正
 *    `startDragging()`；
 *  - 双击且未产生显著位移 → `toggleMaximize()`（保留自定义标题栏的
 *    双击最大化/还原，与三大平台原生标题栏一致，在 mouseup 上触发）。
 *
 * 属性名改用 `data-qomicex-drag-region`（取值语义与 Tauri 一致：
 * 空 / `"true"` = 仅命中元素自身；`"deep"` = 子树内命中即拖；`"false"` = 禁用，
 * 且 button/input 等可交互元素裸命中会被阻断）。换了属性名，Tauri
 * 内置脚本便不再接管这些区域，彻底避免"mousedown 即拖窗"。
 */

/** 拖动区属性名。刻意区别于 `data-tauri-drag-region`，见文件头说明。 */
export const DRAG_REGION_ATTR = 'data-qomicex-drag-region'

/**
 * 位移阈值（px）。触控板轻点后的指尖微移（通常 1~4px）不应拖动窗口；
 * 鼠标拖动超过该值后窗口直接跟手，用户无感知。原生 Windows 的
 * SM_CXDRAG/SM_CYDRAG 为 4px，这里取稍大的 8px 以兼容触控板抖动。
 */
const DRAG_THRESHOLD_PX = 8
const DRAG_THRESHOLD_SQ = DRAG_THRESHOLD_PX * DRAG_THRESHOLD_PX

// 与 tauri/src/window/scripts/drag.js 保持一致的可交互元素集合：
// 裸命中（不带本属性）时阻断拖动，保证标题栏按钮/输入框等照常点击。
const CLICKABLE_TAGS = new Set([
  'A',
  'BUTTON',
  'INPUT',
  'SELECT',
  'TEXTAREA',
  'LABEL',
  'SUMMARY',
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

function isClickableElement(el: HTMLElement): boolean {
  return (
    CLICKABLE_TAGS.has(el.tagName) ||
    (el.hasAttribute('contenteditable') && el.getAttribute('contenteditable') !== 'false') ||
    (el.hasAttribute('tabindex') && el.getAttribute('tabindex') !== '-1') ||
    INTERACTIVE_ROLES.has(el.getAttribute('role') ?? '')
  )
}

/**
 * 由事件路径自底向上判定是否命中拖动区，语义与 Tauri 内置脚本一致：
 * 可交互元素裸命中 → 阻断；`"false"` → 阻断；`"deep"` → 子树内任意命中即拖；
 * 空 / `"true"` → 仅元素自身被直接命中才拖。
 */
function isDragRegion(path: EventTarget[]): boolean {
  for (const el of path) {
    if (!(el instanceof HTMLElement)) continue
    const attr = el.getAttribute(DRAG_REGION_ATTR)
    if (isClickableElement(el) && attr === null) return false
    if (attr === null) continue
    if (attr === 'false') return false
    if (attr === 'deep') return true
    if (attr === '' || attr === 'true') return el === path[0]
  }
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

function clearPending(): void {
  pending = null
}

/** 对当前窗口执行一次动作；同步取窗口失败/动作 reject 都静默吞掉。 */
function dragWindow(action: (win: Window) => Promise<unknown>): void {
  try {
    action(getCurrentWindow()).catch(() => {})
  } catch {
    /* 非 Tauri 环境或 internals 尚未就绪：忽略 */
  }
}

function onMouseDown(e: MouseEvent): void {
  // 无论本次是否命中拖动区，先丢掉上一次未决手势：mouseup 有可能在窗口外发生
  // （页面收不到），残留的 pending 会让下一次"按住 + 移动"误触发拖窗
  clearPending()
  // 与 Tauri 内置脚本一致：只处理主键的单击/双击，忽略其它按键与三连击
  if (e.button !== 0) return
  if (e.detail !== 1 && e.detail !== 2) return
  if (!isDragRegion(e.composedPath())) return
  // 只记账、不动窗口，也不阻止默认行为/传播：拖动区内的点击与原来完全一样
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

const INSTALLED_FLAG = '__qomicexDragRegionsInstalled'

/**
 * 安装拖动区监听。在 `src/main.tsx` 调用一次即可覆盖所有加载本 SPA 的窗口
 * （主窗口、game-log-window、plugin-webview-*）。
 * 纯浏览器 dev（无 `__TAURI_INTERNALS__`）时直接跳过——那种环境下
 * `data-tauri-drag-region` 本来也不生效。
 */
export function installDragRegions(): void {
  if (typeof window === 'undefined' || typeof document === 'undefined') return
  const globalScope = globalThis as unknown as Record<string, unknown>
  if (globalScope[INSTALLED_FLAG]) return
  globalScope[INSTALLED_FLAG] = true
  if (!('__TAURI_INTERNALS__' in window)) return

  document.addEventListener('mousedown', onMouseDown)
  document.addEventListener('mousemove', onMouseMove)
  document.addEventListener('mouseup', onMouseUp)
  // 拖动途中窗口失焦（如被切换/最小化）→ 丢掉未决手势，避免残留
  window.addEventListener('blur', clearPending)
}
