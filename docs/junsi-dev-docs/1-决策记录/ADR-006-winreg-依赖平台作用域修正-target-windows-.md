# ADR-006：winreg 依赖平台作用域修正（target.windows）

| 属性 | 内容 |
|---|---|
| 状态 | 已采纳 |
| 日期 | 2026-08-12 |
| 决策者 | AI Agent |

## 背景

CI release action 在 Linux/macOS（含 arm64）构建 backend 失败：winreg 0.52 的 lib.rs 在非 Windows 平台执行 compile_error!("OS not supported")。定位：src-backend/qomicex-backend/Cargo.toml 在无条件 [dependencies] 段声明 winreg（license_core.rs board_id 读取 Windows 注册表 BIOS 信息）；qomicex-core-rust 的 winreg 已在 [target.'cfg(windows)'.dependencies]（lan_discovery.rs DNS 读取，使用点均有 cfg 保护）。

## 决策

winreg = "0.52" 从 [dependencies] 移至 [target.'cfg(windows)'.dependencies]（与 windows-sys 同段）。代码使用点 license_core.rs:319 已有 #[cfg(windows)] 保护，无需改代码。Windows 构建不变；非 Windows 平台不再编译 winreg crate。

## 备选方案

### 方案 移除 winreg 改用 reg query 命令
- 优点：未说明
- 缺点：board_id 读取 BIOS 信息需解析命令输出，代码改动大且更脆弱
- 为何不选：winreg 是既有实现，仅需修正依赖声明作用域

### 方案 保留无条件依赖 + 代码条件编译
- 优点：未说明
- 缺点：非 Windows 仍会编译 winreg crate（Cargo 对无条件依赖不做平台裁剪），报错依旧
- 为何不选：未解决根本问题

## 影响
- src-backend/qomicex-backend/Cargo.toml
- CI release 各平台 job（win 不变，linux/mac 修复）
- license_core.rs（license-required feature，代码零改动）

## 修订记录
| 日期 | 版本 | 修改内容 | 修改人 |
|---|---|---|---|
| 2026-08-12 | v1.0 | 初版创建 | AI Agent |