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
import { join, resolve } from 'node:path'

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

export async function waitFor(url, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url)
      if (res.ok) return
    } catch { /* 服务未就绪：继续重试 */ }
    await new Promise((r) => setTimeout(r, 500))
  }
  throw new Error(`等待服务超时: ${url}`)
}

/** 端口被占不等于服务可用（上一次运行的半死进程会占着端口却不响应）。 */
async function respondsOk(url, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url)
      if (res.ok) return true
    } catch { /* 服务未就绪：继续重试 */ }
    await new Promise((r) => setTimeout(r, 300))
  }
  return false
}

/** 子进程组：进程退出或收到信号时一并清理（Windows 下按进程树杀，pnpm 会再派生 node）。 */
export function createProcessGroup() {
  const spawned = []
  const spawnProc = (name, cmd, args, opts = {}) => {
    const child = spawn(cmd, args, {
      cwd: opts.cwd ?? ROOT,
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
      try { child.kill() } catch { /* 已经退出 */ }
    }
    for (const child of spawned) {
      if (process.platform === 'win32' && child.pid) {
        spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
      }
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
 */
export async function startServices({ group, mock } = {}) {
  const stubArgs = [join(ROOT, 'scripts/harness/stub.mjs'), '--port', String(STUB_PORT), '--plugin-dir', PLUGINS_DIR]
  if (mock) stubArgs.push('--mock', mock)
  group.spawnProc('stub', process.execPath, stubArgs)

  const viteAlreadyRunning = await respondsOk(VITE_URL)
  if (!viteAlreadyRunning) {
    console.log('[harness] Vite dev 未运行，自动启动 (pnpm run dev)…')
    group.spawnProc('vite', 'pnpm', ['run', 'dev'], { shell: true })
  }

  await waitFor(`${STUB_URL}/api/health`)
  await waitFor(VITE_URL, 90000)
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
  if (process.platform === 'win32') {
    return [
      join(programFiles, 'Google/Chrome/Application/chrome.exe'),
      join(programFilesX86, 'Google/Chrome/Application/chrome.exe'),
      join(programFiles, 'Microsoft/Edge/Application/msedge.exe'),
      join(programFilesX86, 'Microsoft/Edge/Application/msedge.exe'),
    ]
  }
  if (process.platform === 'darwin') {
    return [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    ]
  }
  return ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser']
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
