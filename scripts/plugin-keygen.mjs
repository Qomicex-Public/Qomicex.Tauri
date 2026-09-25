#!/usr/bin/env node
// 插件签名密钥对生成器（ADR-050 Ed25519 三级信任链）
//
// 用法：
//   node scripts/plugin-keygen.mjs                  # 密钥对写入 plugin-key.json（0600），stdout 只打印 publicKey
//   node scripts/plugin-keygen.mjs --out key.json   # 指定输出路径
//   node scripts/plugin-keygen.mjs --json           # 一行 JSON（便于脚本/CI 解析，同样不含私钥）
//   node scripts/plugin-keygen.mjs --force          # 覆盖已存在的输出文件
//
// 为什么默认不打印私钥：私钥一旦进入 stdout 就会落到终端回滚、CI 日志与 shell history 里，
// 而这些都是明文存储、且难以清理。因此 stdout 只输出可公开的 publicKey 与文件路径，
// 私钥只落在权限 0600 的文件中。
//
// 输出文件字段：
//   privateKey  PKCS#8 DER base64（仅私钥持有者可见）
//   publicKey   raw 32 字节 base64（可公开）
//
// 根钥（商店）：privateKey → wrangler secret put PLUGIN_ROOT_PRIVATE_KEY
//              publicKey  → launcher 内置常量 / wrangler var PLUGIN_ROOT_PUBLIC_KEY
// 开发者钥：    privateKey 本地保管（CLI 打包签名用）
//              publicKey  → POST /api/v1/developer/keys 上传换证书

import { webcrypto } from 'node:crypto'
import { chmodSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const subtle = webcrypto.subtle

function b64(buf) {
  return Buffer.from(buf).toString('base64')
}

// `--out` 需要取值；`--json` / `--force` 是纯开关，用 includes 判断。
function flagValue(name) {
  const i = process.argv.indexOf(name)
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : undefined
}

async function generate() {
  const { publicKey, privateKey } = await subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify'])
  const pub = await subtle.exportKey('raw', publicKey)
  const priv = await subtle.exportKey('pkcs8', privateKey)
  return {
    alg: 'Ed25519',
    privateKey: b64(priv),
    publicKey: b64(pub),
  }
}

const asJson = process.argv.includes('--json')
const overwrite = process.argv.includes('--force')
const outPath = resolve(process.cwd(), flagValue('--out') ?? 'plugin-key.json')

const pair = await generate()
try {
  // 默认 'wx'：文件已存在就报错，避免无声覆盖掉一把已投入使用的密钥。
  writeFileSync(outPath, JSON.stringify(pair, null, 2) + '\n', { flag: overwrite ? 'w' : 'wx' })
  // POSIX 上 mode 在创建时生效；Windows 只支持只读位，需另行用 ACL 收紧。
  chmodSync(outPath, 0o600)
} catch (err) {
  if (err && err.code === 'EEXIST') {
    console.error(`文件已存在：${outPath}（用 --force 覆盖，或换一个 --out 路径）`)
    process.exit(1)
  }
  throw err
}

if (asJson) {
  console.log(JSON.stringify({ alg: pair.alg, publicKey: pair.publicKey, privateKeyFile: outPath }))
} else {
  console.log(`已写入密钥对：${outPath}（权限 0600，勿提交到版本库）`)
  console.log(`  publicKey (raw base64): ${pair.publicKey}`)
  console.log('')
  console.log('根钥用途：privateKey → wrangler secret put PLUGIN_ROOT_PRIVATE_KEY')
  console.log('          publicKey  → 填入 launcher 的 ROOT_PUBLIC_KEY 常量 + wrangler var PLUGIN_ROOT_PUBLIC_KEY')
  console.log('开发者钥用途：privateKey 本地保管，publicKey → POST /api/v1/developer/keys 换证书')
}
