# ADR-136：信雅互联实例按 FFAPI 命名归一 Fabric 依赖（issue #363）

| 属性 | 内容 |
|---|---|
| 状态 | 已采纳 |
| 日期 | 2026-11-18 |
| 决策者 | AI Agent |
| 关联 | issue #363、ADR-101（依赖检测在 core 解析、前端判定）、ADR-116（按加载器选解析侧） |

## 背景

issue #363：Forge/NeoForge 整合包用信雅互联（Sinytra Connector）加载 Fabric 模组，游戏能正常启动，但实例管理的「缺失依赖」把 Fabric 侧条目判为未满足。

代码事实：`src/lib/modDependencies.ts` 只回答「这个 mod id 在不在」。Fabric jar（没有 Forge 元数据）在 Forge 实例里按 ADR-116 回退 Fabric 侧解析，`depends` 里是 `fabric` / `fabric-api` / `fabric-*-v1`。

上游命名（Sinytra Connector 官方 docs，实测版本 2026-11）：

- Connector 的 FML mod id：新版 `connector`，Forge 1.20.x 的 1.x 用 `connectormod`；
- Forgified Fabric API（FFAPI）主 id：`fabric_api`（下划线）；
- FFAPI 的所有子模块把上游 id 的 `-` 换成 `_`（`fabric-transfer-api-v1` → `fabric_transfer_api_v1`）。

因此按原样比较 id 时，Connector 包的整片 Fabric API 依赖都会被误报；这不代表缺文件，而是两侧命名不一致。

## 决策

1. 在 `computeMissingDependencies` 里识别**启用中的** Connector（`connector` 或 `connectormod`），且要求实例加载器为 Forge/NeoForge（Connector 只在这两类实例里运行）。禁用的 Connector 不参与加载，不能借此放行。
2. 仅当 Connector 存在时，对 `fabric` / `fabric-` 前缀的依赖做一次 FFAPI 归一后再匹配，且**只与 FFAPI 自己提供的 id 集合比较**（主 id `fabric_api`/`fabric-api` 及其嵌套子模块）：
   - `fabric`（1.19.2 之前的 Fabric API id）→ `fabric_api` / `fabric-api`；
   - `fabric-*` → 连字符换下划线（`fabric_lifecycle_events_v1` 等）。
3. 归一范围刻意收窄到 `fabric` / `fabric-` 前缀：其他模组的连字符 id 不经手，避免把真实缺失误判成「已提供」。
4. 不校验版本（沿用 ADR-101 口径）；不改后端/core 解析与缓存——依赖数据本身正确，问题只在 id 比对。
5. 新增回归脚本 `scripts/test-mod-dependencies.mjs`（tsc 编译真实源码后断言）与 `pnpm run test:mod-deps`。

## 备选方案

### 全局把 `-`/`_` 视为等价
- 优点：改动更小，不止覆盖 Connector
- 缺点：普通 Fabric 实例上会把 `my-mod` 与 `my_mod` 混为一谈，掩盖真实缺失
- 为何不选：不采纳：误报换成漏报更糟

### 把 `fabric` 加进 `PLATFORM_PROVIDED_IDS`
- 优点：一行解决旧模组的 `fabric` 依赖
- 缺点：与 ADR-101 v1.2 的明确决策冲突，会让「依赖旧版 Fabric API 但没装 API」的真实问题被静默吞掉
- 为何不选：不采纳

### 后端/core 解析时改写依赖 id
- 优点：前端逻辑简单
- 缺点：依赖 id 是模组声明的事实，改写后影响所有消费方（更新检查、联机比对）；而且只有 Connector 实例才该归一，解析层拿不到「实例里有没有 Connector」
- 为何不选：不采纳：判定所需上下文在前端

## 影响

- `src/lib/modDependencies.ts`（Connector 识别 + `connectorAliases` + `isSatisfied` 分支）
- `scripts/test-mod-dependencies.mjs`（新增，7 个断言）
- `package.json`（`test:mod-deps` 脚本）

## 风险

- Connector 装了但 FFAPI 没装：`fabric`/`fabric-api` 仍会报缺失（正确——需要 FFAPI）。
- 只映射 `fabric` 前缀；若将来 FFAPI 改了命名规则或 Connector 又换 id，需要同步更新常量。
- 无后端/缓存变更，回滚只需还原前端文件与脚本。

## 修订（2026-11-25）：v1.0 的 Connector 判定从未生效（issue #373 评论）

实测两个真实 jar 后修正前提：

1. `Connector-1.0.0-beta.49+1.20.1.jar` **没有** `META-INF/mods.toml` 也没有 `fabric.mod.json`——它是 Forge 的 `IModLocator`（条目只有 `META-INF/services`、class、`mappings.tsrg`）。静态扫描结果里不存在 `connector` / `connectormod` 这个模组，所以 v1.0 的 `connectorPresent` 恒为 false，归一逻辑从未生效。
2. `fabric-api-0.92.6+1.11.15+1.20.1.jar`（FFAPI）的 `META-INF/mods.toml`：`modId = "fabric_api"`，`provides = ["fabric", "fabric-api"]`；子模块是 `META-INF/jarjar/*.jar` 嵌套 jar，id 保持上游连字符（`fabric-lifecycle-events-v1`）。
3. core 原先只收集嵌套 jar 的 id，不解析 `provides`，因此 `fabric` / `fabric-api` 永远匹配不上。

修正：

- core（`qomicex-core-rust/src/services/local/mods.rs`）解析 `fabric.mod.json` 与 `mods.toml` 的 `provides` 并入 `providesIds`（trim、去重、排除自身 id）；per-jar 缓存版本 5 → 6，后端 mods 缓存 schema 5 → 6，升级后自动重扫。
- 前端开关从「Connector mod id 存在」改为「**启用中的 FFAPI 存在**」（`fabric_api` / `fabric-api`）：FFAPI 只在 Connector 环境里存在，且不依赖 Connector 的模组元数据。
- 归一改为双向（`fabric-*` ↔ `fabric_*`），覆盖依赖写成 FML 下划线 id 的情况；仍只与 FFAPI 自己提供的 id 比较。
- 回归脚本改为「有 FFAPI 放行 / 无 FFAPI 仍报 / 双向归一」。

## 修订记录

| 日期 | 版本 | 修改内容 | 修改人 |
|---|---|---|---|
| 2026-11-18 | v1.0 | 初版创建 | AI Agent |
| 2026-11-25 | v1.1 | Connector 判定改为 FFAPI 存在性；core 解析 provides；双向归一；缓存版本 +1（issue #373） | AI Agent |
