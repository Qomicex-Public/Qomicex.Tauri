# @qomicex/cli — qomicex 插件 CLI

Qomicex 插件生态脚手架：`create` / `dev` / `pack` / `verify` / `publish`。零运行时依赖（Node ≥ 20，仅用内置 `node:fs`/`node:zlib`/WebCrypto）。

## 安装

```bash
# 仓库内（pnpm workspace 成员，`packages/qomicex-cli`）
pnpm install
pnpm --filter @qomicex/cli build
# 本地链接到 PATH
pnpm --filter @qomicex/cli link
```

## 命令

### create
```bash
qomicex create com.example.demo
```
从内置模板生成合法插件项目（Vite + React 19 + TS + Tailwind + `@qomicex/plugin-ui`），自动替换 `manifest.json` / `package.json` 中的 id。模板 `layers:["l2"]`（iframe 沙箱），权限最小集 `config:read / ui:toast / network:cors_proxy`。生成后提示 `pnpm install`。

### dev
```bash
qomicex dev            # 默认 5173
qomicex dev --port 3000
```
起本地插件调试环境：
- **仓库内（harness 模式）**：插件位于仓库 `plugins-dev/{id}` 时，自动检测并 spawn `scripts/harness/run.mjs`，进入完整调试环境——Playwright 起 Vite(:1420) + 注入 Tauri mock + stub mock server(:5100) + 源码变更热重载（重建后整页 reload）。此模式 `--port` 不生效（harness 固定端口），`Ctrl+C` 退出时一并清理 stub/Vite。
- **仓库外（裸 Vite）**：未检测到 harness 时回退为起 Vite dev server + 在项目根写 `.qomicex-dev.json`（dev 源插件配置：插件 id → localhost URL 映射），供手动注册 dev 源使用。

### pack
```bash
qomicex pack                          # tsc && vite build → release/<id>-<version>.qplugin
qomicex pack --version 0.2.0          # 覆盖 manifest 版本号
qomicex pack --key ./dev-key.pem      # 附签名（仅 signature.json；完整证书链请用 publish）
qomicex pack --skip-build             # 跳过构建（复用现有 dist）
```
`.qplugin` = zip，`manifest.json` 在根 + `dist/**`。`entry.theme` / `contributes.overlay.file` 若引用 `dist/` 下文件但源码在根目录，会自动拷入。

### verify
```bash
qomicex verify                        # 目录模式：manifest + 权限 + 长循环
qomicex verify --package ./release/x.qplugin   # 包模式：manifest + 签名验签
```
- **manifest 合法性**：id（反向域名/安全字符）、name、version(semver)、minLauncherVersion、layers、permissions、entry、contributes。
- **权限最小化**：对比 `manifest.permissions` 与源码实际调用的桥方法（`METHOD_PERMISSIONS` 表）。声明未用 / 用了未声明都会报错。
- **长循环告警**：`while(true)`、`for(;;)`、`setInterval` 无界轮询（提示放 Worker/WASM/后端）。
- **签名检查**：包模式用内置商店根公钥验签（ADR-050）；无签名提示"未签名"不拒绝。

### publish
```bash
export QOMICEX_SIGN_KEY=<私钥 base64/PEM>   # 或 --key ./key.pem
qomicex publish                            # 设备流登录 → 签名 → 上传
qomicex publish --changelog "修复 X" --yes
qomicex publish --api http://127.0.0.1:8787/api/v1   # 本地商店（wrangler dev）调试
```
流程（对齐商店契约，见 `docs/junsi-dev-docs/2-架构设计/插件生态技术提案.md` §3.1/§4.1 与 ADR-050）：
1. `POST /api/v1/auth/device/code` → 打印授权码与验证 URL → 轮询 `device/token` 拿访问令牌（RFC 8628）。
2. `POST /api/v1/developer/keys` 上传 Ed25519 公钥 → 商店根钥签发开发者证书（`keyId` + `signature.cert.json`）。
3. 用私钥对包体签名（规范化 JSON 载荷 → Ed25519 → `signature.json`），与证书一起打进 `.qplugin`。
4. 查找/创建插件记录（`/plugins/mine` → 无则 `POST /plugins`），确认后 `POST /plugins/:id/versions` multipart 上传。
5. 成功后将签名包存为 `release/<id>-<version>.signed.qplugin` 供复验。

## AI 辅助开发

CLI 随包分发 **AI skill 包**（`skills/qomicex-plugin/`），供 AI agent（Claude / opencode / Cursor 等）在写插件时加载，获得准确且不过时的 manifest 字段、权限目录、桥 API 签名、主题 token、签名与调试流程——避免 AI 臆造字段。安装 CLI 后本地路径为 `node_modules/@qomicex/cli/skills/qomicex-plugin/`（npm 包内，随 `files` 分发）。

`qomicex create` 默认**不自动复制** skill 包到项目目录（保持项目最小化）；需要时手动复制即可。

在 AI 会话中这样用：

```text
你是 Qomicex 插件开发工程师。请先阅读 <CLI 安装路径>/skills/qomicex-plugin/SKILL.md
（及其余分册，尤其 rules.md），然后帮我做一个「XXX」插件：
1. qomicex create com.example.xxx 生成项目
2. 实现功能（manifest / 权限 / API 签名以技能包文档为准，不臆造）
3. qomicex verify 过 0 error
4. qomicex pack 出包
```

skill 包结构：

```text
skills/qomicex-plugin/
  SKILL.md            # 主文档：何时用、快速开始、常见错误
  manifest-schema.md  # manifest.json 全字段 + layers + render + dependencies + contributes
  permissions.md      # 权限目录（39 项，normal/warning/danger）+ 方法→权限映射
  plugin-api.md       # 桥 API 签名速查（完整文档见 D:\docs\docs\plugins\plugin-api.md）
  theme.md            # 三级语义 token + var() 消费约定
  signing.md          # Ed25519 签名流程（生成密钥 → pack --key → publish）
  debugging.md        # harness 热重载调试
  rules.md            # AI 生成插件的硬性规则
```

## 签名密钥

生成 Ed25519 密钥对（PKCS#8 PEM 或 raw 32 字节 seed base64）：

```bash
openssl genpkey -algorithm Ed25519 -out dev-key.pem
# raw seed 提取（publish 也接受 PEM，通常不必）
openssl pkey -in dev-key.pem -outform DER | tail -c 32 | base64
```

## 开发

```bash
pnpm --filter @qomicex/cli build      # tsc → dist/（rewriteRelativeImportExtensions 输出可运行 ESM）
pnpm --filter @qomicex/cli typecheck
```

## 设计说明

- **零依赖**：zip 读写（`node:zlib` + 手写 CRC32/目录结构）、Ed25519（WebCrypto）、参数解析（手写）均不引入第三方包。
- **签名规范化** 与 store `src/lib/signature.ts`、launcher `plugin_signature.rs` 字节级一致（键序/无空白 canonicalJson，`signedHash` = 载荷 SHA-256）。
- **不改商店上传接口**：只读参考契约实现客户端。
