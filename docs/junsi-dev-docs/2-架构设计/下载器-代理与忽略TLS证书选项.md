# 下载器全局选项：HTTP 代理与忽略 TLS 证书校验

> 生成时间：2026-08-20 19:12

# 下载器全局选项：HTTP 代理与忽略 TLS 证书校验

版本：qomicex-downloader 子模块（commit 1769c23 `feat(downloader): add optional proxy and ignore-tls-verify options`）

## 新增字段（`src/task.rs` `DownloadOptions`）

`DownloadOptions` 新增两个公开字段，均可选，默认值保持既有行为不变：

| 字段 | 类型 | 默认 | 说明 |
|------|------|------|------|
| `proxy` | `Option<String>` | `None` | 可选的完整代理 URL，如 `Some("http://127.0.0.1:7890")`、`Some("socks5://127.0.0.1:1080")`。`None` 表示不走代理。仅当 URL 能解析为绝对地址时才应用，否则静默忽略。 |
| `ignore_ssl_certs` | `bool` | `false` | 为 `true` 时禁用 TLS 证书校验（reqwest `danger_accept_invalid_certs(true)`），用于自签/不受信任证书的场景。默认开启证书校验。 |

## 生效范围（`src/manager.rs` `build_clients`）

- HTTP/2（`h2`）客户端与（开启 `http3` feature 且 `enable_http3` 时）HTTP/3 客户端**都**应用这两个选项。
- 代理通过 `reqwest::Proxy::all(url)` 解析；解析失败（非法/不支持的 scheme）时静默跳过代理，不改变行为。
- `ignore_ssl_certs == true` 时对两个客户端都调用 `.danger_accept_invalid_certs(true)`。
- 其余既有客户端设置（timeout、connect_timeout、user_agent、h2 自适应窗口、大帧、tcp_keepalive 等）保持不变。

## 说明

- 代理 scheme 支持取决于 reqwest 编译期 features：当前 Cargo.toml 仅启用 `http2`/`rustls-tls`/`stream`，HTTP 代理可用；`socks5://` 需要 reqwest 的 `socks` feature，未启用时该类 URL 会被 `if let Ok` 静默忽略（不报错）。
- 新增单元测试覆盖：`DownloadOptions::default()` 为 `proxy == None`、`ignore_ssl_certs == false`，以及带代理 + `ignore_ssl_certs=true` 构造 `DownloadManager` 不 panic。


## 修订记录
| 日期 | 版本 | 修改内容 | 修改人 |
| 2026-08-20 | v1.0 | 初版创建 | AI Agent |

### 2026-10-04 更新

## 启动器后端侧的作用范围界定（2026-10-04 补充）

以上是 downloader 子模块自身的选项语义。在**启动器后端**（`src-backend/qomicex-backend/`）里，设置项 `ignoreSslCert`（`settings.rs` 的 `ignore_ssl_cert`）会被散播到多个 reqwest 客户端，**但不是无差别生效**：

| 客户端 / 链路 | 是否应用 `ignore_ssl_cert` | 说明 |
| :--- | :--- | :--- |
| 共享 `http_client`（`build_http_client`） | 是 | 启动器大部分出站请求 |
| 插件 proxy 客户端 `proxy_client` | 是 | 对应 C# 命名 HttpClient "PluginProxy" |
| downloader / core 内部客户端 | 是 | 经 `DownloadOptions` / `CoreOptions` 传入 |
| **插件包直链下载 `plugin_download_client`** | **否（刻意例外）** | 见下 |

### 为什么 `plugin_download_client` 不继承（issue #127 / PR #173）

该客户端服务于 `POST /api/plugins/install-url`（深链快捷安装），下载的是**马上要被当成代码安装的 `.qplugin`**。若继承 `ignore_ssl_cert`，则用户为「自签名/内网镜像」开的那个设置会顺带允许中间人用任意包替换正在安装的插件 —— 与本端点其余防护（SSRF 校验 / 禁重定向 / 体积上限）自相矛盾。

因此该客户端**始终校验证书**；其余参数（代理、`no_proxy`、UA、60s 超时）仍继承 —— 代理不降低安全边界，且不继承会破坏企业内网环境。官方分发（`cdn.qomicex.top`）用有效证书，正常路径不受影响；确需自签名源的场景应走「本地上传」，那条路用户能看到实际文件。

> 该取舍曾以「参数与共享客户端一致」的形式写进 ADR-100 初版，后被证伪并修正。修复同时消掉了 CodeQL `rust/disabled-certificate-check`（severity **high**）告警 —— 该规则对 PR 变更行报警，先前 `danger_accept_invalid_certs` 出现在新增行上即被标记。

### 排障提示：查 CodeQL 告警必须显式传 `ref`

`GET /repos/{owner}/{repo}/code-scanning/alerts` **不加 `ref=` 参数时只返回默认分支的告警**。统计某个 PR/分支的告警必须显式传 `ref=refs/pull/<N>/merge` 或 `ref=refs/heads/<branch>`，否则会把「默认分支之外的告警数 = 0」这个恒真式误当成「没有新告警」的证据（该误判曾真实发生过一次）。


