# ADR-100：Issue #127 外部唤起：qomicex-launcher:// OS 协议 + single-instance + 深链动作分发

| 属性 | 内容 |
|---|---|
| 状态 | 已采纳 |
| 日期 | 2026-10-04 |
| 决策者 | AI Agent |

## 背景

Issue #127（[Improvement] 添加 qomicex:// 协议支持）诉求：浏览器等外部程序无法直接拉起启动器，希望支持 URL 协议与命令行参数，实现快捷启动实例、快速安装插件/整合包、快速进联机房间。

现状取证：
- `qomicex://` 已被 webview **内部**自定义协议占用（`register_asynchronous_uri_scheme_protocol("qomicex")`，ADR-040 的 QIPC 管道传输；前端 `API_BASE` 探测成功后翻转为 `http://qomicex.localhost/api` 或 `qomicex://localhost/api`）。
- 启动器无任何 OS 级协议注册：`src-tauri/Cargo.toml` 无 `tauri-plugin-deep-link` / `tauri-plugin-single-instance`。
- 已有的 argv 解析先例：`--debug <port>`（lib.rs `parse_debug_port`）。
- 插件安装入口只有「本地目录」「multipart 上传」，**没有按 URL 下载安装**。
- `origin/main`(3b33ba91) 与全部 PR 均无 deep-link 相关改动 → 上游未实现，需自研。

## 决策

采用 Tauri 官方 `tauri-plugin-deep-link` + `tauri-plugin-single-instance`（后者开 `deep-link` feature），协议名取 **`qomicex-launcher`**。

1. **协议名不用 issue 标题里的 `qomicex`**：`qomicex` 已是 webview 内部伪协议，同名注册 OS 协议会在 macOS（CFBundleURLTypes vs WKURLSchemeHandler）、Linux（xdg-mime vs webkit custom scheme）产生真实歧义，且对第三方开发者而言「内部伪协议」与「OS 协议」同名会造成文档与排障混乱。改用 `qomicex-launcher` 后内部 IPC 零改动、无破坏性变更。
2. **single-instance 必须是第一个注册的插件**：插件按注册顺序执行，第二次启动若先跑完 setup 会再 spawn 一个后端；`deep-link` feature 使插件在回调前先把 argv 转交给 deep-link 插件，于是「运行中被二次唤起」与「冷启动」两条路径汇合到同一处。
3. **接收分两条路径**：冷启动用 `get_current()`（`.setup()` 里注册的 `on_open_url` 此刻尚未挂上，插件在自身 setup 阶段已消费过 argv，必须主动取）；热路径靠 `on_open_url`。两者统一写入 `PendingDeepLink` 队列并向主窗口 emit `deep-link://action`，前端挂载后经 `take_pending_deep_link` 取走——纯 emit 会丢冷启动那次。
4. **URL 语法**（动作在 host、参数在 path，host 会被 URL 解析器小写化）：
   - `qomicex-launcher://launch/<实例名或ID>`
   - `qomicex-launcher://open/<route>`（仅白名单内部路由）
   - `qomicex-launcher://join/<房间码>`
   - `qomicex-launcher://install/plugin?slug=<slug>&version=<v>`（商店，带签名校验）
   - `qomicex-launcher://install/plugin?url=<https://….qplugin>`
   - `qomicex-launcher://install/modpack?type=modrinth|curseforge|ftb&projectId=<p>&fileId=<f>[&name=<实例名>]`
5. **`install/modpack` 必须带 projectId+fileId**：后端 `/modpack/install-direct` 在线分支两者缺一即 400 `MODPACK_SOURCE_REQUIRED`（`id` 字段语义是「目标实例名」而非项目 id）。不支持 `path=`，那条分支等于让网页指定本地磁盘文件。
6. **安全模型**：深链可被任意网页触发。可落地代码的动作一律先确认，仅当 URL 来源主机命中官方白名单（`AUTO_INSTALL_HOSTS`，**精确匹配 host 且必须 https**）时免确认；商店 `slug=` 无来源域可判，恒需确认；确认后放行无签名包的口径与设置页「本地上传 + 风险确认后重试」一致。`open` 只接受白名单路由前缀。
7. **新增后端端点 `POST /api/plugins/install-url`**（body `{url}`，query `allowUnsigned`）：与 `/plugins/upload` 只差「字节从哪来」，校验与安装复用同一条 `install_from_package`；SSRF 复用 `/plugins/proxy` 的 `validate_target`（DNS 解析后逐 IP 拒内网/保留地址），不另写一套以免规则漂移；下载上限 64 MiB。

## 备选方案

### 方案 方案 B：手写 OS 注册（注册表 / .desktop / Info.plist）+ 自研单实例
- 优点：零新增依赖；不引入官方插件的行为面
- 缺点：三平台三套实现；macOS 的 CFBundleURLTypes 必须在 bundle 期由 bundler 生成，手写要改打包配置且易漏；单实例需自研跨平台 IPC 唤醒，官方正是为此提供 deep-link feature 集成；维护成本与漏改风险显著更高
- 为何不选：舍弃。官方插件已把三平台注册与单实例转发做全，自研只是重复承担平台差异。

### 方案 方案 C：OS 协议直接沿用 qomicex（按 issue 字面）
- 优点：与 issue 标题一致，第三方文档里就是 qomicex://
- 缺点：与内部 IPC 伪协议同名；macOS/Linux 存在注册机制歧义风险；排障时难以区分「这是 OS 协议还是内部管道协议」
- 为何不选：舍弃（用户裁定）。用 qomicex-launcher 一次性消除冲突类风险，内部协议零改动。

