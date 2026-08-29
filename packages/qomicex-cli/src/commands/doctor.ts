// qomicex doctor — 环境诊断（纯只读，零副作用）：Node/pnpm/项目/manifest/plugin-ui/
// vite/签名环境/后端/store/harness。--json 可选供脚本消费。
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { runCapture } from '../lib/io.ts'
import { validateManifest } from '../lib/manifest.ts'
import { findHarnessStart } from '../lib/project.ts'

export interface DoctorOptions {
  json?: boolean
  api?: string
}

interface DoctorCheck {
  name: string
  ok: boolean
  detail: string
}

async function checkUrl(url: string, timeoutMs = 5000): Promise<{ ok: boolean; detail: string }> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(url, { signal: controller.signal })
    return { ok: res.ok, detail: `HTTP ${res.status}` }
  } catch (e) {
    return { ok: false, detail: e instanceof Error ? e.message : String(e) }
  } finally {
    clearTimeout(timer)
  }
}

async function checkWebCryptoEd25519(): Promise<{ ok: boolean; detail: string }> {
  try {
    await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify'])
    return { ok: true, detail: 'Ed25519 可用（WebCrypto）' }
  } catch {
    return { ok: false, detail: 'Ed25519 不可用（需 Node ≥ 20 WebCrypto）' }
  }
}

export async function doctorCommand(opts: DoctorOptions = {}): Promise<void> {
  const root = process.cwd()
  const checks: DoctorCheck[] = []

  const nodeMajor = Number(process.versions.node.split('.')[0])
  checks.push({
    name: 'Node 版本',
    ok: nodeMajor >= 20,
    detail: `${process.version}（需 ≥ 20）`,
  })

  const pnpm = await runCapture('pnpm --version', 8000)
  checks.push({
    name: 'pnpm',
    ok: pnpm.code === 0,
    detail: pnpm.code === 0 ? pnpm.stdout.trim() : (pnpm.stderr.trim() || `退出码 ${pnpm.code}`),
  })

  const manifestFile = join(root, 'manifest.json')
  if (!existsSync(manifestFile)) {
    checks.push({ name: '插件项目', ok: false, detail: `${root} 缺少 manifest.json（需在插件项目内运行）` })
  } else {
    const manifest = JSON.parse(readFileSync(manifestFile, 'utf8')) as Record<string, unknown>
    const m = validateManifest(manifest)
    const errors = m.issues.filter((i) => i.severity === 'error').length
    checks.push({ name: '插件项目', ok: m.ok, detail: `manifest 校验 ${errors} 错误 / ${m.issues.length} 项` })
  }

  const uiPkg = join(root, 'node_modules', '@qomicex', 'plugin-ui', 'package.json')
  if (existsSync(uiPkg)) {
    try {
      const v = (JSON.parse(readFileSync(uiPkg, 'utf8')) as { version?: string }).version ?? '?'
      checks.push({ name: '@qomicex/plugin-ui', ok: true, detail: `已安装 v${v}` })
    } catch {
      checks.push({ name: '@qomicex/plugin-ui', ok: false, detail: 'package.json 解析失败' })
    }
  } else {
    checks.push({ name: '@qomicex/plugin-ui', ok: false, detail: '未安装（pnpm install 后使用）' })
  }

  const viteBin = join(root, 'node_modules', '.bin', process.platform === 'win32' ? 'vite.cmd' : 'vite')
  checks.push({
    name: 'Vite',
    ok: existsSync(viteBin),
    detail: existsSync(viteBin) ? '已安装' : '未安装（pnpm install 后使用）',
  })

  const openssl = await runCapture('openssl version', 5000)
  checks.push({
    name: 'openssl',
    ok: openssl.code === 0,
    detail: openssl.code === 0 ? openssl.stdout.trim() : '不可用（签名密钥生成需要）',
  })

  checks.push({ name: 'Ed25519', ...(await checkWebCryptoEd25519()) })

  const backend = await checkUrl('http://127.0.0.1:5000/api/health', 4000)
  checks.push({
    name: '后端 :5000',
    ok: backend.ok,
    detail: backend.ok ? '运行中（api/health 正常）' : `未运行（${backend.detail}）`,
  })

  const storeApi = opts.api ?? process.env.QOMICEX_STORE_API ?? 'https://plugins.qomicex.top/api/v1'
  const store = await checkUrl(`${storeApi}/registry`, 6000)
  checks.push({
    name: '插件商店',
    ok: store.ok,
    detail: store.ok ? `${storeApi}/registry 可达` : `${store.detail}（${storeApi}）`,
  })

  const harness = findHarnessStart(root)
  checks.push({
    name: '调试 harness',
    ok: harness !== null,
    detail: harness ? harness : '未定位到（仓库外目录正常）',
  })

  if (opts.json) {
    const ok = checks.filter((c) => c.ok).length
    console.log(JSON.stringify({ ok: ok === checks.length, passed: ok, total: checks.length, checks }, null, 2))
    return
  }

  let failed = 0
  for (const c of checks) {
    const mark = c.ok ? '✔' : '✗'
    console.log(`${mark} ${c.name}: ${c.detail}`)
    if (!c.ok) failed++
  }
  const passed = checks.length - failed
  console.log(`\n诊断完成：${passed}/${checks.length} 通过，${failed} 项需关注`)
}