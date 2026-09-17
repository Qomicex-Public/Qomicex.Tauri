# CHECKPOINT_BATCH_6 — 世界预览同步上游（批次 3 / 批 2）

| 属性 | 内容 |
|---|---|
| 日期 | 2026-09-17 |
| 分支 | `migrate/world-viewer-f50d849-2fb6f72-808eb78` |
| 状态 | ✅ 通过 |
| 对应上游 | world-viewer `2fb6f72`（渲染内 ColorMemo 颜色解析记忆表） |

## 本批原子包

| 包 | 上游提交 | 目标文件 |
|---|---|---|
| 2 | `2fb6f72` | `src-backend/qomicex-backend/src/services/world_view/render.rs`、`ported_tests.rs` |

与批 1 的包 1 共用 cargo target / `Cargo.lock`，故串行执行。

## 改动

`render.rs`（+48 行）：
1. `BlockRefRef<'a>` 的 derive 补 `Hash`（ColorMemo 需要作 key）
2. 在 `resolve_color` 之后新增私有 `struct ColorMemo<'a> { entries: HashMap<BlockRefRef<'a>, ([u8; 3], TintKind)> }` 及 `impl`（`new()` / `resolve()`）
3. `Surface::fill()`：在 `cache.acquire(...)` 之后、for 循环之前 `let mut memo = ColorMemo::new();`；两处颜色解析改为 `memo.resolve(&cache.palette, block, scan.tint)`

`ported_tests.rs`（+176 行）：新增 `mod memo_regression`，含上游 3 个测试。

## 移植理由（上游实测）

单瓦片以同一批方块调 `color_ref` 约 8 万次（GTNH z=0 实测 82944 列仅 102 种不同 id+meta），每次分配 3 个 `String`，占渲染约 60% 时间。改为渲染内局部 memo 按 `BlockRefRef` 记忆 `(rgb, tint kind)`，biome 命中后再套用。

放渲染内而非共享到 `TileCache`：共享需加锁，每列抢锁会让前端 6 路并发瓦片请求串行化。

## 验证

```
cargo build --manifest-path src-backend/qomicex-backend/Cargo.toml
    Finished `dev` profile [unoptimized + debuginfo] target(s) in 36.10s

cargo test --manifest-path src-backend/qomicex-backend/Cargo.toml memo_regression -- --nocapture
running 3 tests
compared 96912 (block, meta, biome) combos
test ...::memo_regression::memo_matches_direct_resolution_for_every_palette_block ... ok
tile has 82944 surface columns but only 102 distinct (id, meta) blocks
test ...::memo_regression::memo_size_is_bounded_by_distinct_blocks_not_columns ... ok
tile bytes stable across cache histories (149646 bytes)
test ...::memo_regression::tile_render_is_repeatable_across_cache_histories ... ok
test result: ok. 3 passed; 0 failed; 0 ignored; 0 measured; 208 filtered out

cargo test --manifest-path src-backend/qomicex-backend/Cargo.toml
test result: ok. 209 passed; 0 failed; 2 ignored; 0 measured; 0 filtered out; finished in 88.53s
```

实测数值与上游 commit message 完全一致（96912 combos / 82944 columns / 102 distinct）。

## 快照比对（QA 等价证据）

上游 `render.rs` 的 ColorMemo 段（`/// Per-render memo` → `/// Directional relief shading`）与本项目逐字符一致：

```
render ColorMemo identical: True
```

## 偏差说明

- `resolve_color` 因两处调用点改为 memo 而变为仅测试使用（`testing::resolve_color`），构建新增 `function resolve_color is never used` 警告。已用 stash 对照验证该警告在改动前不存在；保留该函数是刻意的——`memo_regression` 用它作为「改动前路径」的对照基准，删掉会失去回归保护。与上游同状态（上游 `lib.rs` 有 `#[cfg(test)] pub mod testing` 复用它）。
- `ColorMemo` 不碰 `ChunkKey`（本项目三元组）与 `is_water_name`（本项目含 `bubble_column`），零冲突。
- Subagent 派发因账户余额不足失败，本批由主控直写（偏离已记录）。
