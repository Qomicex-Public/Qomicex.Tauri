#!/usr/bin/env node
/**
 * 插件调试 harness 后端 stub（纯 node:http，无框架）。
 *
 * 目的：让插件在纯浏览器（无 Tauri、无 Rust 后端）下能跑起来并调用桥 API。
 * 默认监听 :5100（与前端 API_BASE :5000 不同），由 run.mjs 用 Playwright
 * page.route 把发往 127.0.0.1:5000/api/** 的请求转发到本 stub。
 *
 * 用法：
 *   node scripts/harness/stub.mjs [--port 5100] [--plugin-dir <dir>]
 */
import { createServer } from 'node:http'
import { readFile, readdir, stat } from 'node:fs/promises'
import { join, resolve, extname, normalize, isAbsolute } from 'node:path'

const PORT = Number(process.argv.find((a, i) => a === '--port') ? process.argv[process.argv.indexOf('--port') + 1] : process.env.QOMICEX_HARNESS_PORT || 5100)
const PLUGIN_DIR = process.argv.find((a, i) => a === '--plugin-dir') ? process.argv[process.argv.indexOf('--plugin-dir') + 1] : resolve('plugins-dev')

const ROOT = process.cwd()

// --- 可配置假数据 ---
// 可通过 --mock file.json 覆盖（见 README/文档）；默认给一组可控默认值。
const MOCK = {
  settings: { greeting: '你好，来自 harness stub', theme: 'dark' },
  appSettings: {
    dataDir: '.qomicex-harness', gameDir: '.minecraft', language: 'zh-CN',
    theme: 'dark', themePreset: 'default', initialized: true,
    animationsEnabled: true, logLevel: 'info', watermarkEnabled: true,
    watermarkText: 'Qomicex', watermarkSubtext: 'harness stub',
  },
  systemInfo: {
    os: 'Windows', arch: 'x64', version: '10.0.26100',
    cpu: 'stub-cpu', cores: 8, memoryTotal: 16 * 1024 ** 3, memoryFree: 8 * 1024 ** 3,
    javaVersion: '21.0.1', javaHome: 'C:/stub/java',
  },
  proxyResponse: { status: 200, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ stub: true, source: 'harness-proxy' }) },
  modpackInstall: { instanceId: 'stub-instance' },
  downloadStart: { taskId: 'stub-task', status: 'queued', targetPath: 'C:/stub/downloads/file.bin' },
  downloadProgress: { sessionId: 'stub', type: 'file', status: 'downloading', stage: 'downloading', progress: 42, currentFile: 'stub.bin', totalFiles: 1, completedFiles: 0, failedFiles: 0, speed: 1024, error: null, isPaused: false, instanceId: null },
  fileRead: { path: 'stub.txt', content: 'harness stub readText' },
  execCommand: { exitCode: 0, stdout: 'stub stdout', stderr: '' },
  wasmList: { plugins: [] },
  settingsState: {},
  pluginStates: {},
}

// --mock file.json 合并覆盖
const mockArgIdx = process.argv.indexOf('--mock')
if (mockArgIdx >= 0 && process.argv[mockArgIdx + 1]) {
  try {
    const mockPath = isAbsolute(process.argv[mockArgIdx + 1]) ? process.argv[mockArgIdx + 1] : join(ROOT, process.argv[mockArgIdx + 1])
    const extra = JSON.parse(await readFile(mockPath, 'utf-8'))
    Object.assign(MOCK, extra)
    console.log('[stub] 加载 mock 配置:', mockPath)
  } catch (e) {
    console.warn('[stub] 读取 mock 文件失败，忽略:', e.message)
  }
}

// --- 静态类型 ---
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.map': 'application/json; charset=utf-8',
}

// --- 插件元数据加载 ---
let pluginCache = new Map()
let idToDir = new Map() // manifest.id -> 目录名（id 与目录名可能不一致，如 top.qomicex.market / Qomicex.Plugin-Market）
async function scanPluginDirs() {
  let entries = []
  try { entries = await readdir(PLUGIN_DIR) } catch {}
  for (const dir of entries) {
    try {
      const m = JSON.parse(await readFile(join(PLUGIN_DIR, dir, 'manifest.json'), 'utf-8'))
      if (m && m.id) idToDir.set(m.id, dir)
    } catch {}
  }
}
async function loadPluginInfo(id) {
  if (pluginCache.has(id)) return pluginCache.get(id)
  try {
    const dir = idToDir.get(id) ?? id
    const manifest = JSON.parse(await readFile(join(PLUGIN_DIR, dir, 'manifest.json'), 'utf-8'))
    const info = {
      manifest,
      dir: join(PLUGIN_DIR, dir),
      state: MOCK.pluginStates[id] ?? 'active',
      installedAt: new Date().toISOString(),
    }
    pluginCache.set(id, info)
    return info
  } catch {
    return null
  }
}

// --- 安全路径校验：只允许访问插件目录下的文件 ---
function safeResolve(pluginId, rel) {
  const dir = idToDir.get(pluginId) ?? pluginId
  const base = resolve(PLUGIN_DIR, dir)
  const target = resolve(base, '.' + normalize('/' + rel))
  return target.startsWith(base + sep()) ? target : null
}
function sep() { return process.platform === 'win32' ? '\\' : '/' }

