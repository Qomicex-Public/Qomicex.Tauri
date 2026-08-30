// qomicex create <id> [--template <react|html|lib>] — 从内置模板生成合法插件项目。
import { cpSync, existsSync, mkdirSync, readdirSync, statSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { checkId } from '../lib/manifest.ts'
import { fail, info } from '../lib/io.ts'

export type TemplateName = 'react' | 'html' | 'lib' | 'wasm'

export const TEMPLATES: Record<TemplateName, { dir: string; desc: string }> = {
  react: { dir: 'plugin', desc: 'Vite + React 19 + TS + Tailwind + @qomicex/plugin-ui' },
  html: { dir: 'plugin-html', desc: '纯 HTML/CSS/JS（esbuild 打包，无框架依赖）' },
  lib: { dir: 'plugin-lib', desc: '纯库插件（无 UI，registerMethod 供其他插件调用）' },
  wasm: { dir: 'plugin-wasm', desc: 'L3 WASM 插件（Rust + wasmtime 沙箱，无浏览器环境）' },
}

export function templateDir(tpl: TemplateName = 'react'): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), `../../templates/${TEMPLATES[tpl].dir}`)
}

export function resolveTemplate(name: string | undefined): TemplateName {
  if (!name) return 'react'
  const n = name.toLowerCase()
  if (n in TEMPLATES) return n as TemplateName
  fail(`未知模板: ${name}（可选: ${Object.keys(TEMPLATES).join(' / ')}，默认 react）`)
  return 'react'
}

function humanizeName(id: string): string {
  const last = id.split('.').pop() ?? id
  const words = last.split('-').filter(Boolean)
  return words.map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ')
}

export async function createCommand(id: string, templateName?: string): Promise<void> {
  if (!id || id.length === 0) fail('用法: qomicex create <id> [--template <react|html|lib|wasm>]（如 qomicex create com.example.demo --template wasm）')
  const errors = checkId(id).filter((e) => !e.startsWith('id 建议'))
  if (errors.length > 0) fail(`非法插件 id：${errors.join('；')}`)

  const tpl = resolveTemplate(templateName)
  const dest = resolve(process.cwd(), id)
  if (existsSync(dest) && readdirSync(dest).length > 0) {
    fail(`目标目录已存在且非空: ${dest}`)
  }
  const src = templateDir(tpl)
  if (!existsSync(src)) fail(`模板目录不存在: ${src}（CLI 安装不完整）`)

  mkdirSync(dest, { recursive: true })
  const name = humanizeName(id)
  copyReplace(src, dest, { __QOMICEX_PLUGIN_ID__: id, __QOMICEX_PLUGIN_NAME__: name })

  info(`✔ 已生成插件项目 ${dest}`)
  info(`  id      : ${id}`)
  info(`  name    : ${name}`)
  info(`  template: ${tpl}（${TEMPLATES[tpl].desc}）`)
  info('')
  info('下一步：')
  info(`  cd ${id}`)
  if (tpl === 'react') {
    info('  pnpm install          # 安装依赖')
    info('  pnpm run dev          # Vite 热重载预览')
  } else if (tpl === 'wasm') {
    info('  rustup target add wasm32-unknown-unknown')
    info('  bash scripts/build.sh # 编译 plugin.wasm（Windows: pwsh scripts/build.ps1）')
  } else {
    info('  pnpm install          # 安装依赖')
    info('  pnpm run build        # esbuild 打包 src/ → dist/')
  }
  info('  qomicex verify        # manifest / 权限 / 长循环 校验')
  info('  qomicex pack          # 构建并打包 .qplugin')
  info('  qomicex publish       # 设备流登录后签名上传到商店')
  info('')
  if (tpl === 'lib') {
    info('提示：库插件无 UI，在 src/main.js 中注册方法，供其他插件 callPlugin 调用；')
    info('依赖方需在 manifest dependencies 声明本库 id。')
  } else if (tpl === 'react') {
    info('提示：模板依赖已发布的 @qomicex/plugin-ui，可在任意目录独立构建；')
    info('若项目创建在仓库 plugins-dev/ 内（pnpm workspace 覆盖区），请用 npm install 安装依赖。')
  } else if (tpl === 'wasm') {
    info('提示：L3 WASM 插件运行在 wasmtime 沙箱，无浏览器环境；')
    info('在 src/lib.rs 中实现逻辑，编译产物 plugin.wasm 由网关按固定文件名加载。')
  } else {
    info('提示：纯 html 插件无框架依赖，src/ 经 esbuild 打包到 dist/；也可直接编辑 dist/ 走无构建流程。')
  }
}

function copyReplace(src: string, dest: string, subs: Record<string, string>): void {
  for (const entry of readdirSync(src)) {
    const s = join(src, entry)
    const d = join(dest, entry)
    if (statSync(s).isDirectory()) {
      mkdirSync(d, { recursive: true })
      copyReplace(s, d, subs)
    } else {
      cpSync(s, d)
      // 只在需要插值的文件里替换（避免误伤 src/ 里运行时全局 window.__PLUGIN_ID__）
      if (/\.(json|html|md|js|ts|tsx|toml|rs)$/.test(entry)) {
        applySubs(d, subs)
      }
    }
  }
}

function applySubs(file: string, subs: Record<string, string>): void {
  let content = readFileSync(file, 'utf8')
  let changed = false
  for (const [k, v] of Object.entries(subs)) {
    if (content.includes(k)) {
      content = content.split(k).join(v)
      changed = true
    }
  }
  if (changed) writeFileSync(file, content, 'utf8')
}