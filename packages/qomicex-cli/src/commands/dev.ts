// qomicex dev — 起本地插件调试环境。
// 在仓库内（plugins-dev/ 等）检测到 scripts/harness/run.mjs 时，spawn harness
// 走完整调试环境（Tauri mock + stub + 热重载）；否则回退裸 Vite + 输出 dev 源配置。
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { findHarnessStart } from '../lib/project.ts'
import { fail, info, runShell } from '../lib/io.ts'

export interface DevOptions {
  port?: number
}

export async function devCommand(opts: DevOptions = {}): Promise<void> {
  const root = process.cwd()
  if (!existsSync(join(root, 'manifest.json'))) fail('当前目录不是插件项目（缺少 manifest.json）')

  const manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8')) as { id?: string }
  const pluginId = manifest.id ?? 'unknown'

  // 仓库内检测到 harness → 走完整调试环境（Tauri mock + stub + 热重载）。
  // 注意：harness 固定使用仓库根 Vite(:1420) + stub(:5100)，CLI 的 --port 在此模式不生效。
  const harness = findHarnessStart(root)
  if (harness) {
    info(`✔ 检测到调试 harness（${harness}），进入完整调试环境（Tauri mock + stub + 热重载）`)
    info('  插件须位于仓库 plugins-dev/{id} 供 harness 定位；--port 参数在此模式不生效（固定 1420）')
    info('  停止：Ctrl+C（会一并清理 stub / Vite）')
    const code = await runShell(`node ${JSON.stringify(harness)} --plugin ${JSON.stringify(pluginId)}`, root)
    if (code !== 0) fail(`harness 退出（code ${code}）`)
    return
  }

  const port = opts.port ?? 5173
  const devUrl = `http://localhost:${port}`

  const devConfig = {
    kind: 'dev-source-plugin',
    pluginId,
    vite: { url: devUrl, port },
    entry: 'index.html',
    launcherHint: '将本插件的 dev 源（registryUrl / 本地插件映射）指向上述地址，或在调试 harness 中打开该 URL。',
    note: 'v1：仅输出配置产物与使用说明，不自动挂载到启动器。',
  }
  const outFile = join(root, '.qomicex-dev.json')
  writeFileSync(outFile, JSON.stringify(devConfig, null, 2))
  info(`✔ 已生成 dev 源插件配置 ${outFile}`)
  info('')
  info(`正在启动 Vite dev server: ${devUrl}`)
  info('  插件入口（与 manifest.entry.frontend 对应）：本机预览打开 index.html 即可')
  info('  热重载：保存源码自动刷新；沙箱 API 桥在浏览器直开时降级为 null')
  info('  停止：Ctrl+C')

  const code = await runShell(`pnpm exec vite --port ${port} --strictPort`, root)
  if (code !== 0) fail(`Vite dev server 退出（code ${code}）`)
}
