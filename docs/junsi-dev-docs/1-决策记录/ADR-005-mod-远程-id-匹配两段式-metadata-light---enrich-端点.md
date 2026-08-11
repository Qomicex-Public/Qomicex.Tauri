# ADR-005：mod 远程 id 匹配两段式：metadata light + enrich 端点

| 属性 | 内容 |
|---|---|
| 状态 | 已采纳 |
| 日期 | 2026-08-11 |
| 决策者 | AI Agent |

## 背景

mods_metadata 原为同步完整扫描（本地 + Modrinth SHA1/CurseForge 指纹网络反查），182+ mods 时 20-54s，远超前端 15s 全局请求超时 → mod 列表永远显示不出来（已先 light 化修复）。但 light 化后 mr/cf id 全空，右键「查看详情」（资源中心跳转）失效。C# 核心（Qomicex.Core.AOT Mods.cs）是同步反查取 ProjectId/ModId（file id 在响应里但未落盘）。

## 决策

两段式：GET /instance/{id}/files/mods/metadata 保持 light（秒回列表展示）；新增 POST /instance/{id}/files/mods/enrich——light 扫描 + enrich_mod_ids（MR version_files 按 SHA1 批量、CF fingerprints 按指纹批量，各一次 API 调用）返回 fileName→{curseForgeId, modrinthId, modrinthVersionId, curseForgeFileId, source} 映射，前端 ModsTab 加载列表后异步调用按 fileName 合并（「查看详情」在 id 就绪后出现，反查失败不影响列表）。core：ModInfo 增加 modrinth_version_id/curse_forge_file_id（C# 响应有但未落盘的 file id），enrich_from_remote 提升为 ModsManager::enrich_mod_ids。舍弃同步反查（超前端 15s 超时）与后端缓存（首次仍慢）。

## 备选方案

### 方案 B 同步反查
- 优点：一次请求全量、完全对齐 C#
- 缺点：20-54s 超前端 15s 全局超时，需前端豁免；MR/CF 抖动整体失败
- 为何不选：用户体验差

### 方案 C 反查+后端缓存
- 优点：重复打开秒回
- 缺点：首次仍慢；缓存失效逻辑
- 为何不选：首次体验未解决

## 影响
- qomicex-core-rust: models/expansion/local.rs（ModInfo +2 字段）、services/local/mods.rs（enrich 提升 trait + file id 填充）、api/local.rs（trait +enrich_mod_ids）
- src-backend: instance_files.rs（ModMetadataDto +2 字段、POST /files/mods/enrich 端点）
- 前端: instance-files.ts（enrichMods）、types（ModEnrichEntry）、InstanceDetail.tsx（ModsTab 异步补全）

## 修订记录
| 日期 | 版本 | 修改内容 | 修改人 |
|---|---|---|---|
| 2026-08-11 | v1.0 | 初版创建 | AI Agent |