# ADR-098：LittleSkin 改用 OAuth 设备代码流登录（issue #145）

| 属性 | 内容 |
|---|---|
| 状态 | 已采纳 |
| 日期 | 2026-10-03 |
| 决策者 | AI Agent |

## 背景

issue #145 要求 LittleSkin 支持通过 OAuth 获取访问 Yggdrasil API 的 Minecraft 令牌，默认首选 OAuth、密码登录为备选，且不影响原有密码功能。

现状：启动器 Yggdrasil 外置登录只有「邮箱 + 密码」路径（`endpoints/auth.rs` 的 `POST /api/auth/yggdrasil`，直连 `{base}/authserver/authenticate`），密码经启动器明文发往验证服务器。LittleSkin 已上线 Yggdrasil Connect / OAuth（官方手册《Yggdrasil Connect / 通过 OAuth 访问 Yggdrasil API》），支持设备代码流与授权代码流。

实测确认的关键事实（2026-10-02）：
1. **必须申请白名单**：`POST https://open.littleskin.cn/oauth/device_code` 用未注册或未加白名单的 client_id 一律返回 `400 {"error":"invalid_client","error_description":"Client was not found or not whitelisted"}`；响应头 `X-Cache-Status: MISS` + `X-Error-Info: Origin`，以时间戳击穿参数复测 3 次一致 → 服务端判定，非 CDN 缓存。发现文档 `https://open.littleskin.cn/.well-known/openid-configuration` 中**无 `shared_client_id`**，故无法复用公共应用 ID。
2. **设备流不需要 client_secret**：官方 token 端点请求体仅 `grant_type` + `client_id` + `device_code`（轮询）/ `refresh_token`（续期），符合 RFC 8628 公共客户端模型；`client_id` 依 RFC 6749 §2.2 为公开值，会出现在浏览器授权 URL 中。
3. **回调 URL 固定**：官方要求在应用管理页把回调 URL 设为 `https://open.littleskin.cn/oauth/callback`（指向 LittleSkin 自家授权页）。设备代码流不消费 `redirect_uri`——实测带/不带该参数的 `device_code` 响应逐字相同。该值仅出现在申请表单中，客户端代码永不使用。
4. **必须申请 `Yggdrasil.Server.Join`**：规范规定未申请该 scope 的令牌会被会话服务器拒绝，表现为「能登录但进不了服务器」。
5. **`PlayerProfiles.Read` 与 `PlayerProfiles.Select` 互斥**：同时申请在设备流中直接返回 `invalid_scope`。
6. **换取 MC 令牌**：`POST https://littleskin.cn/api/yggdrasil/authserver/oauth`（body `{"uuid":"<无符号 uuid>"}`，Bearer OAuth 令牌鉴权），响应与 Yggdrasil 登录 API **完全同构**（`accessToken` / `clientToken` / `availableProfiles` / `selectedProfile`）。
7. **角色列表**：`GET https://littleskin.cn/api/yggdrasil/sessionserver/session/minecraft/profile` + `Bearer <OAuth token>`（需 `PlayerProfiles.Read`）。
8. **现有启动链路可直接复用**：`resolve_auth_options`（`instance.rs:1692`）对 `login_method == "Yggdrasil"` 已使用 `server_url` + `access_token` + `--authlibInjector=`；只要把 OAuth 换出的 MC 令牌写进 `access_token`，启动、皮肤、披风、ALI 展示全部零改动。

范围决策（用户裁定）：**严格拆开** —— #145 只做 OAuth 登录；`appsettings.json` 重构（含 CurseForge key secret 化、`appsettings.example.json` 模板、`debug.yml` 本地配置）另开独立 issue。理由：CF key 的 secret 化在技术上正是 appsettings 重构的主干（`include_str!("../appsettings.json")` 为编译期展开，注入 secret 必须为该文件建立 CI 生成 + 本地 gitignore 机制），且牵动 7 处 CI 后端构建步骤；混入会让 #145 无法独立验收与回滚。

## 决策

采用「仅 LittleSkin 定制 + 设备代码流 + 应用内角色多选」，并在本单内一并实现 OAuth 刷新令牌自动续期。

**1) 新增 `endpoints/littleskin.rs` 三端点**（`endpoints/mod.rs` 注册 + `app.rs` merge）

