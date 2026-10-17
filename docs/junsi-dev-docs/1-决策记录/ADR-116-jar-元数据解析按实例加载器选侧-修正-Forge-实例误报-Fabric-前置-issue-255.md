# ADR-116：jar 元数据解析按实例加载器选侧，修正 Forge 实例误报 Fabric 前置（issue #255）

| 属性 | 内容 |
|---|---|
| 状态 | 已采纳 |
| 日期 | 2026-10-17 |
| 决策者 | AI Agent |

## 背景

issue #255 报告：Forge 实例（刀剑异闻录整合包，Forge 1.20.1）的模组列表提示「缺少前置」，但提示缺失的是 `fabric`——一个 Forge 实例根本不可能也不应该安装的 Fabric 侧条目。

取证结论（实测，非推断）：
- core `parse_metadata` 按固定优先级 `fabric.mod.json` → `META-INF/mods.toml` → `neoforge.mods.toml` → `mcmod.info` 解析，命中第一个即 return（`qomicex-core-rust/src/services/local/mods.rs`）。
- `create_mods(game_dir, version, version_segmented, api_key)` 无 loader 参数，core 无从知道实例跑哪个加载器。
- 多端模组（Architectury 等）把两套元数据装进**同一个 jar**。下载真实 jar 解包实测：
  | jar | fabric.mod.json `depends` | mods.toml 依赖 |
  |---|---|---|
  | `collective-1.20.1-8.53.jar`（该整合包实含） | `fabricloader, fabric, minecraft, java` | 仅 `minecraft` |
  | `Towns-and-Towers-1.12-Fabric+Forge.jar` | `fabricloader, fabric, minecraft, cristellib` | Forge 侧 |
  | `packetfixer-…-merged.jar` | `fabricloader, minecraft` | Forge 侧 |
  | `BadOptimizations-2.4.1-1.20.1.jar` | `minecraft` | Forge 侧 |
- 前端 `PLATFORM_PROVIDED_IDS` 刻意不含 `fabric`（ADR-101 v1.2：它是 1.19.2 前旧版 Fabric API 的 mod id，当作平台 id 会吞掉真实缺失）→ Forge 实例读到 Fabric 侧 depends 后，`fabric` 被判为缺失并显示为「缺失依赖 / fabric」，与截图完全吻合。
- 影响面：Modrinth 同时标 forge+fabric 的项目 6042 个；刀剑异闻录含 Collective 等多端库。

被证伪的备选判据：曾考虑「按 `fabric.mod.json` 的 `id` 与 `mods.toml` 的 `modId` 是否一致来识别多端模组」——实测四个真实双元数据 jar 两侧 id **4/4 完全相同**，无从区分。

## 决策

1. **由加载器决定解析侧**（根治）：`LocalResourcesFactory::create_mods` 增加 `loader: Option<&str>`，core 归为三侧 `LoaderSide::{Forge, NeoForge, Fabric}` 并据此分派解析顺序：
   - NeoForge → `META-INF/neoforge.mods.toml` → `META-INF/mods.toml` → `fabric.mod.json` → `mcmod.info`；
   - Forge / Cleanroom → `META-INF/mods.toml` → `neoforge.mods.toml` → `fabric.mod.json` → `mcmod.info`；
   - Fabric / Quilt / 其它 / **未知** → `fabric.mod.json` → Forge 系 → `mcmod.info`（与修复前完全一致）。
   未知一律按 Fabric 优先：本次修复的目标是消除「Forge 实例读到 Fabric 侧」的误报，对加载器未知的调用方保持既有行为，不引入新回归。
   选择改 core 而非只在前端过滤 depId：前端过滤只能压掉 `fabric`/`fabricloader` 这类**平台 id**，挡不住 `cristellib` 这类真实前置的误报，且展示字段（name/version/description）同样取自错的一侧。
