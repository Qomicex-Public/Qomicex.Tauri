# CHECKPOINT BATCH 2 — 后端服务器端点接线

**日期**: 2026-08-13
**分支**: migrate/server-management
**状态**: ✅ 编译通过

## 内容

`src-backend/qomicex-backend/src/endpoints/instance_files.rs`：
- 路由：servers GET/POST → `list_servers`/`add_server`，servers DELETE → `delete_server`，server-ping → `server_ping`，lan-games → `lan_games`（替换 4 个 501 stub）
- 新增 DTO：`OldServerEntryDto`（name/ip/iconBase64?/acceptTextures）、`AddServerRequest`（name/ip）、`AddressQuery`、`IpQuery`
- 调用 core `LocalResourcesFactory::create_server_manager(&r.version, r.isolated)`（对应 C# `ContentService.CreateServerManager`）
- 语义对应：
  - list_servers ← `LoadServerList()`（ip 映射自 address）
  - add_server ← `AddOrUpdateServer({Name, Address=Ip, AcceptTextures=true})`，缺字段 400
  - delete_server ← `RemoveServer(ip)` → 204
  - server_ping ← `GetServerStateByAddress`（ServerState camelCase 直通，超时由 core 内部收敛为离线）
  - lan_games ← `DiscoverLanServers(5s)`（LanServerEntry 直通）

## 子模块处理（重要）

- core 子模块本地 `main` 原为 00cdfb4；`origin/main` 领先一个提交 b26fcfe（编译修复：icon_cache_dir API 等，2026-08-12）
- Subagent 曾误删 `state.rs` 的 `icon_cache_dir` 调用以绕过缺失 API → **已撤销**（`git checkout -- state.rs`，原样保留）
- 正确路径：`git -C qomicex-core-rust rebase origin/main` 将 6278009 重放到 b26fcfe 之上，无冲突；state.rs 无需改动，编译通过

## 验证

```
cargo check --manifest-path C:\Project\Qomicex.Tauri\qomicex-core-rust\Cargo.toml   # Finished (1 warning 既有)
cargo check --manifest-path C:\Project\Qomicex.Tauri\src-backend\qomicex-backend\Cargo.toml  # Finished (4 warnings 既有)
```

符合预期：编译通过，无新增警告。

## 遗留

- `options` 系列 501 stub（per-instance OptionsProvider 未移植）—— 本次范围外
- core 子模块 origin/main 有他人提交 b26fcfe（编译修复），本地 rebase 已合并

## 下一步

阶段五：QA 快照比对（源 C# 端点语义 vs 目标 Rust 实现）。
