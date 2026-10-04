# ADR-101：模组依赖检测在 core 解析、前端判定（issue #165）

| 属性 | 内容 |
|---|---|
| 状态 | 已采纳 |
| 日期 | 2026-10-04 |
| 决策者 | AI Agent |

## 背景

实例详情的 Mods 列表此前无法看到模组依赖情况，玩家常在缺少前置依赖时启动失败却得不到任何提示（issue #165，type: improvement）。侦察发现 `src/components/ModCard.tsx` 里前人已留下明确扩展点注释：「暂无『依赖缺失』类问题状态——ModMetadata 没有依赖字段，后端也不返回，有数据源后再在此处扩展，不伪造状态」。core `ModInfo` 只有 name/description/version/authors 等字段，`parse_fabric_json` 丢弃了 `fabric.mod.json` 的 `id` 与 `depends`，`parse_forge_toml` 只读 `mods[0]` 的展示字段。

## 决策

1. **依赖数据在 core 解析，不重复实现**：给 submodule `qomicex-core-rust` 的 `ModInfo` 增加 `mod_id: String` 与 `dependencies: Vec<ModDependencyInfo>`，在既有 `parse_fabric_json`（`id` / `depends`）与 `parse_forge_toml`（顶层 `[[dependencies.<自身modid>]]` 的 `modId`/`mandatory`/`versionRange`/`type`）中填充，并同步扩展 per-jar 缓存 `CachedModMeta`（新字段带 `#[serde(default)]` 以兼容旧缓存）。backend `ModMetadataDto` 直接映射，前端按 mod id 集合判定。舍弃「仅 backend 侧解析」方案：需给 backend 加 toml 依赖并二次解包 jar，与 core 的格式回退顺序（fabric→mods.toml→neoforge→mcmod）会 drift，且性能与缓存一致性更差；「纯前端解析 jar」不可行（WebView 无法读本地 zip）。
2. **只收「强制依赖」**：fabric 的 `depends`（不含 recommends/suggests/breaks/conflicts）、forge `mandatory` 缺省 true 且非 false、neoforge `type="required"`。可选依赖缺失不影响启动，收录只会误报。
3. **判定口径取严格模式（已与产品确认）**：只有**启用中**的 mod 才算「已提供」依赖——`.disabled` 的 mod 不参与运行时加载，若算满足就会掩盖真实的启动失败原因。禁用中的模组自身也不挂警告（它不加载，警告是噪音）。
4. **明确不校验版本约束**：`versionRange` 是 Maven/自定义谓词（如 `[1.20.1,1.21)`），前端无可靠语义判定本地版本是否落入区间，强行判断会误报；故只回答「mod id 在不在」，版本区间仅作提示文本展示。
5. **平台内置依赖排除，且只收「加载器自身」的 id**：`minecraft`/`java`/`forge`/`neoforge`/`fabricloader`/`quilt_loader` 等恒被加载器满足，若不过滤则每个 Forge/Fabric 模组都会被标成缺失。过滤放在前端统一做（core 保留原始数据）。
   **收录标准**：只有能从加载器自身元数据取得依据的 id 才可入列；**模组 / API 的 id 绝不能当平台 id**——`fabric` 是 1.19.2 之前**旧版 Fabric API** 的 mod id（Fabric Loader 自身是 `fabricloader`；Fabric API 的 id 自 1.19.2 起改为 `fabric-api`，见 [Fabric Wiki](https://wiki.fabricmc.net/tutorial:setup)）。若把 `fabric` 当平台 id，「依赖旧版 Fabric API 但未安装」这一真实启动失败原因会被静默吞掉，与本功能目的直接相悖。`quilt` 同理（Quilt Loader 自身是 `quilt_loader`，其 `provides` 只声明 `fabricloader`，不声明 `quilt`）。此类 id 必须正常走「已启用模组的 `modId` / `providesIds`」匹配：装了能匹配上，没装就该报缺失。（PR #177 评审发现，已在 `9f71c01` 修正，并同步把判定标准写入代码注释防回流。）
6. **老 mod 文件名兜底**：只认版本后缀形态 `{dep}` / `{dep}-{version}` / `{dep}_{version}` 且 `{version}` 以数字开头（CurseForge/Modrinth 命名约定）。刻意不做子串包含与中缀匹配——`create-addon-1.0` 不提供 `create`（此约束由验证脚本实测捕获并修正）。宁可漏报也不误报。
7. **缓存 schema 版本失效**：新增 `MODS_CACHE_SCHEMA`（后端 mods 列表缓存）与 `MOD_META_CACHE_VERSION`（core per-jar 缓存），版本不符时一律判未命中、强制重扫。仅靠「文件未变」（size+mtime / 目录指纹）发现不了「解析逻辑升级了」——旧缓存会把新字段经 `#[serde(default)]` 静默读成空，导致本功能无声失效（实测踩过：升级后 `providesIds` 恒为 0）。
8. **可点击入口放菜单而非 Tooltip**：`plugin-ui` 的 `Tooltip` 内容是 `pointer-events-none` 且在 mouseleave 隐藏，无法承载可点击项；「去下载前置」入口改放右键/更多菜单，排除了在 Tooltip 内放按钮的做法。
9. **必须采集嵌套 Jar-in-Jar 子模块 id（真实数据驱动的重要修正）**：容器 jar 顶层只声明自身 id，子模块 id 在内嵌 jar 里。实测 `fabric-api-0.161.0.jar` 顶层 `id` 仅 `fabric-api`，但 `META-INF/jars/` 下嵌 **44 个** jar，分别提供 `fabric-lifecycle-events-v1`、`fabric-resource-loader-v0` 等。只读顶层 id 会让依赖这些子模块的模组被大面积误报——在真实整合包 Fabulously Optimized（38 mods）上实测误报 **7 个**。故 core 新增 `ModInfo.provides_ids`，解析两种真实布局：Fabric 的 `META-INF/jars/*.jar`、Forge/NeoForge JarJar 的 `META-INF/jarjar/metadata.json` → `jars[].path`；前端把 `providesIds` 一并计入「已提供」集合。只做一层嵌套（JiJ 规范即一层，且避免解压炸弹式递归），单步失败静默跳过。

## 备选方案

### 方案 方案 B：仅 backend 侧重复解析 jar
- 优点：不触碰 submodule，发布耦合小
- 缺点：与 core 的格式回退顺序会 drift；backend 需新增 toml 依赖；每次扫描二次解包 jar，性能与缓存一致性更差
- 为何不选：解析逻辑应单一权威源，避免两份实现漂移

### 方案 方案 C：纯前端解析 jar
- 优点：无后端改动
- 缺点：WebView 无法读取本地 zip 文件
- 为何不选：技术不可行

### 方案 宽松口径：禁用 mod 也算满足依赖
- 优点：减少「一禁用就报缺失」的困扰
- 缺点：会漏报真实的启动失败原因，与 issue 想要解决的痛点相悖
- 为何不选：严格口径才与游戏实际加载行为因果一致

### 方案 Tooltip 内放可点击的「去下载前置」按钮
- 优点：交互更集中
- 缺点：Tooltip 内容 pointer-events-none 且 mouseleave 即隐藏，按钮点不到
- 为何不选：实测组件行为不支持，改放菜单

## 影响
- qomicex-core-rust/src/models/expansion/local.rs（ModDependencyInfo + ModInfo 的 mod_id/dependencies/provides_ids）
- qomicex-core-rust/src/services/local/mods.rs（fabric/forge 依赖解析、嵌套 JiJ id 采集、CachedModMeta + 版本号、26 个测试）
- src-backend/qomicex-backend/src/endpoints/instance_files.rs（ModDependencyDto + providesIds 映射 + MODS_CACHE_SCHEMA=3）
- src/types/index.ts（ModDependency + ModMetadata 的 modId/dependencies/providesIds）
- src/lib/modDependencies.ts（新增判定模块）
- src/components/ModCard.tsx（⚠ 徽标 + 菜单入口）
- src/pages/InstanceDetail.tsx（筛选桶 + 汇总横幅 + 跳转）
- qomicex-tauri-i18n 7 语言 instanceDetail.ts（各 5 键）
- 父仓需 bump 两个 submodule 指针

## 验证（真实数据）
- 真实整合包实测（本机 `C:\qomicex-launcher` 数据目录）：Fabulously Optimized（Fabric 38）、Enigmatica 2 Expert（Forge 262）、GTNH 2.8.4（Forge 230）、test-neoforge。
- 修复嵌套 JiJ 前：Fabulously Optimized 误报 **7** 个缺失依赖（全为 fabric-api 子模块）→ 修复后 **0**。
- 正向对照（证明非假阴性）：清空 `providesIds` 精确重现那 7 个误报；禁用/移除 fabric-api 亦各报 7 个。
- PR #177 评审修复（`9f71c01`）后复验：移除 `fabric`/`quilt` 未引入任何新误报，三个真实整合包仍为 0 缺失；新增 7 项行为断言（含「只声明 modId=fabric 的旧版 API 仍能满足依赖」「11 个真平台 id 仍被排除」两条关键回归）全部通过。
- 浏览器实机（Playwright + Tauri mock，`/instances/ba13cdf9-cc7?tab=mods`）：筛选桶计数、汇总横幅（「有 7 个模组缺少前置依赖」+「只看这些」）、7 行筛选结果带 ⚠ 徽标、Tooltip（「缺失依赖 / fabric-api」）、「下载前置：fabric-api」跳转至资源中心（带 keyword/gameVersion/loader）均确认。

## 修订记录
| 日期 | 版本 | 修改内容 | 修改人 |
|---|---|---|---|
| 2026-10-04 | v1.0 | 初版创建 | AI Agent |
| 2026-10-04 | v1.1 | 真实数据验证发现嵌套 JiJ 子模块 id 缺失导致大面积误报，新增 providesIds 采集；缓存加版本号；补真实数据与浏览器实测结论 | AI Agent |
| 2026-10-04 | v1.2 | PR #177 评审指出 `fabric` 被误当平台内置 id（实为旧版 Fabric API 的 id），连同同类项 `quilt` 一并移除并写明收录标准；补该修复的复验结论 | AI Agent |