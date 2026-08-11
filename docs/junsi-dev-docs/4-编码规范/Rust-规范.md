# Rust 编码规范

> 生成时间：2026-08-09 16:37

# Rust 编码规范

适用于 `src-backend/qomicex-backend/`（主后端）与 `src-tauri/`（桌面壳）。

## 代码风格

- 使用 `rustfmt` 默认配置（`cargo fmt`），行宽 100
- 使用 `cargo clippy` 检查，保持无 warning
- 模块组织：`src/endpoints/<domain>.rs`（每个模块导出 `router()` 函数，在 `app.rs` 中 `merge` 到 `/api` 根路由）
- 错误处理：统一返回 `ApiResult<T>`（`error.rs` 中 thiserror 定义），handler 不用 try/catch 模式
- 未实现的功能用 `_501` 后缀函数返回 `StatusCode::NOT_IMPLEMENTED`，并注释说明依赖哪个服务（如 `// 501 stubs: launch (depend on LaunchTracker)`）
- 端点模块顶部用 `//!` 文档注释说明模块职责和未移植部分

## 跨平台规则

- 路径拼接用 `std::path::PathBuf` / `Path::join`，禁止硬编码盘符或 `\`
- 平台判断用 `cfg!(windows)` / `cfg!(unix)` 或 `#[cfg(...)]`（不用 `cfg(not(windows))` 表示 unix）
- 打开文件/URL 用 `open` crate（对应 C# 的 `UseShellExecute = true`）
- 系统信息用 `sysinfo` crate

## 状态管理

- 共享状态集中在 `state.rs` 的 `AppState`，通过 `Arc<AppState>` 注入 Router
- 监听地址固定 `127.0.0.1`，端口 `QOMICEX_PORT` 环境变量覆盖，默认 5000

## 依赖约定

- 核心引擎 `qomicex-core-rust`、下载器 `qomicex-downloader-rust`、连接器 `qomicex-connector-rust` 为同级目录 crate，通过相对路径 `path = "../../..."` 引用
- 许可证相关代码用 feature `license-required` 门控（对应 C# `-p:LicenseRequired=true`）


## 修订记录
| 日期 | 版本 | 修改内容 | 修改人 |
| 2026-08-09 | v1.0 | 初版创建 | AI Agent |