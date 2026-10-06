# AGENTS.md

本文件是 AI 代理在本仓库工作的**唯一入口**。所有 AI 工具（Cursor、Claude Code、Copilot、opencode 等）必须遵守本文件及下列文件：

- [`rules/AI_CONSTITUTION.md`](rules/AI_CONSTITUTION.md) — AI 宪法（硬规则）
- [`AI_POLICY.md`](AI_POLICY.md) — AI 使用政策（披露、责任）
- [`CONTRIBUTING.md`](CONTRIBUTING.md) — 贡献指南（提交信息、注释、PR）

冲突时优先级：`AI_CONSTITUTION.md` > `AI_POLICY.md` > `CONTRIBUTING.md` > 本文件。

---

## 0. 核心规则

1. **你必须理解你的代码。** 无法解释的改动不要提交。
2. **默认最小改动。** 不顺手重构、不格式化无关文件、不改公共 API。
3. **注释默认不写。** 只解释非显然的 why、约束、坑。
4. **提交信息只写工程事实**：标题、根因、方案、验证、风险、refs。
5. **不得声称运行过未运行的命令。** 测试结果必须来自真实执行。
6. **AI 使用必须披露**（见 PR 模板）。
7. 禁止生成 emoji、夸赞、免责声明、AI 对话残留、自我评价。

禁止出现在提交信息 / 注释中：`修法一/修法二`、`方案一/方案二`、`CodeRabbit`、`评审过程`、`worktree`、`子模块 pin`、`AI 对话`、`本 PR 不再`。

---

## 1. 项目概览

Qomicex Launcher — Minecraft 启动器。

| 层 | 技术 | 目录 | 端口 |
|---|---|---|---|
| 桌面外壳 | Tauri v2 (Rust) | `src-tauri/` | — |
| 前端 | React 19 + Vite 7 + TS + Tailwind | `src/` | 1420 |
| 后端 API | Rust (axum + tokio) | `src-backend/qomicex-backend/` | 5000 |
| UI 组件库 | workspace 包 `@qomicex/plugin-ui` | `packages/plugin-ui/` | — |

前端 `/api/*` 代理到 `http://localhost:5000`；后端绑定 `127.0.0.1:5000`，`QOMICEX_PORT` 覆盖。前端 `src/api/client.ts` 也直连 `:5000`，代理是 fallback。

Submodule（recursive）：`qomicex-core-rust/`、`qomicex-downloader-rust/`、`qomicex-connector-rust/`、`qomicex-tauri-i18n/`、`Qomicex.Updater/`。Legacy 在 `legacy` 分支。

`src-backend/Qomicex.Launcher.Backend.Neo/` 是 **gitignored 本地残留**（含 NTFS 保留名），不要当代码。

---

## 2. 必跑命令

### 前端

```bash
pnpm install --frozen-lockfile
pnpm --filter @qomicex/plugin-ui build   # dist/ gitignored，改 plugin-ui 后必跑
pnpm run typecheck
pnpm run lint
pnpm run format:check
pnpm run build
pnpm run dev          # :1420
pnpm run tauri dev
```

### 后端

```bash
cargo run --manifest-path src-backend/qomicex-backend/Cargo.toml
cargo run --manifest-path src-backend/qomicex-backend/Cargo.toml --features license-required
cargo fmt --manifest-path src-backend/qomicex-backend/Cargo.toml
cargo clippy --manifest-path src-backend/qomicex-backend/Cargo.toml --no-deps -- -D warnings
cargo test --manifest-path src-backend/qomicex-backend/Cargo.toml
```

### Tauri

```bash
cargo fmt --manifest-path src-tauri/Cargo.toml
cd src-tauri && cargo test --lib plugin_gateway
```

**Rust 工具链被 `rust-toolchain.toml` 钉在 1.95.0**，不要改成 `stable`。

