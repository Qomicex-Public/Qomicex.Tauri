# CHECKPOINT — Batch 2：world-viewer 8828130 同步（1.13-1.17 区块格式 + 旧版方块名配色）

| 属性 | 内容 |
|---|---|
| 上游提交 | `8828130` fix(world): 支持 1.13-1.17 区块格式与旧版方块名配色 |
| 上游日期 | 2026-09-16 19:52 |
| 本项目基线 | `b2c2c0e`（2026-09-16 00:20，早于上游提交） |
| 移植方向 | 适配新架构（`crate::` → `super::`，测试并入 `ported_tests.rs`） |
| 完成日期 | 2026-09-16 |

## 变更文件

| 文件 | 增/删 | 内容 |
|---|---|---|
| `src/services/world_view/palette.rs` | +148 | `LEGACY_ALIASES`（55 项旧名→现代名）、`legacy_alias()`、56 项缺失颜色 |
| `src/services/world_view/region.rs` | +153/-22 | `BlockStates::from_parts` + `spans`、连续/补齐两种 long 解码、`legacy_block_states()`、`parse_legacy_palette()`、`parse_legacy_block_states()`、fast parser 同步 |
| `src/services/world_view/testing.rs` | +1 | 导出 `BlockStates`/`Section` 供测试驱动生产代码 |
| `src/services/world_view/ported_tests.rs` | +330 | `mod palette_packing`（5 测试）、`mod legacy_colors`（3 测试）、`all_saves_smoke` 扩 4 存档 |

## 上游缺陷的本地差异

| 项 | 上游 | 本项目 |
|---|---|---|
| 区块缓存键 | —（本次未涉及） | 沿用 ADR-080 已修的 `ChunkKey = (dim, cx, cz)` |
| `palette_index` 除零 | `bits==0 && data.is_some()` 时 `64/0` panic | 提前 `if bits == 0 { return Some(0) }` |

## 验证证据

```
cargo fmt -- --check        → exit 0
cargo test --bin qomicex-backend
  test result: ok. 180 passed; 0 failed; 2 ignored
```

关键新增测试（全部 ok）：

```
ported_tests::palette_packing::contiguous_layout_is_detected_and_decoded
ported_tests::palette_packing::padded_layout_is_detected_and_decoded
ported_tests::palette_packing::both_layouts_agree_on_the_same_indices
ported_tests::palette_packing::four_bit_layouts_are_identical
ported_tests::palette_packing::single_entry_palette_needs_no_data
ported_tests::legacy_colors::legacy_names_resolve_to_colours
ported_tests::legacy_colors::modern_names_still_resolve
ported_tests::legacy_colors::real_legacy_saves_have_no_fallback_grey
ported_tests::all_saves_smoke::all_saves_open_and_render
```

真实存档实测（`all_saves_smoke` 输出）：

| 存档 | 最佳瓦片不透明像素 |
|---|---|
| 1.6.4（pre-1.13 名） | 53248 |
| 1.8.9（pre-1.13 名） | 57344 |
| 1.14.4（平级 Palette/BlockStates） | 65536 |
| 1.16.5（平级 Palette/BlockStates） | 65536 |

## 负向验证（证明测试非空转）

1. 注释掉 `let base = legacy_alias(base);` → `legacy_colors` 2 项 FAILED
   （`minecraft:waterlily resolved to [46,67,244], expected [40,90,35]`；
   `1.6.4: 4096 columns still fall back to grey; names: ["minecraft:leaves"]`）
2. 把 `block_states` 还原为 `None` → `all_saves_smoke` FAILED
   （`1.14.4: no tile rendered terrain (best 0 px)`、`1.16.5: 同上`）

两次改动均已还原，还原后 180/180 全绿。

## 未采纳项

无。上游本次提交的功能与修复全部同步。

## 技术债

- 上游 1.13–1.15 连续打包布局本机无存档可验，仅靠合成数据测试
  （`palette_packing::contiguous_layout_is_detected_and_decoded`）覆盖。
- 领域层在主仓与上游各一份，后续上游演进仍需手工同步（ADR-080 已记录）。


## 修订：PR #96 审查意见处理（Sourcery）

| 审查断言 | 核实 | 处理 |
|---|---|---|
| wooden_slab/double_wooden_slab → oak_slab 返回 unknown 灰 | 不成立（src=vanilla [125,125,125]），但颜色是石灰色而非木色 | 补 minecraft:oak_slab [156,127,78] |
| piston_head/piston_extension → minecraft:piston 返回 unknown 灰 | 成立（src=unknown [80,80,80]） | 补 piston/piston_head/sticky_piston 颜色 |

新增护栏：alias_targets_all_resolve_to_colours（扫描全部 55 项别名目标）、legacy_slab_aliases_are_wood_coloured。

负向验证：移除新增颜色后 alias_targets_all_resolve_to_colours FAILED，精确复现审查报的两个别名。

测试数：180 → **182**（全绿）。
