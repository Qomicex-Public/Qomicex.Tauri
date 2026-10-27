# ADR-122：游戏目录搬迁时接管实例设置——修复 gameDir 变更导致 JVM 参数丢失

| 属性 | 内容 |
|---|---|
| 状态 | 已采纳 |
| 日期 | 2026-10-26 |
| 决策者 | AI Agent（人工复核） |

## 背景

用户反馈：导入 MMC 格式的 GTNH 2.8.4 后一开始可以正常游玩，过一段时间 JVM
参数被重置为默认值，游戏直接无法启动。以下为**合成示例**，不对应任何真实用户
路径或实例 id：

- 旧实例记录：`id=example-instance`、`name=GTNH 2.8.4`、`gameDir=<gameDir-A>`；
- 用户把整个 `.minecraft` 迁移到 `<gameDir-B>`，随后旧目录的 `versions/`
  被清空；
- 迁移后记录里 `jvmArgs`、`javaPath`、`versionIsolation`、`modpackName`
  全部缺失，`maxMemory` 回到默认值，`id` 也变成新的。

根因不是 MMC 导入没有写入 JVM 参数，而是**实例身份键包含 `game_dir`**：

- `sync_from_disk` 按 `(game_dir, name)` 匹配记录；
- 第 1 步清理残留时，旧 `game_dir` 下 `versions/{name}` 已不存在 → 删除旧记录；
- 第 4 步在新 `game_dir` 下找不到记录 → 用 `Default` 新建一条记录；
- 新记录只从磁盘扫描补图标/版本/loader，JVM 参数、内存、Java 路径、备注、
  分组与游玩统计全部归零，`id` 也换成新的。

GTNH 这类包依赖 `lwjgl3ify` 注入的 `--add-opens`、`-Djava.system.class.loader`
等参数；参数丢失后启动必然失败。此前 issue #244 / ADR-111 修的是「版本 JSON
`id` 与目录名漂移」，不覆盖「整个游戏目录换盘」这一路径。

## 决策

在 `sync_from_disk` 清理残留**之前**增加一次搬迁接管（第 1b 步），并在写回前
对持有实例锁的最新列表的克隆再执行一次，避免并发合并把刚补回的设置当成用户
改动；任何 `qomicex.json` 写失败都放弃本次扫描写回并保留旧记录。

接管条件（必须同时满足，避免把并存的多个游戏目录或不可访问的卷误合并）：

1. 旧记录 `versionIsolation` 生效（共享目录无法用版本目录是否存在判断搬迁）；
2. 旧 `game_dir` 与新 `game_dir` 归一化（解析 + canonicalize）后的根路径不同；
3. 旧根目录状态不是 `Unknown`（卷暂时不可用/权限不足时不接管），且
   `versions/{记录名}`、`versions/{扫描目录名}`、按旧 `game_dir` 反查出的
   JSON id 别名目录都**确认不存在**；
4. 记录名命中扫描目录名，或命中版本 JSON `id`（兼容旧客户端的身份漂移）；
5. 游戏版本双方都非空且一致；loader 双方都有时规范化后一致，双方都无才视为
   一致——缺失元数据不当作匹配；
6. 符合条件的来源记录**唯一**；多个已删除目录都匹配时放弃接管，避免把无关
   安装的账号令牌/JVM 参数带过来。

两种落地方式：

- **新目录还没有记录**：直接把旧记录搬到新 `game_dir`，保留原 `id` 与全部设置；
  若新目录已带 `qomicex.json`（整目录搬迁），先用它按项合并。
- **新目录已有记录**（用户先切目录、后删旧目录的常见顺序）：把旧记录里新记录
  缺失、且用户**没有显式清空**的设置逐键补进新记录，保留新记录的 `id` 与统计；
  补写后立即 `write_full` 刷新新目录的 `qomicex.json`，只有写成功才删除旧记录。
  若旧记录是默认实例而新记录 id 不同，同步把 `default_instance.json` 改指新 id。

`GameInstance` 新增 `clearedSettings` 镜像字段，记录用户通过更新接口显式清空/
重置过的键（JVM、Java 路径、内存、备注、隔离、校验、隐藏、分组等）。
搬迁接管遇到这些键时保持目标值，不再把旧目录的值补回；旧记录上的标记也会继承，
避免以后从更老的记录复活。`lastPlayed` 取两者较晚值，`loaderVersion` 缺失时补旧值。
账号名/UUID/accessToken 不跨记录搬运：搬迁接管是启发式匹配，即使来源唯一也可能
选错，凭据泄漏的代价高于少恢复一次登录态；目标没有账号时走全局账号选择。

同时，MMC 导入写 JVM 参数由 `get_by_id` + `update` 整对象替换、忽略错误，改为
`update_with` 只补丁 `jvm_args`；记录不存在或独立配置落盘失败会让导入任务失败
并给出可读原因，不再静默留下一个启动必崩的实例。Technic/Solder 的元数据回写也
改为字段补丁并记录失败。

