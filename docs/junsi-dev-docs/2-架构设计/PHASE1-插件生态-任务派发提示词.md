# PHASE1 插件生态 — 任务派发提示词包

> 来源：`docs/junsi-dev-docs/2-架构设计/插件生态技术提案.md` + ADR-049
> 用途：以下每份提示词**自包含**，可直接复制粘贴给任何能读写本仓库的 AI agent（Cursor / Claude / opencode 子代理等）。
> 通用约束（所有任务都遵守，已内嵌在每份里）：
> - 语言中文交流；文件编码 UTF-8
> - 前端 TS/TSX 本地 import 必须带文件扩展名（`.ts`/`.tsx`），否则 Vite 报错
> - 修改 `src-backend/qomicex-backend/` 或 `src-tauri/` 下 `.rs` 后必须跑 `cargo fmt --manifest-path src-backend/qomicex-backend/Cargo.toml`
> - 包管理器用 pnpm；改完 `packages/plugin-ui/src/` 必须重建 `pnpm --filter @qomicex/plugin-ui build`
> - 不改 AGENTS.md、不提交 git（除非明确要求）

---

## 任务 ① 插件默认渲染切到 iframe(l2)

**前置依赖**：无（可最先开工）

**背景**：当前插件默认走内联渲染（`renderInline`，`src/plugins/sandbox.ts:212`），插件 JS 与启动器共享同一 WebView2 renderer 主线程 —— 一个 `while(true)` 长循环就会冻死整个启动器。提案要求：**UI 插件一律默认 iframe 沙箱**，内联降为显式 opt-in。

**现状代码**（先通读再动手）：
- `src/plugins/types.ts`：`PluginLayer = 'l0' | 'l1' | 'l2' | 'l3'`，`layers` 决定渲染方式
- `src/plugins/sandbox.ts`：`createSandbox`(l2 iframe, `:169`) / `renderInline`(内联, `:212`) / `apiBridgeScript` + `sourceMap`(postMessage 桥) / `METHOD_PERMISSIONS`(`:399`)
- `src/plugins/plugin-loader.tsx`：`activatePlugin`(`:57`) 决定走哪条渲染路径
- `src/pages/PluginPage.tsx`：`/plugins/p/:pluginId` 页挂载容器

**目标**：
1. 无 `l2` 但有前端入口（`entry.frontend`）的插件，**默认走 `createSandbox`**；仅声明 `l0`/`l1`（纯 CSS/主题类）的插件保持 CSS 注入即可
2. 保留 `renderInline`，仅在 manifest 显式要求（如新增 `"render": "inline"` 或既有约定）时使用
3. 确保 iframe 桥（postMessage → `sourceMap` → `executePluginMethod` → 权限校验）在切换后完整可用，覆盖现有所有 API（callBackend/proxyFetchStream/overlay/download/modpack.install 等）

**验收标准**：
- `pnpm run build`（tsc strict + vite）通过
- 用 `docs/junsi-dev-docs/2-架构设计/前端浏览器调试-Playwright-Tauri-mock注入.md` 的 mock 法起浏览器，验证带 `entry.frontend` 的插件挂载在 `<iframe sandbox="allow-scripts">` 内、桥方法可调用
- 构造一个 `setTimeout 循环/同步长循环` 的测试插件，确认主 UI 不冻结（iframe 外页面可交互）
- 纯 CSS 插件（l0/l1，无 frontend）行为不回归

**红线**：不引入新依赖；不改权限模型；不破坏 L3 WASM 路径。

**完成清单**：
- [ ] `plugin-loader.tsx` 默认路径切到 iframe
- [ ] 内联降为 opt-in，旧插件兼容
- [ ] 桥全量 API 在 iframe 下回归通过
- [ ] build + harness 验证通过，写出验证记录

---

## 任务 ② 主题语义 token 规范 v1 + 主题管理器 + .qtheme 解析（颜色主题）

**前置依赖**：无（可与 ① 并行；涉及 plugin-ui 重建）

**背景**：现状 token 平铺（`--primary`/`--accent-foreground`，`src/index.css`），无语义分层，`theme.css` 裸全局注入。提案要求升级为 **primitive → semantic → component 三级**，语义 token 点分命名（`foreground.accent`/`background.emphasis` 等），主题包用 `.qtheme` 格式，plugin-ui 组件只消费 `var(--*)` 实现即时换肤。

