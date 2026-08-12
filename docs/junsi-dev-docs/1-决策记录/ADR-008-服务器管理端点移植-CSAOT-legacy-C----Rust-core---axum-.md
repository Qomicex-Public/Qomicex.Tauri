# ADR-008：服务器管理端点移植（CSAOT-legacy C# → Rust core + axum）

| 属性 | 内容 |
|---|---|
| 状态 | 已采纳 |
| 日期 | 2026-08-13 |
| 决策者 | AI Agent |

## 背景

CSAOT-legacy 分支（C# Neo 后端）的服务器管理端点（GET/POST/DELETE /servers、/server-ping、/lan-games）在 main 分支的 Rust 重写中仍是 501 stub（instance_files.rs 注释 "rely on a not-yet-portable per-instance ServerManager"）。core 子模块 qomicex-core-rust 已完整移植 ServerManager（servers.dat CRUD + MC Ping + LAN 发现 + SRV 解析），但 struct 为 pub(crate) 且后端无工厂方法接入。

## 决策

采用 core 工厂方法接线：LocalResourcesFactory 新增 create_server_manager(version, version_specific) -> Box<dyn ServerManager>（对应 C# ContentService.CreateServerManager(gameDir, version, versionSpecific)，game_dir 由工厂持有）；后端每请求通过 core.local_resource_provider().create_server_manager 创建 per-instance 管理器替换 501 stub。C# DTO 语义逐字保留：GET servers → OldServerEntryDto（name/ip/iconBase64?/acceptTextures），POST → AddOrUpdateServer(AcceptTextures=true)，DELETE ?ip= → 204，server-ping ?address= → ServerState 直通（超时离线），lan-games → DiscoverLanServers(5s) 直通。范围仅服务器管理，options 501 stub 留待后续。

## 备选方案

### 方案 后端自实现 ServerManager trait
- 优点：不碰 core 子模块
- 缺点：重复核心逻辑（NBT 解析/Ping 协议/LAN 发现），与 core 既有实现分叉
- 为何不选：拒绝：core 已有 100% 移植的完整实现，自实现是纯浪费

### 方案 把 ServerManager 改为 pub 直接构造
- 优点：改动最小
- 缺点：破坏 core 全 pub(crate) 封装约定，与 create_mods 等既有工厂模式不一致
- 为何不选：拒绝：工厂方法模式是 core 既有惯例（DefaultLocalResourcesFactory）

## 影响
- qomicex-core-rust/src/api/local.rs：trait 新增 create_server_manager
- qomicex-core-rust/src/services/local/factory.rs：实现工厂方法
- src-backend/qomicex-backend/src/endpoints/instance_files.rs：4 个 501 stub → 真实端点（list_servers/add_server/delete_server/server_ping/lan_games）
- qomicex-core-rust/src/api/server.rs + services/server/server.rs：新增 async 变体 get_server_state_by_address_async 修复 sync-over-async panic
- MAPPING_TABLE.yaml：新增服务器管理映射段

## 修订记录
| 日期 | 版本 | 修改内容 | 修改人 |
|---|---|---|---|
| 2026-08-13 | v1.0 | 初版创建 | AI Agent |