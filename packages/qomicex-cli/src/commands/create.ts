// qomicex create <id> — 从内置模板生成合法插件项目。
import { cpSync, existsSync, mkdirSync, readdirSync, statSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { checkId } from '../lib/manifest.ts'
import { fail, info } from '../lib/io.ts'

export function templateDir(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), '../../templates/plugin')
}

function humanizeName(id: string): string {
  const last = id.split('.').pop() ?? id
  const words = last.split('-').filter(Boolean)
  return words.map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ')
}

export async function createCommand(id: string): Promise<void> {
  if (!id || id.length === 0) fail('用法: qomicex create <id>（如 qomicex create com.example.demo）')
  const errors = checkId(id).filter((e) => !e.startsWith('id 建议'))
  if (errors.length > 0) fail(`非法插件 id：${errors.join('；')}`)

  const dest = resolve(process.cwd(), id)
  if (existsSync(dest) && readdirSync(dest).length > 0) {
    fail(`目标目录已存在且非空: ${dest}`)
  }
  const src = templateDir()
  if (!existsSync(src)) fail(`模板目录不存在: ${src}（CLI 安装不完整）`)

  mkdirSync(dest, { recursive: true })
  const name = humanizeName(id)
  copyReplace(src, dest, { __QOMICEX_PLUGIN_ID__: id, __QOMICEX_PLUGIN_NAME__: name })

  info(`✔ 已生成插件项目 ${dest}`)
  info(`  id   : ${id}`)
  info(`  name : ${name}`)
  info('')
  info('下一步：')
  info(`  cd ${id}`)
  info('  pnpm install          # 安装依赖')
  info('  pnpm run dev          # 本地热重载预览')
  info('  qomicex verify        # manifest / 权限 / 长循环 校验')
  info('  qomicex pack          # 构建并打包 .qplugin')
  info('  qomicex publish       # 设备流登录后签名上传到商店')
  info('')
  info('提示：模板依赖已发布的 @qomicex/plugin-ui，可在任意目录独立构建；')
  info('若项目创建在仓库 plugins-dev/ 内（pnpm workspace 覆盖区），请用 npm install 安装依赖。')
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
      if (/\.(json|html|md)$/.test(entry)) {
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
