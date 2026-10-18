// Copyright (C) 2026 Qomicex Launcher Contributors
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * 插件 iframe 的宿主容器。
 *
 * `srcdoc` iframe 只有进入文档才会执行脚本（issue #260）：库插件没有页面宿主，若
 * iframe 只由 PluginPage 挂载，`registerMethod` 永不执行，依赖方的 `callPlugin` 全
 * 部失败。因此库插件激活时就把 iframe 放进挂在 body 上的隐藏宿主；打开插件页面时
 * 整体迁入页面容器，离开时迁回隐藏位置 —— 搬动走 `moveBefore`，不重建浏览上下文。
 */

/** 隐藏态：移出视口且不可见，但仍参与脚本执行。 */
export const HIDDEN_HOST_STYLE =
  'position:fixed;left:-99999px;top:0;width:1024px;height:768px;overflow:hidden;visibility:hidden;pointer-events:none'

/** 页面内显示态：铺满承载容器。 */
export const MOUNTED_HOST_STYLE = 'width:100%;height:100%'

/** 宿主初始为隐藏态；未挂进文档时样式无实际影响。 */
export function createHost(pluginId: string): HTMLDivElement {
  const host = document.createElement('div')
  host.style.cssText = HIDDEN_HOST_STYLE
  host.dataset.pluginHost = pluginId
  host.setAttribute('aria-hidden', 'true')
  return host
}

/**
 * 建 iframe 并放进宿主。`hiddenMount` 为 true 时立刻挂进 body：`srcdoc` iframe 只有
 * 进入文档才执行脚本，库插件没有页面宿主，创建时不挂载就等于方法永不注册（#260）。
 * 由 `sandbox.ts` 的 createSandbox / createSlotSandbox 统一调用，避免各写一份。
 */
export function createIframeHost(pluginId: string, hiddenMount: boolean) {
  const host = createHost(pluginId)
  const iframe = document.createElement('iframe')
  iframe.setAttribute('sandbox', 'allow-scripts')
  iframe.style.cssText = 'border:none;width:100%;height:100%'
  host.appendChild(iframe)
  if (hiddenMount) attachHost(host)
  return { host, iframe }
}

/** 挂进 body 的隐藏位置（库插件常驻用）。 */
export function attachHost(host: HTMLDivElement) {
  ;(document.body ?? document.documentElement).appendChild(host)
}

/**
 * 是否支持 `moveBefore`。
 *
 * 不支持时不能靠 `appendChild` 搬动活着的 iframe：那会重建浏览上下文、重跑插件脚本，
 * 而且每次进出插件页都重来一遍（不是一次）。那种环境下改为固定宿主位置 + 纯 CSS
 * 呈现切换（见 mountHost / unmountHost），节点始终不离开原来的父节点。
 */
function supportsMoveBefore(): boolean {
  return typeof (Element.prototype as unknown as { moveBefore?: unknown }).moveBefore === 'function'
}

/** 同文档搬动节点：`moveBefore` 不重建浏览上下文，插件脚本不会重跑。 */
function moveNode(node: HTMLElement, parent: HTMLElement) {
  const moveBefore = (parent as ParentNode & { moveBefore?: (n: Node, ref: Node | null) => void }).moveBefore
  if (typeof moveBefore === 'function') {
    try {
      moveBefore.call(parent, node, null)
      return
    } catch { /* moveBefore 要求节点已有父且同文档，不满足时退回 appendChild */ }
  }
  parent.appendChild(node)
}

/**
 * 显示态的覆盖：宿主挪进页面容器时铺满容器；无 `moveBefore` 时宿主留在 body，
 * 用 fixed 定位覆盖到页面容器所占的矩形上（纯视觉切换，iframe 不重载）。
 */
const COVER_STYLE =
  'position:fixed;overflow:hidden;pointer-events:auto;visibility:visible;z-index:1'

/**
 * 无 `moveBefore` 时，宿主用 fixed 覆盖页面容器，需要跟随容器位置变化（窗口缩放、
 * 侧边栏展开/收起、滚动）重新对齐。返回取消函数；有 `moveBefore` 时无需跟踪。
 *
 * 对同一 host 去重：重复 mount（切换设置 tab、插件停用再启用）时先取消旧的跟踪器，
 * 否则 observer 与 scroll 监听会累积。
 */
const mountTrackers = new WeakMap<HTMLDivElement, () => void>()

export function trackMountTarget(host: HTMLDivElement, target: HTMLElement, isMounted: () => boolean): () => void {
  mountTrackers.get(host)?.()
  mountTrackers.delete(host)
  if (supportsMoveBefore()) return () => {}
  const sync = () => {
    if (!isMounted()) return
    const rect = target.getBoundingClientRect()
    host.style.cssText = `${COVER_STYLE};left:${rect.left}px;top:${rect.top}px;width:${rect.width}px;height:${rect.height}px`
  }
  const observer = new ResizeObserver(sync)
  observer.observe(target)
  window.addEventListener('resize', sync)
  window.addEventListener('scroll', sync, true)
  sync()
  const stop = () => {
    observer.disconnect()
    window.removeEventListener('resize', sync)
    window.removeEventListener('scroll', sync, true)
    mountTrackers.delete(host)
  }
  mountTrackers.set(host, stop)
  return stop
}

/** 迁入页面容器并显示。 */
export function mountHost(host: HTMLDivElement, target: HTMLElement) {
  if (!supportsMoveBefore()) {
    // 固定位置渲染：iframe 留在 body 上，只改几何与可见性
    const rect = target.getBoundingClientRect()
    host.style.cssText = `${COVER_STYLE};left:${rect.left}px;top:${rect.top}px;width:${rect.width}px;height:${rect.height}px`
    host.removeAttribute('aria-hidden')
    if (host.parentElement !== (document.body ?? document.documentElement)) {
      ;(document.body ?? document.documentElement).appendChild(host)
    }
    return
  }
  if (host.parentElement === target) return
  host.style.cssText = MOUNTED_HOST_STYLE
  host.removeAttribute('aria-hidden')
  moveNode(host, target)
}

/** 退回 body 的隐藏位置，已注册的插件方法不随页面卸载消失。 */
export function unmountHost(host: HTMLDivElement) {
  const body = document.body ?? document.documentElement
  if (host.parentElement === body) {
    // 已经在 body：只需恢复隐藏样式（无 moveBefore 的固定位置渲染路径也走这里）
    host.style.cssText = HIDDEN_HOST_STYLE
    host.setAttribute('aria-hidden', 'true')
    return
  }
  host.style.cssText = HIDDEN_HOST_STYLE
  host.setAttribute('aria-hidden', 'true')
  moveNode(host, body)
}