2. **Cleanroom 归入 Forge 系**：它是 Forge fork，模组元数据同为 `META-INF/mods.toml`。
3. **per-jar 缓存身份必须含解析侧**：缓存 key 由 `{pathSha1}.json` 改为 `{pathSha1}-{forge|neoforge|fabric}.json`。同一 jar 在 Forge 实例按 mods.toml 解析、在 Fabric 实例按 fabric.mod.json 解析，结果不同；只按路径做 key 会让先扫的实例把结论喂给后扫的实例（size+mtime 完全相同，无从察觉）。
4. **两级缓存版本 bump**：core `MOD_META_CACHE_VERSION` 3→4、backend `MODS_CACHE_SCHEMA` 4→5。旧缓存里 Forge 实例的 dependencies 取自 fabric.mod.json，不失效会继续误报。
5. **backend 的 mods 缓存必须记录并校验 loader**（PR #258 评审 sourcery 指出）：磁盘缓存原只校验 schema/TTL/目录指纹。实例换加载器（如 Forge → Fabric）时目录签名不变、TTL 未到，会继续返回按旧加载器解析的依赖。现缓存写入 `loader`，命中时按**解析侧等价**比较（`forge`/`cleanroom` 同为 Forge 侧、`fabric` 与未知同为 Fabric 侧、`neoforge` 独占一侧），不一致则强制重扫（stale 分支同样拒绝）。
6. **host_port 的 mods 扫描改用「实际游戏加载器」**（PR #258 评审 sourcery 指出）：`detect_loaders` 按 `libraries` 顺序入列，OptiFine 常排在 Forge/NeoForge 之前，原先直接取「首个非 Vanilla/Unknown」会把 Forge+OptiFine 宿主判成 OptiFine，从而按 Fabric 侧解析双端 jar。现新增 `ConnectorGameInfo.scan_loader`（`skip_serializing`，不进协议负载），由 `pick_game_loader` 按 NeoForge → Forge → Cleanroom → Quilt → Fabric 优先级挑选，与展示用的 `loader` 解耦。
7. **嵌套 Jar-in-Jar 的 id 采集也要按侧**（PR #9 评审 sourcery 指出）：嵌套 jar 同样可能是双端 jar，`collect_nested_ids` / `nested_jar_id` 原先固定读 Fabric 侧，Forge 实例会把另一端的 id 记进 `provides_ids`，掩盖真实的 Forge 侧依赖。现按侧优先、另一侧兜底。
8. **解析「未填充」不再等同于「命中」**（PR #9 评审 sourcery 指出）：原实现只要条目存在就停止（`parse_*` 返回 `()`，结构不符时静默不填充），会让有效的备用元数据被跳过。现 `parse_fabric_json` / `parse_forge_toml` 返回是否成功填充，`try_parse_mod_metadata` 据此区分三态：`Parsed`（停止）/ `NotPresent`（回退下一格式或 `mcmod.info`）/ `ReadError`（条目存在但读取失败 → 同源 `catch{}` 语义，放弃本 jar）。
9. **「是对象/有表」不等于「可用」**（PR #258 评审 CodeRabbit 指出）：第 8 条首版只判定 JSON 是对象、TOML 含 `[[mods]]` 首元素，于是 `fabric.mod.json` 为 `{}`、或 `[[mods]]` 全空时仍返回成功，解析提前停止，`mod_id`/`dependencies` 恒空而同 jar 的有效备用元数据不被采纳。现判定改为「实际提取到可用字段」：fabric 侧要求 `id`/`name`/`version` 任一非空或 `depends` 为对象，Forge 侧要求 `modId`/`displayName`/`version`/`description` 任一非空；否则视为未填充并回退下一格式。
10. **前端不改**：修复后 Forge 实例不再看到 fabric 侧依赖，`PLATFORM_PROVIDED_IDS` 维持 ADR-101 v1.2 的口径（`fabric`/`quilt` 不得入列）。

## 备选方案

### 方案 方案 B：仅前端按实例 loader 过滤 depId
- 优点：改动最小，不动 core 签名，当天可闭环
- 缺点：数据源仍错侧：fabric.mod.json 的展示字段（name/version/description）继续覆盖 Forge 侧；Towns-and-Towers 的 `cristellib` 这类**真实前置**挡不住，仍会误报；同类问题（NeoForge 读 Forge 侧等）都还在
- 为何不选：只压症状不修根因；本 issue 的截图虽指 fabric，但同一根因会以其它形式复发

