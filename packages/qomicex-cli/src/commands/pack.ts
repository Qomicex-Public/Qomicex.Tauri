// qomicex pack — 构建（tsc && vite build）并打 .qplugin（manifest.json 在 zip 根）。
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { readManifestFile, collectDir } from '../lib/project.ts'
import { zipWrite, type ZipEntry } from '../lib/zip.ts'
import { fail, info, runShell, warn } from '../lib/io.ts'
import { parsePrivateKey, signPackage } from '../lib/signature.ts'

export interface PackResult {
  outPath: string
  entries: Record<string, Uint8Array>
}

export interface PackOptions {
  outDir?: string
  version?: string
  key?: string
  skipBuild?: boolean
}

/** 组装包内条目：manifest.json + dist/**，并把入口引用的根文件（theme.css/overlay.html）拷进 dist。 */
export function buildPackageEntries(root: string, manifest: Record<string, unknown>): Record<string, Uint8Array> {
  const entries: Record<string, Uint8Array> = {}
  entries['manifest.json'] = new TextEncoder().encode(JSON.stringify(manifest))
  const distDir = join(root, 'dist')
  if (!existsSync(distDir)) fail('缺少 dist/ 目录，请先构建（pnpm run build 或使用 qomicex pack）')
  for (const f of collectDir(distDir, 'dist/')) entries[f.name] = f.data

  // entry.theme / contributes.overlay.file 引用 dist/ 下文件但源码在根目录时，自动拷入
  const entry = manifest.entry as { theme?: string; frontend?: string } | undefined
  const overlay = (manifest.contributes as { overlay?: { file?: string } } | undefined)?.overlay
  for (const ref of [entry?.theme, overlay?.file]) {
    if (typeof ref !== 'string' || !ref.startsWith('dist/')) continue
    const target = join(root, ref)
    if (existsSync(target)) continue
    const rootSrc = join(root, ref.slice('dist/'.length))
    if (existsSync(rootSrc)) {
      writeFileSync(target, readFileSync(rootSrc))
      entries[ref] = readFileSync(target)
    }
  }
  return entries
}

export async function packCommand(opts: PackOptions = {}): Promise<PackResult> {
  const root = process.cwd()
  const manifestFile = join(root, 'manifest.json')
  if (!existsSync(manifestFile)) fail('当前目录不是插件项目（缺少 manifest.json）')

  if (!opts.skipBuild) {
    info('==> 构建前端（tsc + vite build）')
    const code = await runShell('pnpm run build', root)
    if (code !== 0) fail('构建失败，请先修复编译错误')
  }

  const manifest = readManifestFile(manifestFile)
  const id = String(manifest.id ?? '')
  const version = opts.version ?? String(manifest.version ?? '')
  if (!id) fail('manifest.json 缺少 id')

  let entries = buildPackageEntries(root, manifest)

  // 可选签名（仅 signature.json；需要证书链请用 publish）
  if (opts.key) {
    const keyContent = await readKeyInput(opts.key)
    const priv = parsePrivateKey(keyContent)
    const { derivePublicKey } = await import('../lib/signature.ts')
    const pub = await derivePublicKey(priv)
    const keyId = `ed25519:${pub.slice(0, 8)}`
    const localCert = join(root, 'signature.cert.json')
    let certJson: string | undefined
    if (existsSync(localCert)) certJson = readFileSync(localCert, 'utf8')
    const sig = await signPackage(entries, priv, keyId, certJson)
    entries = { ...entries, ...sig }
    if (!certJson) warn('缺少本地 signature.cert.json，商店上传仍需证书；建议改用 qomicex publish 走完整签名')
  }

  const outDir = resolve(root, opts.outDir ?? 'release')
  mkdirSync(outDir, { recursive: true })
  const outPath = join(outDir, `${id}-${version}.qplugin`)
  writeFileSync(outPath, zipWrite(Object.entries(entries).map(([name, data]): ZipEntry => ({ name, data }))))
  info(`✔ 已生成 ${outPath} (${entriesCount(entries)} 个文件)`)
  return { outPath, entries }
}

async function readKeyInput(key: string): Promise<string> {
  if (key.trim().startsWith('-----BEGIN') || /^[A-Za-z0-9+/=]{20,}$/.test(key.trim())) {
    // 内联 PEM / base64
    return key.trim()
  }
  const { readFileSync } = await import('node:fs')
  const p = resolve(process.cwd(), key)
  return readFileSync(p, 'utf8').trim()
}

function entriesCount(entries: Record<string, Uint8Array>): number {
  return Object.keys(entries).length
}