**现状代码**：
- `src/index.css`：`:root`/`.light`/`data-theme="latte|frappe|macchiato|mocha"` 的 HSL 变量表
- `tailwind.config.js` + `packages/plugin-ui/src/tailwind-preset.ts`：颜色全部映射为 `hsl(var(--...))` —— 已是 var() 消费，审计是否全量
- `packages/plugin-ui/src/components/*`：需审计有无内联色值（本任务不重建组件，仅审计 + 文档）
- 既有主题决策：ADR-033（自定义主题色 Accent）、ADR-034（主色跟随背景）、ADR-035/036（毛玻璃 glass blur）、ADR-018（自定义字体 fontdb）

**目标**：
1. 产出**三级语义 token 规范文档**（落 `docs/junsi-dev-docs/6-UI/组件设计/` 或 `2-架构设计/`）：色板 token（foreground.* / background.* / border.* / accent.* / status.*）+ 非色 token（radius/space/font/motion/shadow/glass），点分命名，附默认值表
2. 实现 **`.qtheme` 解析器**（v1 先做颜色主题 + 可选 `theme.css` 命名空间注入；`theme.mjs` 计算层标 TODO 不实现）：读 `theme.json`（schema 用 zod 校验）→ 产出 CSS 变量写入 `:root`/`data-theme`
3. **主题管理器**（`src/` 下，建议 `src/theme/`）：加载/切换/持久化主题；提供 `useTheme()` 给前端；事件驱动全组件换肤
4. 审计 `packages/plugin-ui/src/components/` 是否全部仅 `var()` 消费，输出审计结果

**验收标准**：
- 切换一个自定义 `.qtheme` 颜色主题，启动器 + 插件 UI 全部即时换肤，**无需重建 plugin-ui dist**
- 用既有 Catppuccin 预设迁移到新 token 命名，视觉无回归
- 非法 theme.json 被 zod 拒绝并给友好错误
- `pnpm run build` 通过；`pnpm --filter @qomicex/plugin-ui build` 通过

**红线**：不引入新依赖；不改组件视觉（仅审计）；不破坏 light/dark/跟随背景等既有行为。

**完成清单**：
- [ ] token 规范文档落地
- [ ] `.qtheme` 解析器 + schema 校验
- [ ] 主题管理器 + 持久化 + useTheme
- [ ] plugin-ui 组件 var() 审计
- [ ] build + 视觉回归通过

---

## 任务 ③ 插件包签名验证（Ed25519 信任链）

**前置依赖**：商店与本仓库都要改（store 仓库在 `D:\QML\qomicex-plugin-store`，独立 git repo）

**背景**：当前 `.qplugin` 上传无签名，供应链投毒风险（社区上传即触发）。提案：**商店根钥签发开发者公钥 → 开发者密钥签每个 release**，包内 `signature.json`，启动器安装/更新时验签。

**现状代码**：
- store：`D:\QML\qomicex-plugin-store\src\lib\qplugin.ts`（zip-slip 校验已有）、`src\plugins.ts`（`POST /:id/versions` 上传版本）、`src\lib\manifest.ts`、`migrations/`（新增表沿用 `NNNN_*.sql` 惯例）、schema 在 `schema.sql`
- launcher 后端：`src-backend/qomicex-backend/src/endpoints/plugin.rs`（`POST /plugins/install`、`/plugins/upload`）、`services/plugin.rs`
- 前端：`src/api/plugins.ts`（`fetchPlugins`/`setPluginState` 等）

**目标**：
1. **store 端**：新 migration 建 `developer_keys` 表（developer 公钥 + 状态 + GitHub org 关联）；开发者可上传公钥（生成密钥对可在 CLI 任务 ⑤ 做，本任务提供 API）；`POST /:id/versions` 上传时校验 `signature.json`（验开发者密钥签名）并校验 signedHash = 规范化 manifest+文件清单的 SHA-256
2. **launcher 后端**：安装/上传插件时做 Ed25519 验签（用 Rust `ed25519-dalek` 或现有依赖；信任源：商店根钥（内置/首次拉取缓存）+ 开发者公钥），验签失败拒绝安装并给明确错误码
3. **签名格式**：`signature.json = { alg, signedHash, signerKeyId, signature }`，规范化 JSON（键序/无空白）保证可复现哈希

**验收标准**：
- store：带有效签名 → 上传成功；篡改包体 → 校验失败拒绝；`pnpm test`（vitest）全绿
- launcher：`cargo test` 通过；手工构造带/不带签名的 `.qplugin`，`/api/plugins/upload` 行为正确（签名缺失 → 拒绝，错误码清晰）
- 两端 Rust 改完都跑 `cargo fmt`

**红线**：私钥绝不出现在代码/仓库/日志；不破坏现有上传兼容（v1 无签名插件给出降级策略：默认拒收新上传，老版本不强制重签——策略写进文档）。