### 方案 方案 C：把 `fabric`/`quilt` 加回 PLATFORM_PROVIDED_IDS
- 优点：一行改动
- 缺点：与 ADR-101 v1.2 的明确决策冲突（该条为 PR #177 评审专门修正、含代码注释防回流）
- 为何不选：会让「装了依赖旧版 Fabric API 的模组、但没装该 API」这一真实启动失败原因被静默吞掉，与本功能目的相悖

### 方案 方案 D：按两侧 id 是否一致识别多端模组
- 优点：不需要 loader 参数
- 缺点：id 在两套元数据里可以不同，按 id 区分会漏掉 id 不一致的多端模组，行为不可预测
- 为何不选：**实测证伪**：四个真实双端 jar 两侧 id 4/4 完全相同（collective / Towns-and-Towers / packetfixer / BadOptimizations），根本区分不出来

### 方案 方案 E：把解析顺序改成「Forge 优先」
- 优点：一行改动
- 缺点：仍不知道加载器；无法处理 NeoForge 与 Forge 元数据并存的情形
- 为何不选：会把「Fabric 实例读 Forge 侧」变成新的误报面（Fabric 生态体量更大），且违背按实例事实解析的原则

## 验证

基线（改动前，rustc 1.95.0）：`cargo test --manifest-path qomicex-core-rust/Cargo.toml --lib mods::` → `30 passed; 0 failed`。

- **新增回归测试**（`mods.rs` 的 `dependency_tests`，9 项）：`e2e_forge_instance_reads_forge_side_of_dual_jar`（Forge 实例不得出现 `fabric`/`fabricloader`/`fabriclib`，且展示字段取 Forge 侧）、`e2e_unknown_loader_keeps_fabric_side`（对照：未知加载器保持 Fabric 优先）、`e2e_forge_instance_falls_back_to_fabric_when_forge_side_absent`（Forge 实例放纯 Fabric 模组时元数据不得退化为空）、`e2e_neoforge_instance_prefers_neoforge_metadata`（NeoForge 取 `neoforge.mods.toml` 而非 `mods.toml`）、`e2e_structurally_invalid_metadata_falls_back_to_other_side`（所选侧条目结构不符时回退另一侧）、`e2e_nested_ids_respect_loader_side`（嵌套 jar id 按侧采集）、`loader_family_classification`（三侧判定 + 大小写/空白归一 + 缓存 tag 互不相同）。
- **接线测试**（`factory.rs` 的 `loader_wiring_tests`）：按真实调用形态 `create_mods(...) → get_mod_list_light()` 断言「同一 jar、同一目录布局，仅 loader 不同 → 解析结果不同」，覆盖「backend 传的 loader 有没有被工厂透传」这一段（单元测试直接调 `Mods::new` 覆盖不到）。
- **「没修复时会失败」验证**（逐项抽掉修复后重跑，均确认失败原因正是目标断言，随后还原全绿）：
  - 抽掉可用性判定（空对象 / 空 `[[mods]]` 回到「结构存在即成功」）→ `e2e_empty_fabric_object_falls_back_to_forge_metadata` FAILED：`空对象不应阻止回退到 mods.toml`（left: `""` / right: `"emptyobj"`）；`e2e_empty_forge_mods_table_falls_back_to_fabric_metadata` FAILED：`空 [[mods]] 不应阻止回退到 fabric 侧`。
    ⚠️ 该组用例的首版是**假通过**：Forge 侧用例误用 `scan(&game_dir, None)`——未知加载器按 Fabric 侧先读 `fabric.mod.json`，根本走不到 `mods.toml` 的判定，抽掉修复仍绿。补齐「必须用 Forge 实例，否则假通过」的原因注释并改为 `Some("forge")` 后才真正守住。
  - 抽掉 Forge 优先分支 → `e2e_forge_instance_reads_forge_side_of_dual_jar` FAILED：`Forge 实例不得采用 fabric.mod.json 侧的 'fabric' 依赖（issue #255）: ["fabric", "fabriclib", "fabricloader", "java", "minecraft"]`；`factory_passes_loader_through_to_metadata_parsing` FAILED：`Forge 实例经工厂扫描后不应含 fabric 依赖: ["fabric", "fabricloader", "minecraft"]` —— 与 issue 截图症状一致。
  - 抽掉 NeoForge 分派（`LoaderSide::from_loader` 把 neoforge 归为 Forge）→ `e2e_neoforge_instance_prefers_neoforge_metadata` 与 `loader_family_classification` FAILED：`NeoForge 实例应取 neoforge 侧展示字段`。
  - 抽掉「结构不符回退」（`if filled` → `if true`，即修复前「命中即算成功」）→ `e2e_structurally_invalid_metadata_falls_back_to_other_side` FAILED：`应从 mods.toml 回退解析出 mod id`。
  ⚠️ 该验证踩过一次坑并已规避：用 `Copy-Item` 还原文件会保留源文件 mtime，cargo 据此判定「未变更」而跳过重编，跑的是陈旧的「已抽掉修复」二进制，会得出「还原后仍 FAILED」的假结论。还原后必须显式刷新 mtime。
