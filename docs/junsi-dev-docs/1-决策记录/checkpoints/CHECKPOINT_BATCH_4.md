# CHECKPOINT — Batch 4：world-viewer 4e6f71d + 1dc33cf 同步

| 属性 | 内容 |
|---|---|
| 上游提交 | `4e6f71d` feat(render): 生物群系染色与水面透视渲染<br>`1dc33cf` perf(tiles): 瓦片渲染缓存与并发优化 |
| 上游日期 | 2026-09-17 |
| 本项目基线 | `8828130` 已同步（PR #96） |
| 移植方向 | 适配新架构，分两个 commit 保留上游语义 |
| 完成日期 | 2026-09-17 |

## 变更规模

| 文件 | 改动 |
|---|---|
| `world_view/biome.rs` | 新增 229 行（tint 解析、两条染色公式） |
| `world_view/biome_tints.rs` | 新增 167 行（79 条数字 id + 67 条命名空间） |
| `world_view/region.rs` | +473（RegionFile/pread/句柄缓存、LegacyBiomes、biome 解析） |
| `world_view/render.rs` | +584（RenderOpts/scan_column/水底双缓冲、LRU+Arc） |
| `world_view/mod.rs` | +119（cache 改 Arc、锁收窄、容量 8192） |
| `endpoints/world_view.rs` | +37（water/shade/alt 查询参数） |
| `world_view/testing.rs` | +131（对齐上游夹具契约） |
| `world_view/ported_tests.rs` | +1111（5 个新 mod） |
| `src/api/world-view.ts` | +36（RenderFlags） |
| `src/lib/world-tile-layer.ts` | +42（maxCached LRU） |
| `src/components/WorldPreviewDialog.tsx` | +94（渲染开关 UI） |
| `qomicex-tauri-i18n` | 4 键 × 7 语言 |

## 验证证据

```
cargo fmt -- --check                    → exit 0
cargo test --bin qomicex-backend
  test result: ok. 203 passed; 0 failed; 2 ignored    (原 182)
pnpm run build (tsc + vite)             → built in 7.50s
```

### 功能实测（与上游记录一致）

| 指标 | 本机 | 上游 |
|---|---|---|
| 水下像素色数（开/关水面透视） | 139 / 16 | 139 / 16 |
| 水下蓝色通道均值（开/关） | 181.2 / 238.8 | 181.2 / 238.8 |
| 水列解析出水底 | 2179 / 2179 | 2179 / 2179 |
| 草方块群系数 | 3 | 3 |

### 性能实测

```
A) old: open+header/chunk:  21.8 ms  (0.067 ms/chunk)
B) new: cached handle     :  13.5 ms  (0.042 ms/chunk)   => 省 38%
byte-identical chunks     : 256

cap   4096 ( 39 MB)  hit 17%  evict 60416
cap   8192 ( 78 MB)  hit 53%  evict 33792
cap  12288 (116 MB)  hit 71%  evict 21504
per chunk: 9.7 KiB
mismatching renders: 0 / 24
```

### 负向验证（三次，均已还原）

1. `needs_tint` 阈值 24 → 255 → `biome::tests::already_coloured_blocks_are_left_alone` FAILED
   （`assertion failed: !needs_tint(green)`）
2. 关掉 shade 的水面混合 → `water_toggle_changes_the_render` FAILED
   （`the water toggle must change the tile`）
3. 读 raw 时偏移量去掉 `+5` → `cached_reader_matches_original_bytes` FAILED

## 本项目相对上游的额外改动

| 项 | 上游 | 本项目 |
|---|---|---|
| 缓存键 | `(cx, cz)` | `(dim, cx, cz)`（ADR-080 已修，本次沿用） |
| 锁粒度 | `Mutex<Option<Arc<TileCache>>>`，锁只护 cache | 原为整个 session 锁跨渲染；本次一并收窄为 Arc + 先取数据再放锁 |
| 缓存容量常量位置 | `lib.rs` `CHUNK_CACHE_CAPACITY` | `mod.rs` `CACHE_CAPACITY`（同为 8192） |

## 跳过项

- 上游 `scripts/check-cache-bound.mjs`、`scripts/measure-tiles.mjs`（Playwright CDP 探针）：本项目无 playwright 依赖，不搬运。
- 上游 5 个 `perf_*.rs` 独立测试文件：并入 `ported_tests.rs` 的 mod（后端是 bin crate，无 lib target）。

## 技术债

- 1.13–1.15 连续打包布局仍无本机存档可验（沿用合成数据测试）。
- `biome_tints.rs` 为手工搬运的生成文件，上游重新生成时需整体替换。
