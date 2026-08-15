# ADR-012：check-updates 更新判定：Modrinth game_versions 序列化修复 + CurseForge latest_files 客户端过滤

| 属性 | 内容 |
|:---|:---|
| 状态 | 已采纳 |
| 日期 | 2026-08-15 |
| 决策者 | AI Agent |

## 背景

check-updates 为 1.21.1 NeoForge 实例报出 mc26.2/fabric 版本，1.12.2 Forge 实例的 EasyLAN 被错误匹配为 EasyLAN-fabric-1.21.11。根因两处：① Modrinth 侧 VersionFilesUpdateRequest 被 rename_all=camelCase 序列化成 gameVersions，而 API 期望 snake_case game_versions，该过滤条件被静默忽略，退化为仅按 loaders 过滤；② CurseForge 侧指纹接口的 latestFiles 不随 gameVersion/modLoader 参数过滤，后端直接取日期最新者导致跨版本/跨加载器错配。

## 决策

① Modrinth：VersionFilesUpdateRequest.game_versions 字段加 #[serde(rename="game_versions")] 显式序列化键，恢复游戏版本过滤（实测 camelCase 返 appleskin-neoforge-mc26.2-3.0.10，snake_case 返 3.0.9）。② CurseForge：不改请求（CF API 忽略过滤参数），改为在后端 refresh_mod_updates 的 CF 分支对 latest_files 自行过滤——game_versions 须包含实例 game_version，且 game_versions 中出现 mod_loader_type::ALL 已知加载器名时须与实例 loader 大小写不敏感一致，之后取最新 Available 文件。涉及模更新端点行为变更，故记录 ADR。

## 备选方案


### 方案 给 CF 指纹请求加 gameVersion/modLoader 参数
- 优点：改动小，FingerprintsRequest 加可选字段即可
- 缺点：实证 CF API 忽略这两个参数，latestFiles 结果不变，无法解决问题
- 为何不选：已用真实指纹实测三次请求结果完全一致，排除

### 方案 CF 分支仅按 game_versions 过滤，不校验加载器
- 优点：更简单
- 缺点：同版本跨加载器（如 forge/fabric 同 MC 版本）时仍可能错配
- 为何不选：加上加载器一致性校验，成本仅几行

## 影响
- check-updates 与批量更新提示结果显著更准确（Create+ 246→99 条且 CF 条目全为 neoforge/1.21.1）
- CF 侧依赖游戏版本字符串在 gameVersions 中的精确匹配，个别 CF 文件的版本串不规范时可能漏报更新
- instance_files.rs 新增 qomicex_core::models::expansion::curseforge::mod_loader_type 导入

## 修订记录
| 日期 | 版本 | 修改内容 | 修改人 |
|:---|:---|:---|:---|
| 2026-08-15 | v1.0 | 初版创建 | AI Agent |