**完成清单**：
- [ ] store migration + developer_keys 表
- [ ] store 上传验签 + signedHash 规范化
- [ ] launcher 安装验签 + 错误码
- [ ] store vitest + launcher cargo test 通过
- [ ] 兼容/降级策略文档

---

## 任务 ④ 插件更新轮询 + /check-updates 消费端

**前置依赖**：store 已提供 `POST /api/v1/check-updates`（`D:\QML\qomicex-plugin-store\src\plugins.ts:519`）；本任务两端都要改

**背景**：提案要求启动器新增**更新轮询**（拉 `/check-updates`，按 launcher 版本 + 插件版本缓存，提示升级）+ 预留灰度（`rolloutPercent`，本任务先落地轮询与提示，灰度 UI 标 TODO）。

**现状代码**：
- store：`src\updates.ts` + `src\plugins.ts` `handleCheckUpdates` —— 已是 `POST /check-updates`，确认其请求/响应结构（输入应为已安装插件清单+launcher 版本，输出应为可升级列表）
- launcher 前端：`src/api/pluginStore.ts`（`/store` 前缀，可能经后端代理）—— 确认 check-updates 走哪个通道（Vite proxy 或后端 proxy）；`src/api/update.ts` 是启动器自身更新，勿混淆
- launcher 后端：`endpoints/plugin.rs` 有 `/plugins/proxy`（`stream:true` 转发）可复用做 store 代理

**目标**：
1. 确认 `handleCheckUpdates` 契约（必要时微调 store 返回 `minLauncherVersion` 过滤、每版本 `sha256`、可选 `rolloutPercent` 字段——默认 100）
2. launcher 前端新增**插件更新检查**：启动后静默拉一次 + 手动刷新入口（可放插件页/市场页）；有可升级项时 toast + 列表 badge
3. 更新流程复用现有安装管线（`POST /api/plugins/install` + 保留上一版本快照目录 `plugins/{id}.bak-{version}` 用于回滚）
4. 灰度字段：若返回 `rolloutPercent < 100`，按客户端随机值决定是否展示升级（不做则标 TODO 后置）

**验收标准**：
- 本地起 store（`pnpm dev`）构造一个更新版本 → launcher 轮询到并提示、可升级、成功后旧版本快照存在
- 无更新时静默、零报错
- `pnpm run build` 通过；store `pnpm test` 通过

**红线**：不阻塞启动流程（更新检查异步静默）；不自动静默升级（需用户确认）；不破坏 `src/api/update.ts`（启动器自身更新）。

**完成清单**：
- [ ] check-updates 契约确认/微调
- [ ] launcher 更新轮询 + 提示 + 升级 + 回滚快照
- [ ] 灰度字段预留
- [ ] 端到端验证记录

---

## 任务 ⑤ qomicex CLI 脚手架（create/dev/pack/verify/publish）

**前置依赖**：最好等 ①（iframe 默认）、②（token 规范）定稿后做 verify 规则；模板参考 `plugins-dev/hello-plugin` 与 `plugins-dev/Qomicex.Plugin-Market`

**背景**：提案要求 CLI：`create <id>`（Vite+React+TS+plugin-ui+tailwind preset）、`dev`（热重载，配合任务⑥ harness）、`pack`（build → .qplugin）、`verify`（manifest/schema + 权限最小化 + 主线程长循环告警 + 签名检查）、`publish`（RFC8628 设备流上传到 store）。

**现状代码**：
- 模板参考：`plugins-dev/hello-plugin`（最小）、`plugins-dev/Qomicex.Plugin-Market`（完整，含 `package.json` 引用 `@qomicex/plugin-ui` + `scripts/build.sh` 打包 .qplugin）
- store 已支持设备流登录（RFC8628，`D:\QML\qomicex-plugin-store` 的 `src/auth.ts`/`src/lib/account.ts`）—— publish 用它拿 token 再调上传 API
- manifest schema/权限目录：`src/plugins/types.ts` + `src-backend/qomicex-backend/src/services/plugin.rs` + store `PERMISSION_CATALOG`

**目标**：
1. 新建 CLI 包（放 `packages/qomicex-cli/` 或独立 repo，与用户确认——默认 `packages/qomicex-cli`，Node + TS，pnpm workspace 成员）
2. `create`：从 hello-plugin 模板拷贝生成合法项目（manifest 含 schemaVersion、layers、permissions 最小集）
3. `pack`：`tsc && vite build` → 打 zip（manifest.json 在根）→ `.qplugin`
4. `verify`：本地校验 manifest 合法性（zod schema）+ 权限仅声明用到的 + 静态检测 `while(true)`/`setInterval` 长循环（AST 扫描，简单启发式即可）+ 调用 `POST /api/plugins/upload` 前的签名检查（任务③ 的签名规则）
5. `publish`：设备流登录 → 拿 token → 调 store 上传
6. `dev`：起本地 dev server + 生成指向 localhost 的"dev 源插件"配置（配合任务⑥）

