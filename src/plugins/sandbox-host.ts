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
 * 同文档搬动节点：`moveBefore` 不重建浏览上下文，插件脚本不会重跑。
 *
 * 无 `moveBefore`（WebKit/Safari，实测 Safari 至今不支持）时退化为 `appendChild`，
 * 这**不是**等价降级：iframe 会被重新加载，新文档要重新执行前端、重新注册方法，
 * 期间注册表里仍留着旧 document 的 window 引用 —— 它的 `closed === true`，
 * `postMessage` 不报错但没人接收，调用方 Promise 永久挂起（实测 >6s 无回执）。
 * 因此仅在拿不到 `moveBefore` 时才走这条路径，且只在有页面宿主、确实需要搬动时
 * 才会触发；库插件的隐藏宿主从不搬动。
 */
function moveNode(node: HTMLElement, parent: HTMLElement) {
  const moveBefore = (parent as ParentNode & { moveBefore?: (n: Node, ref: Node | null) => void }).moveBefore
  if (typeof moveBefore === 'function') {
    try {
      moveBefore.call(parent, node, null)
      return
    } catch { /* moveBefore 要求节点已有父且同文档，不满足时走 appendChild */ }
  }
  parent.appendChild(node)
}

/** 迁入页面容器并显示。 */
export function mountHost(host: HTMLDivElement, target: HTMLElement) {
  if (host.parentElement === target) return
  host.style.cssText = MOUNTED_HOST_STYLE
  host.removeAttribute('aria-hidden')
  moveNode(host, target)
}

/** 退回 body 的隐藏位置，已注册的插件方法不随页面卸载消失。 */
export function unmountHost(host: HTMLDivElement) {
  const body = document.body ?? document.documentElement
  if (host.parentElement === body) return
  host.style.cssText = HIDDEN_HOST_STYLE
  host.setAttribute('aria-hidden', 'true')
  moveNode(host, body)
}
