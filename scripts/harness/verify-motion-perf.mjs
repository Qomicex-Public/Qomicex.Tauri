#!/usr/bin/env node
// Copyright (C) 2026 Qomicex Launcher Contributors
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * 动效性能探针：量页面转场、设置页滚动、侧边栏折叠的帧时间。
 *
 * 为什么需要它：「卡」是体感，改前改后都说不清。这里用真实 Chromium 跑同一组交互，
 * 输出 p50/p95 帧间隔、>32ms 长帧数与 longtask 总时长；同一台机器改前改后对比数字。
 * 无头 Chromium 与 WebView2 的 GPU 侧差异见
 * docs/junsi-dev-docs/2-架构设计/前端浏览器调试-Playwright-Tauri-mock注入.md：
 * 合成器/GPU 开销不可比，但布局、绘制与主线程代价可比，这正是本脚本要盯的部分。
 *
 * 用法：
 *   pnpm run harness:verify-motion                      # 只报告
 *   pnpm run harness:verify-motion -- --max-stalls 2    # 任一场景 >16.7ms 的帧超过 2 帧则 exit 1
 *   pnpm run harness:verify-motion -- --cpu-throttle 4  # 节流 4x，放大低配机上的主线程开销
 *   pnpm run harness:verify-motion -- --material frosted --headed
 *
 * `--material` 只改 `data-material` 属性，对 frosted/acrylic/aero 这类纯 CSS 材质有效；
 * 液态玻璃由组件渲染（quidlass），要量它得在设置页里切。
 */
import {
  TAURI_MOCK,
  VITE_URL,
  createProcessGroup,
  launchChromium,
  routeApiToStub,
  startServices,
} from './lib.mjs'

const args = process.argv.slice(2)
const flag = (name, fallback) => {
  const i = args.indexOf(name)
  return i >= 0 && i + 1 < args.length ? args[i + 1] : fallback
}

const MAX_STALLS = Number(flag('--max-stalls', '0')) || 0
const CPU_THROTTLE = Number(flag('--cpu-throttle', '0')) || 0
const MATERIAL = flag('--material', '')
const HEADED = args.includes('--headed')
const SETTLE_MS = Number(flag('--settle', '700')) || 700

/** 页内探针：rAF 帧间隔 + longtask。rAF 在 main.tsx 里被 fps-limiter 接管，量到的就是用户看到的帧。 */
const PROBE = `
(() => {
  window.__motionFrames = [];
  window.__motionLong = [];
  let last = 0;
  const tick = (t) => {
    if (last) window.__motionFrames.push(t - last);
    last = t;
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) window.__motionLong.push(e.duration);
    }).observe({ entryTypes: ['longtask'] });
  } catch { /* 不支持 longtask 的浏览器：只报帧间隔 */ }
})();
`

function summarize(label, { frames, long }) {
  const sorted = [...frames].sort((a, b) => a - b)
  const q = (p) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] : 0)
  return {
    label,
    frames: frames.length,
    p50: q(0.5),
    p95: q(0.95),
    max: sorted.length ? sorted[sorted.length - 1] : 0,
    // headless Chromium 不跟 vsync，rAF 能跑多快跑多快（p50 常在 6ms），
    // 所以判据是「超过一帧预算的帧数」而不是 p95。
    over16: frames.filter((f) => f > 16.7).length,
    over32: frames.filter((f) => f > 32).length,
    longTaskMs: long.reduce((a, b) => a + b, 0),
  }
}

async function resetProbe(page) {
  await page.evaluate(() => {
    window.__motionFrames.length = 0
    window.__motionLong.length = 0
  })
}

async function collect(page, label) {
  const raw = await page.evaluate(() => ({
    frames: window.__motionFrames.slice(),
    long: window.__motionLong.slice(),
  }))
  return summarize(label, raw)
}

/** 用侧边栏真实链接切换路由（pushState 不会触发 react-router 的转场动画）。 */
async function clickRoute(page, href) {
  const found = await page.evaluate((target) => {
    const link = [...document.querySelectorAll('a[href]')].find(
      (a) => a.getAttribute('href') === target,
    )
    if (!link) return false
    link.click()
    return true
  }, href)
  if (!found) throw new Error(`侧边栏找不到 ${href} 链接：页面可能还没挂载完`)
  await page.waitForFunction((target) => location.pathname === target, href, { timeout: 5000 })
}

