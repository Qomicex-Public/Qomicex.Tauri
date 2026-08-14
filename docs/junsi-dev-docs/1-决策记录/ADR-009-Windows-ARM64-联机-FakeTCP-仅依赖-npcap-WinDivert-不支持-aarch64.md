# ADR-009：Windows ARM64 联机 FakeTCP 仅依赖 npcap，WinDivert 不支持 aarch64

| 属性 | 内容 |
|---|---|
| 状态 | 已采纳 |
| 日期 | 2026-08-13 |
| 决策者 | AI Agent |

## 背景

排查"Windows ARM 端 FakeTCP 联机是否可用"时发现：EasyTier4QML fork 的 `easytier/third_party/arm64/WinDivert64.sys` 内容是纯文本占位符（"WinDivert doesn't support aarch64, this is a placeholder file to make tauri happy."），并非真实驱动。需要固化 ARM64 联机协议栈的事实，避免将来误判"connector 的 arm64 third_party 缺 WinDivert 文件导致功能不可用"。

## 决策

Windows ARM64 的 FakeTCP 联机支持成立且与 WinDivert 无关：1) easytier 的 windivert 依赖被 `[target.'cfg(all(windows, any(target_arch = "x86_64", target_arch = "x86")))']` 排除，aarch64 完全不编译 WinDivert（windivert-sys build.rs 对非 x86/x64 直接 panic!("Unsupported target architecture!")，但该依赖在 ARM64 目标上根本不参与构建）；2) ARM64 上 faketcp netfilter 走 `pnet`（npcap，Packet.lib），Windows UDP 广播捕获走 raw socket（capture_raw.rs，需管理员）；3) 运行时只需 arm64 版 Packet.dll（release.yml windows-arm64 job 已从 `qomicex-connector-rust/easytier/third_party/arm64/` 打包），不需要 WinDivert64.sys；4) connector-rust 工作区根 third_party/arm64 不携带 WinDivert64.sys 是正确的。x64/x86 上 WinDivert 也只是可选后端：无 WinDivert64.sys 时 open 失败自动 fallback 到 pnet，faketcp 依旧可用。

## 备选方案

### 方案 在 connector-rust 的 third_party/arm64 添加占位 WinDivert64.sys
- 优点：与 fork 目录结构完全一致
- 缺点：无用死资源，easytier aarch64 构建/运行均不引用它
- 为何不选：不采纳：会误导后人以为 ARM64 需要该文件

## 影响
- qomicex-connector-rust/easytier/third_party/arm64/（保持现状：仅 Packet.dll/lib + wintun.dll）
- .github/workflows/release.yml windows-arm64 job（已正确打包 arm64 Packet.dll/wintun.dll）
- AGENTS.md 联机注意事项（可补充 ARM64 无 WinDivert 约束说明）

## 修订记录
| 日期 | 版本 | 修改内容 | 修改人 |
|---|---|---|---|
| 2026-08-13 | v1.0 | 初版创建 | AI Agent |