## 备选方案

### 方案 保留版本目录不存在的记录（幽灵记录）

- 优点：不会删设置，搬迁后按名字重新命中即可恢复
- 缺点：删除实例后记录永久残留，列表/DELETE/默认实例引用都会出现悬空项；
  ADR-111 评审已明确否决
- 为何不选：无法区分「临时搬迁」与「用户已删除」

### 方案 只在前端切换目录时批量改 `game_dir`

- 优点：语义直接，不需要扫描期猜测
- 缺点：插件、脚本、手动改 `settings.json`、旧客户端都不会走该入口；旧数据
  已经丢失时也无法补救；前端并不持有完整的实例列表写入能力
- 为何不选：存储层必须兜底

### 方案 只看同名就合并，不检查旧目录是否还存在

- 优点：实现简单，能覆盖「复制后保留旧目录」的顺序
- 缺点：用户可能有意在两个目录并存两份同名同版本实例，合并会偷走其中一份的
  JVM/内存设置；旧卷暂时离线时也会误判
- 为何不选：误合并的代价高于少恢复一次；旧目录真实存在或状态未知时保持两条记录

### 方案 把 MMC `+jvmArgs` 注入版本 JSON `arguments.jvm` 作为兜底

- 优点：实例记录再次丢失时仍能启动
- 缺点：MMC 常见旧格式版本 JSON 没有 `arguments.game`，直接注入 `arguments.jvm`
  会触发启动报错；且用户显式清空 JVM 参数后，版本 JSON 兜底会让参数「复活」
- 为何不选：需要额外的覆盖标记与格式分支，风险大于收益；独立配置
  `qomicex.json` 已能在记录丢失时恢复设置

## 影响

- `services/instance.rs`：新增 `scanned_dir_name`、`adopt_moved_game_dir_instances`、
  `find_moved_game_dir_source`、`carry_orphan_settings`、`cleared_settings` 跟踪；
  第 1b 步与第 6 步写回前各执行一次；第 4 步统一使用预先解析的目录名；
  游戏根目录、去重键与重复校验统一走 `normalized_game_root`。
- `endpoints/modpack.rs`：MMC 导入的 JVM 参数回写改为 `update_with` 并传播失败；
  Technic/Solder 元数据回写改为字段补丁。
- 行为限制：只接管隔离开启、旧版本目录确认不存在、元数据确认兼容且来源唯一的
  记录；写 `qomicex.json` 失败时保留旧记录并放弃本次扫描写回。
- 对已经丢失且旧记录已被删除的存量实例，磁盘上没有可自动恢复的 JVM 参数；
  需要用户重新导入原始 MMC 包或在实例设置中重新填写。

## 验证

- `sync_from_disk_adopts_settings_when_game_dir_moves`：旧目录已删、新目录无记录，
  原 `id`/JVM/内存/Java/备注/统计全部保留，新目录写入 `qomicex.json`，重启后仍在。
- `sync_from_disk_restores_settings_into_existing_default_record`：新目录已有默认
  记录且有游玩统计，旧目录随后删除，设置补进新记录且旧记录被清理。
- `sync_from_disk_respects_user_cleared_settings`：目标记录显式清空 JVM/内存后，
  旧值不得被补回。
- `sync_from_disk_does_not_guess_between_multiple_orphan_sources`：多个同名来源
  无法判定时不接管。
- `sync_from_disk_aborts_writeback_when_qomicex_cannot_be_written`：配置写失败时
  保留旧记录，不假装恢复成功。
- `sync_from_disk_does_not_adopt_when_legacy_alias_dir_still_exists`：旧记录名为
  JSON id、实际目录仍存在时只修复名字，不搬走设置。
- `sync_from_disk_keeps_settings_when_version_omitted_from_scan`：扫描条目缺少
  版本信息时不误删已有记录（原有防御网回归）。
- `sync_from_disk_does_not_steal_settings_when_old_game_dir_still_exists`：旧目录
  仍存在时保持两条记录，不偷设置。
- `sync_from_disk_does_not_adopt_across_game_versions`：同名但 1.20.1 → 1.7.10
  不接管。
- `sync_from_disk_does_not_adopt_without_compatible_metadata`：缺少版本/loader
  元数据时不接管。
- `update_with_tracks_user_cleared_settings`：清空/重置会记录标记，重新设置有值
  会取消标记。
- `merge_concurrent_writeback_respects_clear_after_adoption`：同步接管先补值、用户
  随后清空时，写回合并不留下旧值。
- 现有 10 个 `sync_from_disk_*` 回归用例全部通过；新增 7 个用例后共 17 个相关
  用例通过（`cargo test --bin qomicex-backend` 575 passed / 0 failed / 2 ignored）。
