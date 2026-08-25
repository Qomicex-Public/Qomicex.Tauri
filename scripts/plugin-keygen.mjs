#!/usr/bin/env node
// 插件签名密钥对生成器（ADR-050 Ed25519 三级信任链）
//
// 用法：
//   node scripts/plugin-keygen.mjs generate            # 生成一对 Ed25519 密钥，输出 JSON
//   node scripts/plugin-keygen.mjs generate --json     # 一行 JSON（便于脚本/CI 解析）
//
// 输出字段：
//   privateKey  PKCS#8 DER base64（仅私钥持有者可见）
//   publicKey   raw 32 字节 base64（可公开）
//
// 根钥（商店）：privateKey → wrangler secret put PLUGIN_ROOT_PRIVATE_KEY
//              publicKey  → launcher 内置常量 / wrangler var PLUGIN_ROOT_PUBLIC_KEY
// 开发者钥：    privateKey 本地保管（CLI 打包签名用）
//              publicKey  → POST /api/v1/developer/keys 上传换证书

import { webcrypto } from 'node:crypto'

const subtle = webcrypto.subtle

function b64(buf) {
  return Buffer.from(buf).toString('base64')
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
const pair = await generate()
console.log(asJson ? JSON.stringify(pair) : `Ed25519 密钥对（勿泄露 privateKey）:
  privateKey (PKCS#8 DER base64): ${pair.privateKey}
  publicKey  (raw base64):        ${pair.publicKey}

根钥用途：privateKey → wrangler secret put PLUGIN_ROOT_PRIVATE_KEY
          publicKey  → 填入 launcher 的 ROOT_PUBLIC_KEY 常量 + wrangler var PLUGIN_ROOT_PUBLIC_KEY
开发者钥用途：privateKey 本地保管，publicKey → POST /api/v1/developer/keys 换证书`)
