# Ed25519 签名流程

签名实现源：`packages/qomicex-cli/src/lib/signature.ts`。规范：**ADR-050 三级信任链**（商店根钥 → 开发者证书 → 包体签名）。与 store `src/lib/signature.ts`、launcher `plugin_signature.rs` 字节级一致。

## 签名载荷（规范化）

```
payload = canonicalJson({
  manifest: sha256Hex(manifest.json 原始字节),
  files: [{ path, sha256 }...]     // 按 path 升序
})
signedHash = SHA-256(payload)      // 文本 UTF-8
signature  = Ed25519(私钥, payload 的 UTF-8 字节)
```

- `canonicalJson`：递归按键排序、无空白 JSON（键序对哈希无影响，保证确定性）。
- 包内 `signature.json` 与 `signature.cert.json` 本身不参与签名。

## 产物文件

| 文件 | 内容 |
|------|------|
| `signature.json` | `{ alg: "Ed25519", signedHash, signerKeyId, signature }` |
| `signature.cert.json` | 商店根钥签发的开发者证书：`{ alg, keyId, developerId, developerName, publicKey, issuedAt, signature }` |

验包要求：**两个文件都必须存在**，缺任一 → 未签名（`verify` 警告不拒绝）；根钥验证书失败 / 包体验签失败 / 哈希不符 → 拒绝。

## 1. 生成密钥对

```bash
openssl genpkey -algorithm Ed25519 -out dev-key.pem
# 可选：提取 raw 32 字节 seed base64（publish 也接受 PEM，通常不必）
openssl pkey -in dev-key.pem -outform DER | tail -c 32 | base64
```

私钥支持三种格式：PKCS#8 PEM、PKCS#8 DER base64、raw 32 字节 seed base64。

> ⚠️ 私钥 = 开发者身份。**禁止**写入插件源码 / manifest / git 仓库 / 提交任何公开位置。使用环境变量 `QOMICEX_SIGN_KEY` 传入。

## 2. pack --key（本地签名，仅 signature.json）

```bash
qomicex pack --key ./dev-key.pem
```

- `keyId = ed25519:{公钥 base64 前 8 字符}`。
- 若项目根存在 `signature.cert.json` 会自动带上（发布过一次后即有）。
- 无证书时 CLI 会警告：商店上传仍需完整证书，建议走 publish。

## 3. publish（完整证书链）

```bash
export QOMICEX_SIGN_KEY=<私钥 base64/PEM>   # 或 --key ./dev-key.pem
qomicex publish
qomicex publish --changelog "修复 X" --yes
qomicex publish --api http://127.0.0.1:8787/api/v1   # 本地商店（wrangler dev）调试
```

流程（RFC 8628 设备流）：
1. `POST /api/v1/auth/device/code` → 打印授权码 + 验证 URL → 轮询 `device/token` 拿访问令牌。
2. `POST /api/v1/developer/keys` 上传 Ed25519 公钥 → 商店根钥签发开发者证书（返回 `keyId` + 证书内容）。
3. 用私钥对包体签名，写入 `signature.json`，与证书一起打进 `.qplugin`。
4. 查找/创建插件记录（`/plugins/mine` → 无则 `POST /plugins`），确认后 `POST /plugins/:id/versions` multipart 上传。
5. 成功后将签名包存为 `release/<id>-<version>.signed.qplugin` 供复验。

## 4. 验包

```bash
qomicex verify --package ./release/x.qplugin
```

- 用内置商店根公钥验签：`STORE_ROOT_PUBLIC_KEY_B64`（与 launcher `plugin_signature.rs` 的 `ROOT_PUBLIC_KEY_B64` 一致）。
- 未签名 → 提示"未签名"（警告，不拒绝）；签名无效 → error 退出。

## 商店根公钥

```
sPKcrc6QR5gcOnQMdq21Jo3yqxN7Mbm61OYxZnKuHE0=
```
（raw base64 Ed25519 公钥；开发 / 自建商店需替换为对应根钥）