仓库是 **pnpm-managed**（`pnpm-lock.yaml` + `workspace:*`）。`package-lock.json` 已过期，npm **不支持** `workspace:*`。只用 pnpm。

---

## 3. 提交信息

Conventional Commits：

```
<type>(<scope>): <summary>

<root cause>

<approach>

<verification>

<refs>
```

- type：`feat` `fix` `build` `chore` `ci` `docs` `perf` `refactor` `revert` `style` `test`
- summary：祈使句、小写、无句号
- 正文只写：根因、方案、验证、风险、refs
- 验证写实际命令与结果，不写过程叙事
- `BREAKING CHANGE:` 放 footer，或 type/scope 后加 `!`

参考：

```text
fix(resource): 补全 Technic 列表元数据并在切片前排序

Technic 列表接口只返回 id/name/slug/url/iconUrl，导致简介、作者、
下载数为空。现对候选集并发拉取详情补全，按 slug 缓存 1 小时；
单条失败降级为列表数据，不用空值覆盖已有值。

聚合搜索原先先切片再补全，补全后 download_count 变化会导致分页
边界漂移。现改为先补全完整候选集，按 download_count 降序、同值
按 id 排序，再切片。

验证：cargo test --bin qomicex-backend；cargo fmt --check。

Refs: #197
```

---

## 4. 注释

默认不写。只有以下情况写：

- 非显然的业务约束
- 外部接口 / 上游数据的坑
- 兼容性、安全性、性能陷阱
- 为什么不能采用更直观的写法

禁止：变更日志式注释、评审记录、PR 讨论、AI 对话残留、解释显而易见的事。

TODO 必须带 issue：

```rust
// TODO(#123): 上游修复后移除兼容分支
```

---

## 5. 项目关键约定

### Import 规则（关键）

本地 TS/TSX import **必须带扩展名**：

```ts
import { foo } from './bar.ts'   // 正确
import { x } from './baz'        // 错误 — Vite 会报错
```

例外：目录 barrel（如 `src/components/ui`）可省略。

### plugin-ui

`@qomicex/plugin-ui` 解析到 `packages/plugin-ui/dist/index.js`。改 `packages/plugin-ui/src/` 后必须重建，否则启动器用旧 `dist/`。`tailwind.config.js` 同时扫描 `src` 与 `dist`。

### 前端约定

- `cn()` from `@qomicex/plugin-ui`（经 `src/components/ui/index.ts` re-export）
- Dark mode：CSS 变量 + `darkMode: "class"`
- Strict TS：`noUnusedLocals` / `noUnusedParameters` / `strict: true`
- 内部导航用 `<Link>`，不用 `<a>`（`<a>` 会重载页面、丢持久状态）
- UI 组件在 `packages/plugin-ui/src/components/`，`src/components/ui/` 只是 re-export barrel
- 图标按钮必须 `Tooltip`；`Select` 用 `Select`/`SelectOption`，不用原生 `<select>`
- 图标↔图标切换用 `MorphIcon`；copy 反馈用 `CopyActionIcon`；异步操作用 `MorphActionIcon`。禁止手写 ternary 切换
- 路由：`BrowserRouter` → `MessageBoxProvider` → `Layout.tsx` → 12 条路由；`SplashScreen` 轮询 `/api/health` 成功后渲染

### 后端约定

- 端点模块在 `src-backend/qomicex-backend/src/endpoints/`，路由在 `app.rs` `build_router` 组装
- 错误统一走 `ApiError`，返回 `ApiResult<T>`。不要 ad-hoc 包装
- 数据目录解析：`QOMICEX_HOME` → `.qomicex-bootstrap` → `{LocalAppData}/qomicex-launcher`
- `appsettings.json` 不入库，由 `build.rs` 生成；环境变量 `CURSEFORGE_API_KEY` / `MICROSOFT_CLIENT_ID` 非空时生效
- dev 凭据用 `.env.local`（debug-only，`src/dev_env.rs` 加载，不触发 `build.rs` 重编）
- 无 OpenAPI 端点（C# 的 `/openapi/v1.json` 已移除）