- **全量**：core `cargo test --lib` → `134 passed; 0 failed; 2 ignored`；core 仅剩 1 条存量 `base64::decode` 弃用警告（非本次引入）；`cargo fmt --check` 通过。backend `cargo test --manifest-path src-backend/qomicex-backend/Cargo.toml` → `478 passed; 0 failed; 2 ignored`；`cargo clippy --no-deps` 无 error；`cargo fmt --check` 通过。CI：主仓 PR #258 的 `backend-check` / `frontend-check` / `frontend-lint` / `plugin-ui-check` / triage 全部 pass。
- **真实数据取证**（下载真实 jar 解包，非构造样本）：见「背景」表格，`collective-1.20.1-8.53.jar` 的 fabric 侧 `depends` 含 `fabric` 而 mods.toml 侧只依赖 `minecraft`；`Towns-and-Towers-1.12-Fabric+Forge.jar` 的文件名即证明「单 jar 分发双端」是厂商的实际做法。
- **未做**：未启动后端做 HTTP 端到端复测（用户选择以单元/集成测试覆盖接线），故 `resolve()` → `create_mods` 的字段透传由类型系统（`Resolved.loader` 为必填字段，缺失即编译失败）与 code review 保证；前端 UI 未做浏览器实机复验（本次前端零改动）。

## 影响
- qomicex-core-rust/src/api/local.rs（create_mods 增 loader 参数）
- qomicex-core-rust/src/services/local/factory.rs（透传 loader + 接线测试）
- qomicex-core-rust/src/services/local/mods.rs（LoaderSide 三侧判定 / parse_metadata 按侧分派 / try_parse_mod_metadata 三态 / 嵌套 id 按侧 / 缓存 key 含侧别 / MOD_META_CACHE_VERSION 3→4）
- qomicex-core-rust/src/jni.rs（唯一另一处 create_mods 调用，传 None）
- src-backend/qomicex-backend/src/endpoints/instance_files.rs（Resolved 增 loader，6 处调用点；ModsCacheEntry 增 loader 并校验；MODS_CACHE_SCHEMA 4→5）
- src-backend/qomicex-backend/src/endpoints/connector.rs（scan_mods_to_entries / scan_host_mods_from_game_dir 增 loader，2 处调用点；新增 ConnectorGameInfo.scan_loader 与 pick_game_loader）
- 父仓需 bump qomicex-core-rust 子模块指针

## 修订记录
| 日期 | 版本 | 修改内容 | 修改人 |
|---|---|---|---|
| 2026-10-17 | v1.0 | 初版创建 | AI Agent |
| 2026-10-17 | v1.1 | PR 评审（sourcery/CodeRabbit）后补 4 项：NeoForge 与 Forge 分侧、嵌套 Jar-in-Jar id 按侧、解析未填充不再等同命中、backend 缓存校验 loader 与 host_port 改用实际游戏加载器；测试增至 7 项，逐项验证「抽掉即失败」 | AI Agent |
| 2026-10-17 | v1.2 | 二轮评审 CodeRabbit 指出「是对象/有表」不等于「可用」：`fabric.mod.json` 为 `{}`、`[[mods]]` 全空时仍算解析成功，会吞掉同 jar 的有效备用元数据。改为按实际提取到的字段判定可用性；补 2 项双向回退测试（含一个必须用 Forge 实例否则假通过的用例）；ADR 决策项增至 10 条 | AI Agent |
