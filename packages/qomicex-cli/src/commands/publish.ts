// qomicex publish — 设备流登录（RFC 8628）→ 注册签名公钥 → 签名打包 → 上传到商店。
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { buildPackageEntries, packCommand, type PackOptions } from './pack.ts'
import { readManifestFile } from '../lib/project.ts'
import { zipRead, zipWrite } from '../lib/zip.ts'
import {
  DEFAULT_API_BASE,
  StoreApiError,
  requestDeviceCode,
  pollDeviceLogin,
  fetchMinePlugins,
  createPlugin,
  registerDevKey,
  uploadVersion,
} from '../lib/store.ts'
import { parsePrivateKey, derivePublicKey, signPackage } from '../lib/signature.ts'
import { confirm, fail, info, warn } from '../lib/io.ts'

export interface PublishOptions extends PackOptions {
  api?: string
  slug?: string
  changelog?: string
  orgId?: string
  package?: string
  yes?: boolean
}

export async function publishCommand(opts: PublishOptions = {}): Promise<void> {
  const root = process.cwd()
  const manifestFile = join(root, 'manifest.json')
  if (!existsSync(manifestFile)) fail('当前目录不是插件项目（缺少 manifest.json）')
  const manifest = readManifestFile(manifestFile)
  const slug = opts.slug ?? String(manifest.id ?? '')
  const version = opts.version ?? String(manifest.version ?? '')
  if (!slug) fail('manifest.json 缺少 id，无法发布')

  // 1) 私钥（必须，商店要求签名包）
  const keyContent = process.env.QOMICEX_SIGN_KEY || (opts.key ? await readKeyFile(opts.key) : '')
  if (!keyContent) {
    fail('缺少签名私钥：请通过环境变量 QOMICEX_SIGN_KEY 或 --key <私钥文件> 提供（PKCS#8 PEM / raw base64 seed）')
  }
  const priv = parsePrivateKey(keyContent)
  const publicKey = await derivePublicKey(priv)

  // 2) 打包（复用 pack 管线；已有 --package 则直接读取）
  let entries: Record<string, Uint8Array>
  if (opts.package) {
    const p = resolve(root, opts.package)
    if (!existsSync(p)) fail(`找不到包文件: ${p}`)
    entries = zipRead(readFileSync(p))
  } else {
    const packOpts: PackOptions = { ...opts }
    await packCommand({ ...packOpts, key: undefined })
    entries = buildPackageEntries(root, manifest)
  }
  // 清掉旧签名文件，避免脏残留
  for (const k of ['signature.json', 'signature.cert.json']) delete entries[k]

  // 3) 设备流登录
  const api = opts.api ?? process.env.QOMICEX_STORE_API ?? DEFAULT_API_BASE
  info('==> 设备流登录')
  const code = await requestDeviceCode(api)
  info(`  请在浏览器打开（或扫码）并登录确认：`)
  info(`  ${code.verificationUriComplete}`)
  info(`  授权码: ${code.userCode}`)
  const login = await pollDeviceLogin(api, code)
  info(`✔ 登录成功：${login.user.username}`)

  // 4) 注册/刷新签名公钥，获取商店根钥签发的证书
  info('==> 注册签名公钥')
  const keyRes = await registerDevKey(api, login.accessToken, publicKey)
  const certJson = JSON.stringify(keyRes.cert)
  info(`✔ 签名证书就绪（keyId: ${keyRes.keyId}）`)

  // 5) 签名
  const sig = await signPackage(entries, priv, keyRes.keyId, certJson)
  entries = { ...entries, ...sig }
  const signedBytes = zipWrite(Object.entries(entries).map(([name, data]) => ({ name, data })))

  // 6) 查找/创建插件记录
  info('==> 确认插件记录')
  let pluginId = ''
  const mine = await fetchMinePlugins(api, login.accessToken)
  const existing = mine.find((p) => p.slug === slug)
  if (existing) {
    pluginId = existing.id
    info(`✔ 找到已有插件 ${slug}（id: ${pluginId}）`)
  } else {
    try {
      const created = await createPlugin(api, login.accessToken, {
        slug,
        name: String(manifest.name ?? slug),
        description: String(manifest.description ?? ''),
        orgId: opts.orgId,
      })
      pluginId = created.id
      info(`✔ 已创建插件记录 ${slug}（id: ${pluginId}，等待商店审核）`)
    } catch (e) {
      if (e instanceof StoreApiError && e.status === 409) {
        const again = await fetchMinePlugins(api, login.accessToken)
        const found = again.find((p) => p.slug === slug)
        if (!found) throw e
        pluginId = found.id
        info(`✔ slug 已存在，复用插件 ${slug}（id: ${pluginId}）`)
      } else {
        throw e
      }
    }
  }

  // 7) 确认后上传
  info('')
  info(`发布预览：`)
  info(`  插件: ${slug}  v${version}`)
  info(`  keyId: ${keyRes.keyId}`)
  info(`  包体: ${signedBytes.length} 字节（已签名）`)
  const ok = await confirm('确认发布到商店？', opts.yes ?? false)
  if (!ok) {
    warn('已取消发布')
    return
  }

  info('==> 上传版本')
  const result = await uploadVersion(api, login.accessToken, pluginId, signedBytes, opts.changelog)
  info(`✔ 上传完成：${slug} v${version}`)
  info(`  商店地址: ${api.replace('/api/v1', '')}`)
  if (typeof result === 'object' && result && 'status' in result) {
    info(`  状态: ${String((result as { status: unknown }).status)}`)
  }

  // 保存签名包到 release/，方便复验
  const outDir = resolve(root, 'release')
  const { mkdirSync } = await import('node:fs')
  mkdirSync(outDir, { recursive: true })
  const outPath = join(outDir, `${slug}-${version}.signed.qplugin`)
  writeFileSync(outPath, signedBytes)
  info(`✔ 已保存签名包 ${outPath}（可 qomicex verify --package 复验）`)
}

async function readKeyFile(key: string): Promise<string> {
  const p = resolve(process.cwd(), key)
  if (existsSync(p)) return readFileSync(p, 'utf8').trim()
  return key.trim()
}
