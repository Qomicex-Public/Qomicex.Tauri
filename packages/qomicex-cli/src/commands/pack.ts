// qomicex pack — 构建（有 package.json 则 pnpm run build；否则跳过）并打 .qplugin。
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

/** 构建方式：package.json 的 scripts.build（react/html/lib）或 Cargo.toml（wasm Rust）。 */
export function hasBuildScript(root: string): boolean {
  const pkgFile = join(root, 'package.json')
  if (existsSync(pkgFile)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgFile, 'utf8')) as { scripts?: Record<string, string> }
      return typeof pkg.scripts?.build === 'string'
    } catch {
      return false
    }
  }
  // L3 wasm 插件：Rust 项目（Cargo.toml），构建产物为 plugin.wasm
  return existsSync(join(root, 'Cargo.toml'))
}

/** 项目构建命令：按项目类型选择（react/html/lib 走 pnpm build；wasm 走 cargo build）。 */
export function buildCommand(root: string): string {
  if (existsSync(join(root, 'Cargo.toml'))) {
    // wasm：优先仓库内 scripts/build.sh（Unix）或 build.ps1（Windows），否则直接 cargo
    if (process.platform === 'win32') {
      return existsSync(join(root, 'scripts', 'build.ps1')) ? 'pwsh -NoProfile -File scripts/build.ps1' : 'cargo build --release --target wasm32-unknown-unknown'
    }
    return existsSync(join(root, 'scripts', 'build.sh')) ? 'bash scripts/build.sh' : 'cargo build --release --target wasm32-unknown-unknown'
  }
  return 'pnpm run build'
}

/** 组装包内条目：manifest.json + dist/**（无 dist/ 时回退收集根目录静态文件），并把入口引用的根文件拷进 dist。 */
export function buildPackageEntries(root: string, manifest: Record<string, unknown>): Record<string, Uint8Array> {
  const entries: Record<string, Uint8Array> = {}
  entries['manifest.json'] = new TextEncoder().encode(JSON.stringify(manifest))
  const distDir = join(root, 'dist')
  if (existsSync(distDir)) {
    for (const f of collectDir(distDir, 'dist/')) entries[f.name] = f.data
  } else {
    // 无 dist/（纯静态 / 无构建 / wasm 项目）：收集 manifest 引用的根文件 + plugin.wasm
    info('⚠ 未找到 dist/ 目录，回退收集 manifest 引用的根目录文件（无构建流程）')
    const refs = referencedFiles(manifest)
    if (existsSync(join(root, 'plugin.wasm'))) refs.push('plugin.wasm')
    for (const ref of refs) {
      const p = join(root, ref)
      if (existsSync(p)) entries[ref] = readFileSync(p)
      else warn(`manifest 引用 ${ref} 不存在，已跳过`)
    }
  }

  // entry.theme / contributes.overlay.file / contributes.slots[].file 引用 dist/ 下文件但源码在根目录时，自动拷入
  const entry = manifest.entry as { theme?: string; frontend?: string } | undefined
  const contributes = manifest.contributes as { overlay?: { file?: string }; slots?: Array<{ file?: string }> } | undefined
  const overlay = contributes?.overlay
  const refs: string[] = []
  if (entry?.theme) refs.push(entry.theme)
  if (overlay?.file) refs.push(overlay.file)
  for (const slot of contributes?.slots ?? []) {
    if (slot.file) refs.push(slot.file)
  }
  for (const ref of refs) {
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

/** manifest 引用的包内文件（entry.frontend/theme/backend + overlay.file）。 */
function referencedFiles(manifest: Record<string, unknown>): string[] {
  const out: string[] = []
  const entry = manifest.entry as Record<string, unknown> | undefined
  if (entry) {
    for (const key of ['frontend', 'theme', 'backend']) {
      const v = entry[key]
      if (typeof v === 'string') out.push(v)
    }
  }
  const overlay = (manifest.contributes as { overlay?: { file?: string } } | undefined)?.overlay
  if (overlay && typeof overlay.file === 'string') out.push(overlay.file)
  return [...new Set(out)]
}

export async function packCommand(opts: PackOptions = {}): Promise<PackResult> {
  const root = process.cwd()
  const manifestFile = join(root, 'manifest.json')
  if (!existsSync(manifestFile)) fail('当前目录不是插件项目（缺少 manifest.json）')

  if (!opts.skipBuild && hasBuildScript(root)) {
    const cmd = buildCommand(root)
    info(`==> 构建（${cmd}）`)
    const code = await runShell(cmd, root)
    if (code !== 0) fail('构建失败，请先修复编译错误')
  } else if (!opts.skipBuild) {
    info('==> 跳过构建（无 package.json / 无 Cargo.toml / 无 build 脚本；直接打包现有文件）')
  }

  const manifest = readManifestFile(manifestFile)
  const id = String(manifest.id ?? '')
  const version = opts.version ?? String(manifest.version ?? '')
  if (!id) fail('manifest.json 缺少 id')

  let entries = buildPackageEntries(root, manifest)

  // 可选签名（signature.json + signature.cert.json；无商店证书时生成自签证书）
  if (opts.key) {
    const keyContent = await readKeyInput(opts.key)
    const priv = parsePrivateKey(keyContent)
    const { derivePublicKey, makeSelfSignedCert } = await import('../lib/signature.ts')
    const pub = await derivePublicKey(priv)
    const keyId = `ed25519:${pub.slice(0, 8)}`
    const localCert = join(root, 'signature.cert.json')
    let certJson: string | undefined
    if (existsSync(localCert)) {
      certJson = readFileSync(localCert, 'utf8')
    } else {
      const name = String((manifest as Record<string, unknown>).name ?? '')
      certJson = await makeSelfSignedCert(priv, keyId, name)
      writeFileSync(localCert, certJson)
      warn('未找到本地签名证书，已生成自签证书并写入 signature.cert.json；上传商店需先在开发者中心注册对应公钥')
    }
    const sig = await signPackage(entries, priv, keyId, certJson)
    entries = { ...entries, ...sig }
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
