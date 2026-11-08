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
5. **backend 的两套磁盘缓存都必须记录并校验 loader**（PR #258 评审 sourcery + 二轮 CodeRabbit 指出）：模组列表缓存（`ModsCacheEntry`）与更新检查缓存（`UpdateCacheEntry`）原只校验 schema/TTL/目录指纹。实例换加载器（如 Forge → Fabric）时目录签名、实例 ID 都不变、TTL 未到，前者会继续返回按旧加载器解析的依赖，后者会把旧加载器筛出的更新清单交给 `batch_update_mods`——那里按清单的 `file_name`/`download_url`/`new_file_name` 删旧文件、装新文件，后果比少一个警告严重得多。现两套缓存都写入 `loader`，命中时按**解析侧等价**比较（`forge`/`cleanroom` 同为 Forge 侧、`fabric` 与未知同为 Fabric 侧、`neoforge` 独占一侧），不一致则拒绝（fresh 与 stale 分支都拒绝，且不基于旧条目触发后台刷新）。
6. **host_port 的 mods 扫描改用「实际游戏加载器」**（PR #258 评审 sourcery 指出）：`detect_loaders` 按 `libraries` 顺序入列，OptiFine 常排在 Forge/NeoForge 之前，原先直接取「首个非 Vanilla/Unknown」会把 Forge+OptiFine 宿主判成 OptiFine，从而按 Fabric 侧解析双端 jar。现新增 `ConnectorGameInfo.scan_loader`（`skip_serializing`，不进协议负载），由 `pick_game_loader` 按 NeoForge → Forge → Cleanroom → Quilt → Fabric 优先级挑选，与展示用的 `loader` 解耦。
7. **嵌套 Jar-in-Jar 的 id 采集也要按侧**（PR #9 评审 sourcery 指出）：嵌套 jar 同样可能是双端 jar，`collect_nested_ids` / `nested_jar_id` 原先固定读 Fabric 侧，Forge 实例会把另一端的 id 记进 `provides_ids`，掩盖真实的 Forge 侧依赖。现按侧优先、另一侧兜底。
8. **解析「未填充」不再等同于「命中」**（PR #9 评审 sourcery 指出）：原实现只要条目存在就停止（`parse_*` 返回 `()`，结构不符时静默不填充），会让有效的备用元数据被跳过。现 `parse_fabric_json` / `parse_forge_toml` 返回是否成功填充，`try_parse_mod_metadata` 据此区分三态：`Parsed`（停止）/ `NotPresent`（回退下一格式或 `mcmod.info`）/ `ReadError`（条目存在但读取失败 → 同源 `catch{}` 语义，放弃本 jar）。
9. **「是对象/有表」不等于「可用」**（PR #258 评审 CodeRabbit 指出）：第 8 条首版只判定 JSON 是对象、TOML 含 `[[mods]]` 首元素，于是 `fabric.mod.json` 为 `{}`、或 `[[mods]]` 全空时仍返回成功，解析提前停止，`mod_id`/`dependencies` 恒空而同 jar 的有效备用元数据不被采纳。现判定改为「实际提取到可用字段」：fabric 侧要求 `id`/`name`/`version` 任一非空或 `depends` 为对象，Forge 侧要求 `modId`/`displayName`/`version`/`description` 任一非空；否则视为未填充并回退下一格式。
10. **可用性必须以身份字段为准，展示字段不算**（PR #9 第二轮评审 sourcery 指出）：第 9 条的「任一字段非空」仍不够——`{"schemaVersion":1,"name":"X","depends":{...}}` 这类**缺 `id`** 的 `fabric.mod.json`、以及只有 `displayName` 而**缺 `modId`** 的 `[[mods]]`，都会被判为已填充使解析提前停止。此时 `mod_id` 恒空、Forge 侧连依赖都取不到（`parse_forge_toml` 不敢猜依赖归属），而同 jar 另一侧其实结构完整。现收紧为：`fabric_json_is_usable` 要求 `id` 非空、`forge_toml_is_usable` 要求 `modId` 非空——两者在各自规范里都是必填，且是「模组是谁」的唯一来源；展示字段单独存在不再算可用。
11. **per-jar 缓存的身份必须是文件身份，不是 size+mtime**（PR #9 第二轮评审 sourcery 指出）：同名替换的 jar 只要体积与毫秒 mtime 不变，旧的 size+mtime 校验就会采信旧条目，调用方拿到的是**旧 jar 的依赖**。且并发扫描（列表页与后台刷新重叠）会写同一个缓存文件，先开始、后完成的旧扫描可覆盖较新的条目。现：
    - 缓存条目追加 `fileKey` = `jar_file_key()`（创建时间秒 + mtime 纳秒的哈希），命中要求 size / mtime / fileKey 三者全同；
    - 写入改为**同目录临时文件 + `rename`** 原子替换，避免半截 JSON 与旧内容截断；
    - 写前按 jar 当前身份复核（`jar_identity`），解析期间 jar 被替换则**不写**，交由下次扫描重扫；
    - `MOD_META_CACHE_VERSION` 4 → 5 使旧条目失效（缺 `fileKey` 的旧条目 `serde(default)` 读作 0，与任何真实身份都不等，等价未命中）。
    不采用「内容哈希」作身份：缓存的意义就是不读文件内容，为此读一遍即抵消全部收益。
