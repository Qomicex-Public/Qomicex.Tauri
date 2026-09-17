# ADR-083：世界预览第三次同步上游：LZ4 区块解压 / 渲染内颜色记忆表 / 瓦片队列中心排序

| 属性 | 内容 |
|---|---|
| 状态 | 已采纳 |
| 日期 | 2026-09-17 |
| 决策者 | AI Agent |

## 背景

上游 C:\Project\world-viewer 在本项目最后同步点 1dc33cf（ADR-082）之后新增 3 个代码提交，本项目均未包含：

1. f50d849 feat(region): 支持 LZ4 压缩区块并修复瓦片位图泄漏
   - Minecraft 1.20.5+ 服务端可写 comp=4（lz4-java LZ4Block 流）的区块，此前 read_chunk 遇 4 直接报 unknown region compression，该类存档无法预览。
   - 该格式不是 LZ4 Frame：magic 是 8 字节 ASCII `LZ4Block`，长度字段为小端；token 高 nibble 0x10 原始 / 0x20 LZ4。按 Amulet-Core PR#283（Amulet issue #1027 的修复）实现。conic-worldmap 用的是 LZ4 Frame magic 且按大端读取，与本格式不符，故未参照。
   - tileLayer 的 LRU 淘汰此前只从 Map 删除而不调用 ImageBitmap.close()，持续平移会泄漏 GPU 内存。

2. 2fb6f72 perf(render): 按方块去重的颜色解析记忆表
   - 单瓦片以同一批方块调 color_ref 约 8 万次（GTNH z=0 实测 82944 列仅 102 种不同 id+meta），每次分配 3 个 String（name_of 克隆、to_owned_ref 克隆、tint_kind 内 to_ascii_lowercase），实测占渲染约 60% 时间。
   - 上游实测：单瓦片 warm 14.77ms → 5.21ms（2.8x），z=0 瓦片 58.18ms → 27.03ms（2.2x），viewport 均值 12.3 → 7.4 ms/tile（1.66x）。

3. 808eb78 perf(tiles): 瓦片请求按视口中心距离排序
   - Leaflet 按行优先请求瓦片，新视口会把顶部几行先取完，用户正看的视口中心反而靠后。
   - 上游实测中心瓦片可见延迟中位数 202ms → 120ms（-41%），均值 238 → 124ms（-48%）；总耗时不变，故以中心瓦片延迟为验收指标。

本项目约束：后端是 bin crate（无 lib target，integration tests 目录不可用）；world_view 模块已有多处本地适配（ChunkKey 为三元组含维度、is_water_name 含 bubble_column 与大小写归一、无 stats() 诊断接口）。

## 决策

采用「适配新架构」移植，3 个原子包分 2 批（批 1 = 包 1+3 并行、批 2 = 包 2 串行，因包 1 与包 2 共用 cargo target/Cargo.lock），2 个 commit 保留上游语义。

1. region.rs 逐字符移植 decompress_lz4（含 LZ4_MAGIC/LZ4_HEADER_LEN 常量与 8 字节 magic 校验、小端 i32 长度、token 分派、截断/负长度/未知方法错误分支）；新增依赖 lz4_flex = "0.14"（与上游同版本）。3 个解压测试按用户确认就地内联为 region.rs 的 #[cfg(test)] mod lz4_tests（与上游一致，本项目 render.rs 已有内联 mod 先例）。
2. render.rs 移植 ColorMemo：BlockRefRef 补 derive Hash，新增私有 struct + impl（new/resolve），Surface::fill() 在 acquire 之后创建 memo、两处颜色解析改走 memo.resolve。上游 3 个回归测试并入 ported_tests.rs 的 mod memo_regression（本项目既有约定）。
3. world-tile-layer.ts 移植 QueuedTile + centerTile() + pump 线性扫描（仅比较当前 _tileZoom 的项，跨 zoom 距离无意义），以及 closeSoon()（延后一个宏任务 close，避免与 createTile 已排队的 drawImage 竞争 InvalidStateError；关闭前复核位图是否被重新命中）。

不移植：上游 stats() 诊断接口（ADR-082 已明确移除）、上游 scripts/measure-*.mjs Playwright CDP 探针（本项目无该依赖）。
保留本项目既有取舍：ChunkKey 三元组、is_water_name 含 bubble_column、#[cfg(unix)]、前端 fetch(url) 无 cors 选项、中文注释与单引号无分号风格。

遗留技术债：resolve_color 因两处调用点改走 memo 而变为仅测试使用，构建新增 `function resolve_color is never used` 警告。保留是刻意的——memo_regression 用它作为「改动前路径」的对照基准，删除会失去回归保护（上游同状态，其 lib.rs 的 testing 模块复用它）。

## 备选方案

### 方案 拆成 3 个独立 commit 逐包提交
- 优点：回溯粒度更细
- 缺点：包 1 与包 2 共用 Cargo.lock 与 cargo target，两次提交间会出现「依赖已加但代码未用」的中间态
- 为何不选：不选：批 1 的两个包无重叠且可并行，包 2 因 cargo 锁串行，2 个 commit 已能区分「功能/正确性」与「性能」两类语义

### 方案 只移植 LZ4 与位图释放（跳过两个 perf）
- 优点：改动最小
- 缺点：放弃 2.2x 的瓦片渲染提速与 -41% 的中心瓦片延迟，而这两项是用户可见的体验问题
- 为何不选：不选：用户明确要求「新的修复和优化」全部同步

### 方案 LZ4 测试并入 ported_tests.rs
- 优点：遵守 MAPPING_TABLE 批次 2 的既有约定，测试集中一处
- 缺点：decompress_lz4 是 region.rs 私有函数，跨文件调用需额外开放可见性
- 为何不选：不选：用户确认就地内联，且与上游一致、无需放宽可见性

### 方案 全量移植（采纳）
- 优点：一次同步到位；逐字符比对可证明与上游等价
- 缺点：单次改动约 477 行（含测试）
- 为何不选：采纳

## 影响
- src-backend/qomicex-backend/Cargo.toml：新增 lz4_flex = "0.14"
- src-backend/qomicex-backend/src/services/world_view/region.rs：+107 行（comp=4 分支、LZ4 常量与 decompress_lz4、lz4_tests mod）
- src-backend/qomicex-backend/src/services/world_view/render.rs：+48 行（BlockRefRef 补 Hash、ColorMemo、fill 两处调用）
- src-backend/qomicex-backend/src/services/world_view/ported_tests.rs：+176 行（mod memo_regression 3 个测试）
- src/lib/world-tile-layer.ts：+100 行（QueuedTile、closeSoon、centerTile、pump/enqueue/load）
- MAPPING_TABLE.yaml：新增 migration_batch_3 段
- docs/junsi-dev-docs/1-决策记录/checkpoints/CHECKPOINT_BATCH_5.md、CHECKPOINT_BATCH_6.md

## 修订记录
| 日期 | 版本 | 修改内容 | 修改人 |
|---|---|---|---|
| 2026-09-17 | v1.0 | 初版创建 | AI Agent |