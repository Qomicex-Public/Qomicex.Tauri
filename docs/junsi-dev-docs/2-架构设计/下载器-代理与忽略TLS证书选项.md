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