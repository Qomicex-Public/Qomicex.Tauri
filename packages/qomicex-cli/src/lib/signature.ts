// 插件包 Ed25519 签名（ADR-050 三级信任链）。
// 规范化与 store `src/lib/signature.ts` / launcher `plugin_signature.rs` 字节级一致：
//   signedHash = SHA-256( canonicalJson({ manifest: sha256Hex(manifest.json 原始字节),
//                                        files: [{path, sha256}...按 path 排序] }) )
//   signature  = Ed25519(私钥, 同载荷 UTF-8 字节)
// 用 Node WebCrypto（node >= 20），零第三方依赖。

export const SIGNATURE_FILE = 'signature.json'
export const CERT_FILE = 'signature.cert.json'
export const ALG = 'Ed25519'
/** 商店签名根公钥（raw base64），与 launcher plugin_signature.rs ROOT_PUBLIC_KEY_B64 一致 */
export const STORE_ROOT_PUBLIC_KEY_B64 = 'YkYb+Oh8CNHyGwKAEy/1p6Vz8FYp7UafymXoHCZhfmQ='

/** Ed25519 PKCS#8 DER 固定前缀（前 16 字节），后接 32 字节 seed */
const ED25519_PKCS8_PREFIX = Uint8Array.from([0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20])

export function bytesToBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64')
}

export function base64ToBytes(b64: string): Uint8Array | null {
  try {
    return new Uint8Array(Buffer.from(b64, 'base64'))
  } catch {
    return null
  }
}

/** 递归按键排序、无空白 JSON（键序对哈希无影响，保持确定性） */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    if (typeof value === 'string') return JSON.stringify(value)
    return String(value)
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  const obj = value as Record<string, unknown>
  const keys = Object.keys(obj).sort()
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(',')}}`
}

function toHex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')
}

export async function sha256HexOf(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return toHex(new Uint8Array(digest))
}

/** 签名待签载荷：{ manifest: sha256Hex(manifest.json 原始字节), files: 按 path 排序 } */
export async function signedPayloadBytes(entries: Record<string, Uint8Array>): Promise<Uint8Array> {
  const manifestBytes = entries['manifest.json']
  if (!manifestBytes) throw new Error('包内缺少 manifest.json，无法签名')
  const files: { path: string; sha256: string }[] = []
  for (const name of Object.keys(entries)) {
    if (name === SIGNATURE_FILE || name === CERT_FILE) continue
    files.push({ path: name, sha256: await sha256HexOf(entries[name]!) })
  }
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  return new TextEncoder().encode(
    canonicalJson({ manifest: await sha256HexOf(manifestBytes), files }),
  )
}

/**
 * 解析私钥 → PKCS#8 DER。支持：PKCS#8 PEM、PKCS#8 DER base64、raw 32 字节 seed base64。
 */
export function parsePrivateKey(input: string): Uint8Array {
  let pem = input.trim()
  if (pem.includes('-----BEGIN')) {
    const body = pem.replace(/-----BEGIN[^-]+-----/, '').replace(/-----END[^-]+-----/, '').replace(/\s+/g, '')
    const der = base64ToBytes(body)
    if (der) return der
  }
  // 可能是 DER base64（45-48 字节，含前缀）或 raw seed base64（32 字节）
  const maybe = base64ToBytes(pem)
  if (!maybe || maybe.length === 0) throw new Error('无法解析私钥：只支持 PKCS#8 PEM / DER base64 / raw 32 字节 seed base64')
  if (maybe.length === 32) {
    const der = new Uint8Array(48)
    der.set(ED25519_PKCS8_PREFIX, 0)
    der.set(maybe, 16)
    return der
  }
  if (maybe.length === 45 || maybe.length === 48) return maybe
  throw new Error(`私钥长度异常（${maybe.length} 字节），应为 32（raw seed）或 45/48（PKCS#8 DER）`)
}

async function signingKey(der: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey('pkcs8', der as BufferSource, { name: ALG }, true, ['sign'])
}

export async function derivePublicKey(privDer: Uint8Array): Promise<string> {
  // WebCrypto 不支持从私钥 exportKey('raw')，改用 node:crypto：PKCS#8 → 私钥对象 → 公钥 → SPKI 末 32 字节 raw。
  const { createPrivateKey, createPublicKey } = await import('node:crypto')
  const priv = createPrivateKey({ key: privDer as unknown as Buffer, format: 'der', type: 'pkcs8' })
  const pub = createPublicKey(priv)
  const spki = pub.export({ format: 'der', type: 'spki' }) as Buffer
  const raw = spki.subarray(spki.length - 32)
  return bytesToBase64(new Uint8Array(raw))
}

async function signBytes(privDer: Uint8Array, msg: Uint8Array): Promise<string> {
  const key = await signingKey(privDer)
  const sig = await crypto.subtle.sign({ name: ALG }, key, msg as BufferSource)
  return bytesToBase64(new Uint8Array(sig))
}

export interface SignatureJson {
  alg: string
  signedHash: string
  signerKeyId: string
  signature: string
}

