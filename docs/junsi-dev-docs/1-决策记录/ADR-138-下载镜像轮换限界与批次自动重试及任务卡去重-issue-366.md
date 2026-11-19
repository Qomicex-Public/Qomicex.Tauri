# ADR-138 下载镜像轮换限界、批次自动重试及任务卡去重（issue #366）

## 背景

Issue #366 与用户反馈给出四类症状：下载卡文件超时、重试出现多张不同名同进度卡片、
重试过一次后没有重试按钮、文件计数在 `0/199 → 23/199 → 1/1` 之间抽动，且整合包
很难一次性下完。排查后确认是四个独立缺陷叠加。

## 根因

1. **镜像轮换没有预算（下载器）**。`run_streamed` / `run_segment` 每次换源都把
   `attempt` 清零，而 `mirror_url()` 是环形轮换、只在 URL 数 < 2 时返回 `None`。
   因此 ≥2 个 URL 时持续失败的文件**永远不会进入 Failed**：要么字节数一直在
   变化让批次看门狗续命（表现为永远下不完），要么整批 120s 无进展后被判
   「下载超时」，真实原因（哪个文件、哪个源、什么状态码）被超时文案掩盖。
2. **批次内单文件失败 = 整批失败**。整合包数百个文件，任一文件一次抖动就让
   整个安装失败，用户只能整包重来。
3. **文件计数按批次覆写**。一条管线串行/并行跑多个 `download_batch`，它们共用
   同一个 `ProgressField`，每个批次都直接覆写 `total_files/completed_files`，
   于是 UI 在 `23/199`（modpack-files）与 `0/1`（下一批次）之间回跳。
4. **同一实例两条建卡路径（前端）**。SSE 会对「本地没有卡片的后端任务」自动补卡，
   而对话框/重试流程也会建卡；`addTask` 无条件前插，`updateTask` 换 instanceId
   时不收编旧卡，于是出现多张不同名同进度卡片。自动补的卡没有 `retry` 描述符，
   卡片渲染据此隐藏重试按钮 →「重试过一次后没有重试按钮」。

## 决策

1. **有限轮换**：新增 `next_mirror(ctx, rotations)`，每个 URL 至多成为一次「当前源」，
   预算用尽返回 `None`，调用方走正常失败路径。流式路径与每个分段各自持有计数，
   分段之间不共享预算（避免首段耗尽预算后其余段无法使用健康镜像）。
2. **批次内自动重试**：`auto_retry_failed` 统一事件与轮询两条路径的重试判定。
   4xx（除 408/429）属确定性失败不重试；dest 占用沿用既有 5 次预算；其余瞬态失败
   给 2 次，走 `DownloadManager::retry`，ranged 任务按 `.part` 位图续传。
3. **文件计数跨批次累计**：`ProgressField` 新增 `file_batches` 计数槽
   （`begin_file_batch` / `set_file_batch_done`），`total_files/completed_files`
   改为各批次求和。分母只增、已完成数只增，并行批次互不覆写。
4. **任务卡去重**：`addTask` 按 id / instanceId（限安装类卡片）合并，保留 `retry`
   描述符与用户命名；SSE 自动补卡的回退名与兜底类型（一律 'modpack'）不覆盖本地
   卡片。`updateTask` 在 instanceId 变更时收编同实例的其他卡片。

## 追加：真实日志驱动的传输层修正（2026-11-19）

补丁实机日志显示失败与重试已按预期工作，但出现大面积「流式响应体首字节超时 20s」，
横跨 edge.forgecdn.net 与 mod.mcimirror.top 两个 host。进一步定位与处置：

5. **H2 `max_frame_size` 从 16MB 降为 256KB**（`manager.rs`）。h2 的
   `LengthDelimitedCodec` 必须收满整个 DATA 帧才把字节交给 body 流（已核对
   h2-0.4.15 `codec/framed_read.rs`），16MB 帧会把 body 首字节延迟放大到整帧下完，
   在慢/拥塞链路上直接撞 20s 首字节看门狗。256KB 把最坏延迟压回数秒级，帧头开销
   占比仍可忽略。
6. **零字节快速失败**（`engine.rs` 流式与分段同口径）：连续 2 次零字节且为超时类
   失败、又没有镜像可换时立即失败。此前同一 URL 要白等满 5 次首字节超时
   （单文件约 2.5 分钟），与批次自动重试叠加后单文件最坏约 7 分钟。
7. **不改 H1/H2 路由**：本机探针（`examples/transport_probe.rs`，24 个真实
   CurseForge 文件）三轮结果 H1 快 1.5 倍 / 快 1.5 倍 / 慢 2 倍，差异被 CDN 限速
   抖动淹没，不构成把 CurseForge 改走 H1 的依据。已回退该路由改动，仅留注释。

## 验证

- `qomicex-downloader-rust`：新增 `dead_mirrors_fail_instead_of_rotating_forever`
  （两个源恒 500，必须在有限时间内 Failed 且保留状态码）与
  `dead_single_source_fails_after_two_empty_attempts`（mock `/hang` 只回响应头，
  两次零字节即放弃，GET 数恰为 2）；`download_core` 44 项、
  `host_cache_parallel` 1 项全部通过，clippy 无警告。
  注：`slow_segment_rebuild_does_not_consume_retry_budget` 在并行跑全量时偶发失败，
  单独跑与 `--test-threads=1` 均通过，属既有的时序敏感用例。
- `qomicex-backend`：新增 `file_counts_accumulate_across_batches`（串行/并行/单调性）、
  `permanent_failure_only_covers_deterministic_http_status`；全量 720 项通过。
- 前端：新增 `scripts/test-download-store-dedupe.mjs`（14 项断言，覆盖双向合并、
  重试收编、非安装卡隔离），`pnpm run test:download-store` 通过；`pnpm run typecheck` 通过。

## 已知限制

- 资源文件（file/batch）任务仍无 `retry` 描述符，失败后不能一键重建；本次只保证
  游戏/整合包安装卡的重试按钮不再因重复卡片而消失。
- 流式路径（源不支持 Range 或文件小于分片阈值）重试仍从头下载，无断点续传。
- `qomicex-downloader-rust` 的 `zz_*.rs` 测试引用本地 `stuck_urls.txt`（未入库），
  `cargo test` / `cargo clippy --all-targets` 因该文件缺失而无法编译，属存量问题。