### 跨平台

Windows / Linux / macOS 都要支持。

- Rust：用 `PathBuf`/`Path::join`，不用硬编码盘符或 `\\`
- 平台守卫用 `#[cfg(windows)]` / `#[cfg(unix)]`，不用 `cfg(not(windows))`
- 前端路径归一化：`.replace(/\\/g, '/')`
- 写二进制后设 `0o755` 权限
- 文件选择器：Windows `['exe']`，其他 `['*']`

### 路径系统（关键）

- `GameDir` = `.minecraft` 根
- `VersionDir` = `GameDir/versions/{VersionDirName}/`
- `VersionDirName` = `{GameVersion}-{Loader}-{LoaderVersion}`（如 `1.20.1-Forge-47.1.0`）
- 隔离目录（`mods` / `saves` / `resourcepacks` / `shaderpacks` / `screenshots` / `datapacks` / `crash-reports` / `servers.dat`）在 `GameDir/versions/{inst.Name}/`
- 共享目录（`versions` / `assets` / `libraries` / `logs` / `temp`）在 GameDir 根
- 路径构造基座永远是 `inst.GameDir`，版本参数用 `inst.Name`

### 错误处理

后端：`ApiError` → `{code, message, detail, traceId, timestamp, status}`。用 `ApiError::bad_request` / `not_found` / `forbidden` / `upstream` / `internal` 构造器。`From<std::io::Error>`：`NotFound`→404、`PermissionDenied`→403、其他→500。

前端：`ApiError` from `src/api/client.ts`，有 `.code` / `.status` / `.detail` / `.traceId` / `.displayMessage`。

---

## 6. 已知坑

- **连接器构建**：`.cargo/config.toml` 提供 `PROTOC` / `VC_LTL` / `YY_THUNKS`（本机路径，换机器需调）；easytier 按相对路径找 `Packet.lib`，已复制到后端 crate；CI 用 `.github/actions/setup-connector-build/`
- **运行后端需要 `Packet.dll`**（npcap，connector-rust 的 `easytier/third_party/`），缺失 → `0xC0000135`
- **TUN 需要 `wintun.dll`**（缺失仅 TUN 不可用，不崩）；非管理员自动回退 no-tun
- **架构不匹配 DLL** → `0xC000007B`
- **easytier smoltcp 不支持 127.0.0.1 回环**，联机需两台真机
- **connector 只提供协议/接口，不内置业务**；踢人等业务在 backend（`services/kick.rs`）
- **`src-backend/Qomicex.Launcher.Backend.Neo/`** 是 gitignored 本地残留，含 NTFS 保留名，递归扫描会 ENOENT。`.gitignore` / `eslint.config.js` / `.prettierignore` 都要排除
- **CI 调 tauri CLI 必须 `pnpm exec tauri build`**，不要 `pnpm run tauri -- build`（pnpm 对 `--` 剥离行为随版本而变）
- **交叉编译作业额外 `rustup target add <triple>`**（`rust-toolchain.toml` 钉 1.95.0，`dtolnay/rust-toolchain@stable` 只装到 stable）
- **Mac Create DMG 必须给 `hdiutil create` 显式 `-size`**（×1.3 + 64MiB），否则 `No space left on device`
- **Vite dev 里前端不能直接挂载**（`TitleBar.tsx` 顶层调 `getCurrentWindow()`），需 Playwright 注入 Tauri mock，见 `docs/junsi-dev-docs/2-架构设计/前端浏览器调试-Playwright-Tauri-mock注入.md`
- **join/host 超时**：前端 120s，后端 `run_with_connector_timeout` 75s → `CONNECTOR_JOIN_TIMEOUT` / `CONNECTOR_HOST_TIMEOUT`

---

## 7. 文档（docs/）

