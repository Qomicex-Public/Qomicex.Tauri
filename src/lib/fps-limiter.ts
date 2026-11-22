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
const pending = new Map<number, FrameCb>()
let rafId = 0
// 下一次允许投递的时间点（0 = 立刻）。按栅格推进而不是"距上次满 interval"，
// 否则显示刷新率上限与设定值不能整除时会系统性掉帧（144Hz 上 60fps 掉成 48fps）。
let nextAt = 0

function schedule() {
  if (!rafId) rafId = nativeRaf(flush)
}

function flush(now: number) {
  rafId = 0
  if (pending.size === 0) return
  if (capFps > 0) {
    const interval = 1000 / capFps
    // 首次进入 / 上限刚变更：以当前 vsync 为起点，避免等一整帧。
    if (nextAt === 0) nextAt = now
    // 留 1ms 容差，避免 vsync 抖动（16.6/16.7ms）让 60fps 上限掉成 30fps。
    if (now + 1 < nextAt) {
      schedule()
      return
    }
    nextAt += interval
    // 落后一帧以上（切后台、长卡顿）就重新对齐，避免连发补帧把动画"快进"。
    // shortcut: 上限受 vsync 栅格限制，144Hz 上设 60fps 实测约 58fps（无法整除）。
    if (nextAt < now) nextAt = now + interval
  }
  // 逐条取、取到再删：同一个批次里的回调可能被 cancelAnimationFrame 撤掉，
  // 快照后统一执行会让已取消的回调仍然跑一次（更新到过期 UI）。
  for (const id of [...pending.keys()]) {
    const cb = pending.get(id)
    if (!cb) continue
    pending.delete(id)
    // 与原生 rAF 一致：一个回调抛错不能拖死同帧其它回调，也不能停掉整个循环。
    try {
      cb(now)
    } catch (e) {
      queueMicrotask(() => {
        throw e
      })
    }
  }
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
  // 重新计时：从「不限」切到「限」或改档位时，第一帧不该被"尚未到点"白等一轮。
  nextAt = 0
}
