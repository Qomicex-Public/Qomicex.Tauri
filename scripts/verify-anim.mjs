#!/usr/bin/env node
// Copyright (C) 2026 Qomicex Launcher Contributors
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * 动效冒烟验证（Playwright + Tauri mock + harness stub，不需要 Rust 后端）。
 *
 * 断言的是「有没有动」，不比对像素：
 *   1. 页面入场：PageShell 的顶层块在 t=0 时 opacity < 1，t=700ms 后回到 1 且无内联 transform 残留
 *   2. 列表入场：实例列表容器首帧存在 opacity < 1 的卡片（玻璃卡只做 opacity）
 *   3. 骨架溶解：ContentTransition 先出骨架、再出内容（若接口返回慢于 400ms）
 *   4. 全局门控：data-anim-enabled=false 时入场块 t=0 即 opacity=1
 *
 * 运行：node scripts/verify-anim.mjs [--headed]
 */
import { TAURI_MOCK, VITE_URL, createProcessGroup, launchChromium, routeApiToStub, startServices } from './harness/lib.mjs'

const headed = process.argv.includes('--headed')
const group = createProcessGroup()
let failed = 0

function check(name, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failed += 1
}

/**
 * 从 document 起点常驻的帧记录器（addInitScript 安装）。
 *
 * 首屏渲染会阻塞主线程一两百毫秒，Node 端的 "等待 main 后再采样" 往往错过
 * 动画窗口；把采样器放进页面，从第一帧就开始记录，才能可靠判定「有没有动」。
 */
const FRAME_RECORDER = () => {
  window.__qmxFrames = []
  const start = performance.now()
  const tick = () => {
    const node = document.querySelector('main [data-key]')
    let target = node
    if (node) {
      // 与 useAnimatedList 一致：动画目标是「列表根的直接子元素」，
      // 它可能是带 data-key 的节点，也可能是包了一层的无 key 包装器。
      let current = node
      while (current.parentElement && current.parentElement.querySelectorAll('[data-key]').length === 1) {
        current = current.parentElement
      }
      target = current
    }
    if (target) {
      window.__qmxFrames.push({
        t: Math.round(performance.now() - start),
        opacity: Number(getComputedStyle(target).opacity),
      })
    }
    if (performance.now() - start < 9000) requestAnimationFrame(tick)
  }
  requestAnimationFrame(tick)
}

/** 读取选择器集合的即时样式（getComputedStyle 是同步的，采样精度足够判断「是否在动」） */
async function sample(page, selector) {
  return page.$$eval(selector, (nodes) => nodes.map((n) => {
    const cs = getComputedStyle(n)
    return {
      opacity: Number(cs.opacity),
      transform: cs.transform,
      hasInlineTransform: n.style.transform !== '',
    }
  }))
}

