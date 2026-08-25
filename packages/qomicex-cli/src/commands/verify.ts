// qomicex verify — manifest 合法性 + 权限最小化 + 长循环告警 + 签名检查。
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { validateManifest, type ManifestIssue } from '../lib/manifest.ts'
import { checkPermissions, checkLongLoops, type ScanFinding } from '../lib/scan.ts'
import { zipRead } from '../lib/zip.ts'
import { verifyPackageSignature } from '../lib/signature.ts'
import { fail, info, warn } from '../lib/io.ts'

export interface VerifyOptions {
  package?: string
}

export async function verifyCommand(opts: VerifyOptions = {}): Promise<void> {
  if (opts.package) {
    await verifyPackage(opts.package)
    return
  }
  const root = process.cwd()
  const manifestFile = join(root, 'manifest.json')
  if (!existsSync(manifestFile)) fail('当前目录不是插件项目（缺少 manifest.json）')

  const manifest = JSON.parse(readFileSync(manifestFile, 'utf8')) as Record<string, unknown>
  const findings: Array<ScanFinding | ManifestIssue> = []
  let errors = 0

  const mCheck = validateManifest(manifest)
  findings.push(...mCheck.issues)
  errors += mCheck.issues.filter((i) => i.severity === 'error').length

  const permissions = Array.isArray(manifest.permissions) ? (manifest.permissions as string[]) : []
  const permCheck = checkPermissions(root, permissions)
  findings.push(...permCheck.findings)
  errors += permCheck.findings.filter((f) => f.severity === 'error').length

  const loops = checkLongLoops(root)
  findings.push(...loops)

  for (const f of findings) {
    const tag = f.severity === 'error' ? '✗' : '⚠'
    const loc = 'file' in f && f.file ? ` (${f.file})` : ''
    if (f.severity === 'error') console.error(`${tag} ${f.message}${loc}`)
    else console.warn(`${tag} ${f.message}${loc}`)
  }

  info(`\n校验完成：${mCheck.issues.length} manifest 项，权限 ${permissions.length} 项（未用 ${permCheck.unused.length}，缺声明 ${permCheck.missing.length}），长循环告警 ${loops.length}`)
  if (errors > 0) {
    console.error(`发现 ${errors} 个错误，请修复后重试`)
    process.exit(1)
  }
  info('✔ verify 通过')
}

async function verifyPackage(pkg: string): Promise<void> {
  const file = resolve(process.cwd(), pkg)
  if (!existsSync(file)) fail(`找不到文件: ${file}`)
  let entries: Record<string, Uint8Array>
  try {
    entries = zipRead(readFileSync(file))
  } catch (e) {
    fail(`不是有效的 .qplugin（zip）: ${e instanceof Error ? e.message : String(e)}`)
  }
  if (!entries['manifest.json']) fail('包内缺少根级 manifest.json')

  const manifest = JSON.parse(new TextDecoder().decode(entries['manifest.json'])) as Record<string, unknown>
  const mCheck = validateManifest(manifest)
  for (const i of mCheck.issues) {
    if (i.severity === 'error') console.error(`✗ [manifest.${i.path}] ${i.message}`)
    else warn(`[manifest.${i.path}] ${i.message}`)
  }

  const sig = await verifyPackageSignature(entries)
  if (sig.ok) {
    info(`✔ 签名有效（开发者: ${sig.cert.developerName}, keyId: ${sig.cert.keyId}）`)
  } else if (sig.code === 'signature_required') {
    warn(sig.reason)
  } else {
    console.error(`✗ 签名无效: ${sig.reason}`)
  }

  if (!mCheck.ok || (sig.ok === false && sig.code === 'signature_invalid')) {
    process.exit(1)
  }
  info('✔ verify 通过')
}