function printResults(results, executablePath) {
  if (results.length === 0) return
  console.log(`\n[harness] 浏览器：${executablePath}`)
  console.log(`[harness] 材质：${MATERIAL || '(设置默认)'}  视口：1440x900  CPU 节流：${CPU_THROTTLE > 1 ? `${CPU_THROTTLE}x` : '无'}\n`)
  const pad = (v, w) => String(v).padEnd(w)
  console.log(
    pad('场景', 22) +
      pad('帧数', 6) +
      pad('p50', 8) +
      pad('max', 8) +
      pad('>16ms', 8) +
      pad('>32ms', 8) +
      'longtask',
  )
  for (const r of results) {
    console.log(
      pad(r.label, 22) +
        pad(r.frames, 6) +
        pad(`${r.p50.toFixed(1)}`, 8) +
        pad(`${r.max.toFixed(1)}`, 8) +
        pad(r.over16, 8) +
        pad(r.over32, 8) +
        `${r.longTaskMs.toFixed(0)}ms`,
    )
  }
}

const group = createProcessGroup()
const results = []
let executable = '(未启动)'
try {
  await startServices({ group })
  const { browser, context, executablePath } = await launchChromium({ headed: HEADED })
  executable = executablePath
  const page = await context.newPage()
  await routeApiToStub(page)
  await page.addInitScript({ content: TAURI_MOCK })
  await page.addInitScript({ content: PROBE })
  page.on('pageerror', (err) => console.log(`[页面] uncaught: ${err.message}`))
  // CPU 节流把主线程代价放大，低配机上「一卡一卡」的布局/绘制开销才看得出来。
  if (CPU_THROTTLE > 1) {
    const cdp = await context.newCDPSession(page)
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: CPU_THROTTLE })
  }

  await page.goto(`${VITE_URL}/`, { waitUntil: 'domcontentloaded' })
  // 路由只在 backendState === 'ready' 后注册，SplashScreen 通过 /api/health 判定；
  // 侧边栏是 <main> 的兄弟节点，选择器不能挂在 main 下。
  await page.waitForSelector('a[href="/instances"]', { timeout: 30000 })
  if (MATERIAL) {
    await page.evaluate((m) => document.documentElement.setAttribute('data-material', m), MATERIAL)
  }

  // 预热：首次挂载的字体/图标加载不应计入任何场景。
  await clickRoute(page, '/instances')
  await page.waitForTimeout(600)
  await clickRoute(page, '/')
  await page.waitForTimeout(600)

  const results = []

  // 页面转场：整页 opacity + 位移，子树里有 backdrop-filter 卡片时最贵。
  for (const href of ['/instances', '/settings', '/']) {
    await resetProbe(page)
    await clickRoute(page, href)
    await page.waitForTimeout(SETTLE_MS)
    results.push(await collect(page, `nav ${href}`))
  }

  // 设置页长列表滚动：内容可视性 + 合成层在滚动中的代价。
  await clickRoute(page, '/settings')
  await page.waitForTimeout(600)
  await page.mouse.move(720, 480)
  await resetProbe(page)
  for (let i = 0; i < 8; i += 1) {
    await page.mouse.wheel(0, 320)
    await page.waitForTimeout(60)
  }
  await page.waitForTimeout(300)
  results.push(await collect(page, 'scroll /settings'))

  // 筛选 Tab 切换：指示器用 transition 动 top/left/width/height（布局属性），
  // 同时列表重排，是最容易看出「每帧布局」代价的交互。
  await clickRoute(page, '/instances')
  await page.waitForTimeout(600)
  await resetProbe(page)
  const tabClicked = await page.evaluate(() => {
    const tabs = [...document.querySelectorAll('[data-tab-id]')]
    const target = tabs[1]
    if (!target) return false
    target.click()
    return true
  })
  if (!tabClicked) throw new Error('实例页找不到筛选 Tab（[data-tab-id]）')
  await page.waitForTimeout(500)
  results.push(await collect(page, 'tab /instances'))

  // 侧边栏折叠：宽度过渡会让整页 reflow。用 DOM click 绕开命中测试
  // （按钮在 Tooltip 触发器内，headless 下偶发被遮挡导致 locator.click 超时）。
  await resetProbe(page)
  const toggled = await page.evaluate(() => {
    const btn = document.querySelector('button[aria-expanded][aria-controls]')
    if (!btn) return false
    btn.click()
    return true
  })
  if (!toggled) throw new Error('找不到侧边栏折叠按钮（button[aria-expanded][aria-controls]）')
  await page.waitForTimeout(400)
  results.push(await collect(page, 'sidebar toggle'))

  printResults(results, executable)
  const over = MAX_STALLS > 0 ? results.filter((r) => r.over16 > MAX_STALLS) : []
  if (over.length > 0) {
    console.error(
      `\n[harness] >16.7ms 的帧超过 ${MAX_STALLS}：${over.map((r) => `${r.label}(${r.over16})`).join('、')}`,
    )
    await browser.close()
    process.exit(1)
  }
  await browser.close()
} catch (e) {
  printResults(results, executable)
  console.error(`\n[harness] 失败：${e.message}`)
  group.killAll()
  process.exit(1)
}
group.killAll()