12. **回退语义在注释里必须分两类写清**（PR #9 第二轮评审 sourcery 指出）：`parse_metadata` 原注释称「任一环节失败静默跳过且不尝试后续格式」，但实现里语法错/结构不符是会回退下一格式的，只有 `read_zip_entry` 返回 `Err` 才放弃整块。注释已改为明确区分两类语义（第三轮又把括号内的结论推翻，见第 13 条）。
13. **单个条目的读取失败不中止整份解析**（PR #9 第三轮评审 sourcery 指出）：第 8/12 条把「读取失败」定成放弃本 jar，但多格式并存时这会让一个损坏条目的压缩数据连带丢掉同 jar 里完好的另一侧元数据——与「按侧选、另一侧兜底」的初衷相反。现 `read_zip_entry` 的 `Err` 只表示**这一种格式不可用**，回退循环 `continue` 试下一种；`MetadataOutcome` 收敛回 `Parsed` / `NotPresent` 两态，删除 `ReadError`。
14. **zip 条目解压必须有上限**（PR #9 第三轮评审 sourcery 指出）：元数据与图标读取原用 `read_to_end` 无界缓冲，一个声明解压后数 GB 的条目即可在扫描期吃光内存。现统一按 `MAX_ZIP_ENTRY_BYTES`（8 MiB）限制，且**同时**校验 zip 头 `size()` 与实读字节数——只信头部不够，头部可被构造得比实际解压量小。
15. **缓存写入的并发与安全细节**（PR #9 第三轮评审 sourcery 指出）：临时文件名只用 `{cache}.{pid}.tmp` 时，同进程内重叠的两次扫描会写/删/改名同一路径；且缓存目录可能被低权限用户写入，`fs::write` 会跟随预先放置的符号链接。现追加进程内自增序号，并改用 `OpenOptions::create_new`（已存在即失败、不跟随符号链接）。缓存命中后再 `stat` 一次比对身份，避免读条目期间 jar 被换掉时返回旧结论。
16. **「结果正确」不等于「缓存被复用」**（PR #9 第三轮评审 sourcery 指出）：隔离测试原先断言「两侧结果不同 + 两个缓存文件存在」，但 `load_cached_mod` 恒返回 `None` 时同样满足——因为每次都重新解析也得到正确结果。现 `Mods` 记录本次扫描的缓存命中数（`cache_hits`，仅测试读），用例断言二次扫描必须命中 1 条。
17. **不采纳：Windows `fs::rename` 不能覆盖**（PR #9 第三轮评审 sourcery 提出）：`std::fs::rename` 的约定即覆盖已存在目标，Windows 经 `MoveFileExW` + `MOVEFILE_REPLACE_EXISTING` 实现，与该意见的前提相反。
18. **不采纳：缓存身份改用内容指纹**（PR #9 第三轮评审 sourcery 提出）：命中缓存的收益就是「不读 jar 内容」，为校验身份而在命中路径读一遍并哈希会让收益归零。现有 `size + mtime(纳秒) + 创建时间(秒)` 覆盖「同名替换」；残余窗口需构造性操作，后果是「元数据滞后一次扫描」且条目可重算。若确需强一致，方向是在下载/替换模组的入口失效对应缓存条目，而不是把内容哈希塞进命中路径。
19. **解压上限必须覆盖所有读取 zip 条目的地方**（PR #9 第四轮评审 sourcery 指出）：第 14 条只覆盖了元数据与图标，`collect_nested_ids`（嵌套 jar 整体读入）与 `@Mod` 注解的 `.class` 扫描仍走无界 `read_to_end`，照样能绕过。现抽出 `read_zip_entry_bytes(entry, declared_size)` 四处共用，头部 `size()` 与实读量双校验——只看头部会被「报小实际大」绕过，只看实读则峰值内存已越界。
20. **缓存未命中路径也要复核文件身份**（PR #9 第四轮评审 sourcery 指出）：第 15 条只在命中路径复核，未命中路径解析完就直接返回；若解析期间 jar 被替换，返回的是旧文件的元数据。现解析后再次比对身份，不一致则丢弃该条（既不返回也不写缓存），由下次扫描读到新文件。
21. **整合包 overrides 必须拒绝越界路径**（PR #9 第四轮评审 sourcery 指出）：`extract_prefixed` 去掉前缀后直接 `Path::join`，条目名 `overrides/../../x` 会写到安装目录之外——条目名来自不可信 zip。现新增 `safe_join_under`，逐段拒绝 `..` 与盘符段并复核结果仍在版本目录内（源实现直接 `Path::Combine`，记作有意偏离）。
22. **JNI 入口的 loader 透传单列 issue #11**（PR #9 第四轮评审 sourcery 提出）：`instanceFilesMetadata` 传 `None` 确会让 Forge 系实例按 Fabric 侧解析，但该问题在本 PR 之前即存在，且 Java 侧签名由外部 core 仓库持有，在此扩参会让现有调用方链接失败，需两仓同步发版。父仓 backend 的 6 处调用点已传真实 loader；JNI 路径在 #11 落地前与改动前行为一致，不构成回归，故不阻塞本 PR。
23. **上限要按内容性质分级**（PR #9 第五轮评审 sourcery 指出）：把 8 MiB 同时用于文本元数据与嵌套 jar / `.class`，会把**合法**的大号嵌套 jar 判为损坏，其声明的 id 与注解依赖一起丢失——反而制造「缺少前置」误报。现拆两级：文本 `MAX_ZIP_ENTRY_BYTES = 8 MiB`、二进制 `MAX_ZIP_BINARY_ENTRY_BYTES = 64 MiB`，`read_zip_entry_bytes` 显式收 `limit` 参数。
24. **嵌套元数据逐个读、命中即返回**（PR #9 第五轮评审 sourcery 指出）：`nested_jar_id` 原先把三个条目都读成字符串再选，单个嵌套 jar 最坏占三份上限的内存，并发扫描下放大成内存压力。现按侧优先顺序逐个读取，每轮只持有一份，命中即返回。
25. **整合包解压的其余加固拆到 issue #12**（PR #9 第四、五轮评审 sourcery）：解压大小/磁盘配额、符号链接防护、越界条目的处理策略、`extract_zip` 同类问题——四项都落在**本 PR 未触碰**的既有解压路径，需先定口径（配额按什么算、越界是整包失败还是记日志继续），不适合夹带在解析选侧 PR 里。
26. **盘符相对段与目录条目判定**（PR #9 第五轮评审 sourcery 指出）：原判定只拒 `len == 2` 的 `C:`，`C:payload` 这类盘符相对段会通过（`PathBuf::push` 会整条替换）；目录条目判定只认 `/`，`subdir\` 会被当文件创建。现抽出 `has_drive_prefix` 与 `is_directory_entry`，两个 `extract_prefixed` 共用。
27. **进度按已处理任务数计数**（PR #9 第六轮评审 sourcery 指出，属本轮改动引入的缺陷）：第 20 条的「解析期间 jar 被替换则丢弃该条」让 `Ok(Ok(None))` 既不重试也不计数，进度回调因此停在 `total_count` 之下，前端进度条卡住。现进度按**已处理任务数**递增，与是否采纳结果无关。丢弃本身保留——返回旧文件的元数据比少一条结论更糟；也不在任务内重试，下一次扫描自然会读到新文件。
28. **Windows 段归一化后再判父目录段**（PR #9 第六轮评审 sourcery 指出）：只比对字面量 `..` 会漏——Win32 的段规范化剥掉尾部点与空格，`..junk` / `...` / `..  ` 都会被当成父目录段，词法 `starts_with` 拦不住。现先归一（剥尾部点与空格），归一后以 `..` 开头即拒绝；纯点/空格段（不含连续两点）仍按空段折叠。
29. **前端不改**：修复后 Forge 实例不再看到 fabric 侧依赖，`PLATFORM_PROVIDED_IDS` 维持 ADR-101 v1.2 的口径（`fabric`/`quilt` 不得入列）。

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
  - 第二轮评审后追加（逐项抽掉 → 失败 → 还原全绿）：
    - 抽掉「身份字段」判定（`fabric_json_is_usable` / `forge_toml_is_usable` 回到「任一字段非空」）→ `e2e_metadata_without_identity_field_falls_back_to_other_side` FAILED：`缺 id 的 fabric 侧不得阻止回退`。
    - 抽掉缓存 key 的侧别（`{path_hash}-{tag}.json` → `{path_hash}.json`）→ `e2e_cache_isolates_metadata_between_loader_sides` FAILED：`Fabric 实例不得复用 Forge 侧缓存: ["minecraft", "forgelib"]`。
    - 抽掉文件身份校验（命中条件回到 size+mtime）→ `cache_entry_requires_matching_file_identity` FAILED：`size 与 mtime 相同但文件身份变了 → 必须重扫（同名替换）`。
    - 抽掉写入前身份复核 → `stale_scan_does_not_write_cache_entry` FAILED：`过期扫描不得写入缓存条目（否则旧结论会冒充当前 jar）`。
  - 第三轮评审后追加：
    - 抽掉「条目读取失败继续下一格式」（`Err(_) => continue` → 直接返回 NotPresent）→ `unreadable_entry_falls_back_to_next_format` 与 `oversized_entry_does_not_drop_other_side_metadata` FAILED：`首选侧条目读取失败不应中止整个解析，应回退下一格式` / `超限的 fabric 侧不应连带丢掉 mods.toml`。
    - 抽掉解压上限 → `oversized_zip_entry_is_rejected_not_buffered` FAILED：`超过上限的条目应判为读取失败，不得整体读入内存`。
    - 令 `load_cached_mod` 恒返回 `None` → `e2e_cache_isolates_metadata_between_loader_sides` FAILED：`Forge 二次扫描应命中 1 条缓存（命中为 0 说明缓存没被复用，本用例证明不了隔离）`——这正是第三轮意见 8 指出的假通过路径，现已堵住。
  - 第四轮评审后追加：
    - 把 `safe_join_under` 的 `..` 判定改成 `continue` → `safe_join_under_rejects_traversal` FAILED：`"../escape.jar" 属越界路径，应被拒绝`。
    - 把 `read_zip_entry_bytes` 退回无界 `read_to_end` 并去掉头部检查 → `oversized_zip_entry_stops_reading_at_limit` FAILED（计数 reader 抓到读取量越界）。
  ⚠️ 该验证踩过一次坑并已规避：用 `Copy-Item` 还原文件会保留源文件 mtime，cargo 据此判定「未变更」而跳过重编，跑的是陈旧的「已抽掉修复」二进制，会得出「还原后仍 FAILED」的假结论。还原后必须显式刷新 mtime。
