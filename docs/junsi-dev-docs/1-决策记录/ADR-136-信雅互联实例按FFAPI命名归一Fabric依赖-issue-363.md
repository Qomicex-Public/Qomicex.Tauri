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

1. 在 `computeMissingDependencies` 里识别**启用中的** Connector（`connector` 或 `connectormod`）。禁用的 Connector 不参与加载，不能借此放行。
2. 仅当 Connector 存在时，对 `fabric` / `fabric-` 前缀的依赖做一次 FFAPI 归一后再匹配：
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

## 修订记录

| 日期 | 版本 | 修改内容 | 修改人 |
|---|---|---|---|
| 2026-11-18 | v1.0 | 初版创建 | AI Agent |
