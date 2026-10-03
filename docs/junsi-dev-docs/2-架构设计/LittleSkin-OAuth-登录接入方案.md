# LittleSkin OAuth 登录接入方案

> 生成时间：2026-10-03 01:43

# LittleSkin OAuth 登录接入方案（issue #145）

> 生成日期：2026-10-02 ｜ 关联：[ADR-098](../1-决策记录/ADR-098-LittleSkin-改用-OAuth-设备代码流登录-issue-145.md)

## 1. 目标与范围

让启动器通过 **OAuth 设备代码流（Device Authorization Grant，RFC 8628）** 登录 LittleSkin，
默认首选 OAuth、密码登录降为备选，且**完全不影响**原有密码登录路径。

范围内：仅 LittleSkin 定制（不写通用 Yggdrasil Connect 发现式适配）；应用内角色多选；含 OAuth 刷新令牌自动续期。

范围外（另开独立 issue）：`appsettings.json` 重构与 CurseForge key secret 化、`debug.yml` 本地配置、
其它验证服务器（Blessing Skin 等，均无公共 client_id）。

## 2. 为什么是设备代码流

| 方案 | 判定 | 原因 |
|---|---|---|
| **设备代码流** | ✅ 采用 | 公共客户端，**不需要 `client_secret`**；不需要真实回调地址；与启动器既有的微软设备码流程同构 |
| 授权代码流 | ❌ 排除 | LittleSkin 官方明确**尚未支持 PKCE**；无 PKCE 就必须内嵌 `client_secret`，而启动器是分发给用户的二进制，secret 必然泄露；且 `127.0.0.1` 回调需与注册的 `redirect_uri` 精确匹配 |

设备流的两个关键性质（已实测）：

- **不需要 `client_secret`**：token 端点请求体仅 `grant_type` + `client_id` + `device_code`（轮询）/ `refresh_token`（续期），符合 RFC 8628 公共客户端模型。
- **`client_id` 不是机密**：依 RFC 6749 §2.2，`client_id` 是公开值（会出现在浏览器授权 URL 中），可安全入库。故本方案 **不建立任何 secret 管线**。

## 3. 前置条件：申请设备代码流白名单

### 3.1 为什么必须申请

LittleSkin 出于公共客户端的安全考虑，要求应用先申请白名单。实测未加白名单的 `client_id` 调用
`POST https://open.littleskin.cn/oauth/device_code` 一律返回：

```json
{"error":"invalid_client","error_description":"Client was not found or not whitelisted"}
```

（响应头含 `X-Cache-Status: MISS` 与 `X-Error-Info: Origin`，以时间戳参数击穿后复测结果一致 → 服务端判定，非 CDN 缓存。）

另：发现文档 `https://open.littleskin.cn/.well-known/openid-configuration` 中**没有 `shared_client_id`**，
因此**无法复用公共应用 ID**，必须自行注册。

### 3.2 回调 URL 说明（常见误解）

