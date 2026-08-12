# CHECKPOINT BATCH 1 — core 工厂方法

**日期**: 2026-08-13
**分支**: migrate/server-management
**状态**: ✅ 编译通过

## 内容

- `qomicex-core-rust/src/api/local.rs`：`LocalResourcesFactory` trait 新增 `create_server_manager(version, version_specific) -> Box<dyn ServerManager + Send + Sync>`（对应 C# `ContentService.CreateServerManager`，game_dir 由工厂 game_root 提供）
- `qomicex-core-rust/src/services/local/factory.rs`：`DefaultLocalResourcesFactory` 实现，`Box::new(ServerManager::new(game_root, version, version_specific))`
- `MAPPING_TABLE.yaml`：新增服务器管理端点/类型/工厂映射段
- `ADR-007`：工厂方法决策记录（Subagent 生成，已审阅）

## 验证

```
cargo check --manifest-path C:\Project\Qomicex.Tauri\qomicex-core-rust\Cargo.toml
Finished `dev` profile [unoptimized + debuginfo] target(s)
```

符合预期：编译通过、零警告。

## 下一步

Batch 2：后端 `instance_files.rs` 替换 4 个 501 stub（servers GET/POST、servers DELETE、server-ping、lan-games），调用 core 工厂方法。