function sendJson(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(data))
}

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type,Authorization',
  }
}

function notFound(res, path) {
  sendJson(res, 404, { code: 'NOT_FOUND', message: `stub 未处理的路由: ${path}`, detail: 'harness stub', timestamp: new Date().toISOString() })
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`)
  const path = decodeURIComponent(url.pathname)
  const method = req.method || 'GET'

  // CORS + preflight
  const cors = corsHeaders()
  if (method === 'OPTIONS') {
    res.writeHead(204, cors)
    res.end()
    return
  }
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization')

  // 读 body
  let body = ''
  for await (const chunk of req) body += chunk

  try {
    // --- /api/ping ---
    if (path === '/api/ping' && method === 'GET') {
      res.writeHead(200, cors)
      res.end('pong')
      return
    }
    // --- /api/settings (全局设置：SplashScreen 通过后 loadSettings 拉取) ---
    if (path === '/api/settings' && method === 'GET') {
      sendJson(res, 200, { ...MOCK.appSettings })
      return
    }
    // --- /api/java/custom、/api/java/search (启动期 Java 扫描，返回空列表) ---
    if ((path === '/api/java/custom' || path === '/api/java/search') && method === 'GET') {
      sendJson(res, 200, [])
      return
    }
    // --- /api/settings/data-dir ---
    if (path === '/api/settings/data-dir' && method === 'GET') {
      sendJson(res, 200, { dataDir: MOCK.appSettings.dataDir ?? '.qomicex-harness' })
      return
    }
    // --- POST /api/store/check-updates (插件静默更新轮询，返回空列表) ---
    if (path === '/api/store/check-updates' && method === 'POST') {
      sendJson(res, 200, { updates: [] })
      return
    }
    // --- /api/health ---
    if (path === '/api/health' && method === 'GET') {
      sendJson(res, 200, { status: 'ok', version: '0.1.0', harness: true })
      return
    }

// --- /api/plugins、/api/plugins/ (hello-plugin listPlugins 用带斜杠路径) ---
    if ((path === '/api/plugins' || path === '/api/plugins/') && method === 'GET') {
      await scanPluginDirs()
      const ids = MOCK.pluginIds?.length ? MOCK.pluginIds : [...idToDir.keys()].sort()
      const list = (await Promise.all(ids.map(loadPluginInfo))).filter(Boolean)
      sendJson(res, 200, list)
      return
    }

    // --- GET /api/diagnostics/health (hello-plugin 示例 callBackend 目标) ---
    if (path === '/api/diagnostics/health' && method === 'GET') {
      sendJson(res, 200, { status: 'healthy', harness: true })
      return
    }

    // --- GET /api/plugins/{id} ---
    let m = path.match(/^\/api\/plugins\/([^/]+)$/)
    if (m && method === 'GET') {
      const info = await loadPluginInfo(m[1])
      if (info) sendJson(res, 200, info)
      else sendJson(res, 404, { code: 'PLUGIN_NOT_FOUND', message: `stub 找不到插件: ${m[1]}`, timestamp: new Date().toISOString() })
      return
    }

    // --- GET /api/plugins/{id}/files/{path} --- 服务插件 dist 静态文件
    m = path.match(/^\/api\/plugins\/([^/]+)\/files\/(.+)$/)
    if (m && method === 'GET') {
      const pluginId = m[1]
      const rel = m[2]
      const filePath = safeResolve(pluginId, rel)
      if (!filePath) {
        sendJson(res, 403, { code: 'FORBIDDEN', message: '路径越界', timestamp: new Date().toISOString() })
        return
      }
      try {
        const data = await readFile(filePath)
        const ext = extname(filePath).toLowerCase()
        res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' })
        res.end(data)
      } catch {
        sendJson(res, 404, { code: 'FILE_NOT_FOUND', message: `stub 找不到文件: ${rel}`, timestamp: new Date().toISOString() })
      }
      return
    }

    // --- GET /api/plugins/settings/{id} ---
    m = path.match(/^\/api\/plugins\/settings\/([^/]+)$/)
    if (m && method === 'GET') {
      const key = `settings:${m[1]}`
      const stored = MOCK.settingsState[key]
      sendJson(res, 200, stored ?? { ...MOCK.settings })
      return
    }
    // --- POST /api/plugins/settings/{id} ---
    if (m && method === 'POST') {
      const key = `settings:${m[1]}`
      const { key: k, value } = JSON.parse(body || '{}')
      if (k !== undefined) {
        MOCK.settingsState[key] = { ...(MOCK.settingsState[key] || {}), [k]: value }
      }
      sendJson(res, 200, MOCK.settingsState[key] || {})
      return
    }

    // --- POST /api/plugins/cache/{id} / GET ---
    m = path.match(/^\/api\/plugins\/cache\/([^/]+)$/)
    if (m && method === 'POST') {
      const { key, value } = JSON.parse(body || '{}')
      MOCK.settingsState[`cache:${m[1]}:${key}`] = value
      sendJson(res, 200, { ok: true })
      return
    }
    if (m && method === 'GET') {
      const key = url.searchParams.get('key')
      sendJson(res, 200, { value: MOCK.settingsState[`cache:${m[1]}:${key}`] ?? null })
      return
    }

    // --- POST /api/plugins/proxy --- (含 stream 变体)
    if (path === '/api/plugins/proxy' && method === 'POST') {
      const reqBody = JSON.parse(body || '{}')
      if (reqBody.stream) {
        // SSE 流式响应：模拟逐步推送
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', ...cors })
        const chunks = ['stub-stream-1', 'stub-stream-2', 'stub-stream-3']
        let i = 0
        const timer = setInterval(() => {
          if (i < chunks.length) {
            res.write(`data: ${JSON.stringify({ chunk: chunks[i] })}\n\n`)
            i++
          } else {
            clearInterval(timer)
            res.end()
          }
        }, 100)
        return
      }
      const base = MOCK.proxyResponse
      sendJson(res, base.status ?? 200, JSON.parse(base.body ?? '{}'))
      return
    }

    // --- POST /api/plugins/download/start ---
    if (path === '/api/plugins/download/start' && method === 'POST') {
      sendJson(res, 200, MOCK.downloadStart)
      return
    }
    // --- GET /api/plugins/download/list ---
    if (path === '/api/plugins/download/list' && method === 'GET') {
      sendJson(res, 200, [MOCK.downloadProgress])
      return
    }
    // --- GET /api/plugins/download/{id}/progress ---
    m = path.match(/^\/api\/plugins\/download\/([^/]+)\/progress$/)
    if (m && method === 'GET') {
      sendJson(res, 200, MOCK.downloadProgress)
      return
    }
    // --- POST /api/plugins/download/{id}/cancel ---
    m = path.match(/^\/api\/plugins\/download\/([^/]+)\/cancel$/)
    if (m && method === 'POST') {
      sendJson(res, 200, { ok: true })
      return
    }

    // --- POST /api/modpack/install-direct ---
    if (path === '/api/modpack/install-direct' && method === 'POST') {
      sendJson(res, 200, MOCK.modpackInstall)
      return
    }

    // --- GET /api/systeminfo ---
    if (path === '/api/systeminfo' && method === 'GET') {
      sendJson(res, 200, MOCK.systemInfo)
      return
    }
    // --- POST /api/system/open-url ---
    if (path === '/api/system/open-url' && method === 'POST') {
      sendJson(res, 200, { ok: true })
      return
    }

    // --- POST /api/plugins/upload ---
    if (path === '/api/plugins/upload' && method === 'POST') {
      sendJson(res, 400, { code: 'HARNESS_READONLY', message: 'harness stub 不执行真实上传（只读沙箱）', timestamp: new Date().toISOString() })
      return
    }

    // --- POST /api/plugins/shell/{id} ---
    m = path.match(/^\/api\/plugins\/shell\/([^/]+)$/)
    if (m && method === 'POST') {
      sendJson(res, 200, MOCK.execCommand)
      return
    }

    // --- 文件读写授权 ---
    m = path.match(/^\/api\/plugins\/files\/([^/]+)\/(read|write|delete|authorize)$/)
    if (m && method === 'POST') {
      const action = m[2]
      if (action === 'read') {
        const { mode } = JSON.parse(body || '{}')
        sendJson(res, 200, mode === 'byte'
          ? { path: MOCK.fileRead.path, contentBase64: Buffer.from('stub bytes').toString('base64') }
          : MOCK.fileRead)
      } else if (action === 'write') {
        const { path } = JSON.parse(body || '{}')
        sendJson(res, 200, { path })
      } else if (action === 'delete') {
        sendJson(res, 200, { ok: true })
      } else if (action === 'authorize') {
        sendJson(res, 200, { ok: true })
      }
      return
    }

    // --- WASM 网关 ---
    if (path === '/api/plugins/wasm' && method === 'GET') {
      sendJson(res, 200, MOCK.wasmList)
      return
    }
    m = path.match(/^\/api\/plugins\/wasm\/([^/]+)\/invoke$/)
    if (m && method === 'POST') {
      sendJson(res, 400, { code: 'WASM_UNAVAILABLE', message: 'harness stub 不执行 WASM（需真实 wasmtime 网关）', timestamp: new Date().toISOString() })
      return
    }

    // --- 插件 state 变更 ---
    m = path.match(/^\/api\/plugins\/([^/]+)\/state$/)
    if (m && method === 'PUT') {
      const { state } = JSON.parse(body || '{}')
      MOCK.pluginStates[m[1]] = state
      const info = await loadPluginInfo(m[1])
      if (info) info.state = state
      sendJson(res, 200, { ok: true })
      return
    }

    notFound(res, `${method} ${path}`)
  } catch (e) {
    sendJson(res, 500, { code: 'STUB_ERROR', message: e.message, timestamp: new Date().toISOString() })
  }
})

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[stub] harness mock server 已监听 http://127.0.0.1:${PORT}/api`)
  console.log(`[stub] 插件目录: ${PLUGIN_DIR}`)
})