- **ADR 索引**：`docs/junsi-dev-docs/README.md`；编号由**文件名**承载，正文首行标题须与文件名一致；新增从 **086** 起（015/085 已占，084 扫描缓存、085 更新通道）
- **`4-编码规范/CSharp-规范.md` 已废止**（后端已重写为 Rust，仓库内无 `.cs`）
- **`2-架构设计/技术选型.md`**：顶部是当前栈，`### 2026-08-09 更新` 是历史快照，改技术栈只改顶部
- **Issue 模板字段名**改动前必读 `docs/junsi-dev-docs/8-部署运维/GitHub-Issue-模板与自动分类.md`（`issue-triage.yml` 是精确字符串匹配，改字段名会静默失效）
- **图标切换映射**：`docs/junsi-dev-docs/6-UI/组件设计/MAPPING_TABLE-icon-ternary-to-MorphIcon.yaml`

---

## 8. 工具链现状（基线）

- **Clippy 存量**：后端 138、Tauri 11（2026-09 基线，1.95.0）。CI advisory（`continue-on-error`），清到 0 后改阻断
- **ESLint 存量**：63 error / 116 warning。清理期间不进 CI 阻断
- **Prettier**：仓库尚未全量格式化（`src/` 172/181 不符）。**不要顺手 `pnpm run format`**，格式化必须是一次独立的 `style:` 提交，全量重排单独排期
- **无前端单测框架**：`playwright` 仅用于 `scripts/harness/`
- **hook 历史写法**：`src/pages/Settings.tsx:523,568` 与 `src/plugins/plugin-loader.tsx:152` 存在 hook 在非组件函数里调用，属阶段 3 待修项

---

## 9. 常见任务

### 添加后端端点

1. 在 `src-backend/qomicex-backend/src/endpoints/` 新建模块
2. 在 `app.rs` 的 `build_router` 注册
3. 错误用 `ApiError`，返回 `ApiResult<T>`
4. 跑 `cargo fmt` + `cargo clippy --no-deps -- -D warnings` + `cargo test`

### 添加/修改 UI 组件

1. 改 `packages/plugin-ui/src/components/`
2. 重建：`pnpm --filter @qomicex/plugin-ui build`
3. `src/components/ui/` 只做 re-export

### 修改翻译

1. 改 submodule `qomicex-tauri-i18n/src/zh-CN/` 或 `src/en/`
2. 在 i18n 仓库单独提交推送
3. `git submodule update --remote` 拉最新
4. **不要**在 `src/i18n/` 下建 zh-CN/en 目录

### 修改连接器

先问：这是协议/接口还是业务功能？协议/接口放 connector，业务放 backend。

### 修改 WASM 插件 fixture

```bash
rustup target add wasm32-unknown-unknown
cd src-tauri/tests/fixtures/dev-test-wasm-src
cargo build --release --target wasm32-unknown-unknown
cp target/wasm32-unknown-unknown/release/dev_test_wasm.wasm ../dev.test.wasm/plugin.wasm
```

---

## 10. 禁止事项

- 提交无法解释的代码
- 伪造测试结果、命令输出、issue / PR 引用
- 泄露密钥、令牌、私有数据、用户数据
- 大规模无意义重构、格式化无关文件
- 生成垃圾注释、过程叙事、emoji、自夸、免责声明
- 在提交信息中写 AI 对话、评审元信息、临时环境细节
- 顺手 `pnpm run format`（格式化必须独立提交）
- 在 CI 里写 `pnpm run tauri -- build`（必须 `pnpm exec tauri build`）
- 把 `src-backend/Qomicex.Launcher.Backend.Neo/` 当代码
- 假设 Windows-only（三平台都要支持）
- 在 `src/i18n/` 下建 zh-CN/en 目录（翻译改 submodule）
- 用原生 `<a>` 做内部导航、用原生 `<select>`、手写 icon ternary