- **全量**：core `cargo test --lib` → `148 passed; 0 failed; 2 ignored`（第六轮评审后；第五轮 146、第四轮 143、第三轮 141、第二轮 138、首轮 134）；另有 `12 + 11 + 0`（integration/其它 target）全绿；`cargo fmt --check` 通过；新增代码无 clippy 告警（仅存量告警）。backend `cargo test --manifest-path src-backend/qomicex-backend/Cargo.toml` → `478 passed; 0 failed; 2 ignored`；`cargo clippy --no-deps` 无 error；`cargo fmt --check` 通过。CI：主仓 PR #258 的 `backend-check` / `frontend-check` / `frontend-lint` / `plugin-ui-check` / triage 全部 pass。
- **真实数据取证**（下载真实 jar 解包，非构造样本）：见「背景」表格，`collective-1.20.1-8.53.jar` 的 fabric 侧 `depends` 含 `fabric` 而 mods.toml 侧只依赖 `minecraft`；`Towns-and-Towers-1.12-Fabric+Forge.jar` 的文件名即证明「单 jar 分发双端」是厂商的实际做法。
- **未做**：未启动后端做 HTTP 端到端复测（用户选择以单元/集成测试覆盖接线），故 `resolve()` → `create_mods` 的字段透传由类型系统（`Resolved.loader` 为必填字段，缺失即编译失败）与 code review 保证；前端 UI 未做浏览器实机复验（本次前端零改动）。

