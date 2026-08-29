#!/usr/bin/env node
// qomicex CLI 入口：create / dev / pack / verify / bump / publish
import { createCommand } from './commands/create.ts'
import { devCommand } from './commands/dev.ts'
import { packCommand } from './commands/pack.ts'
import { verifyCommand } from './commands/verify.ts'
import { publishCommand } from './commands/publish.ts'
import { bumpCommand } from './commands/bump.ts'
import { fail } from './lib/io.ts'
import { createRequire } from 'node:module'

// 版本号单一来源：package.json（bump 只改一处）
const VERSION = createRequire(import.meta.url)('../package.json').version

interface ParsedArgs {
  command: string
  positional: string[]
  options: Record<string, string | boolean>
}

function parseArgs(argv: string[]): ParsedArgs {
  const positional: string[] = []
  const options: Record<string, string | boolean> = {}
  const command = argv[0] ?? 'help'
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i]!
    if (a.startsWith('--')) {
      const eq = a.indexOf('=')
      if (eq !== -1) {
        options[a.slice(2, eq)] = a.slice(eq + 1)
      } else {
        const next = argv[i + 1]
        if (next !== undefined && !next.startsWith('--')) {
          options[a.slice(2)] = next
          i++
        } else {
          options[a.slice(2)] = true
        }
      }
    } else if (a.startsWith('-') && a.length === 2) {
      options[a.slice(1)] = true
    } else {
      positional.push(a)
    }
  }
  return { command, positional, options }
}

function helpText(): string {
  return `
qomicex v${VERSION} — Qomicex 插件生态 CLI

用法:
  qomicex create <id>           从内置模板生成合法插件项目（Vite+React+TS+plugin-ui+tailwind）
  qomicex dev [--port <n>]      起本地 Vite dev server + 生成 dev 源插件配置（默认 5173）
  qomicex pack [--out-dir <d>] [--version <v>] [--key <k>] [--skip-build]
                                构建并打 .qplugin（manifest.json 在 zip 根）
  qomicex verify [--package <f>]
                                manifest 合法性 + 权限最小化 + 长循环告警 + 签名检查
  qomicex bump <major|minor|patch> [--version <v>]
                                递增 manifest.json 版本号（或 --version 直接指定）
  qomicex publish [--key <k>] [--slug <s>] [--changelog <c>] [--api <url>] [--org-id <id>] [--package <f>] [--skip-build] [--yes]
                                设备流登录 → 注册签名公钥 → 签名 → 上传到商店
  qomicex --help | -h           显示帮助
  qomicex --version | -v        显示版本

环境变量:
  QOMICEX_SIGN_KEY   签名私钥（PKCS#8 PEM 或 raw base64 seed），publish 必填
  QOMICEX_API_KEY    商店 API Key（CI 模式下跳过设备流登录，自动确认上传）
  QOMICEX_STORE_API  商店 API base（默认 https://plugins.qomicex.top/api/v1）
`
}

async function main(): Promise<void> {
  const { command, positional, options } = parseArgs(process.argv.slice(2))

  if (command === 'help' || command === '--help' || command === '-h' || options['help']) {
    console.log(helpText())
    return
  }
  if (command === '--version' || command === '-v' || command === 'version') {
    console.log(VERSION)
    return
  }

  const num = (v: unknown, d: number) => (typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : d)

  try {
    switch (command) {
      case 'create':
        await createCommand(positional[0] ?? '')
        break
      case 'dev':
        await devCommand({ port: num(options['port'], 5173) })
        break
      case 'pack':
        await packCommand({
          outDir: typeof options['out-dir'] === 'string' ? options['out-dir'] : undefined,
          version: typeof options['version'] === 'string' ? options['version'] : undefined,
          key: typeof options['key'] === 'string' ? options['key'] : undefined,
          skipBuild: options['skip-build'] === true,
        })
        break
      case 'verify':
        await verifyCommand({ package: typeof options['package'] === 'string' ? options['package'] : undefined })
        break
      case 'bump':
        await bumpCommand({
          part: positional[0] ?? 'minor',
          version: typeof options['version'] === 'string' ? options['version'] : undefined,
        })
        break
      case 'publish':
        await publishCommand({
          key: typeof options['key'] === 'string' ? options['key'] : undefined,
          slug: typeof options['slug'] === 'string' ? options['slug'] : undefined,
          changelog: typeof options['changelog'] === 'string' ? options['changelog'] : undefined,
          api: typeof options['api'] === 'string' ? options['api'] : undefined,
          orgId: typeof options['org-id'] === 'string' ? options['org-id'] : undefined,
          package: typeof options['package'] === 'string' ? options['package'] : undefined,
          yes: options['yes'] === true,
          skipBuild: options['skip-build'] === true,
        })
        break
      default:
        fail(`未知命令: ${command}\n${helpText()}`)
    }
  } catch (e) {
    fail(e instanceof Error ? e.message : String(e))
  }
}

void main()
