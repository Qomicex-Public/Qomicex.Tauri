# ADR-007：LocalResourcesFactory.create_server_manager 工厂方法（ServerManager 移植）

| 属性 | 内容 |
|---|---|
| 状态 | 已采纳 |
| 日期 | 2026-08-13 |
| 决策者 | AI Agent |

## 背景

C# 后端 ContentService.CreateServerManager(gameDir, version, versionSpecific) 创建 ServerManager 实例；Rust 侧服务器管理器（crate::api::server::ServerManager trait + services/server/servers_dat.rs 实现）已存在，但 LocalResourcesFactory 工厂 trait 尚无对应创建入口。本 ADR 记录该工厂方法的映射决策。

## 决策

在 LocalResourcesFactory trait 增加同步方法 create_server_manager(&self, version: &str, version_specific: bool) -> Box<dyn ServerManager + Send + Sync>，DefaultLocalResourcesFactory 实现为 Box::new(ServerManager::new(self.game_root.clone(), version.to_string(), version_specific))。game_dir 参数由工厂持有的 game_root 提供，签名缺省（与 C# 工厂持有 gameRoot 语义一致）；无 apiKey（服务器管理不涉及 Modrinth/CurseForge API）。同步方法（C# 无 Task），返回 Box<dyn> 所有权转移，与 create_mods 等 6 个既有方法形态一致。

## 备选方案

### 方案 显式 game_dir 参数（与 C# 三参签名完全一致）
- 优点：与源签名一一对应，调用方可传任意目录
- 缺点：与工厂持有 game_root 的设计重复，调用方需冗余传参；既有多数 create_* 方法均依赖工厂字段
- 为何不选：拒绝——工厂语义即持有 game_root，由工厂提供更一致

### 方案 异步方法 + 引用返回 &dyn
- 优点：—
- 缺点：C# 无 Task，异步无依据；&dyn 无法持有新建对象（决策见 local.rs 头注释 p18）
- 为何不选：拒绝——同步 + Box<dyn> 与既有工厂方法形态一致

## 影响
- qomicex-core-rust/src/api/local.rs：trait 新增方法 + crate::api::server::ServerManager import + 方法映射表注释
- qomicex-core-rust/src/services/local/factory.rs：impl 新增方法
- 后端接入方后续可直接调用 factory.create_server_manager 获取 ServerManager 实例

## 修订记录
| 日期 | 版本 | 修改内容 | 修改人 |
|---|---|---|---|
| 2026-08-13 | v1.0 | 初版创建 | AI Agent |