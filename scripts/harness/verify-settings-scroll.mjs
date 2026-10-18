#!/usr/bin/env node
// Copyright (C) 2026 Qomicex Launcher Contributors
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * 端到端校验插件设置页可被**用户**滚动（issue #269 的浏览器侧护栏）。
 *
 * `scripts/test-plugin-settings-scroll.mjs` 只对注入 CSS 做静态断言；本脚本补上浏览器侧：
 * 起 stub + Vite dev、注入 Tauri mock，进「设置 → 插件 → 插件设置」，用真实 `mouse.wheel`
 * 滚长设置页 iframe。必须用真实滚轮：`overflow:hidden` 时 `window.scrollTo` 依然有效
 * （`scrollHeight > clientHeight` 也照旧成立），只有真实滚轮能复现「被裁掉」。
 *
 * 设置页是 srcdoc iframe（见 sandbox.ts loadSandboxContent），frame 的 URL 恒为 about:srcdoc，
 * 因此按槽位 `data-slot-id` 定位，不能用 URL 匹配。
 *
 * 「没被裁掉」的判据是 iframe 自己滚到 maxScroll 且底部标记入视口；外层则比较 iframe 最近的滚动
 * 容器（PageShell，overflow-y-auto）的 scrollTop 是否变化——Layout 的 main 是 overflow-hidden，
 * window.scrollY 恒为 0，拿它当断言等于没断言。
 *
 * 依赖 plugins-dev/settings-pages-demo（本脚本会自动构建其 dist/）。
 * 用法：pnpm run harness:verify-settings-scroll [--headed]
 * 退出码：0 全部通过；1 有断言失败。
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  PLUGINS_DIR,
  TAURI_MOCK,
  VITE_URL,
  createProcessGroup,
  launchChromium,
  routeApiToStub,
  startServices,
} from './lib.mjs'

const PLUGIN_ID = 'settings-pages-demo'
const PLUGIN_NAME = '设置页演示'
const PLUGIN_DIR = join(PLUGINS_DIR, PLUGIN_ID)
const LONG_FILE = 'dist/settings-long.html'
const SHORT_FILE = 'dist/settings-short.html'
const MARKER_ID = 'settings-bottom-marker'