export interface CertJson {
  alg: string
  keyId: string
  developerId: string
  developerName: string
  publicKey: string
  issuedAt: string
  signature: string
}

/** 自签开发者证书（开发者私钥签证书体）：未注册商店密钥时的离线打包/本地验证用，商店上传需对应公钥已注册。 */
export async function makeSelfSignedCert(
  privDer: Uint8Array,
  keyId: string,
  developerName = '',
): Promise<string> {
  const { derivePublicKey } = await import('./signature.ts')
  const publicKey = await derivePublicKey(privDer)
  const body: CertJson = {
    alg: ALG,
    keyId,
    developerId: '',
    developerName,
    publicKey,
    issuedAt: new Date().toISOString(),
    signature: '',
  }
  const certBody = canonicalJson({
    alg: body.alg,
    keyId: body.keyId,
    developerId: body.developerId,
    developerName: body.developerName,
    publicKey: body.publicKey,
    issuedAt: body.issuedAt,
  })
  body.signature = await signBytes(privDer, new TextEncoder().encode(certBody))
  return JSON.stringify(body)
}

/**
 * 对包内全部条目生成签名文件。
 * @param certJson 商店根钥签发的开发者证书 JSON（POST /developer/keys 返回值），
 *                 省略时仅生成 signature.json（publish 场景由调用方传证书）。
 */
export async function signPackage(
  entries: Record<string, Uint8Array>,
  privDer: Uint8Array,
  keyId: string,
  certJson?: string,
): Promise<Record<string, Uint8Array>> {
  const payload = await signedPayloadBytes(entries)
  const signedHash = await sha256HexOf(payload)
  const signature = await signBytes(privDer, payload)
  const sigJson: SignatureJson = { alg: ALG, signedHash, signerKeyId: keyId, signature }
  const out: Record<string, Uint8Array> = {}
  out[SIGNATURE_FILE] = new TextEncoder().encode(JSON.stringify(sigJson))
  if (certJson) out[CERT_FILE] = new TextEncoder().encode(certJson)
  return out
}

async function verifyEd25519(pubKeyB64: string, msg: Uint8Array, sigB64: string): Promise<boolean> {
  const pubBytes = base64ToBytes(pubKeyB64)
  const sigBytes = base64ToBytes(sigB64)
  if (!pubBytes || !sigBytes || pubBytes.length !== 32 || sigBytes.length !== 64) return false
  try {
    const key = await crypto.subtle.importKey('raw', pubBytes as BufferSource, { name: ALG }, false, ['verify'])
    return await crypto.subtle.verify({ name: ALG }, key, sigBytes as BufferSource, msg as BufferSource)
  } catch {
    return false
  }
}

export type VerifyResult =
  | { ok: true; cert: CertJson }
  | { ok: false; code: 'signature_required' | 'signature_invalid'; reason: string }

/**
 * 验包（与 store verifyPackageSignature 同逻辑）：缺少签名/证书、根钥验证失败、包体签名失败、哈希不符 → 拒绝。
 */
export async function verifyPackageSignature(
  entries: Record<string, Uint8Array>,
  rootPubKeyB64 = STORE_ROOT_PUBLIC_KEY_B64,
): Promise<VerifyResult> {
  const sigRaw = entries[SIGNATURE_FILE]
  const certRaw = entries[CERT_FILE]
  if (!sigRaw || !certRaw) {
    return { ok: false, code: 'signature_required', reason: '缺少 signature.json / signature.cert.json（未签名）' }
  }
  let sig: SignatureJson
  let cert: CertJson
  try {
    sig = JSON.parse(new TextDecoder().decode(sigRaw)) as SignatureJson
    cert = JSON.parse(new TextDecoder().decode(certRaw)) as CertJson
  } catch {
    return { ok: false, code: 'signature_invalid', reason: '签名文件解析失败' }
  }
  if (sig.alg !== ALG || cert.alg !== ALG) return { ok: false, code: 'signature_invalid', reason: '不支持的签名算法' }
  if (cert.keyId !== sig.signerKeyId) return { ok: false, code: 'signature_invalid', reason: '证书与签名 signerKeyId 不一致' }

  const certBody = canonicalJson({
    alg: cert.alg,
    keyId: cert.keyId,
    developerId: cert.developerId,
    developerName: cert.developerName,
    publicKey: cert.publicKey,
    issuedAt: cert.issuedAt,
  })
  const certSigOk = await verifyEd25519(rootPubKeyB64, new TextEncoder().encode(certBody), cert.signature)
  if (!certSigOk) return { ok: false, code: 'signature_invalid', reason: '签名证书无效（商店根钥验证失败）' }

  const payload = await signedPayloadBytes(entries)
  const sigOk = await verifyEd25519(cert.publicKey, payload, sig.signature)
  if (!sigOk) return { ok: false, code: 'signature_invalid', reason: '包体签名验证失败（开发者密钥不符或包被篡改）' }

  const recomputed = await sha256HexOf(payload)
  if (recomputed !== sig.signedHash) return { ok: false, code: 'signature_invalid', reason: '签名哈希与包内容不匹配' }
  return { ok: true, cert }
}
