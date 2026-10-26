# ADR-122：游戏目录搬迁时接管实例设置——修复 gameDir 变更导致 JVM 参数丢失

| 属性 | 内容 |
|---|---|
| 状态 | 已采纳 |
| 日期 | 2026-10-26 |
| 决策者 | AI Agent |

## 背景

用户反馈：导入 MMC 格式的 GTNH 2.8.4 后一开始可以正常游玩，过一段时间 JVM
参数被重置为默认值，游戏直接无法启动。

现场数据（`C:\qomicex-launcher\data\instances.json`）显示 GTNH 记录：

- `id=c2e942a5-a1c`、`name=GTNH 2.8.4`、`gameDir=E:\.minecraft`；
- `jvmArgs`、`javaPath`、`versionIsolation`、`modpackName` 全部缺失；
- `maxMemory=4096`（默认值），`lastPlayed=2026-10-23`，`playTime=1`。

日志与目录时间线还原了实际经过：

1. 2026-10-11 08:43 在 `C:\.minecraft` 导入 GTNH，实例 id 为 `711a4808-299`；
   08:45 启动并正常游玩 36 分钟。
2. 2026-10-20 13:13 用户把 `.minecraft` 复制到 `E:\.minecraft`，14:34 启动器
   扫描的 `gameDir` 变为 `E:\.minecraft`；随后 `C:\.minecraft\versions` 被清空。
3. 2026-10-23 07:48 启动 `c2e942a5-a1c`，进程立即以 code=1 退出。

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
对持有实例锁的最新列表再执行一次，避免并发合并把刚补回的设置当成用户改动。

接管条件（必须同时满足，避免把并存的多个游戏目录误合并）：

1. 旧记录 `versionIsolation` 生效（共享目录无法用版本目录是否存在判断搬迁）；
2. 旧 `game_dir` 与新 `game_dir` 解析后的根路径不同；
3. 旧 `versions/{记录名}` 与 `versions/{扫描目录名}` 都不存在（旧目录已删/搬走）；
4. 记录名命中扫描目录名，或命中版本 JSON `id`（兼容旧客户端的身份漂移）；
5. 游戏版本一致（双方都非空时），loader 一致（双方都有时）。

两种落地方式：

- **新目录还没有记录**：直接把旧记录搬到新 `game_dir`，保留原 `id` 与全部设置；
  若新目录已带 `qomicex.json`（整目录搬迁），先用它按项合并。
- **新目录已经有一条默认记录**（用户先切目录、后删旧目录的常见顺序）：把旧记录里
  **缺失**的设置逐键补进新记录，保留新记录的 `id`、`createdAt` 与较新的统计；
  随后第 1 步清理旧记录。补写后立即 `write_full` 刷新新目录的 `qomicex.json`，
  否则下一次读取会用旧的默认配置把补回的 JVM/内存再次覆盖。

补写只填空值，不覆盖新记录已有值，避免把用户在新目录里手动改过的设置回滚。
内存仅在「新记录仍为默认壳」时补回，防止把用户显式重置过的内存改回旧值。

同时，MMC 导入写 JVM 参数由 `get_by_id` + `update` 整对象替换、忽略错误，改为
`update_with` 只补丁 `jvm_args`；记录不存在或独立配置落盘失败会让导入任务失败
并给出可读原因，不再静默留下一个启动必崩的实例。

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
  JVM/内存设置
- 为何不选：误合并的代价高于少恢复一次；旧目录真实存在时保持两条记录

### 方案 把 MMC `+jvmArgs` 注入版本 JSON `arguments.jvm` 作为兜底

- 优点：实例记录再次丢失时仍能启动
- 缺点：MMC 常见旧格式版本 JSON 没有 `arguments.game`，直接注入 `arguments.jvm`
  会触发启动报错；且用户显式清空 JVM 参数后，版本 JSON 兜底会让参数「复活」
- 为何不选：需要额外的覆盖标记与格式分支，风险大于收益；独立配置
  `qomicex.json` 已能在记录丢失时恢复设置

## 影响

- `services/instance.rs`：新增 `scanned_dir_name`、`adopt_moved_game_dir_instances`、
  `find_moved_game_dir_source`、`carry_orphan_settings`；第 1b 步与第 6 步写回前
  各执行一次；第 4 步统一使用 `scanned_dir_name`。
- `endpoints/modpack.rs`：MMC 导入的 JVM 参数回写改为 `update_with` 并传播失败。
- 行为限制：只接管隔离开启、旧版本目录确实不存在的记录；同名但游戏版本/loader
  不同的实例不接管。
- 对已经丢失且旧目录已删除的存量实例，磁盘上没有可恢复的 JVM 参数；需要用户
  重新导入原始 MMC 包或在实例设置中重新填写。

## 验证

- `sync_from_disk_adopts_settings_when_game_dir_moves`：旧目录已删、新目录无记录，
  原 `id`/JVM/内存/Java/备注/统计全部保留，新目录写入 `qomicex.json`，重启后仍在。
- `sync_from_disk_restores_settings_into_existing_default_record`：新目录已有默认
  记录且有游玩统计，旧目录随后删除，设置补进新记录且旧记录被清理。
- `sync_from_disk_does_not_steal_settings_when_old_game_dir_still_exists`：旧目录
  仍存在时保持两条记录，不偷设置。
- `sync_from_disk_does_not_adopt_across_game_versions`：同名但 1.20.1 → 1.7.10
  不接管。
- 现有 10 个 `sync_from_disk_*` 回归用例全部通过。