### 方案 方案 D：仅做 OS 协议注册，不引入 single-instance
- 优点：改动更小
- 缺点：启动器已开着时点网页链接会再开一个实例，重复 spawn 后端/抢管道名，行为不可预期
- 为何不选：舍弃。Windows/Linux 上深链本质是「新进程带 URL 参数启动」，没有单实例就无法唤醒已有窗口。

## 影响
- src-tauri/Cargo.toml：新增 tauri-plugin-deep-link、tauri-plugin-single-instance(deep-link)
- src-tauri/tauri.conf.json：plugins.deep-link.desktop.schemes=["qomicex-launcher"]
- src-tauri/capabilities/default.json：新增 deep-link:default
- src-tauri/src/deep_link.rs（新）：协议注册、冷/热两条接收路径、PendingDeepLink 队列、take_pending_deep_link 命令
- src-tauri/src/lib.rs：single-instance 首位注册 + deep-link 插件 + manage(PendingDeepLink) + setup 里 deep_link::init
- src/lib/deepLink.ts（新）：纯解析（动作联合类型、路由白名单、官方域白名单）
- src/components/DeepLinkHandler.tsx（新）：事件/队列两入口 + 动作分发 + 短窗去重
- src/App.tsx：BrowserRouter 内挂载 DeepLinkHandler
- src/api/plugins.ts：新增 installPluginFromUrl
- src-backend/qomicex-backend/src/endpoints/plugin.rs：新增 POST /plugins/install-url + install_url handler + INSTALL_URL_MAX_BYTES
- qomicex-tauri-i18n：新增 deepLink 命名空间（7 语言同步，submodule 需单独提交）

## 修订记录
| 日期 | 版本 | 修改内容 | 修改人 |
|---|---|---|---|
| 2026-10-04 | v1.0 | 初版创建 | AI Agent |

### 2026-10-04 更新

## 补充决策（VERIFY 阶段发现）：`--debug <port>` 时跳过 single-instance

**问题**：`packages/qomicex-cli` 的 `qomicex debug` 与 ADR-063 的约定是「每次用 `--debug <port>` 启动一个新进程来暴露 CDP 端口」。CDP 端口由**进程启动时**的环境变量（`WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS` / `WEBKIT_INSPECTOR_*`）决定，无法转交给已在跑的实例。若无条件注册 single-instance，启动器已在运行时再执行 `qomicex debug`，新进程会被拦截并退出、CDP 端口永远不会打开——调试链路静默失效。

**决策**：`parse_debug_port()` 返回 `Some` 时**不注册** `tauri-plugin-single-instance`，其余情况照常注册。

```rust
let debug_port = parse_debug_port();
#[cfg(desktop)]
if debug_port.is_none() {
    builder = builder.plugin(tauri_plugin_single_instance::init(
        |app, argv, _cwd| deep_link::handle_second_instance(app, &argv),
    ));
}
```

**代价与边界**：显式调试模式下没有单实例，深链的「运行中二次唤起」也无法转发（冷启动深链仍工作）。该模式本就是开发者手动触发的短时状态，且退化为与本次改动之前完全一致的行为，可接受。

## 验证证据（本机实测）

| 项 | 命令 | 结果 |
|---|---|---|
| 前端类型 | `npx tsc --noEmit` | `EXIT=0` |
| 前端构建 | `pnpm run build` | `BUILD_EXIT=0`（`✓ built in 8.96s`） |
| Rust 格式 | `cargo fmt -- --check`（backend + tauri） | 均 `0` |
| Rust 编译 | `cargo check`（backend + tauri） | 均 `EXIT=0` |
| 后端测试 | `cargo test -p qomicex-backend` | `361 passed; 0 failed; 2 ignored` |
| Tauri 网关测试 | `cargo test --lib plugin_gateway` | `2 passed` |
| i18n 结构 | 7 语言 key/占位符奇偶校验 | 均 `keys=12`、占位符集合一致 |

**新端点 `POST /api/plugins/install-url` 端到端实测**（真实后端 + 临时 `QOMICEX_HOME`，`:5099`）：

| 用例 | 输入 | 结果 |
|---|---|---|
| 空 url | `{"url":""}` | 400 `INSTALL_URL_REQUIRED` |
| 非 http(s) | `ftp://example.com/a.qplugin` | 400 `INSTALL_URL_SCHEME_NOT_ALLOWED` |
| SSRF-回环 | `http://127.0.0.1:1/a.qplugin` | 400 `PROXY_PRIVATE_ADDRESS` |
| SSRF-hostname | `http://localhost/a.qplugin` | 400 `PROXY_PRIVATE_ADDRESS` |
| 下载成功但非 zip | `https://www.baidu.com/` | 400 `INVALID_PLUGIN_PACKAGE`（**证明 fetch 真的执行**） |
| DNS 失败 | `https://no-such-host-….invalid/a.qplugin` | 400 `PROXY_DNS_FAILED` |
| **完整成功路径** | 商店真实包 `https://cdn.qomicex.top/plugins/top.qomicex.mctiers/1.0.0.qplugin` | **200 + PluginInfo**，落盘到临时 home，`GET /api/plugins` 可见 |
| `allowUnsigned` 接线 | 同上 + `?allowUnsigned=true` | 200（覆盖安装，`hasRollback:true`） |

**未在本机验证（需真机）**：OS 协议注册本身（Windows 注册表 `HKCU\Software\Classes\qomicex-launcher` 写入、从浏览器点击链接唤起、二次唤起转发到已有窗口）——需要安装/运行构建后的启动器并点击链接，属环境依赖项。