官方要求在 [OAuth 2 应用管理页](https://littleskin.cn/user/oauth/manage) 将应用的回调 URL 设置为：

```
https://open.littleskin.cn/oauth/callback
```

这个地址**不是回调到本启动器**，而是指向 LittleSkin 自家的授权落地页（用户在浏览器输完授权码后由它接手）。因此：

- **不需要**公网域名、服务器或本地 HTTP 监听端口；
- **不需要**在申请材料中提供任何「我方回调地址」；
- **代码中永不使用该值** —— 设备流只做「请求设备码 → 轮询换令牌」，没有任何 redirect 环节。

实测验证设备码端点是否消费 `redirect_uri`：带与不带该参数，响应逐字相同（均卡在未注册的 `invalid_client`），
证明该参数在设备流中不被读取——它只是应用创建表单的必填项。

### 3.3 申请工单模板（可直接照抄）

| 项目 | 内容 |
|---|---|
| 收件人 | `support@littlesk.in` |
| 邮件标题 | `申请 OAuth 设备代码流白名单` |
| 应用名称 | `Qomicex Launcher` |
| 客户端 ID | `1580` |
| 正文 scope 列表 | `Yggdrasil.MinecraftToken.Create`<br>`Yggdrasil.PlayerProfiles.Read`<br>`Yggdrasil.Server.Join` |
| 申请理由 | 启动器外置登录改用 OAuth，避免向第三方应用提供明文密码；需换取 MC 令牌、展示用户名下角色列表、并支持加入多人游戏服务器。 |

工单正文示例：

```
应用名称（必填）：Qomicex Launcher
客户端 ID（必填）：1580
申请权限列表（可选，每行一个权限）：
Yggdrasil.MinecraftToken.Create
Yggdrasil.PlayerProfiles.Read
Yggdrasil.Server.Join
申请理由（可选）：启动器外置登录改用 OAuth，避免明文密码；需换取 MC 令牌、展示角色列表、支持进服。
```

⚠️ **三个必须注意的点**：

1. **不要申请 `Yggdrasil.PlayerProfiles.Select`** —— 它与 `.Read` **互斥**，同时申请在设备流中直接返回 `invalid_scope`。本方案用 `.Read` 在启动器内做角色多选。
2. **`Yggdrasil.Server.Join` 必须写进邮件** —— 规范规定未申请该 scope 的令牌会被会话服务器**拒绝**，症状是「能登录但进不了服务器」。
3. `openid` 与 `offline_access` 是 OAuth 标准 scope，**无需**列入工单；但代码请求时必须带上（`offline_access` 是拿到 `refresh_token` 的前提，即自动续期的前提）。

### 3.4 审批周期与测试模式

- 官方称约 **一周内** 审核并通过邮件回复结果。
- **首次申请默认为测试模式**：仅应用创建者可完成授权。投产前需**再发一封工单申请解除测试模式**。

## 4. 完整时序

```
┌─ 前端 Accounts.tsx（Yggdrasil 标签页 → 登录方式 = OAuth） ─────────────┐
│                                                                        │
│ ① 点击「开始 OAuth 授权」                                              │
│      └─ POST /api/auth/littleskin/device-code                          │
│            └─ 后端 POST https://open.littleskin.cn/oauth/device_code    │
│                 scope=openid offline_access                            │
│                       Yggdrasil.PlayerProfiles.Read                    │
│                       Yggdrasil.MinecraftToken.Create                  │
│                       Yggdrasil.Server.Join                            │
│            ← { device_code, user_code, verification_uri,               │
│                verification_uri_complete, expires_in, interval }        │
│                                                                        │
│ ② 展示 user_code + 复制到剪贴板；openUrl(verification_uri_complete)     │
│      （用户在其浏览器完成登录 / 二步验证 / 角色授权）                    │
│                                                                        │
│ ③ 按 interval 轮询                                                     │
│      └─ POST /api/auth/littleskin/poll { deviceCode }                  │
│            └─ 后端表单 POST https://open.littleskin.cn/oauth/token      │
│                 grant_type=urn:ietf:params:oauth:grant-type:device_code │
│            ← authorization_pending → 继续轮询                           │
│            ← slow_down            → 继续轮询（采用返回的新 interval）    │
│            ← access_token + refresh_token（申请 offline_access 时）     │
│                                                                        │
│ ④ 用 OAuth 令牌拉取角色列表                                             │
│      └─ GET https://littleskin.cn/api/yggdrasil/                       │
│              sessionserver/session/minecraft/profile                    │
│           Authorization: Bearer <OAuth access_token>                   │
│      ← [ { id, name, properties }, ... ]                               │
│                                                                        │
│ ⑤ 应用内多选角色（复用现有「选择要登录的角色」UI）                        │
│      └─ POST /api/auth/littleskin/select                               │
│           { accessToken, refreshToken, serverUrl, selectedProfiles }   │
│            └─ 对每个角色 POST https://littleskin.cn/api/yggdrasil/      │
│                 authserver/oauth  { uuid }   ← Bearer OAuth 令牌        │
│               ← { accessToken(MC), clientToken, availableProfiles,      │
│                   selectedProfile }   （与 Yggdrasil 登录 API 同构）     │
│            └─ 落库 StoredAccount{ login_method:"Yggdrasil",            │
│                 server_url, access_token=MC令牌,                        │
│                 oauth_provider:"LittleSkin",                           │
│                 oauth_refresh_token=OAuth刷新令牌, token=clientToken }  │
│                                                                        │
│ ⑥ 刷新账户列表 → 导航到账户详情                                          │
└────────────────────────────────────────────────────────────────────────┘

┌─ 启动前自动续期（复用同一把全局锁，与微软续期同构） ────────────────────┐
│ refresh_account_token()                                                │
│   ├ login_method=="Yggdrasil" && oauth_provider 有值 && refresh_token   │
│   │    ① POST /oauth/token  grant_type=refresh_token                    │
│   │         → 新 OAuth access_token + 新 refresh_token                  │
│   │           （⚠️ 一次性且轮换：旧值立即失效，必须串行化）                │
│   │    ② POST /api/yggdrasil/authserver/oauth → 新 MC 令牌              │
│   │    ③ 落库                                                            │
│   ├ 失败：invalid_grant / invalid_client / 401 → 401 TOKEN_EXPIRED      │
│   │        （前端既有 MicrosoftReauthDialog 重登引导自动生效）           │
│   └ 传输层失败 → 503 NETWORK_ERROR                                      │
└────────────────────────────────────────────────────────────────────────┘
```

## 5. 数据模型

`StoredAccount` / `AccountInfo`（`services/account.rs`）各新增两个**可选**字段：

| 字段 | 类型 | 说明 |
|---|---|---|
| `oauth_provider` | `Option<String>` | OAuth 提供方标识，本方案固定为 `"LittleSkin"`；密码登录的历史账户为 `None` |
| `oauth_refresh_token` | `Option<String>` | OAuth 刷新令牌（`offline_access`），用于启动前自动续期 |

两者均带 `#[serde(default)]`，**存量 `accounts.json` 无需迁移**。

**关键设计**：**不新增 `login_method` 枚举值**，沿用 `"Yggdrasil"`。由此：

- `resolve_auth_options`（`instance.rs:1692`）的 Yggdrasil 分支零改动 → **启动链路零改动**（`access_token` 即 MC 令牌，`--authlibInjector` 照旧）；
- `skin.rs` / `connector.rs` 的 Yggdrasil 分支零改动 → 皮肤、披风、头像、联机全部照常工作；
- OAuth 账户与密码账户在 UI 上通过 `oauth_provider` 区分展示。

## 6. 错误映射

| 上游错误 | HTTP | 后端 code | 前端表现 |
|---|---|---|---|
| `invalid_client`（未加白名单） | 400 | `LITTLESKIN_OAUTH_NOT_WHITELISTED` | 提示需申请设备代码流白名单 |
| `authorization_pending` | 200 | —（`isPending: true`） | 继续轮询 |
| `slow_down` | 200 | —（`isPending: true` + 新 `interval`） | 继续轮询（延长间隔） |
| `expired_token` | 400 | `LITTLESKIN_DEVICE_CODE_EXPIRED` | 提示验证码已过期，重新登录 |
| `access_denied` | 400 | `LITTLESKIN_ACCESS_DENIED` | 提示用户在浏览器中取消或拒绝授权 |
| `invalid_scope` | 400 | `LITTLESKIN_INVALID_SCOPE` | 提示权限申请有误（多为误加了互斥的 `Select`） |
| OAuth 刷新 `invalid_grant` / `invalid_client` | 401 | `TOKEN_EXPIRED` | 复用既有 `MicrosoftReauthDialog` 重登引导 |
| 网络传输失败 | 503 | `NETWORK_ERROR` | 提示检查网络 |

## 7. 受限项与验收状态

- **client_id `1580` 当前实测仍返回 `invalid_client`**（2026-10-02，已排除 CDN 缓存干扰）→ 白名单尚未生效。
- 因此**设备码全链路 E2E 挂起**，待白名单生效后补测：
  设备码获取 → 轮询取令牌 → 角色列表 → 换取 MC 令牌 → 落库 → 启动进服 → OAuth 续期。
- 白名单生效前可验证的部分：`invalid_client` 透传、非 `littleskin.cn` 服务器被拒、client_id 配置路径、单元测试。
- 首次审批为**测试模式**（仅应用创建者可授权），投产前需再发工单解除。


## 修订记录
| 日期 | 版本 | 修改内容 | 修改人 |
| 2026-10-03 | v1.0 | 初版创建 | AI Agent |