# 权限目录与最小权限原则

权限目录源：`src/plugins/types.ts` 的 `PERMISSION_CATALOG`（启动器）与 `packages/qomicex-cli/src/lib/permissions.ts`（CLI verify，两者一致）。方法→权限映射源：CLI `src/lib/permissions.ts` 的 `METHOD_PERMISSIONS` 表（与 `src/plugins/sandbox.ts` 一致）。

## 风险分级

| 级别 | 含义 | 安装详情弹窗视觉 |
|------|------|------|
| `normal` | 只读 / 低影响 | 蓝 |
| `warning` | 写操作 / 网络 / 进程类 | 黄 |
| `danger` | 系统命令 / 文件写 / 装插件 | 红 |

**最小权限原则**：只声明真正用到的权限。`qomicex verify` 会扫描源码实际调用的桥方法（按 `METHOD_PERMISSIONS` 表），**声明了未用到的 → 报错；用了没声明的 → 报错**。因此 AI 生成插件时务必按"最终调用了哪些 API"反推权限集合，宁可少而准。

## 完整权限目录（43 项）

| 权限 ID | 风险 | 用途 |
|---------|------|------|
| `instance:read` | normal | 读取实例列表 |
| `instance:write` | warning | 创建/修改/删除实例（含安装整合包） |
| `account:read` | normal | 读取账号列表 |
| `license:read` | normal | 读取许可证信息 |
| `config:read` | normal | 读取启动器配置 / 插件配置 |
| `config:write` | warning | 修改启动器配置 / 插件配置 |
| `cache:access` | normal | 读写插件缓存 |
| `endpoint:discover` | normal | 获取后端 API 端点 |
| `page:list` | normal | 获取页面列表 |
| `network:fetch` | warning | 调用后端 API（callBackend）/ 插件互调 |
| `network:cors_proxy` | warning | CORS 代理请求（proxyFetch / proxyFetchStream） |
| `network:websocket` | warning | WebSocket 连接 |
| `network:proxy` | warning | 修改代理设置 |
| `ui:inject_sidebar` | normal | 注入侧边栏菜单 |
| `ui:inject_settings` | normal | 注入设置页 |
| `ui:picture_in_picture` | warning | 画中画窗口 |
| `ui:sub_window` | warning | 独立子窗口 / 悬浮窗 |
| `ui:context_menu` | normal | 注入右键菜单 |
| `ui:toast` | normal | 应用内 toast 通知 |
| `ui:navigate` | normal | 跳转页面 |
| `system:info` | normal | 读取系统和启动器信息 |
| `system:notification` | normal | 发送系统通知 / 打开外链 |
| `clipboard:read` | warning | 读取剪贴板 |
| `clipboard:write` | warning | 写入剪贴板 |
| `wasm:execute` | warning | 执行 WASM 模块（callWasm） |
| `plugin:install` | danger | 安装/卸载/更新插件 |
| `plugin:list` | normal | 读取已安装插件列表 |
| `plugin:log` | normal | 写插件日志到启动器 trace（调试排障） |
| `resource:read` | normal | 读取游戏资源文件 |
| `resource:write` | warning | 写入游戏资源文件 |
| `java:manage` | warning | 管理 Java 运行时 |
| `download:manage` | warning | 管理下载中心任务 |
| `game:process` | warning | 启停游戏进程 |
| `game:log` | normal | 检测游戏日志 |
| `connector:host` | warning | 启停联机 |
| `connector:scan` | normal | 扫描局域网联机 |
| `shell:execute` | danger | 执行系统命令 |
| `filesystem:read` | warning | 读取文件系统 / 目录列举（listDir） |
| `filesystem:write` | danger | 写入/删除文件系统 / 本地 zip 解压（extractArchive） |
| `process:manage` | danger | 管理常驻进程（spawn/stdin/kill/alive/logs/list） |
| `dialog:open` | normal | 打开系统文件/目录选择对话框（pickFile/pickDirectory） |

## 方法 → 权限映射（生成权限列表时照此反推）

| API 方法 | 所需权限 |
|----------|----------|
| `getSettings` | `config:read` |
| `setSettings`、`registerMethod` | `config:write` |
| `getCache` / `setCache` | `cache:access` |
| `callBackend`、`callPlugin` | `network:fetch` |
| `proxyFetch` / `proxyFetchStream` | `network:cors_proxy` |
| `uploadPlugin` | `plugin:install` |
| `callWasm` / `listWasmPlugins` | `wasm:execute` |
| `readText` / `readBytes` | `filesystem:read` |
| `writeText` / `writeBytes` / `deleteFile` | `filesystem:write` |
| `execCommand` | `shell:execute` |
| `navigate` | `config:read` |
| `showToast` | `ui:toast` |
| `log` | `plugin:log` |
| `getSystemInfo` | `system:info` |
| `openUrl` | `system:notification` |
| `listPlugins` | `plugin:list` |
| `overlay.*`（create/show/hide/destroy/setHtml/setPosition） | `ui:sub_window` |
| `download.addTask` / `.progress` / `.cancel` / `.list` | `download:manage` |
| `download.registerInstall` | `instance:write` |
| `modpack.install` | `instance:write` |
| `process.spawn` / `.stdin` / `.kill` / `.alive` / `.logs` / `.list` | `process:manage` |
| `pickFile` / `pickDirectory` | `dialog:open` |
| `extractArchive` | `filesystem:write` |
| `listDir` | `filesystem:read` |
| `sendNotification` | `system:notification` |
| `openPluginSettings` | `config:read` |
| `registerHook` | `hook:register` |
| `onLauncherExit` | 无需权限（被动事件） |
| `addMenuItem` | `ui:inject_sidebar` |

## 常见权限组合

- **纯 UI 插件**（模板默认）：`config:read` + `ui:toast` + `network:cors_proxy`。
- 需要联网的插件：`network:cors_proxy`（外网请求）或 `network:fetch`（调启动器后端）。
- 需要持久化自己的配置：加 `config:write`（配合 `getSettings`/`setSettings`）。
- 需要文件读写：`filesystem:read`（读）或 `filesystem:write`（写/删，danger）。文件访问是**授权制**——首次访问用户弹窗确认，按路径前缀持久化。

## 用户可能关闭权限

权限不是「声明过就一定可用」。用户可在「设置 → 插件 → 详情 → 权限」逐项关闭（含 proxyFetch 的内网访问策略），有效权限 = manifest − 用户关闭项：

- 被关闭的权限调用会抛 `Permission denied: requires <permission>`，必须按「能力不可用」降级，不要假设声明过就一定能用。
- 关闭 `ui:inject_sidebar` / `ui:inject_settings` / `ui:sub_window` 会隐藏对应入口，插件是被重新加载而不是收到通知。
- 静态入口必须同时声明权限：`contributes.menuItems` 要 `ui:inject_sidebar`，`contributes.settingsPages` 要 `ui:inject_settings`，`action: "overlay"` 另要 `ui:sub_window`。只写 `contributes.*` 不声明权限，启动器不会注入（`qomicex verify` 会报 error）。
- 这两个权限不经过桥方法，但 `qomicex verify` 的「未使用权限」检查会把 manifest 静态贡献算作使用场景，不会提示移除；如果确实不再注入，应当连 `contributes.*` 一起删。
- `proxyFetch` 默认拒绝本机/内网地址；依赖本地 API 的插件应在文档里说明需要用户开启白名单或「允许内网地址」。

## 模板默认 manifest

```json
{
  "layers": ["l2"],
  "permissions": ["config:read", "ui:toast", "network:cors_proxy"]
}
```