try {
  await startServices({ group })
  const { browser, context } = await launchChromium({ headed })

  // --- 场景 1：正常入场 ---
  const page = await context.newPage()
  await page.addInitScript(TAURI_MOCK)
  await page.addInitScript(FRAME_RECORDER)
  await routeApiToStub(page)

  const errors = []
  page.on('pageerror', (err) => errors.push(String(err)))

  // 先落在设置页，等首屏稳定后再用 SPA 点击切页——这样能从动画第一帧开始采样
  await page.goto(`${VITE_URL}/settings`, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('main [data-reveal]', { timeout: 30000 })
  await page.waitForTimeout(900)
  // 首次启动可能有 EULA/引导弹窗挡住点击：连续 Esc 关掉
  for (let i = 0; i < 5; i++) {
    if (!(await page.$('div.fixed.inset-0.z-50'))) break
    await page.keyboard.press('Escape')
    await page.waitForTimeout(250)
  }

  await page.click('a[href="/instances"]')
  const early = await sample(page, 'main [data-reveal]')
  check('页面入场：存在参与动画的区块', early.length > 0, `${early.length} 块`)
  check('页面入场：首帧未到终态', early.some((s) => s.opacity < 0.99), JSON.stringify(early.map((s) => s.opacity)))

  await page.waitForTimeout(800)
  const settled = await sample(page, 'main [data-reveal]')
  check('页面入场：700ms 后全部不透明', settled.every((s) => s.opacity > 0.99))
  check('页面入场：结束后无内联 transform 残留', settled.every((s) => !s.hasInlineTransform))

  // --- 场景 2：列表入场（实例页：stub 没有数据，这里补两条版本记录） ---
  await page.route('**/api/versions/scan**', async (route) => {
    // 慢接口：让骨架必然显示（400ms 延迟 + 最短停留），同时守住
    // 「加载完成后骨架必须切换成内容」这条回归（PR #387 审查修复引入过卡死）。
    await new Promise((resolve) => setTimeout(resolve, 1000))
    await route.fulfill({
      json: {
        path: '.minecraft',
        noJsonDirs: [],
        refineRequired: false,
        versions: [
          { name: '1.20.1', dirName: '1.20.1', gameVersion: '1.20.1', state: 'Available', stateDescribe: '', loaders: [] },
          { name: '1.20.1-Forge-47.1.0', dirName: '1.20.1-Forge-47.1.0', gameVersion: '1.20.1', state: 'Available', stateDescribe: '', loaders: [{ type: 'Forge', version: '47.1.0' }] },
        ],
      },
    })
  })
  await page.route('**/api/instance', (route) => {
    if (route.request().method() !== 'GET' || new URL(route.request().url()).pathname !== '/api/instance') {
      return route.fallback()
    }
    return route.fulfill({ json: [] })
  })

  await page.goto(`${VITE_URL}/instances`, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('main .animate-shimmer', { timeout: 4000 })
  const skeletonDuring = await page.$$eval('main .animate-shimmer', (nodes) => nodes.length)
  const cardsDuring = await page.$$eval('main [data-key]', (nodes) => nodes.length)
  check('骨架溶解：慢接口时先出占位、不出内容', skeletonDuring > 0 && cardsDuring === 0, `${skeletonDuring} 占位 / ${cardsDuring} 卡片`)

  await page.waitForSelector('main [data-key]', { timeout: 8000 })
  const skeletonAfter = await page.$$eval('main .animate-shimmer', (nodes) => nodes.length)
  check('骨架溶解：加载完成后占位已移除', skeletonAfter === 0, `${skeletonAfter} 个残留`)

  await page.waitForTimeout(900)
  const frames = await page.evaluate(() => window.__qmxFrames ?? [])
  const withCards = frames.filter((f) => f.opacity !== null)
  const dipped = withCards.some((f) => f.opacity < 0.99)
  check('列表入场：fixture 卡片已渲染', withCards.length > 0, `${withCards.length} 帧`)
  if (withCards.length > 0) {
    check('列表入场：出现过未到终态的卡片', dipped, `${withCards.length} 帧 / 最低 ${Math.min(...withCards.map((f) => f.opacity)).toFixed(2)}`)
    const cardsSettled = await page.$$eval('main [data-key]', (nodes) => nodes.map((n) => {
      let target = n
      while (target.parentElement && target.parentElement.querySelectorAll('[data-key]').length === 1) {
        target = target.parentElement
      }
      return target.style.transform !== '' || target.style.opacity !== ''
    }))
    check('列表入场：结束后无内联样式残留', cardsSettled.every((has) => !has))
  }

  // --- 场景 3：全局门控 ---
  await page.evaluate(() => {
    document.documentElement.dataset.animEnabled = 'false'
    document.documentElement.style.setProperty('--anim-duration-multiplier', '0')
  })
  await page.click('a[href="/settings"]').catch(async () => {
    await page.evaluate(() => document.querySelector('a[href="/settings"]').click())
  })
  await page.waitForTimeout(150)
  const gated = await page.$$eval('main [data-reveal]', (nodes) => nodes.map((n) => ({
    inlineOpacity: n.style.opacity,
    inlineTransform: n.style.transform,
  })))
  check(
    '门控：关闭动画后不写入内联样式',
    gated.length > 0 && gated.every((s) => s.inlineOpacity === '' && s.inlineTransform === ''),
    JSON.stringify(gated),
  )

  check('无页面级 JS 异常', errors.length === 0, errors.slice(0, 3).join(' | '))

  await browser.close()
} finally {
  group.killAll()
}

console.log(failed === 0 ? 'verify-anim: all checks passed' : `verify-anim: ${failed} check(s) failed`)
process.exit(failed === 0 ? 0 : 1)
