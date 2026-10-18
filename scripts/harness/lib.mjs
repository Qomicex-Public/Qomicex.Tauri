#!/usr/bin/env node
// Copyright (C) 2026 Qomicex Launcher Contributors
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * 插件调试 harness 公共设施：stub/Vite 生命周期、Tauri mock、API 转发、浏览器启动。
 *
 * `run.mjs`（交互式调试）与 `verify-settings-scroll.mjs`（自动校验）共用，避免
 * Tauri mock 与端口/进程管理在多份脚本里各写一遍而悄悄漂移。mock 的写法与
 * 「为什么需要 mock」见 docs/junsi-dev-docs/2-架构设计/前端浏览器调试-Playwright-Tauri-mock注入.md。
 */
import { spawn, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { delimiter, join, resolve } from 'node:path'

export const ROOT = resolve(import.meta.dirname, '../..')
export const VITE_URL = 'http://127.0.0.1:1420'
export const STUB_PORT = 5100
export const STUB_URL = `http://127.0.0.1:${STUB_PORT}`
export const PLUGINS_DIR = join(ROOT, 'plugins-dev')

/**
 * 在页面脚本执行前注入的 Tauri API mock：没有 Tauri 时 `window.__TAURI_INTERNALS__`
 * 为 undefined，`getCurrentWindow()`（TitleBar 模块顶层调用）会抛，React 整棵树无法挂载。
 */
export const TAURI_MOCK = `
(() => {
  let cid = 0; const cbs = new Map();
  const internals = {
    metadata: { currentWindow: { label: 'main' }, currentWebview: { label: 'main' } },
    transformCallback: (cb) => { const id = ++cid; cbs.set(id, cb); return id; },
    unregisterCallback: (id) => { cbs.delete(id); },
    invoke: (cmd) => new Promise((res) => {
      const bools = ['is_maximized','is_minimized','is_focused','is_decorated',
                     'is_resizable','is_maximizable','is_minimizable','is_closable',
                     'is_fullscreen','is_visible','is_always_on_top'];
      if (bools.some(b => cmd && cmd.indexOf(b) >= 0)) return res(false);
      if (cmd && cmd.indexOf('plugin:event|listen') >= 0) return res(1);
      return res(undefined);
    }),
    event: { listen: async () => () => {}, once: async () => () => {},
             emit: async () => {}, emitTo: async () => {} },
    convertFileSrc: (p) => p,
  };
  Object.defineProperty(window, '__TAURI_INTERNALS__',
    { value: internals, configurable: true });
  window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { registerListener: () => {}, unregisterListener: () => {} };
  window.__TAURI_APP_PLUGIN_INTERNALS__ = { transformCallback: internals.transformCallback };
  window.__TAURI_OS_PLUGIN_INTERNALS__ = {};
  window.__TAURI_WINDOW_PLUGIN_INTERNALS__ = {};
  if (!window.__DEBUG__) window.__DEBUG__ = { unlocked: true, disableAnimations: false, showComponentBoundaries: false };
})();
`

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * 单次探测，必须带超时：服务接受连接却不响应 HTTP 时，裸 fetch 会一直挂着，
 * 让上层的截止时间形同虚设（harness 卡死而不是超时/改起服务）。
 */
async function fetchOk(url, timeoutMs = 2000) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) })
    return res.ok
  } catch {
    return false
  }
}

/** 端口被占不等于服务可用（上一次运行的半死进程会占着端口却不响应）。 */
async function respondsOk(url, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await fetchOk(url)) return true
    await sleep(300)
  }
  return false
}

/**
 * 等「本次 spawn 的服务」就绪，并确认端口上响应的确实是它：端口已被别的实例占用时
 * 子进程会立刻退出（EADDRINUSE），但健康检查照样通过——那台服务属于另一次运行，
 * `--plugin-dir` / `--mock` 与本次不一致，继续跑只会得出错误结论，所以要分离出来。
 */
