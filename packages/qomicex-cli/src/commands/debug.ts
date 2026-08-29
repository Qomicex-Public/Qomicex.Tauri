// qomicex debug — 启动启动器开放 CDP 调试端口 + 实时 tail 启动器日志。
// 供第三方开发者（无需启动器源码）用 Playwright / Chrome DevTools connectOverCDP
// 自动化调试，实时查看后端/插件日志。
// 日志通道不依赖后端 TCP（release 恒为纯 IPC）：tail {BaseDir}/logs/qomicex-backend.log
// （FileLog 逐行 flush 实时落盘，含 [plugin:...] / [frontend:...] trace 行）。
import { join } from 'node:path'
import { locateLauncher, launchWithCdp, waitForCdp, resolveLauncherBaseDir, tailFile } from '../lib/launcher.ts'
import { fail, info } from '../lib/io.ts'

export interface DebugOptions {
  port?: number
  launcher?: string
  noLogs?: boolean
  noKill?: boolean
}

export async function debugCommand(opts: DebugOptions = {}): Promise<void> {
  const cdpPort = opts.port ?? 9222
  const exe = locateLauncher(opts.launcher)
  if (!exe) {
    fail('未找到启动器可执行文件。请用 --launcher <path> 指定，或设 QOMICEX_LAUNCHER_PATH，或先构建 src-tauri/target/{release,debug}')
  }

  info(`==> 启动启动器并开放 CDP :${cdpPort}`)
  info(`  可执行: ${exe}`)
  info(`  平台: ${process.platform}${process.platform === 'win32' ? '（WebView2 CDP）' : '（WebKit Inspector，尽力支持）'}`)
  const { child } = launchWithCdp(exe, cdpPort)

  let abort: AbortController | null = null
  const cleanup = () => {
    abort?.abort()
    if (!opts.noKill && child && !child.killed) {
      child.kill()
    }
  }
  process.on('SIGINT', () => {
    console.log('\n==> 停止调试')
    cleanup()
    process.exit(0)
  })

  try {
    const targets = await waitForCdp(cdpPort, 30000)
    info(`✔ CDP 就绪: http://localhost:${cdpPort}`)
    info(`  DevTools 前端: http://localhost:${cdpPort}`)
    for (const t of targets) {
      info(`  - [${t.type}] ${t.title || '(untitled)'} ${t.url}`)
    }
    info(`  自动化示例（Playwright）: connectOverCDP('http://127.0.0.1:${cdpPort}')`)
  } catch (e) {
    cleanup()
    fail(e instanceof Error ? e.message : String(e))
  }

  if (opts.noLogs) {
    info('  日志流已禁用（--no-logs）')
  } else {
    const logFile = join(resolveLauncherBaseDir(), 'logs', 'qomicex-backend.log')
    info(`  实时日志: ${logFile}`)
    abort = new AbortController()
    void tailFile(logFile, (line) => console.log(`[trace] ${line}`), abort.signal)
  }

  info('  Ctrl+C 停止（--no-kill 保留启动器运行）')
  await new Promise<void>((resolveExit) => {
    child.on('exit', () => resolveExit())
    child.on('error', () => resolveExit())
  })
  info('启动器已退出')
}