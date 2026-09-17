# CHECKPOINT_BATCH_5 — 世界预览同步上游（批次 3 / 批 1）

| 属性 | 内容 |
|---|---|
| 日期 | 2026-09-17 |
| 分支 | `migrate/world-viewer-f50d849-2fb6f72-808eb78` |
| 状态 | ✅ 通过 |
| 对应上游 | world-viewer `f50d849`（LZ4 区块 + 位图释放）、`808eb78`（瓦片队列中心排序） |

## 本批原子包

| 包 | 上游提交 | 目标文件 |
|---|---|---|
| 1 | `f50d849`（仅 region 部分） | `src-backend/qomicex-backend/src/services/world_view/region.rs`、`src-backend/qomicex-backend/Cargo.toml` |
| 3 | `f50d849` + `808eb78`（仅 tileLayer 部分） | `src/lib/world-tile-layer.ts` |

批 2（`render.rs` ColorMemo）与包 1 共用 cargo target / Cargo.lock，故串行放到 `CHECKPOINT_BATCH_6.md`。

## 包 1：region comp=4 LZ4Block 解压

新增（+107 行）：
- `read_chunk` 的 `match comp` 增加 `4 => Ok(Some(decompress_lz4(&raw)?)),`
- `const LZ4_MAGIC: &[u8; 8] = b"LZ4Block"` / `const LZ4_HEADER_LEN: usize = 8 + 1 + 4 + 4 + 4`
- `fn decompress_lz4(data: &[u8]) -> Result<Vec<u8>, String>`（lz4-java LZ4Block 流：8 字节 magic + token 高 nibble `0x10` 原始 / `0x20` LZ4 + 三个小端 i32）
- `#[cfg(test)] mod lz4_tests`（3 个测试，就地内联，用户确认）

依赖：`lz4_flex = "0.14"`（与上游同版本）。

**关键辨析**：这是 lz4-java 的 **LZ4Block 流**，不是 LZ4 Frame 格式；magic 为 ASCII `LZ4Block`、长度字段小端。`conic-worldmap` 用的是 LZ4 Frame magic 且按大端读取，与本格式不符，故未参照。

## 包 3：前端瓦片层

新增/覆盖（+100 行）：
- `type QueuedTile = { z, x, y, job }`；`queue` 由 `Array<() => void>` 改为 `QueuedTile[]`
- `private closeSoon(bitmap)`：`setTimeout(...,0)` 内复核 `this.cache.values()` 是否仍持有该位图，存活则 return，否则 `bitmap.close()`
- `remember()` 淘汰时对 evicted 调 `closeSoon`；`clearCache()` 在 clear 前对每个值调 `closeSoon`
- `private centerTile()` + `pump()` 改为每次取距视口中心最近的一项（仅比较 `t.z === center.z`）
- `enqueue(z, x, y, job)`；`load(key, coords, url, onReady)`

## 验证

```
cargo build --manifest-path src-backend/qomicex-backend/Cargo.toml
    Finished `dev` profile ... in 1m 02s      （无 error）

cargo test --manifest-path src-backend/qomicex-backend/Cargo.toml lz4_tests
running 3 tests
test services::world_view::region::lz4_tests::rejects_lz4_frame_magic ... ok
test services::world_view::region::lz4_tests::rejects_bad_magic_and_truncation ... ok
test services::world_view::region::lz4_tests::decodes_raw_then_lz4_blocks ... ok
test result: ok. 3 passed; 0 failed; 0 ignored; 0 measured; 205 filtered out

pnpm exec tsc --noEmit   → exit 0（无输出）
```

## 快照比对（QA 等价证据）

上游 `region.rs` 的 LZ4 段（`/// lz4-java` → `/// Open region handles`）与本项目逐字符一致：

```
region LZ4 block identical: True | upstream chars 2342 | target chars 2342
```

前端按「去注释 + 统一引号 + 去分号 + 压缩空白」归一后逐段比对：

```
closeSoon      identical: True
remember       identical: True
clearCache     identical: True   （上游多出 stats()，本项目按 ADR-082 保持移除）
centerTile     identical: True
pump           identical: True
enqueue        identical: True
QueuedTile     identical: True
createTile-call identical: True
load-sig+enqueue 差异仅两处既有分歧：本项目 fetch(url)（上游 fetch(url,{mode:'cors'})）与尾逗号
```

## 偏离与说明

- Subagent 派发因账户余额不足失败，本批由主控直写（偏离「主控不写业务代码」，已在此记录）。
- 上游 `stats()` 诊断接口未移植（ADR-082 既有取舍）；上游 `scripts/measure-*.mjs` 探针未移植（本项目无 playwright 依赖）。
- 保留本项目既有分歧：`#[cfg(unix)]`（上游 `#[cfg(not(windows))]`）、`ChunkKey` 三元组、`is_water_name` 含 `bubble_column`、前端 `fetch(url)` 无 cors 选项、中文注释与单引号无分号风格。
