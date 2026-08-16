# ADR-022：存档设置管理（level.dat NBT 编辑，core-rust 实现）

| 属性 | 内容 |
|---|---|
| 状态 | 已采纳 |
| 日期 | 2026-08-16 |
| 决策者 | AI Agent + 用户 |

## 背景

实例管理的「存档」tab 需要新增「存档设置管理」：按存档编辑其设置，实现方式为读写存档目录的 NBT 文件 `level.dat`（及 `level.dat_old`），NBT 编辑参考现有「服务器管理」（servers.dat NBT 读写模式）与 [Minecraft wiki NBT 格式](https://zh.minecraft.wiki/w/%E5%AD%98%E6%A1%A3%E5%9F%BA%E7%A1%80%E6%95%B0%E6%8D%AE%E5%AD%98%E5%82%A8%E6%A0%BC%E5%BC%8F?variant=zh-cn)。Gate 0 预检确认上游（origin/main 与子模块）未实现该功能，自研。

用户确认方案 **A1+B1+C1+D1+E1**，并补充「存档管理的实现可以加到 core-rust 里」（业务逻辑也进 core，不只 NBT 解析器）。

## 决策

- **core-rust**：
  - `util/nbt_full.rs`：把 `services/local/saves.rs`（B10）的私有全量 NBT 解析器（gzip 魔数探测、Byte/Short/Int/Long/Float/Double/String/List/Compound/IntArray/LongArray、`Vec` 保插入序写回）提升为公共模块；saves.rs 改为复用，行为不变。
  - `services/local/level_dat.rs`（pub(crate)）：精选白名单字段读写 `LevelDatSettings`（LevelName/GameType/Difficulty/allowCommands/hardcore/Time/DayTime/raining/thundering/SpawnX/Y/Z/RandomSeed + GameRules 子集 6 项）；**写前自动备份 `level.dat.qomicex.bak`、任一步失败回滚原字节、全树往返保留未知键/类型**；`restore_from_old` 从 `level.dat_old` 恢复（备份当前后覆盖，_old 也须为合法 NBT）；缺失字段读取取默认值。
  - `api/local.rs` `SavesManager` trait 新增 `read_level_dat_settings` / `update_level_dat_settings` / `restore_level_dat_from_old`（Result 返回，错误统一 `Error::Params`）；DTO `LevelDatSettings`/`LevelGameRules` 入 `models/expansion/local.rs`（camelCase）。
- **backend**：仅加 3 个薄端点（经 `create_saves()` trait 门面调用，不重复实现）：
  - `GET  /instance/{id}/files/saves/{name}/settings`（读；level.dat 缺失 → 404 SAVE_LEVEL_DAT_NOT_FOUND）
  - `PUT  /instance/{id}/files/saves/{name}/settings`（写；返回服务器侧重读值）
  - `POST /instance/{id}/files/saves/{name}/settings/restore`（恢复；_old 缺失 → 404 SAVE_LEVEL_DAT_OLD_NOT_FOUND）
  - core `Error::Params` → 400，其余 → 500。
- **前端**：`SaveCard` 每存档加「设置」按钮（⚙，与备份/重命名并列，右键菜单同步）→ `SaveSettingsDialog` 精选表单（Select 模式/难度、数字输入时间/出生点/种子、Checkbox 作弊/硬核/天气/游戏规则）；实例运行中显示警告；「从 level.dat_old 恢复」走 `useMessageBox().confirm` 二次确认；保存成功刷新存档列表（名称变更）。
- **i18n**：`saveSettings.*` 与 `dialogs.save.settings` 文案入 i18n submodule 三语言（zh-CN/en-US/en-GB，zh-TW 回退 zh-CN），编辑翻译在 i18n 仓库单独提交推送。

## 备选方案

### 方案 A2：NBT 全套逻辑写进 backend
- 优点：不碰 core 子模块
- 缺点：重复实现 NBT 解析/序列化，与 core 既有实现分叉漂移
- 为何不选：拒绝：core 已有经测试的全量解析器（saves.rs B10），提升为公共模块复用更优

### 方案 B2/B3：独立「存档设置」tab / 存档详情页
- 优点：入口更显眼
- 缺点：多一步先选存档导航 / 需新建页面成本高
- 为何不选：拒绝：与服务器管理一致的行内按钮弹窗最顺手

### 方案 C2/C3：全量 NBT 树编辑器（JSON 树形编辑任意字段）
- 优点：可编辑任意字段
- 缺点：风险高（改坏世界存档）、UI 成本大
- 为何不选：拒绝：精选白名单表单安全直观，未知键经全树往返天然保留

### 方案 D2/D3：level.dat 与 level.dat_old 同步编辑
- 优点：自由度更高
- 缺点：`_old` 本就是上一会话快照，同步写破坏其语义
- 为何不选：拒绝：只编辑 level.dat + 提供「从 _old 恢复」最合理

## 影响
- qomicex-core-rust（子模块，单独提交推送 4130c52）：新增 `util/nbt_full.rs`、`services/local/level_dat.rs`（+7 单测）；saves.rs 重构复用；`api/local.rs` trait + `models/expansion/local.rs` DTO
- src-backend/qomicex-backend/src/endpoints/instance_files.rs：+3 端点（save_settings_get/put/restore、save_settings_dir/saves_manager/map_level_dat_error 辅助）
- src/：types/index.ts（SaveSettings/SaveGameRules）、api/instance-files.ts（getSaveSettings/updateSaveSettings/restoreSaveFromOld）、components/SaveSettingsDialog.tsx（新）、components/SaveCard.tsx（⚙ 按钮+弹窗+running）、pages/InstanceDetail.tsx（running 透传）
- qomicex-tauri-i18n（子模块，单独提交推送 c5a4900）：saveSettings 文案 3 语言
- 验证：core cargo test 全绿（28 lib+9 integration）；backend cargo test 37 通过；前端 tsc+vite build 通过；临时 backend + 合成 gzip level.dat 端到端验证 GET/PUT/重读/备份文件/restore/404/400 全通过

## 修订记录
| 日期 | 版本 | 修改内容 | 修改人 |
|---|---|---|---|
| 2026-08-16 | v1.0 | 初版创建 | AI Agent |
| 2026-08-16 | v1.1 | 存档设置扩展（Z1 一期）：① 修复三语言缺失的 `saveSettings.allowCommands`/`hardcore` i18n 键；② Data 白名单新增 `DifficultyLocked`/`clearWeatherTime`/`rainTime`/`thunderTime`/`WanderingTraderSpawnChance`/`SpawnDelay` + 世界边界 7 项（BorderCenterX/Z、BorderSize、BorderSafeZone、BorderDamagePerBlock、BorderWarningBlocks、BorderWarningTime）；③ GameRules 扩展 20 布尔 + 3 数值（randomTickSpeed/spawnRadius/maxEntityCramming，String 数字）；④ level.dat 双格式映射（按内容探测，不依赖 DataVersion）：`Data.difficulty_settings` 存在 → 难度/硬核/锁定读写 `difficulty_settings{difficulty:String,hardcore,locked}`，`Data.spawn` 存在 → 出生点读写 `spawn.pos`(IntArray)，否则经典键；残留键保留（未知键保留原则）。安全模型不变（写前备份/失败回滚/全树往返）；新增 DTO 字段**不加** `#[serde(default)]`（保持全量提交语义：旧客户端 PUT 因缺字段被后端 400 拒绝，避免默认值（如 borderSize=0）静默覆盖写坏存档）。决策记录见 .memory/decisions/2026-08-16T12-16-22。已知限制：26.1snap6+ 重构格式（GameRules/天气/边界/商人移出到 game_rules.dat/weather.dat/world_border.dat/wandering_trader.dat）本期不生效，完整支持为二期任务。core 2448273 / i18n b666ecc | AI Agent |
