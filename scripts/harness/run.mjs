#!/usr/bin/env node
/**
 * 插件调试 harness 启动器（Playwright + Tauri mock 注入 + 热重载）
 *
 * 不启动 Tauri、不启动 Rust 后端，纯浏览器调试插件：
 *   1. 起 stub mock server（scripts/harness/stub.mjs，默认 :5100）
 *   2. 复用已有 Vite dev(:1420)；未起则自动 spawn
 *   3. addInitScript 注入 Tauri mock（写法来自
 *      docs/junsi-dev-docs/2-架构设计/前端浏览器调试-Playwright-Tauri-mock注入.md）
 *   4. 打开插件页 http://127.0.0.1:1420/plugins/p/{pluginId}
 *   5. fs.watch 监听插件 src，变更 → 重建 → 整页 reload（iframe 重新挂载）
 *
 * 用法：
 *   node scripts/harness/run.mjs <pluginId> [--headed] [--mock file.json] [--build-cmd "pnpm run build"]
 *   或仓库根：pnpm run harness -- hello-plugin
 */
import { spawn, spawnSync } from 'node:child_process'
import { watch, existsSync, copyFileSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { createServer } from 'node:net'

const ROOT = resolve(import.meta.dirname, '../..')
const VITE_URL = 'http://127.0.0.1:1420'
const STUB_PORT = 5100
const STUB_URL = `http://127.0.0.1:${STUB_PORT}`
const PLUGINS_DIR = join(ROOT, 'plugins-dev')

// --- CLI 解析 ---
const args = process.argv.slice(2)
const pluginId = args.find(a => !a.startsWith('--'))
const flag = (name) => {
  const i = args.indexOf(name)
  return i >= 0 ? args[i + 1] : undefined
}
const headed = args.includes('--headed')
const buildCmd = flag('--build-cmd') ?? 'pnpm run build'

if (!pluginId) {
  console.error('用法: node scripts/harness/run.mjs <pluginId> [--headed] [--mock file.json] [--build-cmd "..."]')
  process.exit(1)
}

const pluginDir = join(PLUGINS_DIR, pluginId)
if (!existsSync(join(pluginDir, 'manifest.json'))) {
  console.error(`找不到插件 ${pluginId}：${pluginDir}/manifest.json 不存在`)
  process.exit(1)
}

// --- Playwright 可用性 ---
let chromium
try {
  ({ chromium } = await import('playwright'))
} catch {
  console.error('未检测到 playwright。请先安装：')
  console.error('  pnpm add -D playwright')
  console.error('  pnpm exec playwright install chromium')
  process.exit(1)
}

// --- 端口占用检测 ---
function isPortOpen(port) {
  return new Promise((resolveFn) => {
    const s = createServer()
    s.once('error', () => resolveFn(true))
    s.once('listening', () => { s.close(); resolveFn(false) })
    s.listen(port, '127.0.0.1')
  })
}

// --- 进程生命周期管理 ---
const spawned = []
function spawnProc(name, cmd, args, opts = {}) {
  const child = spawn(cmd, args, { cwd: opts.cwd ?? ROOT, shell: opts.shell ?? false, env: { ...process.env }, stdio: ['ignore', 'pipe', 'pipe'] })
  child.stdout?.on('data', d => process.stdout.write(`[${name}] ${d}`))
  child.stderr?.on('data', d => process.stdout.write(`[${name}] ${d}`))
  spawned.push(child)
  return child
}
async function killAll() {
  for (const child of spawned) {
    try { child.kill() } catch {}
  }
  // Windows 下杀进程树（pnpm 会再派生 node）
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

// --- 1. 起 stub ---
const mockArgs = flag('--mock')
const stubArgs = [join(ROOT, 'scripts/harness/stub.mjs'), '--port', String(STUB_PORT), '--plugin-dir', PLUGINS_DIR]
if (mockArgs) stubArgs.push('--mock', mockArgs)
spawnProc('stub', process.execPath, stubArgs)

// --- 2. 确保 Vite dev 在跑 ---
const viteAlreadyRunning = await isPortOpen(1420)
if (!viteAlreadyRunning) {
  console.log('[harness] Vite dev 未运行，自动启动 (pnpm run dev)…')
  spawnProc('vite', 'pnpm', ['run', 'dev'], { shell: true })
}

// --- 等待服务就绪 ---
async function waitFor(url, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url)
      if (res.ok) return
    } catch {}
    await new Promise(r => setTimeout(r, 500))
  }
  throw new Error(`等待服务超时: ${url}`)
}
await waitFor(`${STUB_URL}/api/health`)
await waitFor(`${VITE_URL}`)