## 影响
- qomicex-core-rust/src/api/local.rs（create_mods 增 loader 参数）
- qomicex-core-rust/src/services/local/factory.rs（透传 loader + 接线测试）
- qomicex-core-rust/src/services/local/mods.rs（LoaderSide 三侧判定 / parse_metadata 按侧分派 / try_parse_mod_metadata 两态 / 嵌套 id 按侧 / 缓存 key 含侧别 / MOD_META_CACHE_VERSION 3→4→5 / 可用性判定要求身份字段 / 缓存按文件身份校验与原子写入 / zip 条目解压上限 / 缓存命中计数）
- qomicex-core-rust/src/jni.rs（唯一另一处 create_mods 调用，传 None；该入口的 loader 透传见 issue #11）
- src-backend/qomicex-backend/src/endpoints/instance_files.rs（Resolved 增 loader，6 处调用点；ModsCacheEntry 与 UpdateCacheEntry 均增 loader 并校验；MODS_CACHE_SCHEMA 4→5）
- src-backend/qomicex-backend/src/endpoints/connector.rs（scan_mods_to_entries / scan_host_mods_from_game_dir 增 loader，2 处调用点；新增 ConnectorGameInfo.scan_loader 与 pick_game_loader）
- qomicex-core-rust/src/services/installers/modpacks/{mod,curseforge,modrinth}.rs（`safe_join_under` 拒绝越界条目 / `has_drive_prefix` / `is_directory_entry`；其余解压加固见 issue #12）
- 父仓需 bump qomicex-core-rust 子模块指针

