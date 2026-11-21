// Copyright (C) 2026 Qomicex Launcher Contributors
// SPDX-License-Identifier: GPL-3.0-or-later

// 渲染帧率上限：接管 `window.requestAnimationFrame`，把回调投递频率钳到设定值。
//
// WebView 没有「限制合成器帧率」的 API，能真正减少绘制的只有一个口子 —— 让每帧的
// 内容更新变少。启动器的动画全部排在 rAF 上（GSAP ticker、页面切换、滚动跟随、
// FPS 读数），所以钳住 rAF 的投递频率，动画就真的按该帧率渲染。
//
// 之前 `maxFrameRate` 只是乘了动画时长（60/fps）：动画变得更慢，但仍按显示器刷新率
// 逐帧绘制，用户体感「没有任何区别」（issue #375）。

type FrameCb = FrameRequestCallback

const nativeRaf = window.requestAnimationFrame.bind(window)

let capFps = 0
let nextId = 1
let pending = new Map<number, FrameCb>()
let rafId = 0
let lastFlush = 0

function schedule() {
  if (!rafId) rafId = nativeRaf(flush)
}

function flush(now: number) {
  rafId = 0
  if (pending.size === 0) return
  // 还没到下一帧的时间点：把这一轮的 vsync 让掉，下次 vsync 再判。
  // 留 1ms 容差，避免 vsync 抖动（16.6/33.3ms）让 60fps 上限掉成 30fps。
  if (capFps > 0 && now - lastFlush < 1000 / capFps - 1) {
    schedule()
    return
  }
  lastFlush = now
  const batch = pending
  pending = new Map()
  for (const cb of batch.values()) {
    // 与原生 rAF 一致：一个回调抛错不能拖死同帧其它回调，也不能停掉整个循环。
    try {
      cb(now)
    } catch (e) {
      queueMicrotask(() => {
        throw e
      })
    }
  }
  // 回调里新排的帧在 `flush` 期间已各自 schedule 过，这里只在还没排时补一次。
  schedule()
}

// 无上限时同样走这里：一帧一次 vsync 的语义与原生 rAF 完全一致，
// 只是多一次 Map 分配。好处是切换上限时不必在两条实现之间倒腾 id。
window.requestAnimationFrame = (cb: FrameCb): number => {
  const id = nextId++
  pending.set(id, cb)
  schedule()
  return id
}

window.cancelAnimationFrame = (id: number) => {
  // 只撤销我们自己发出去的 id。**不能**回退到原生 cancel：原生 id 与小整数同域，
  // 一旦撞上我们内部 `nativeRaf(flush)` 的 id，会把调度循环本身取消掉，动画永久停摆。
  pending.delete(id)
}

/** 设置帧率上限；`0`/非法值 = 不限制（跟随显示器刷新率）。 */
export function setFrameCap(fps: number): void {
  const next = Number.isFinite(fps) && fps > 0 ? fps : 0
  if (next === capFps) return
  capFps = next
  // 从「不限」切到「限」时重新计时，避免第一帧被误判为"尚未到点"而白等一轮。
  lastFlush = performance.now()
}
