# ADR-013：check-updates loader 兼容回退：非标准加载器（Cleanroom/LiteLoader）按 Forge 兼容处理

| 属性 | 内容 |
|:---|:---|
| 状态 | 已采纳 |
| 日期 | 2026-08-15 |
| 决策者 | AI Agent |

## 背景

1.12.2-Cleanroom-0.6.7-alpha 实例（loader=Cleanroom）mods 目录 jei_1.12.2-4.16.5.1023.jar，check-updates 扫不出最新 4.16.5.1027。Modrinth 上 JEI 1.12.2 全部版本 loaders=["forge"]，Cleanroom 非 Modrinth 已知加载器 → 严格按 loaders=["cleanroom"] 过滤结果为空。CurseForge 侧同理：实例 loader 非已知 CF 加载器时加载器一致性校验误伤。

## 决策

① Modrinth 分支：严格按实例 loader 过滤的 latest 反查返回后，对未命中的 sha1 用「任意 loader + 同游戏版本」回退重查并合并到 latest_map。② CurseForge 分支：实例 loader 不在 mod_loader_type::ALL（Forge/LiteLoader/Fabric/Quilt/NeoForge）时视为 Forge 兼容，跳过加载器一致性校验（仅保留 game_versions 过滤）。两条均只在标准加载器严格过滤有效时保持原行为，Cleanroom/LiteLoader 等非标准加载器按 Forge 系兼容处理。

## 备选方案


### 方案 把非标准 loader 显式映射到 forge
- 优点：语义最直白
- 缺点：Cleanroom/LiteLoader 等需逐个硬编码映射，漏一个就再修一个
- 为何不选：未说明

### 方案 恒用空 loader 查
- 优点：实现最简单
- 缺点：对所有实例多一次 API 调用
- 为何不选：浪费请求

### 方案 严格过滤漏配哈希回退任意 loader
- 优点：精准、不影响标准加载器实例
- 缺点：Modrinth 严格过滤为空时需重查，多一次 API 调用（仅此场景）
- 为何不选：采纳

## 影响
- Cleanroom 实例 JEI 1023→1027 正常检出（用户场景复测通过）
- EasyLAN(forge 1.12.2)/Create+(neoforge 1.21.1) 回归无损
- 副作用上限：某 mod 对实例 loader 无任何版本时回退可能建议其他加载器版本（少见，前端可自行拒绝）

## 修订记录
| 日期 | 版本 | 修改内容 | 修改人 |
|:---|:---|:---|:---|
| 2026-08-15 | v1.0 | 初版创建 | AI Agent |