## 修订记录
| 日期 | 版本 | 修改内容 | 修改人 |
|---|---|---|---|
| 2026-10-17 | v1.0 | 初版创建 | AI Agent |
| 2026-10-17 | v1.1 | PR 评审（sourcery/CodeRabbit）后补 4 项：NeoForge 与 Forge 分侧、嵌套 Jar-in-Jar id 按侧、解析未填充不再等同命中、backend 缓存校验 loader 与 host_port 改用实际游戏加载器；测试增至 7 项，逐项验证「抽掉即失败」 | AI Agent |
| 2026-10-17 | v1.3 | 二轮评审 CodeRabbit 补第三处同类遗漏：更新检查缓存 `UpdateCacheEntry` 同样不校验 loader，而它的产物会被 `batch_update_mods` 用于删装模组文件；两套缓存的 loader 校验口径统一到 `loader_matches` | AI Agent |
| 2026-10-17 | v1.2 | 二轮评审 CodeRabbit 指出「是对象/有表」不等于「可用」：`fabric.mod.json` 为 `{}`、`[[mods]]` 全空时仍算解析成功，会吞掉同 jar 的有效备用元数据。改为按实际提取到的字段判定可用性；补 2 项双向回退测试（含一个必须用 Forge 实例否则假通过的用例）；ADR 决策项增至 10 条 | AI Agent |
| 2026-11-04 | v1.4 | PR #9 第二轮评审 sourcery 补 3 项：① 可用性收紧为「身份字段」——`fabric.mod.json` 必须有 `id`、`[[mods]]` 必须有 `modId`，展示字段单独存在不算可用；② per-jar 缓存改用文件身份（`fileKey` = 创建时间+mtime）校验并以临时文件 + `rename` 原子写入，写前复核 jar 身份，`MOD_META_CACHE_VERSION` 4→5；③ 纠正 `parse_metadata` 回退语义注释（不可解析→回退，读取失败→放弃）。补 4 项测试并逐项验证「抽掉即失败」；ADR 决策项增至 13 条 | AI Agent |
| 2026-11-08 | v1.5 | PR #9 第三轮评审 sourcery 8 项逐条核对：6 项采纳——单条目读取失败不再中止整份解析（推翻 v1.4 第③条的结论）、zip 条目解压上限 8 MiB（头 size 与实读双校验）、临时文件名加进程内序号并用 `create_new` 防符号链接、缓存命中后复核 jar 身份、隔离测试增加缓存命中数断言；2 项举证不采纳——Windows `fs::rename` 覆盖语义与标准库文档相反、缓存身份改内容指纹会让命中收益归零。补 4 项测试并逐项验证「抽掉即失败」；ADR 决策项增至 19 条 | AI Agent |
| 2026-11-08 | v1.6 | PR #9 第四轮评审 sourcery 6 项逐条核对：5 项采纳——解压上限覆盖嵌套 jar 与 `.class` 扫描（抽出 `read_zip_entry_bytes` 四处共用）、创建时间取纳秒、缓存未命中路径也复核文件身份、计数器验证读取确实停在上限、整合包 `safe_join_under` 拒绝越界条目；1 项单列 issue #11（JNI `instanceFilesMetadata` 缺 loader，需两仓同步发版）。测试 141→143；ADR 决策项增至 23 条 | AI Agent |
| 2026-11-08 | v1.7 | PR #9 第五轮评审 sourcery 8 项逐条核对：4 项采纳——上限按内容性质分级（文本 8 MiB / 二进制 64 MiB，避免误伤大号嵌套 jar）、`nested_jar_id` 逐个读命中即返回、`has_drive_prefix` 覆盖盘符相对段、`is_directory_entry` 两种分隔符；4 项不采纳并说明理由，其中三项整合包解压加固拆到 issue #12（本 PR 未触碰的既有路径）。测试 143→146；ADR 决策项增至 27 条 | AI Agent |
| 2026-11-08 | v1.8 | PR #9 第六轮评审 sourcery 5 项逐条核对：2 项为本 PR 改动引入的缺陷并已修复——`Ok(Ok(None))` 丢弃结论时不计进度（改为按已处理任务数计数）、只比对字面量 `..`（改为按 Win32 口径归一再判父目录段）；3 项不采纳，其中两项整合包解压项并入 issue #12。测试 146→148；ADR 决策项增至 29 条 | AI Agent |
