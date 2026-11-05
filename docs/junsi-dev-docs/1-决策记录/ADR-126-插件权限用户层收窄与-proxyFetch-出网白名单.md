# ADR-126：插件权限用户层收窄与 proxyFetch 出网白名单

| 属性 | 内容 |
|:---|:---|
| 状态 | 已采纳 |
| 日期 | 2026-11-06 |
| 决策者 | AI Agent |
| 相关文件 | `services/plugin_permissions.rs`、`endpoints/plugin.rs`、`src/plugins/permissions.ts`、`src/components/PluginPermissionPanel.tsx` |

## 背景

插件权限此前只有两层：

1. manifest `permissions` 静态声明；
2. `executePluginMethod()` 的 `manifest.permissions.includes(requiredPerm)` 单点校验。

安装后用户既不能收窄权限，也不能为单个插件放宽 proxyFetch 的 SSRF 防护。后者已造成实际限制：`validate_target()` 在 DNS 解析后逐个 IP 拒绝内网/保留地址，依赖本机 API（本地推理、代理工具、私有服务）的插件只能绕道 `callBackend` 或自带代理。反过来，用户看到某个插件声明了 `shell:execute`、`filesystem:write` 也没有任何手段关掉，只能整个停用插件。

## 决策

### 1. 有效权限 = manifest − 用户禁用项

- 新增 `{base}/plugin-permissions.json`，结构为 `pluginId → { disabled: string[], corsProxy: { allowPrivate, allowlist } }`。
- 新增 `GET/PUT /api/plugins/{id}/permissions`；插件卸载时删除对应条目。
- 只降权：manifest 没声明的权限不会因为本地配置出现，提权仍然只有重新安装/改包一条路。
- 权限校验仍在前端完成（`sandbox.ts` / `hook-registry.ts`），只是判断从 `manifest.permissions.includes` 换成 `isPermissionGranted()`；`callBackend` 的特权路由二次鉴权同步改用同一函数。

**Why not 存进插件自己的 `settings.json`**：插件可通过 `setSettings` 写该文件，等于自己给自己开权限。也否掉了 localStorage 方案：清站点数据即丢，且后端无法按策略决定 SSRF 校验，等于策略只对好心插件有效。

### 2. proxyFetch 出网策略

`/plugins/proxy` 的请求体新增 `pluginId`，由 `createPluginBridge()` 在展开插件参数**之后**写入（`{ ...req, pluginId }`），插件无法覆盖。后端按 `pluginId` 查策略：

1. 命中 `allowlist` → 跳过 SSRF 校验；
2. 否则 `allowPrivate` 为真 → 跳过；
3. 都不满足 → 维持原 `validate_target()`。

- 白名单优先于开关，使「只放行 `localhost:8080`」不必连带打开整个内网。
- 条目支持 `host`、`host:port`、`*.suffix`（同时匹配 apex）；端口缺省表示任意端口；不支持 IPv6 字面量（`[::1]` 会被端口解析拒绝，需要时用开关）。`localhost` 与 `127.0.0.1` 视为不同主机，需要分别添加。
- `proxy_client` 的 `redirect(none)` 不变，因此放宽的只是初始目标，不存在逐跳绕过。
- **始终禁止**代理到启动器自身 API（回环地址 + 自身端口，域名解析到回环同样拦截，`PROXY_SELF_TARGET` 403）。后端不做权限校验，若放开这一步，插件只需一次 `proxyFetch` 就能绕过 `shell:execute`、`filesystem:write` 等全部限制。
- `/plugins/install-url`（深链安装 `.qplugin`）不读该策略，始终严格。

### 3. 静态贡献跟随权限隐藏

manifest 静态贡献不经过方法调用，只拦方法会出现「权限已禁用但入口还在」：

| 贡献 | 权限 |
|:---|:---|
| `contributes.menuItems` | `ui:inject_sidebar` |
| `menuItems[].action = "overlay"` + `contributes.overlay` | 额外要求 `ui:sub_window` |
| `contributes.settingsPages` | `ui:inject_settings` |

改动这些权限后需要重挂载插件，UI 保存成功后对 active 插件执行 `deactivatePlugin()` + `activatePlugin()`；其余权限即时生效，不重启插件。

### 4. 存储与校验边界

`plugin_permissions.rs` 与 `plugin-states.json` 同目录、同生命周期，写入前规范化（权限 id 字符集/去重/上限 256；白名单条目解析/去重/上限 64）。

明确写进注释与本文档的**已知边界**：后端仍不做身份认证，本地任意进程可以直接 `POST /plugins/proxy` 并伪造 `pluginId`。这与「权限校验不在后端」的既有模型一致——SSRF 策略保护的是启动器不被插件顺手当成内网跳板，不是防止本机进程访问本机网络。

## 被否方案

| 方案 | 否决原因 |
|:---|:---|
| 纯前端 localStorage | 清数据即丢；后端 SSRF 校验无法按策略生效 |
| 安装时逐项授权 + 每次调用弹窗 | 打扰度高，与「在设置里统一禁用」的诉求不符；插件后台调用无法弹窗 |
| 只做全关开关，不做白名单 | 打开开关等于把整台内网交给插件，最小权限无从谈起 |
| 允许用户授予 manifest 未声明的权限 | 破坏安装时授权语义，安装弹窗失去意义 |

## 影响

- 前端：`src/plugins/permissions.ts`（新）、`sandbox.ts`、`hook-registry.ts`、`plugin-loader.tsx`、`plugin-api.ts`、`pluginStore.ts`、`api/plugins.ts`、`components/PluginPermissionPanel.tsx`（新）、`PluginStoreManage.tsx`、`PluginSettingsTab.tsx`。
- 后端：`services/plugin_permissions.rs`（新）、`services/mod.rs`、`state.rs`、`endpoints/plugin.rs`。
- i18n：`settings.plugins` 新增 23 个键，7 个 locale。
- 插件开发者：运行时可能收到 `Permission denied`，即使 manifest 已声明。CLI skill 的 permissions 文档需注明「必须处理权限被用户关闭」。
- 文档：插件系统 API 增加用户层覆盖说明。

## 验证

- `cargo test plugin_permissions`：8 个单测（默认策略、开关、精确/通配/端口匹配、大小写与尾点、规范化、上限、落盘往返）。
- `cargo test endpoints::plugin::tests`：10 个通过（含新增 `loopback_hosts_are_recognized`）。
- `cargo check --tests`：通过；`cargo fmt --check`：通过。
- `pnpm run typecheck`：通过。
- `pnpm run lint`：0 error。
- 隔离环境冒烟（独立 `QOMICEX_HOME` + `QOMICEX_PORT=5055` + 本地 5099 服务）：
  - `GET /api/plugins/hello-plugin/permissions` → 默认 `{disabled:[], allowPrivate:false, allowlist:[]}`
  - `PUT` 传 `['shell:execute','SHELL:EXECUTE','bad id']` 与 `['LocalHost:5099','localhost:0','*','*.lan']` → 回读 `{disabled:['shell:execute'], allowlist:['localhost:5099','*.lan']}`
  - `POST /api/plugins/proxy` 带 `pluginId` 且命中白名单 → `200`，body `local-ok`
  - 同一目标不带 `pluginId` → `400 PROXY_PRIVATE_ADDRESS`
  - 白名单放行 `localhost:5055` 后代理自身 API → `403 PROXY_SELF_TARGET`
  - `plugin-permissions.json` 落盘内容与回读一致
