# ADR-048：启动前强制刷新微软账户 token 并按失败类型分流

| 属性 | 内容 |
|---|---|
| 状态 | 已采纳 |
| 日期 | 2026-08-24 |
| 决策者 | AI Agent |

## 背景

Rust 重写丢失了 C# 版"启动时经 core auth provider 刷新微软 token"的行为：qomicex-core-rust 桌面启动链路（jvm_args.rs 直接以存储的 access_token 替换 ${auth_access_token}）从不调用 MicrosoftAuthProvider::refresh_login（该函数仅 Android JNI 桥使用），前端亦从不调用 /api/auth/microsoft/refresh。MC access_token 约 24h 过期后，name/uuid 依然正确但加入正版验证服务器被拒。instance.rs resolve_auth_options 的注释声称的刷新行为实际不存在（误导性注释已一并修正）。

## 决策

在后端单点修复：新增 instance::refresh_microsoft_token(auth, accounts, account)，普通启动（launch_instance）与联机建房（connector.rs）两条组装 AuthOptions 的路径统一前置调用。按失败类型分流（用户确认的策略）：(1) 非 Microsoft 账户或缺 refresh_token → 原样放行；(2) core 返回 Err（断网等传输层故障）→ 放行旧 token 继续启动；(3) Ok(success=false)（refresh_token 失效）→ 返回 401 TOKEN_EXPIRED 阻止启动。成功则更新 access_token/refresh_token/name/uuid 并经 AccountService.save_account 落库。分流语义依据 core microsoft.rs 实现：HTTP 请求本身失败走 Err，微软拒绝（invalid_grant 等，HTTP 非 2xx）走 Ok(failed_auth_result)。前端零改动——Instances/InstanceDetail/Dashboard 既有的 TOKEN_EXPIRED 错误码分支（原为不可触发的死代码）自动弹出微软重登引导对话框。

## 备选方案

### 方案 前端启动前手动调 /auth/microsoft/refresh 再 launch
- 优点：不动后端
- 缺点：依赖前端两步调用，联机建房等后端直接组装 auth 的路径容易漏改；多一次 HTTP 往返
- 为何不选：未说明

### 方案 定期后台刷新
- 优点：无感知续期
- 缺点：复杂度高，仍无法解决「启动时已过期」的主场景
- 为何不选：未说明

## 影响
- 启动耗时：微软账户每次启动多一次 MS+XBL+MC 认证链路往返（约1-2s）
- 离线场景不受影响：断网时 Err 分支放行，与旧行为一致
- 历史数据兼容：无 refresh_token 的存量微软账户不刷新、维持旧行为
- 已知边界：StoredAccount.token 字段刷新后不同步（与现有 /auth/microsoft/refresh 端点行为一致，core 桌面链路不读取该字段，无实际影响）

## 修订记录
| 日期 | 版本 | 修改内容 | 修改人 |
|---|---|---|---|
| 2026-08-24 | v1.0 | 初版创建 | AI Agent |

### 2026-08-24 更新
## 修订 v1.1：断网场景改为阻止启动

**变更**：传输层失败（断网等，core 返回 Err）的处理由「放行旧 token 继续启动」改为「返回 503 NETWORK_ERROR 阻止启动」，提示文案引导用户检查网络或改用离线模式启动。

**决策理由**：微软账户在断网下放行旧 token 启动后，游戏连接正版会话服务器同样必然失败，白启一次；直接拦截并给出离线登录建议的反馈路径更短。

**配套改动**：
- 后端：`refresh_microsoft_token` Err 分支 → `ApiError::new(503, "NETWORK_ERROR", ...)`（instance.rs）
- 前端：Instances/InstanceDetail(×3)/Dashboard 的 launch catch 在 TOKEN_EXPIRED 分支后新增 `NETWORK_ERROR` 分支，弹出 `errors.networkError` 文案
- i18n（qomicex-tauri-i18n submodule，需独立提交）：zh-CN/zh-TW/zh-HK/en-US/en-GB/ja-JP/ru-RU 七语言 errors.ts 新增 `networkError` key
- 主仓库 `src/i18n/errors.ts`：`NETWORK_ERROR: 'errors.networkError'` 映射
- 单元测试：`transport_error_blocks_with_network_error` 断言 code=NETWORK_ERROR、status=503


### 2026-08-24 更新
## 修订 v1.2：覆盖皮肤/披风链路（Issue #18）

**背景**：Issue #18「微软登录状态不会刷新」——长时间不用后账户详情页鉴权类功能（披风列表/切换披风/上传/重置皮肤）失效。与启动问题同根因（token 过期无刷新），不同链路。

**改动**：
- 后端 `skin.rs` `mc_token()`（所有鉴权类皮肤操作的单一 token 入口）前置调用 `refresh_microsoft_token`，自动续期后操作无感恢复；refresh_token 失效 → TOKEN_EXPIRED、断网 → NETWORK_ERROR，分流与启动链路一致
- 前端 `AccountDetail.tsx`：loadMcCapes/handleCapeToggle/handleSkinUpload/handleSkinReset 四处 catch 识别 TOKEN_EXPIRED/NETWORK_ERROR → 复用 `MicrosoftReauthDialog` 弹重登引导；页面打开即加载披风列表，天然满足 Issue #18 期望的「自动检测并提示重新登录」