- `POST /api/auth/littleskin/device-code` — 表单 POST `https://open.littleskin.cn/oauth/device_code`，`scope = openid offline_access Yggdrasil.PlayerProfiles.Read Yggdrasil.MinecraftToken.Create Yggdrasil.Server.Join`；返回 `deviceCode` / `userCode` / `verificationUri` / `verificationUriComplete` / `expiresIn` / `interval`。上游 `invalid_client` 映射为 `400 LITTLESKIN_OAUTH_NOT_WHITELISTED`（文案引导申请白名单）。
- `POST /api/auth/littleskin/poll` — 表单 POST `/oauth/token`（`grant_type=urn:ietf:params:oauth:grant-type:device_code`）；`authorization_pending` → 待授权、`slow_down` → 待授权并回传新 `interval`、`expired_token` / `access_denied` / `invalid_client` / `invalid_scope` → 错误码 + 描述。
- `POST /api/auth/littleskin/select` — 校验 `server_url` host 必须为 `littleskin.cn`（否则 400 `LITTLESKIN_ONLY`）；对每个选中角色 POST `/api/yggdrasil/authserver/oauth` 换取 MC 令牌；经 `AccountService` 落库。

**2) 角色选择放应用内**：使用 `Yggdrasil.PlayerProfiles.Read`（而非互斥的 `.Select`）→ 授权后用 OAuth 令牌调 profile 列表端点取全部角色，复用现有「选择角色」多选 UI，一次授权可建多个账户；因不申请 `Select`，**无需解析或校验 `id_token`**，规避 JWKS 签名验证（LittleSkin 可能使用 RS256/PS256/ES256/EdDSA）带来的复杂度与失败面。

**3) 账户模型**：**不新增 `login_method` 枚举值** —— 沿用 `"Yggdrasil"`，仅新增两个可选字段 `oauth_provider: Option<String>`（值 `"LittleSkin"`）与 `oauth_refresh_token: Option<String>`（均 `#[serde(default)]`）。效果：`skin.rs` / `connector.rs` / `resolve_auth_options` 的 `Yggdrasil` 既有分支**全部零改动**，启动链路零改动（`access_token` 即 MC 令牌），存量 `accounts.json` 无需迁移。

**4) 自动续期（本单内实现）**：新增 `refresh_account_token`，吸收现有 `refresh_microsoft_token` 并**复用同一把全局锁**（`MS_REFRESH_LOCK`，改名后语义不变），新增分支：`login_method == "Yggdrasil" && oauth_provider.is_some() && !oauth_refresh_token.is_empty()` → ① OAuth `refresh_token` 换新 access_token（**一次性且轮换，旧值立即失效，必须串行化**）→ ② 用新令牌换新 MC 令牌 → ③ 落库。失败分流沿用 ADR-048：`invalid_grant` / `invalid_client` / 401 → `TOKEN_EXPIRED`（前端既有 `MicrosoftReauthDialog` 重登引导自动生效）；传输层失败 → 503 `NETWORK_ERROR`。三处调用点（`instance.rs:628` / `connector.rs:667` / `skin.rs:760`）切换到新函数；`refresh_microsoft_token` 及其既有单测保留不动。

**5) client_id 配置**：`const LITTLESKIN_CLIENT_ID: &str = "1580";` 作为源码常量 + `LITTLESKIN_CLIENT_ID` 环境变量覆盖，对齐仓库既有的 `const YGGDRASIL_DEFAULT`（`auth.rs:23`）与 `MICROSOFT_CLIENT_ID` 覆盖模式。**完全不修改 `appsettings.json`**（服务端公开值，非机密，可入库）。

**6) 前端**：`Accounts.tsx` 的 Yggdrasil 标签页内新增「登录方式」分段切换（服务器为 LittleSkin 时显示，**默认 OAuth**）；OAuth 分支含状态步进、授权码展示与复制、自动打开 `verificationUriComplete`；**密码分支（现有表单）整体保留零改动**。授权成功后复用现有角色多选步骤，确认时改走 `/auth/littleskin/select`。复用现有 `MicrosoftStep` 联合类型与 `StatusDot`，不触碰微软流程任何代码。

**7) 白名单未生效期间的交付策略**：代码先行，白名单审批期间只验证不依赖授权的边界（`invalid_client` 透传、非 LittleSkin 服务器被拒、client_id 配置路径）；设备码全链路 E2E 明确挂起，待白名单生效后补测。**不得在未完成 E2E 的情况下宣称功能完成。**

## 备选方案

### 方案 授权代码流（Authorization Code Flow）
- 优点：官方推荐用于有后端服务器的场景；可拿 refresh_token 且无需用户手输授权码
- 缺点：LittleSkin 官方明确「尚未支持 PKCE」；无 PKCE 就必须内嵌 client_secret，而启动器是分发给用户的二进制，secret 必然泄露；`127.0.0.1` 回调需与注册的 redirect_uri 精确匹配，端口不固定即失败
- 为何不选：安全上不可行（secret 无法保密），且回调匹配脆弱。官方手册亦指明无后端/原生应用应使用设备代码流