// --- 3. Tauri mock（复自 docs 文档，跨导航保留） ---
const TAURI_MOCK = `
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

// --- 4. 启动浏览器并打开插件页 ---
const browser = await chromium.launch({ headless: !headed })
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
const page = await context.newPage()

// 把前端直连 :5000 的请求转发到 stub :5100（API_BASE 硬编码为 5000，不依赖 Vite proxy）
await page.route('http://127.0.0.1:5000/api/**', async (route) => {
  const req = route.request()
  const url = req.url().replace('http://127.0.0.1:5000', STUB_URL)
  const headers = { ...req.headers(), host: `127.0.0.1:${STUB_PORT}` }
  let body
  try { body = req.postDataBuffer() } catch {}
  try {
    const res = await fetch(url, { method: req.method(), headers, body, redirect: 'manual' })
    const data = await res.arrayBuffer()
    await route.fulfill({
      status: res.status,
      headers: Object.fromEntries(res.headers.entries()),
      body: Buffer.from(data),
    })
  } catch (e) {
    await route.abort('failed')
  }
})
// localhost 变体兜底（前端 /api 走代理时）
await page.route('http://localhost:5000/api/**', async (route) => {
  const req = route.request()
  const url = req.url().replace('http://localhost:5000', STUB_URL)
  try {
    const res = await fetch(url, { method: req.method(), headers: req.headers(), body: req.postDataBuffer?.() })
    await route.fulfill({ status: res.status, headers: Object.fromEntries(res.headers.entries()), body: Buffer.from(await res.arrayBuffer()) })
  } catch (e) {
    await route.abort('failed')
  }
})

await page.addInitScript({ content: TAURI_MOCK })
page.on('console', (msg) => {
  if (msg.type() === 'log' || msg.type() === 'warning' || msg.type() === 'error') {
    process.stdout.write(`[页面] ${msg.type()}: ${msg.text()}\n`)
  }
})
page.on('pageerror', (err) => { process.stdout.write(`[页面] uncaught: ${err.message}\n`) })

console.log(`[harness] 打开插件页 ${VITE_URL}/plugins/p/${pluginId} …`)
await page.goto(`${VITE_URL}/plugins/p/${pluginId}`, { waitUntil: 'domcontentloaded' })

// 等待挂载：main 出现后再等插件 iframe 挂进容器
let mounted = false
for (let i = 0; i < 30; i++) {
  const hasMain = await page.evaluate(() => !!document.querySelector('main'))
  const hasFrame = await page.evaluate(() => !!document.querySelector('main iframe'))
  if (hasMain && hasFrame) { mounted = true; break }
  await page.waitForTimeout(500)
}
if (!mounted) {
  console.warn('[harness] 等待插件 iframe 挂载超时（页面可能仍在加载，检查 stub 日志）')
} else {
  console.log('[harness] ✅ 插件已挂载到 iframe，可打开 DevTools 调试')
}

// --- 5. 热重载：监听插件源码，重建后整页 reload ---
let reloadTimer = null
let building = false
let srcDirs = [join(pluginDir, 'src')]
if (existsSync(join(pluginDir, 'index.html'))) srcDirs.push(join(pluginDir, 'index.html'))
if (existsSync(join(pluginDir, 'theme.css'))) srcDirs.push(join(pluginDir, 'theme.css'))
if (existsSync(join(pluginDir, 'overlay.html'))) srcDirs.push(join(pluginDir, 'overlay.html'))
if (existsSync(join(pluginDir, 'vite.config.ts'))) srcDirs.push(join(pluginDir, 'vite.config.ts'))

const watchers = srcDirs.map((p) => {
  if (!existsSync(p)) return null
  return watch(p, { recursive: existsSync(p) && !p.endsWith('.html') && !p.endsWith('.css') && !p.endsWith('.ts') }, async (evt, fname) => {
    if (fname?.includes('node_modules') || fname?.includes('.vite-temp')) return
    clearTimeout(reloadTimer)
    reloadTimer = setTimeout(async () => {
      if (building) return
      building = true
      console.log(`[hot] 检测到 ${pluginId} 变更 (${evt}: ${fname})，重新构建…`)
      try {
        const child = spawn(buildCmd, { cwd: pluginDir, shell: true, stdio: ['ignore', 'pipe', 'pipe'] })
        child.stdout?.on('data', d => process.stdout.write(`[hot] ${d}`))
        child.stderr?.on('data', d => process.stdout.write(`[hot] ${d}`))
        const code = await new Promise((res) => child.on('exit', res))
        if (code !== 0) throw new Error(`build 失败 (exit ${code})`)
        // 复制 manifest 引用的额外文件（theme.css、overlay.html 等 vite build 不打包的内容）
        for (const extra of ['overlay.html', 'theme.css']) {
          const src = join(pluginDir, extra)
          const dst = join(pluginDir, 'dist', extra)
          if (existsSync(src) && !existsSync(dst)) {
            try { copyFileSync(src, dst); console.log(`[hot] 复制 ${extra} → dist/`) } catch {}
          }
        }
        console.log('[hot] ✅ 构建完成，刷新页面…')
        await page.reload({ waitUntil: 'domcontentloaded' })
        await page.waitForTimeout(2500)
      } catch (e) {
        console.error(`[hot] 构建/重载失败: ${e.message}`)
      } finally {
        building = false
      }
    }, 400)
  })
})

console.log(`[harness] 监听热重载: ${srcDirs.join(', ')}`)
console.log('[harness] Ctrl+C 退出并清理（stub/Vite 一并停掉）')

// 保持进程存活
await new Promise(() => {})