const headed = process.argv.includes('--headed')
const results = []
function check(name, ok, detail = '') {
  results.push({ name, ok, detail })
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${name}${detail ? ` — ${detail}` : ''}`)
}

/** 断言失败也不中断，收集完再统一给退出码。 */
async function step(name, fn) {
  try {
    return await fn()
  } catch (e) {
    check(name, false, `异常：${e.message}`)
    return null
  }
}

/** 点击文本完全匹配的按钮/tab；轮询等待元素出现（页面挂载有先后）。 */
async function clickText(page, text, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const clicked = await page.evaluate((t) => {
      const el = [...document.querySelectorAll('button,[role="tab"]')].find((b) => (b.textContent || '').trim() === t)
      if (!el) return false
      el.click()
      return true
    }, text)
    if (clicked) return true
    await page.waitForTimeout(400)
  }
  return false
}

/** 关掉「未检测到 Java 运行时」等模态：模态会截获滚轮，造成假阴性。 */
async function dismissModals(page) {
  for (let i = 0; i < 5; i += 1) {
    const clicked = await page.evaluate(() => {
      const el = [...document.querySelectorAll('button')].find((b) => (b.textContent || '').trim() === '确定')
      if (!el) return false
      el.click()
      return true
    })
    if (!clicked) break
    await page.waitForTimeout(400)
  }
}

/** 槽位 iframe 的选择器（frame URL 恒为 about:srcdoc，只能按 data-slot-id 定位）。 */
const slotSelector = (file) => `.plugin-slot[data-slot-id="plugin-settings:${PLUGIN_ID}:${file}"] iframe`

/** 按槽位拿到设置页 iframe 与它的文档（srcdoc，等插件 HTML fetch 完才渲染）。 */
async function waitForSlotFrame(page, file, timeoutMs = 25000) {
  const selector = slotSelector(file)
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const el = await page.$(selector)
    const frame = el ? await el.contentFrame() : null
    if (frame) {
      const ready = await frame.evaluate(() => !!document.body && document.body.children.length > 0).catch(() => false)
      if (ready) return { el, frame }
    }
    await page.waitForTimeout(300)
  }
  return null
}

/** 设置页 iframe 的读值：内容/视口高度、两轴 overflow、当前滚动位置、底部标记位置。
 *  滚动位置取 window.scrollY 与 document.scrollingElement.scrollTop 的较大值：body 带 overflow 时
 *  不同浏览器把滚动落到哪个对象上并不一致。 */
const probeFrame = (markerId) => {
  const html = document.documentElement
  const scroller = document.scrollingElement ?? html
  const marker = markerId ? document.getElementById(markerId) : null
  const rect = marker?.getBoundingClientRect()
  return {
    scrollY: Math.round(Math.max(window.scrollY, scroller.scrollTop)),
    scrollHeight: html.scrollHeight,
    clientHeight: html.clientHeight,
    maxScroll: html.scrollHeight - html.clientHeight,
    bodyOverflowY: getComputedStyle(document.body).overflowY,
    htmlOverflowY: getComputedStyle(html).overflowY,
    markerInView: !!rect && rect.top < window.innerHeight && rect.bottom > 0,
  }
}

/** 宿主文档里 iframe 最近的滚动容器（可滚动 overflow 的最近祖先，没有则回退 document.scrollingElement）。
 *  不能只看 window.scrollY：Layout 的 main 是 overflow-hidden，页面本身永远不滚，设置页真正的滚动
 *  容器是外层 PageShell（overflow-y-auto），比较它的 scrollTop 才能发现「外层跟着滚」。 */
const probeOuterScroll = (selector) => {
  const scrollable = (el) => {
    const overflowY = getComputedStyle(el).overflowY
    return overflowY === 'auto' || overflowY === 'scroll' || overflowY === 'overlay'
  }
  let node = document.querySelector(selector)?.parentElement ?? null
  let container = null
  while (node && node !== document.documentElement) {
    if (scrollable(node)) {
      container = node
      break
    }
    node = node.parentElement
  }
  const target = container ?? document.scrollingElement ?? document.documentElement
  const classes = typeof target.className === 'string' ? target.className.trim().split(/\s+/).slice(0, 2).join('.') : ''
  return {
    via: container ? `${target.tagName.toLowerCase()}${classes ? `.${classes}` : ''}` : 'document.scrollingElement',
    scrollTop: Math.round(target.scrollTop),
    scrollHeight: target.scrollHeight,
    clientHeight: target.clientHeight,
  }
}

/** iframe 内当前滚动位置（与 probeFrame 同口径）。 */
const frameScrollTop = (frame) => frame.evaluate(() => Math.round(Math.max(window.scrollY, (document.scrollingElement ?? document.documentElement).scrollTop)))

/** 真实滚轮：鼠标移到 iframe 中心后连续滚动，最后一格只补到 iframe 底部为止。
 *  滚轮越过 iframe 底部后，剩余量会被浏览器链式交给外层滚动容器（scroll chaining），那是正常行为，
 *  却会掩盖「外层是不是自己在滚」，所以这里不产生溢出。返回实际 tick 次数。 */
async function wheelScroll(page, box, frame, maxScroll, ticks = 20, deltaY = 300) {
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  let used = 0
  for (let i = 0; i < ticks; i += 1) {
    const remaining = maxScroll - await frameScrollTop(frame)
    if (remaining <= 2) break
    await page.mouse.wheel(0, Math.min(deltaY, remaining))
    used += 1
    await page.waitForTimeout(100)
  }
  await page.waitForTimeout(400)
  return used
}

// --- 0. 构建 fixture（dist/ 是生成物，避免用到过期产物） ---
const buildScript = join(PLUGIN_DIR, 'build.mjs')
if (!existsSync(join(PLUGIN_DIR, 'manifest.json')) || !existsSync(buildScript)) {
  console.error(`找不到 fixture 插件：${PLUGIN_DIR}（需要 manifest.json 与 build.mjs）`)
  process.exit(1)
}
const build = spawnSync(process.execPath, [buildScript], { cwd: PLUGIN_DIR, stdio: 'inherit' })
if (build.status !== 0) {
  console.error('fixture 构建失败')
  process.exit(1)
}

// 每次运行用独立的私有临时目录放 stub mock（mkdtemp 是 0700，且不复用可预测路径）
const mockDir = mkdtempSync(join(tmpdir(), 'qomicex-harness-settings-scroll-'))
const mockPath = join(mockDir, 'mock.json')
writeFileSync(mockPath, JSON.stringify({ pluginIds: [PLUGIN_ID] }, null, 2))

let browser = null
let group = null
let error = null
try {
  // --- 1. stub + Vite dev（只暴露本 fixture，设置页 tab 唯一） ---
  group = createProcessGroup()
  await startServices({ group, mock: mockPath })

  // --- 2. 浏览器 + Tauri mock ---
  const launched = await launchChromium({ headed })
  browser = launched.browser
  console.log(`[verify] 浏览器: ${launched.executablePath}`)
  const page = await launched.context.newPage()
  await routeApiToStub(page)
  await page.addInitScript({ content: TAURI_MOCK })

  await page.goto(`${VITE_URL}/`, { waitUntil: 'domcontentloaded', timeout: 90000 })
  for (let i = 0; i < 40; i += 1) {
    if (await page.evaluate(() => !!document.querySelector('main'))) break
    await page.waitForTimeout(500)
  }

  // --- 3. 设置 → 插件 → 插件设置 ---
  const long = await step('进入插件设置页', async () => {
    await page.evaluate(() => document.querySelector('a[href="/settings"]')?.click())
    if (!await clickText(page, '插件')) throw new Error('找不到「插件」设置 tab')
    if (!await clickText(page, '插件设置')) throw new Error('找不到「插件设置」tab')
    await dismissModals(page)
    let slot = await waitForSlotFrame(page, LONG_FILE, 8000)
    if (!slot) {
      await clickText(page, `${PLUGIN_NAME} 1`, 5000)
      slot = await waitForSlotFrame(page, LONG_FILE, 15000)
    }
    if (!slot) throw new Error(`设置页 iframe 未渲染：${LONG_FILE}`)
    return slot
  })

  if (long) {
    check(`插件设置页列出本 fixture（${PLUGIN_ID}）`, true)

    const box = await long.el.boundingBox()
    check('长设置页 iframe 高度确定且非零', !!box && box.height > 100, box ? `${Math.round(box.width)}x${Math.round(box.height)}` : '无 boundingBox')

    const before = await long.frame.evaluate(probeFrame, MARKER_ID)
    check('长设置页内容确实溢出（需要滚动才看得到底部）', before.maxScroll > 200, `scrollHeight=${before.scrollHeight} clientHeight=${before.clientHeight} maxScroll=${before.maxScroll}`)
    check('body 两轴 overflow 不是 hidden/clip（否则用户滚不动）', before.bodyOverflowY !== 'hidden' && before.bodyOverflowY !== 'clip', `body.overflowY=${before.bodyOverflowY} html.overflowY=${before.htmlOverflowY}`)
    check('滚动前在顶部', before.scrollY === 0, `scrollY=${before.scrollY}`)

    const outerBefore = await page.evaluate(probeOuterScroll, slotSelector(LONG_FILE))
    const ticks = box ? await wheelScroll(page, box, long.frame, before.maxScroll) : 0
    const after = await long.frame.evaluate(probeFrame, MARKER_ID)
    const outerAfter = await page.evaluate(probeOuterScroll, slotSelector(LONG_FILE))

    check('真实滚轮能滚动长设置页', after.scrollY > 0, `scrollY=${after.scrollY} / maxScroll=${after.maxScroll}`)
    check('滚到底部（未被截断）', after.scrollY >= after.maxScroll - 2, `scrollY=${after.scrollY} maxScroll=${after.maxScroll}`)
    check('底部标记滚入视口', after.markerInView, `markerInView=${after.markerInView}`)
    check('滚动发生在 iframe 内（宿主滚动容器不跟着滚）', outerAfter.scrollTop === outerBefore.scrollTop, `${ticks} 格滚轮到 iframe 底部，${outerBefore.via} scrollTop ${outerBefore.scrollTop} → ${outerAfter.scrollTop}`)
  }

  // --- 4. 短设置页：内容不溢出时不应有滚动条 ---
  const short = await step('切到短设置页', async () => {
    if (!await clickText(page, `${PLUGIN_NAME} 2`, 8000)) throw new Error('找不到短设置页 tab')
    const slot = await waitForSlotFrame(page, SHORT_FILE, 20000)
    if (!slot) throw new Error(`短设置页 iframe 未渲染：${SHORT_FILE}`)
    return slot
  })
  if (short) {
    const probe = await short.frame.evaluate(probeFrame)
    check('短设置页内容不溢出（无多余滚动条/空白）', probe.maxScroll <= 1, `scrollHeight=${probe.scrollHeight} clientHeight=${probe.clientHeight}`)
    check('短设置页 overflow 同样不是 hidden/clip', probe.bodyOverflowY !== 'hidden' && probe.bodyOverflowY !== 'clip', `body.overflowY=${probe.bodyOverflowY}`)
  }
} catch (e) {
  error = e
} finally {
  // 失败路径也必须回收：浏览器与 harness 子进程都不留在后台
  if (browser) await browser.close().catch(() => {})
  group?.killAll()
  rmSync(mockDir, { recursive: true, force: true })
}

const failed = results.filter((r) => !r.ok)
if (error) console.error(`[verify] 运行失败：${error.message}`)
console.log(`\n[verify] ${results.length - failed.length}/${results.length} 通过`)
for (const f of failed) console.error(`[verify] FAIL ${f.name}${f.detail ? ` — ${f.detail}` : ''}`)

process.exit(error || failed.length ? 1 : 0)