### 方案 通用 Yggdrasil Connect 发现式适配
- 优点：从 `feature.openid_configuration_url` 自动发现 device/token/userinfo 端点，任何支持 Yggdrasil Connect 的验证服务器都可复用一套代码
- 缺点：每个验证服务器都需单独为 Qomicex 申请白名单（过程为人工邮件工单，约一周）；发现文档中无 `shared_client_id`，无法复用公共应用 ID；多站差异带来更大失败面与测试成本
- 为何不选：收益无法实现——没有公共 client_id，通用化后仍要逐站申请；退化为「多写代码但不多支持站点」。用户亦选择「仅 LittleSkin」

### 方案 网页端选角色（Yggdrasil.PlayerProfiles.Select）
- 优点：用户在自己浏览器里完成角色选择，启动器无需实现角色列表 UI
- 缺点：与 `PlayerProfiles.Read` 互斥（同时申请设备流直接 `invalid_scope`）；一次授权只能建一个账户；必须解析并校验 `id_token` 的 `selectedProfile` 声明，需处理 RS256/PS256/ES256/EdDSA 与 JWKS 轮换
- 为何不选：失去多账户一次授权能力，且引入 JWT 签名验证这一非必要复杂度。应用内多选可复用现有 UI 且无需解析 id_token

### 方案 在本单内顺带重构 appsettings.json（CF key secret 化）
- 优点：一次性解决密钥入库与死配置问题
- 缺点：`include_str!("../appsettings.json")` 是编译期展开，移除或改注入必须建立「CI 生成 + 本地 gitignore」机制，牵动 release.yml 6 处 + debug.yml 7 处后端构建步骤；与 OAuth 功能无技术耦合，混入后 #145 无法独立验收与回滚
- 为何不选：用户裁定严格拆开，另开独立 issue。该重构与 OAuth 无关，且会显著扩大 PR 范围与回归面

## 影响
- 新增 src-backend/qomicex-backend/src/endpoints/littleskin.rs；endpoints/mod.rs 增 `pub mod littleskin;`；app.rs 增 `.merge(endpoints::littleskin::router())`
- services/account.rs：StoredAccount / AccountInfo 各增 oauth_provider、oauth_refresh_token 两个 Option<String>（#[serde(default)]，存量 JSON 免迁移）
- endpoints/instance.rs：新增 refresh_account_token（吸收 refresh_microsoft_token 并复用同一全局锁，新增 Yggdrasil+OAuth 续期分支）
- 调用点切换：instance.rs:628、connector.rs:667、skin.rs:760 → refresh_account_token（refresh_microsoft_token 及其单测保留）
- 前端：src/pages/Accounts.tsx（Yggdrasil 标签页内新增登录方式切换 + OAuth 分支）、src/api/account.ts（3 个 wrapper）、src/types/index.ts（Account 增 2 个可选字段）
- i18n submodule qomicex-tauri-i18n：7 语言 accounts.ts 全部新增 accounts.ygg.oauth* key（zh-CN 为 schema 基准，漏一个即编译失败），需在 i18n 仓库单独提交推送
- 新增文档：ADR-098；2-架构设计/LittleSkin-OAuth-登录接入方案.md；更新 2-架构设计/账号管理流程.md 与 3-API规范/API列表.md
- 明确不改动：appsettings.json、login_method 取值、refresh_microsoft_token、微软登录流程代码
- 另开独立 issue（不在本 PR）：appsettings.json 重构——删除 5 项死配置（Logging / AllowedHosts / Kestrel / AppConfig / Connector:RelayApi，Rust 引用数均为 0）、CurseForge:ApiKey 与 Microsoft:ClientId 改 secret 注入、提交 appsettings.example.json + 本地文件 gitignore、debug.yml 同步注入、修正 state.rs 中「仓库默认值是占位符」的错误注释（实测该 key 被 CurseForge 接受，HTTP 200）
- 已知安全遗留（超出本单范围，用户裁定只轮换不清历史）：CurseForge:ApiKey 曾以明文存在于公开仓库 git 历史（自 67f5301 起）并随 release 分发。2026-10-02 复测该 key 仍返回 HTTP 200（对照组 bogus 为 403），即轮换尚未生效，需持续跟进
- 受限项：设备码全链路 E2E 依赖 LittleSkin 白名单审批（client_id 1580 当前实测仍为 invalid_client），首次审批为测试模式仅应用创建者可授权，投产前需再发工单解除

## 修订记录
| 日期 | 版本 | 修改内容 | 修改人 |
|---|---|---|---|
| 2026-10-03 | v1.0 | 初版创建 | AI Agent |