**验收标准**：
- `qomicex create com.example.x` 生成的项目 `pnpm install && pnpm run build` 通过
- `qomicex pack` 产出可被 launcher `POST /api/plugins/upload` 接收的 `.qplugin`
- `qomicex verify` 能拦下：坏 manifest、权限滥用、明显长循环
- CLI 本身 `tsc --noEmit` 通过

**红线**：不引入重型脚手架（create 用模板拷贝，不用 yeoman 等）；不改 store 上传接口（除非必要）；发布命令需用户显式确认。

**完成清单**：
- [ ] CLI 包骨架 + create/pack/verify/publish/dev
- [ ] 模板 + 权限最小化规则
- [ ] publish 设备流对接
- [ ] 端到端验证记录

---

## 任务 ⑥ 插件调试 harness（Playwright + Tauri mock 注入 + 热重载）

**前置依赖**：无（可与 ① 并行；① 完成后 harness 可升级验证 iframe）

**背景**：提案要求插件开发者**无需重启启动器**即可调试插件逻辑。复用已有 `docs/junsi-dev-docs/2-架构设计/前端浏览器调试-Playwright-Tauri-mock注入.md`（Tauri API mock 注入法）。

**现状代码**：
- 已有文档：`docs/junsi-dev-docs/2-架构设计/前端浏览器调试-Playwright-Tauri-mock注入.md`（mock 写法、`addInitScript` 注入 `window.__TAURI_INTERNALS__`、挂载等待方法）
- 插件桥实现：`src/plugins/plugin-api.ts`（`createPluginBridge`）、`src/plugins/sandbox.ts`（桥注入脚本）
- 后端 stub 需求：插件 API（`callBackend`/`proxyFetch`/`download.*`/`modpack.install` 等）在纯浏览器下无后端 —— 需 mock 服务

**目标**：
1. 提供 **harness 启动器**（脚本或小包，放 `scripts/` 或 `packages/qomicex-cli` 内，与任务⑤共享）：Playwright 起 Vite dev(:1420) → `addInitScript` 注入 Tauri mock → 打开插件页
2. **后端 stub**：一个本地 mock server（如 Node http / 简单 express-free 实现）模拟插件依赖的 `/api/plugins/*` 等接口，返回可配置假数据；`__PLUGIN_API__` 完整 mock（getSettings/setSettings/callBackend/proxyFetch/download.*/overlay.*/modpack.install）
3. **热重载**：监听插件源码 → 重建 → 向页面发 `__qomicex_reload`（iframe 重载）或 Vite HMR；不触碰启动器其他状态
4. 配套使用文档：怎么跑、怎么 mock 数据、怎么断点调试

**验收标准**：
- 不启动 Tauri、不启动 Rust 后端，纯浏览器跑起一个示例插件并能调用 mock API
- 改插件源码保存 → 页面自动更新（热重载生效）
- 覆盖 `overlay` iframe 场景（插件 overlay 也能在 harness 中打开）
- `pnpm run build` 不受影响

**红线**：harness 只读/沙箱调试，禁止触发真实写数据、启动实例、真实下载；用后停 server。

**完成清单**：
- [ ] harness 启动器 + Tauri mock 注入
- [ ] 后端 stub + __PLUGIN_API__ mock
- [ ] 热重载
- [ ] 使用文档 + 验证记录

---

## 派发顺序建议

| 顺序 | 任务 | 理由 |
|---|---|---|
| 第 1 批（并行） | ① iframe 默认化、⑥ harness、② token 规范 | 互不依赖，都是地基；⑥ 可为①提供验证手段 |
| 第 2 批 | ③ 签名验证（store+launcher） | 需上游 ① 无关，独立；store 端可先动 |
| 第 3 批 | ④ 更新轮询 | 依赖 store check-updates 契约，可与③并行排期 |
| 第 4 批 | ⑤ CLI | 依赖①/②的 verify 规则 + ⑥的 dev 对接，最后收口 |

冲突提示：① 与 ⑥ 都改 `src/plugins/sandbox.ts`/`plugin-loader.tsx` 附近逻辑 —— 若并行，建议 ⑥ 先只做 harness 层（不动渲染路径），渲染默认切换归 ①；或串行。任务③④⑤ 与前端 `src/api/*` 有小范围交集（plugins.ts），注意 git 合并。
