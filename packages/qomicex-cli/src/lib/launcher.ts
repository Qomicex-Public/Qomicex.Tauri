// 启动器定位 + CDP 启动 + 日志 tail（debug 命令用）。
// Windows：WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS 开 WebView2 CDP 端口；
// Linux/macOS：WEBKIT_INSPECTOR_SERVER / WEBKIT_INSPECTOR_HTTP_SERVER 尽力支持。
// 日志不依赖后端 TCP（release 纯 IPC）：tail {BaseDir}/logs/qomicex-backend.log
// （FileLog 逐行 flush 实时落盘，含插件/前端 trace 行）。
import { spawn, type ChildProcess } from 'node:child_process'
import { closeSync, existsSync, openSync, readFileSync, readSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

export const LAUNCHER_NAME = 'Qomicex Launcher'
// cargo 原生 bin 名（tauri 打包时才会重命名为 LAUNCHER_NAME；纯 cargo build 产物是它）
export const CARGO_BIN_NAME = 'qomicex-launcher'

export function launcherCdpEnv(port: number): Record<string, string> {
  if (process.platform === 'win32') {
    return { WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}` }
  }
  if (process.platform === 'darwin') {
    return { WEBKIT_INSPECTOR_HTTP_SERVER: `127.0.0.1:${port}` }
  }
  return { WEBKIT_INSPECTOR_SERVER: `127.0.0.1:${port}` }
}

/** 返回 targetDir 下存在的启动器二进制中最新的（bundle 名 + cargo 原生名；
 * 优先 mtime，避免命中旧的 tauri bundle 产物）；都不存在返回默认。 */
function launcherBinPath(targetDir: string): string {
  const candidates = process.platform === 'win32'
    ? [`${LAUNCHER_NAME}.exe`, `${CARGO_BIN_NAME}.exe`]
    : [LAUNCHER_NAME, CARGO_BIN_NAME]
  const existing = candidates
    .map((c) => join(targetDir, c))
    .filter((p) => existsSync(p))
  if (existing.length === 0) return join(targetDir, candidates[0]!)
  existing.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)
  return existing[0]!
}

function launcherMacAppPath(targetDir: string): string {
  return join(targetDir, `${LAUNCHER_NAME}.app`, 'Contents', 'MacOS', LAUNCHER_NAME)
}

/** 从 cwd 向上找仓库 src-tauri/target/{release|debug}/ 下的启动器二进制。 */
function findRepoTarget(cwd: string): string | null {
  let dir = resolve(cwd)
  while (true) {
    const tauri = join(dir, 'src-tauri')
    for (const profile of ['release', 'debug']) {
      const bin = launcherBinPath(join(tauri, 'target', profile))
      if (existsSync(bin)) return bin
      if (process.platform === 'darwin') {
        const app = launcherMacAppPath(join(tauri, 'target', profile))
        if (existsSync(app)) return app
      }
    }
    const parent = dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

/** 已安装启动器常见安装路径（Windows %LocalAppData%\Programs，macOS /Applications，Linux ~/.local/share）。 */
function installedPath(): string | null {
  if (process.platform === 'win32') {
    const p = join(process.env.LOCALAPPDATA ?? '', 'Programs', LAUNCHER_NAME, `${LAUNCHER_NAME}.exe`)
    return existsSync(p) ? p : null
  }
  if (process.platform === 'darwin') {
    const p = `/Applications/${LAUNCHER_NAME}.app/Contents/MacOS/${LAUNCHER_NAME}`
    return existsSync(p) ? p : null
  }
  const p = join(homedir(), '.local', 'share', 'qomicex-launcher', LAUNCHER_NAME)
  return existsSync(p) ? p : null
}

/**
 * 定位启动器可执行文件。优先级：--launcher 显式参数 > QOMICEX_LAUNCHER_PATH env >
 * 仓库 target（src-tauri/target/{release|debug}）> 已安装路径。
 */
export function locateLauncher(explicit?: string): string | null {
  if (explicit) return existsSync(explicit) ? resolve(explicit) : null
  const env = process.env.QOMICEX_LAUNCHER_PATH
  if (env && existsSync(env)) return env
  return findRepoTarget(process.cwd()) ?? installedPath()
}

/** 以 `--debug <port>` 参数 + CDP 环境变量（兼容旧启动器）启动启动器进程。
 * 日志经 stdout/stderr 实时推送（启动器 stderr 回显 + backend 转发），stdio 继承即可看到。 */
export function launchWithCdp(exePath: string, port: number): { child: ChildProcess } {
  const child = spawn(exePath, ['--debug', String(port)], {
    env: { ...process.env, ...launcherCdpEnv(port) },
    stdio: 'inherit',
  })
  return { child }
}

export interface CdpTarget {
  id: string
  type: string
  title: string
  url: string
  webSocketDebuggerUrl: string
}

/** 轮询 CDP HTTP 端点 /json/list 直到就绪，返回 target 列表。 */
export async function waitForCdp(port: number, timeoutMs = 30000): Promise<CdpTarget[]> {
  const deadline = Date.now() + timeoutMs
  let lastErr = 'CDP 未就绪'
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/list`)
      if (res.ok) {
        const targets = (await res.json()) as CdpTarget[]
        if (targets.length > 0) return targets
        lastErr = 'CDP 已响应但无 target'
      }
    } catch (e) {
      lastErr = e instanceof Error ? e.message : String(e)
    }
    await new Promise((r) => setTimeout(r, 1000))
  }
  throw new Error(`CDP 端口 ${port} 等待超时：${lastErr}`)
}