async function waitForOwned({ child, url, timeoutMs }) {
  let exited = null
  child.once('exit', (code) => { exited = code ?? 0 })
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (exited !== null) return { ok: false, exited }
    if (await fetchOk(url)) return { ok: true }
    await sleep(300)
  }
  return { ok: false, exited: null }
}

/**
 * 子进程组：进程退出或收到信号时一并清理。
 * POSIX 下 `shell:true`（Windows 上 pnpm 是 .cmd 才需要 shell）会多出一层 shell，
 * 只 kill 直接子进程杀不到 pnpm/vite，因此让它自成进程组、退出时按组杀；
 * Windows 走 taskkill /T 杀进程树。
 */
export function createProcessGroup() {
  const spawned = []
  const spawnProc = (name, cmd, args, opts = {}) => {
    const child = spawn(cmd, args, {
      cwd: opts.cwd ?? ROOT,
      detached: process.platform !== 'win32',
      shell: opts.shell ?? false,
      env: { ...process.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    child.stdout?.on('data', (d) => process.stdout.write(`[${name}] ${d}`))
    child.stderr?.on('data', (d) => process.stdout.write(`[${name}] ${d}`))
    spawned.push(child)
    return child
  }
  const killAll = () => {
    for (const child of spawned) {
      if (!child.pid) continue
      try {
        if (process.platform === 'win32') {
          spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
        } else {
          process.kill(-child.pid, 'SIGTERM')
        }
      } catch { /* 已经退出 */ }
      try { child.kill() } catch { /* 兜底 */ }
    }
    spawned.length = 0
  }
  process.on('exit', () => { killAll() })
  process.on('SIGINT', () => { killAll(); process.exit(0) })
  process.on('SIGTERM', () => { killAll(); process.exit(0) })
  return { spawnProc, killAll }
}

/**
 * 起 stub mock server，并确保 Vite dev 在跑（未运行则自动 spawn）。返回时两者都已就绪。
 * `mock` 为 stub 的额外 mock 配置（如限制活跃插件列表）。
 *
 * stub 必须是本次启动的那一个：端口被占用时直接报错，而不是默默用别人的 mock 跑完。
 * Vite 反过来——用户自己起的 dev server 按文档复用，不算本次服务，退出时不杀。
 */
export async function startServices({ group, mock } = {}) {
  const stubArgs = [join(ROOT, 'scripts/harness/stub.mjs'), '--port', String(STUB_PORT), '--plugin-dir', PLUGINS_DIR]
  if (mock) stubArgs.push('--mock', mock)
  const stub = group.spawnProc('stub', process.execPath, stubArgs)

  const stubReady = await waitForOwned({ child: stub, url: `${STUB_URL}/api/health`, timeoutMs: 20000 })
  if (!stubReady.ok) {
    throw new Error(stubReady.exited !== null
      ? `stub 启动失败（exit ${stubReady.exited}）：:${STUB_PORT} 可能已被另一次 harness 运行的 stub 占用，请先停掉它`
      : `stub 未就绪：${STUB_URL}/api/health`)
  }

  const viteAlreadyRunning = await respondsOk(VITE_URL)
  if (!viteAlreadyRunning) {
    console.log('[harness] Vite dev 未运行，自动启动 (pnpm run dev)…')
    const vite = group.spawnProc('vite', 'pnpm', ['run', 'dev'], { shell: true })
    const viteReady = await waitForOwned({ child: vite, url: VITE_URL, timeoutMs: 90000 })
    if (!viteReady.ok) {
      // 抢不到端口但端口上确实起来了（用户同时启动 dev server）→ 复用，别误报失败
      if (await respondsOk(VITE_URL, 3000)) {
        console.log('[harness] Vite 由已有进程提供，复用它（退出时不会杀掉）')
      } else {
        throw new Error(viteReady.exited !== null ? `Vite 启动失败（exit ${viteReady.exited}）` : `Vite 未就绪：${VITE_URL}`)
      }
    }
  }
  return { viteAlreadyRunning }
}

/**
 * 把前端直连 :5000 的请求转发到 stub :5100（`API_BASE` 硬编码 5000，不依赖 Vite proxy），
 * 并兜底 localhost 变体（前端走 /api 代理时）。
 */
export async function routeApiToStub(page) {
  for (const host of ['http://127.0.0.1:5000', 'http://localhost:5000']) {
    await page.route(`${host}/api/**`, async (route) => {
      const req = route.request()
      const url = req.url().replace(host, STUB_URL)
      const headers = { ...req.headers(), host: `127.0.0.1:${STUB_PORT}` }
      let body
      try { body = req.postDataBuffer() } catch { /* GET 无 body */ }
      try {
        const res = await fetch(url, { method: req.method(), headers, body, redirect: 'manual' })
        await route.fulfill({
          status: res.status,
          headers: Object.fromEntries(res.headers.entries()),
          body: Buffer.from(await res.arrayBuffer()),
        })
      } catch {
        await route.abort('failed')
      }
    })
  }
}

async function importChromium() {
  try {
    return (await import('playwright')).chromium
  } catch {
    console.error('未检测到 playwright。请先安装：')
    console.error('  pnpm add -D playwright')
    console.error('  pnpm exec playwright install chromium')
    process.exit(1)
  }
}

/** 系统已装的 Chromium 系浏览器（Playwright 自带浏览器未 install 时可用）。 */
function systemChromiumPaths() {
  const programFiles = process.env['ProgramFiles'] ?? 'C:\\Program Files'
  const programFilesX86 = process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)'
  const fixed = []
  let names = []
  if (process.platform === 'win32') {
    fixed.push(
      join(programFiles, 'Google/Chrome/Application/chrome.exe'),
      join(programFilesX86, 'Google/Chrome/Application/chrome.exe'),
      join(programFiles, 'Microsoft/Edge/Application/msedge.exe'),
      join(programFilesX86, 'Microsoft/Edge/Application/msedge.exe'),
    )
  } else if (process.platform === 'darwin') {
    fixed.push(
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    )
  } else {
    // snap / nix / 自定义前缀装的 Chromium 不在固定路径里，按 PATH 找
    names = ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'microsoft-edge', 'microsoft-edge-stable']
  }
  const fromPath = (process.env.PATH ?? '').split(delimiter).flatMap((dir) => names.map((n) => join(dir, n)))
  return [...fixed, ...fromPath]
}

/**
 * 启动 Chromium 并开好 1440x900 上下文。可执行文件按顺序尝试：
 * `QOMICEX_CHROMIUM` 环境变量 → Playwright 自带 → 系统已装的 Chromium 系浏览器。
 * 三者都是 Chromium 内核，对前端行为等价（与 WebView2 的差异见调试文档的注意事项）。
 */
export async function launchChromium({ headed = false } = {}) {
  const chromium = await importChromium()
  const candidates = [process.env.QOMICEX_CHROMIUM, null, ...systemChromiumPaths()]
  const failures = []
  for (const executablePath of candidates) {
    if (executablePath && !existsSync(executablePath)) continue
    let browser
    try {
      browser = await chromium.launch(executablePath ? { headless: !headed, executablePath } : { headless: !headed })
    } catch (e) {
      failures.push(`${executablePath ?? '(playwright 自带)'}: ${String(e.message).split('\n')[0]}`)
      continue
    }
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
    return { browser, context, executablePath: executablePath ?? '(playwright 自带)' }
  }
  console.error('无法启动 Chromium，候选与原因：')
  for (const f of failures) console.error(`  - ${f}`)
  console.error('提示：pnpm exec playwright install chromium，或 QOMICEX_CHROMIUM=<浏览器可执行文件>')
  process.exit(1)
}
