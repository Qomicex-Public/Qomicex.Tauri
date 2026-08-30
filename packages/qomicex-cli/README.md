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
qomicex create com.example.demo                  # 默认 react 模板
qomicex create com.example.html --template html   # 纯 HTML/CSS/JS（-t html 短参数也可）
qomicex create com.example.lib -t lib             # 纯库插件（无 UI，registerMethod 供调用）
qomicex create com.example.wasm --template wasm   # L3 WASM 插件（Rust + wasmtime）
```
从内置模板生成合法插件项目，自动替换 `manifest.json` / `package.json` / `Cargo.toml` / `src/lib.rs` 中的 id。四种模板：

| 模板 | `--template`/`-t` | 结构 | 构建 |
|------|-------------------|------|------|
| **react**（默认） | `react` | Vite + React 19 + TS + Tailwind + `@qomicex/plugin-ui`，`layers:["l2"]` | `pnpm run build`（tsc + vite） |
| **html** | `html` | 纯 HTML/CSS/JS（无框架），`src/` + esbuild 打包 → `dist/` | `pnpm run build`（esbuild） |
| **lib** | `lib` | 纯库插件（无 UI），`src/main.js` 注册方法供其他插件 `callPlugin`，`layers:["l3"]` | `pnpm run build`（esbuild） |
| **wasm** | `wasm` | L3 WASM 插件（Rust cdylib + `src/lib.rs`），`layers:["l3"]`、无 entry | `bash scripts/build.sh` / `pwsh scripts/build.ps1`（cargo build） |

生成后提示 `pnpm install`（wasm 为 `rustup target add wasm32-unknown-unknown`）。

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
qomicex pack                          # 有 package.json → pnpm run build；有 Cargo.toml → cargo build；无则跳过
qomicex pack --version 0.2.0          # 覆盖 manifest 版本号
qomicex pack --key ./dev-key.pem      # 附签名（仅 signature.json；完整证书链请用 publish）
qomicex pack --skip-build             # 跳过构建（复用现有 dist）
```
`.qplugin` = zip，`manifest.json` 在根 + `dist/**`（或 `plugin.wasm`）。构建自动检测：项目有 `package.json` 且含 `scripts.build` 时走 `pnpm run build`（react/html/lib）；有 `Cargo.toml` 时走 `scripts/build.sh` / `build.ps1`（wasm）；两者皆无则跳过（纯静态项目）。无 `dist/` 时回退收集 manifest 引用的根文件与 `plugin.wasm`。`entry.theme` / `contributes.overlay.file` 若引用 `dist/` 下文件但源码在根目录，会自动拷入。

### verify
```bash
qomicex verify                        # 目录模式：manifest + 权限 + 长循环
qomicex verify --package ./release/x.qplugin   # 包模式：manifest + 签名验签
```
- **manifest 合法性**：id（反向域名/安全字符）、name、version(semver)、minLauncherVersion、layers、permissions、entry、contributes。
- **权限最小化**：对比 `manifest.permissions` 与源码实际调用的桥方法（`METHOD_PERMISSIONS` 表）。声明未用 / 用了未声明都会报错。源码扫描：有 `src/` 时扫 `src/`（`dist/` 视为产物跳过）；无 `src/` 的纯静态/纯 html 插件也扫 `dist/` 与根目录 html，支持 `__PLUGIN_API__?.` 可选链写法。**L3 纯 wasm 插件**（layers 含 l3、无前端 entry、无 JS 源码）跳过 JS 权限扫描（`wasm:execute` 由网关消费）。
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

> 认证：无 `QOMICEX_API_KEY` 时优先用 `qomicex login` 持久化的会话（refresh token 30 天，经 `/auth/refresh` 旋转续期）免登录；失效才回退设备流。

### login / logout
```bash
qomicex login              # 设备流登录，会话持久化到 ~/.qomicex/auth.json（0600）
qomicex login --api http://127.0.0.1:8787/api/v1   # 指定商店
qomicex logout             # 清除本地会话
```
登录成功后 30 天内 `qomicex publish` 免重复授权（access token 15 分钟过期时自动用 refresh token 续期，旋转式）。会话按 store API base 区分。

### lint
```bash
qomicex lint               # manifest/权限/长循环 + 相对 import 扩展名 + 资源引用
qomicex lint --json        # 结构化输出（CI 消费：{ok, errors, warnings, findings}）
```
比 `verify` 更严的发布前静态门禁，额外检查：
- **相对 import 缺扩展名**：`import ... from './x'` 无扩展名且非目录 barrel → error（Vite 硬规则，见仓库 AGENTS.md）。
- **资源引用存在性**：`entry.frontend/theme/backend`、`contributes.overlay.file` 指向的文件不存在 → error（`dist/` 引用未构建时给 warning）。

### doctor
```bash
qomicex doctor             # 环境诊断（纯只读，零副作用）
qomicex doctor --json
```
逐项检查：Node ≥20、pnpm、插件项目 + manifest 合法性、`@qomicex/plugin-ui`、Vite、openssl + WebCrypto(Ed25519)、后端 `:5000`、插件商店可达、调试 harness 可定位。

### debug
```bash
qomicex debug                            # 启动启动器开放 CDP :9222 + 实时日志
qomicex debug --port 9223 --no-logs      # 指定 CDP 端口 / 仅 CDP 不要日志
qomicex debug --launcher ./dist/launcher.exe --no-kill
```
定位启动器（`--launcher` > `QOMICEX_LAUNCHER_PATH` > 仓库 `src-tauri/target/{release,debug}` > 安装路径），以 `--debug <port>` 参数启动。**启动器本身支持 `Qomicex Launcher.exe --debug <port>`**——第三方开发者无需 CLI/源码，直接命令行传参即可开放 CDP + 实时推送日志；**release 默认纯 IPC 不受影响**（仅显式传参才启用）：
- **Windows（WebView2）**：`--debug <port>` 设 `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=<port>` 开放 CDP；轮询 `/json/list` 打印 targets + DevTools 前端地址，可用 Playwright `connectOverCDP()` / Chrome DevTools 自动化。
- **Linux/macOS**：`--debug <port>` 设 `WEBKIT_INSPECTOR_SERVER` / `WEBKIT_INSPECTOR_HTTP_SERVER` 尽力支持（需应用启用 inspector）。
- **实时日志双通道**：① 启动器 stderr 实时推送（backend 日志 + 启动器日志，`stdio: inherit` 直接可见）；② tail `{BaseDir}/logs/qomicex-backend.log`（backend `FileLog` 逐行 flush 实时落盘，含 `[plugin:...]` / `[frontend:...]` trace 行）打印 `[trace] ...`。**均不依赖后端 TCP**，数据目录按 `QOMICEX_HOME` → `.qomicex-bootstrap` → 默认目录解析。
- `Ctrl+C` 停止并结束启动器子进程（`--no-kill` 保留）。

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