/** 解析启动器数据目录（与 backend settings::resolve_base_dir 一致）：
 * QOMICEX_HOME env → {LocalAppData}/qomicex-launcher/.qomicex-bootstrap 内容 → 默认目录。 */
export function resolveLauncherBaseDir(): string {
  const envHome = process.env.QOMICEX_HOME
  if (envHome && envHome.trim()) return envHome.trim()
  const localData = process.platform === 'win32'
    ? process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local')
    : process.platform === 'darwin'
      ? join(homedir(), 'Library', 'Application Support')
      : process.env.XDG_DATA_HOME ?? join(homedir(), '.local', 'share')
  const appDir = join(localData, 'qomicex-launcher')
  const bootstrap = join(appDir, '.qomicex-bootstrap')
  if (existsSync(bootstrap)) {
    const content = readFileSync(bootstrap, 'utf8').trim()
    if (content) return content
  }
  return appDir
}

/** 实时 tail 日志文件（每行回调）。从头读取（debug 场景启动器刚起，dump 完整会话含启动日志）；自动处理轮转。 */
export async function tailFile(
  filePath: string,
  onLine: (line: string) => void,
  signal: AbortSignal,
  intervalMs = 500,
): Promise<void> {
  let fd: number | null = null
  let offset = 0
  let lastSize = -1
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
  while (!signal.aborted) {
    try {
      if (fd === null) {
        if (!existsSync(filePath)) {
          await sleep(intervalMs)
          continue
        }
        fd = openSync(filePath, 'r')
        const st = statSync(filePath)
        offset = 0
        lastSize = st.size
      }
      const st = statSync(filePath)
      if (st.size < lastSize) {
        closeSync(fd)
        fd = null
        offset = 0
        lastSize = st.size
        continue
      }
      lastSize = st.size
      if (st.size > offset) {
        const buf = Buffer.alloc(st.size - offset)
        readSync(fd, buf, 0, buf.length, offset)
        offset += buf.length
        const text = buf.toString('utf8')
        for (const line of text.split('\n')) {
          const l = line.trimEnd()
          if (l) onLine(l)
        }
      }
    } catch {
      /* 文件瞬时不可读（轮转/删除窗口）跳过 */
    }
    await sleep(intervalMs)
  }
  if (fd !== null) closeSync(fd)
}