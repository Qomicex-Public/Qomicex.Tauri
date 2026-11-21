# ADR-140 日志管道统一：startup_id、启动边界事件与字段字典

状态：已采纳
日期：2026-11-22

## 背景

2026-10-06 ~ 2026-11-21 的用户日志暴露出四类问题，直接导致「出了问题查不到原因」：

1. 三天日志混在一个文件里，没有任何字段标记**哪一次启动**，只能靠时间间隔和 PID 猜。
2. 只剩 4 行动作日志（`qipc listening` 被当成启动完成），启动卡住时无法判断卡在哪一步。
3. 同一文件里三种行格式并存：后端 `2026-10-06T12:18:12Z  INFO ...`、
   downloader `[downloader:Info] ...`、前端 `[frontend:warn] ...`（后两者没有时间戳），
   无法统一排序、分组、查询。
4. 异常日志只有一句话（`qipc connection error: Broken pipe (os error 32)`），
   没有连接标识、阶段、是否预期、影响范围；高频预期断连还记 `WARN`，稀释信噪比。

同一批反馈里还有一条路径事实：macOS 上 `abs_dir=/.minecraft versions_exists=false` ——
从 Finder 启动的进程 cwd 是 `/`，相对 `gameDir` 被 `std::path::absolute` 拼到了根目录。

## 决策

1. **一种行格式**：`<RFC3339 UTC 毫秒> <LEVEL> [<service>] startup_id=<id> <message> [key=value ...]`。
   - tracing 事件由 `services/log_format::UnifiedFormat` 直接写行（不再用默认格式器，
     也不再依赖 `with_ansi/with_target` 这些默认格式器的开关）。
   - downloader / 前端上报 / 插件 / 子进程输出统一走 `trace::trace_event(service, level, msg)`，
     由同一处生成前缀并做 URL 脱敏。
   - 字段规范：snake_case，单位必带后缀，空值不输出。字典见
     [日志格式与字段字典](../8-部署运维/日志格式与字段字典.md)。
2. **startup_id**：进程启动生成 8 位十六进制，进程内恒定，注入每一行。前端上报与
   下载器事件沿用后端 id —— 它们跑在这个后端进程的语境里。
3. **启动边界事件**：`app_starting`（环境快照）/ `app_stage`（阶段进度）/
   `app_ready`（带 `duration_ms`）/ `app_start_failed`（带 `stage`）。失败由
   `Startup` 的 `Drop` 兜底，panic 与提前返回都能落一条。
4. **级别按「是否预期、是否影响用户」定**：预期断连降 `DEBUG` 并标 `impact=none`；
   有兜底的降级记 `WARN` 且必须带 `reason`。
5. **相对 `gameDir` 按用户主目录展开**（`settings::resolve_game_dir`），不再按进程 cwd；
   扫描日志补 `path_source` / `home_dir` / `cwd` / `versions_exists`，让「没装游戏」与
   「路径拼错」可区分。
6. **脱敏兜底在框架层**：敏感字段名白名单之外，写盘前转义控制字符；URL 脱敏集中在
   `trace_event`。

## 影响

- 日志查看器（`LogTab` 的级别推断）匹配 `\bERROR\b` / `\bWARN\b`，新格式无需改动。
- 每行多出 `[service] startup_id=xxxxxxxx` 约 30 字节，5 MiB 单文件可容纳的行数略降，
  换取可排序与可分组。
- 前端上报的行使用后端接收时间戳，不是浏览器端时间；跨机时钟不一致场景不受影响。

## 未采纳 / 待排期

- **downloader 结构化字段**（`total_bytes` / `total_segments` / `segment_index` 取代
  `total=Some(24758786)` 这类 Debug 输出）：需要改 qomicex-downloader 子模块并单独提交，
  本次只在后端侧统一了前缀与级别。
- **分级保留**（ERROR 30 天 / WARN 14 天 / INFO 7 天 / 采样 3 天）：当前是单文件 5 MiB ×
  10 份滚动，分级需要产品先确认合规留存口径。
- **高频 INFO 采样**：先观察统一格式后的实际量级，避免过早引入采样把首个现场丢掉。
