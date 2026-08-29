# ADR-063：qomicex CLI 优化与插件 log API

| 属性 | 内容 |
|---|---|
| 状态 | 已采纳 |
| 日期 | 2026-08-29 |
| 决策者 | AI Agent |

## 背景

用户要求优化 qomicex-cli：新增 login/logout（token 持久化）、lint（增强静态检查）、doctor（环境诊断）、debug（启动器 CDP + 实时日志）；并追加启动器侧插件 log API，供插件写日志到 trace 体系（debug 与生产环境都有用）。经核对 store 官方 API 契约（access token 15min / refresh token 30 天，POST /auth/refresh 旋转式续期），启动器桥结构（sandbox.ts METHOD_PERMISSIONS + executePluginMethod），后端 trace 体系（TraceBufferStore + /api/logs/frontend 先例）。

## 决策

① CLI 新增 login/logout：会话持久化 ~/.qomicex/auth.json（0600，按 store apiBase 区分）；publish 无 API Key 时优先用持久化 refreshToken 调 POST /auth/refresh 旋转续期，失效才走设备流并回写。② 新增 lint：在 verify 基础上加相对 import 缺扩展名（Vite 硬规则）+ entry/contributes 资源引用存在性检查，--json 输出供 CI。③ 新增 doctor：纯只读诊断 node/pnpm/项目/plugin-ui/vite/openssl+WebCrypto/后端:5000/商店/harness。④ 新增 debug：定位启动器（--launcher > env > 仓库 target > 安装路径），Windows 设 WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS 开放 WebView2 CDP（Linux/macOS 用 WEBKIT_INSPECTOR_SERVER 尽力），轮询 /json/list 打印 targets，经后端新增 /api/diagnostics/trace/stream SSE 实时 tail。⑤ 插件 log API：桥方法 log(message, level?)，新增权限 plugin:log(normal)（同步 types.ts/sandbox.ts/CLI permissions.ts/i18n submodule 7 locale），后端新增 POST /api/plugins/log → trace_append("[plugin:{id}:{level}] {msg}")，全级别写入（trace 环形缓冲 2000 天然限流）。后端 SSE 基于 services/trace.rs 新增 broadcast 通道（容量 256，无订阅者静默丢弃）。不选复用 /api/logs/frontend（trace 格式冗余），不选跟随日志级别过滤（信息最全）。

## 备选方案

### 方案 debug 复用 /api/diagnostics/trace 快照轮询
- 优点：零后端改动
- 缺点：~1s 轮询延迟，非实时
- 为何不选：用户选实时 SSE

### 方案 插件日志复用 POST /api/logs/frontend
- 优点：不加后端端点
- 缺点：trace 显示为 [frontend:info] [plugin:...]，格式冗余且归属不清
- 为何不选：新增 /api/plugins/log 格式干净

### 方案 token 仅存项目目录
- 优点：多项目隔离
- 缺点：每项目重复登录
- 为何不选：用户选用户目录跨项目

## 影响
- packages/qomicex-cli：新增 commands/login|logout|lint|doctor|debug + lib/auth|lint|launcher，store.ts refreshToken，io.ts runCapture，index.ts 注册，bump SEMVER 同步
- src-backend：services/trace.rs 加 broadcast，endpoints/system.rs 加 /api/diagnostics/trace/stream SSE，endpoints/plugin.rs 加 POST /api/plugins/log
- src/plugins：types.ts PERMISSION_CATALOG + sandbox.ts METHOD_PERMISSIONS/executePluginMethod + plugin-api.ts PluginBridge.log
- qomicex-tauri-i18n submodule：plugins.permission.pluginLog（7 locale）
- 文档：API列表.md、插件系统API.md、CLI README、skill 包 plugin-api.md/permissions.md

## 修订记录
| 日期 | 版本 | 修改内容 | 修改人 |
|---|---|---|---|
| 2026-08-29 | v1.0 | 初版创建 | AI Agent |

### 2026-08-29 更新
## 修订（2026-08-29 实测后修正）

**发现问题**（实测证据）：
1. release 启动器内嵌 backend 恒以 `QOMICEX_IPC_PIPE` + `QOMICEX_NO_TCP=1` 纯 IPC 模式运行（`lib.rs spawn_backend`），**不监听 127.0.0.1:5000**——最初设计的 `GET /api/diagnostics/trace/stream` SSE 通道在真实启动器下无法连接。
2. 早期方案曾尝试给 `spawn_backend` 加 `QOMICEX_BACKEND_TCP` 开关让 release 开 TCP——**被否决**：release 纯 IPC 是刻意设计（性能/安全/端口冲突，macOS 上与系统端口冲突风险），TCP 仅限启动器自身开发调试。

**最终修正**：
1. **启动器新增 `--debug <port>`（或 `-d <port>`）启动参数**：`lib.rs run()` 解析后设 `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=<port>`（macOS `WEBKIT_INSPECTOR_HTTP_SERVER`、Linux `WEBKIT_INSPECTOR_SERVER`）。**release 默认行为不变**（纯 IPC），仅显式传参才开放 CDP。第三方开发者无需源码/CLI，直接 `Qomicex Launcher.exe --debug 9223` 即可。
2. **日志不依赖 TCP，双通道**：① 启动器 stderr 实时推送（`logger::log_line` 回显 + backend stdout/stderr 转发，`stdio: inherit` 直接可见）；② tail `{BaseDir}/logs/qomicex-backend.log`（backend `FileLog` 逐行 `write_all + flush` 实时落盘，含 `[plugin:...]`/`[frontend:...]` trace 行）。
3. **`qomicex debug` 命令**：spawn 启动器传 `--debug <port>` + env fallback（兼容旧启动器，端口一致不冲突），stdout 打印 CDP targets + `[trace]` 文件 tail；`locateLauncher` 同时匹配 bundle 名 `Qomicex Launcher.exe` 与 cargo 原生名 `qomicex-launcher.exe`，取 mtime 最新者（避免命中旧 bundle 产物）。
4. `GET /api/diagnostics/trace/stream` SSE 端点**保留**（仅独立运行/开发模式的 backend TCP 下可用），`qomicex debug` 不再依赖它。

**验证**：不带 `--debug` 启动 release → backend ipc-only + 5000 不监听 ✓；带 `--debug 9224` → CDP 9224 开放且 backend 仍 ipc-only ✓；`qomicex debug` → CDP 通 + stderr 推送 + `[trace]` 文件 tail（含启动日志）✓；`cargo test --lib plugin_gateway` 2 passed ✓。
