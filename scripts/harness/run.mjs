#!/usr/bin/env node
// Copyright (C) 2026 Qomicex Launcher Contributors
// SPDX-License-Identifier: GPL-3.0-or-later

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
import { spawn } from 'node:child_process'
import { watch, existsSync, copyFileSync } from 'node:fs'
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

// --- 进程生命周期管理 ---
const group = createProcessGroup()

// --- 1-2. 起 stub、确保 Vite dev 在跑，并等待两者就绪 ---
await startServices({ group, mock: flag('--mock') })

// --- 3-4. 启动浏览器，注入 Tauri mock，打开插件页 ---
const { context, executablePath } = await launchChromium({ headed })
const page = await context.newPage()

await routeApiToStub(page)
await page.addInitScript({ content: TAURI_MOCK })
page.on('console', (msg) => {
  if (msg.type() === 'log' || msg.type() === 'warning' || msg.type() === 'error') {
    process.stdout.write(`[页面] ${msg.type()}: ${msg.text()}\n`)
  }
})
page.on('pageerror', (err) => { process.stdout.write(`[页面] uncaught: ${err.message}\n`) })

console.log(`[harness] 浏览器: ${executablePath}`)
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
            try { copyFileSync(src, dst); console.log(`[hot] 复制 ${extra} → dist/`) } catch { /* 复制失败不阻断热重载 */ }
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

// 退出时关闭文件监听句柄，避免 harness 已退出而 watcher 仍占着资源。
process.on('exit', () => {
  for (const w of watchers) w?.close()
})
console.log(`[harness] 监听热重载: ${srcDirs.join(', ')}`)
console.log('[harness] Ctrl+C 退出并清理（stub/Vite 一并停掉）')

// 保持进程存活
await new Promise(() => {})
