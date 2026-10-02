# ADR-097：资源中心整合包原地更新（issue #118）——索引+清单双基线、journal 回滚、绝不删除实例

| 属性 | 内容 |
|---|---|
| 状态 | 已采纳 |
| 日期 | 2026-10-02 |
| 决策者 | AI Agent |

## 背景

issue #118 要求：资源中心在线安装的整合包，当 CurseForge/Modrinth 存在新版本时支持原地更新，用户无需重新下载与转移存档。参考 Prism 的实现，但排除手动导入的整合包。用户已确认三项范围：①仅资源中心在线安装 + 版本隔离实例可更新；②允许跨 MC/加载器版本更新并显式标记警告；③安装侧优化收敛为「安装即写入来源字段 + 托管文件清单」。

侦察得到两个决定方案形态的事实：
1. `/versions/scan` 的 ScannedVersionEntry **没有 modpack 字段**，前端 `ScannedVersion.modpack?` 恒为 undefined，因此 `sync_scan` 带来的整合包元数据恒为 None，`sync_from_disk` 的「补全」分支永不触发 —— 整合包元数据的唯一事实来源是 `instances.json`（由安装路径写入）。这消除了「磁盘侧元数据需同步、否则扫描会把版本信息改回旧值」的风险。
2. 安装失败走 `try_delete`（连实例记录一起删）。这对「新建实例」合理，但对「原地更新」是灾难：会删掉用户的实例与存档。

Prism 的实际做法（已核对 develop 源码 FlameInstanceCreationTask.cpp / ModrinthInstanceCreationTask.cpp）：安装时把包索引留在实例内（`flame/manifest.json`、`mrpack/modrinth.index.json`），更新时用旧索引 vs 新索引做 diff，剔除相同 fileId（CF）/ 相同 sha512（MR）的文件，旧 overrides 全删，然后 `setOverride(true, 原实例ID)` 把整个新版本下到 `.tmp/<随机>` 暂存目录，再 `overrideFolder` 覆盖进原实例（带指数退避重试以防 Windows 杀软锁文件）。Prism 源码内两处 TODO/FIXME 自认：overrides 一律覆盖、不区分用户改动；`.disabled` 模组未处理。

本仓库两个基线都不存在：既有安装路径既不保留包索引，也不记录已装文件清单。

## 决策

采用「双基线 + journal 回滚 + 绝不删实例」方案：

**1. 双基线（方案 C）**，路径统一落 `versions/{name}/.qomicex/`：
- 包索引留存 `pack/`（CF manifest.json / MR modrinth.index.json）—— 回答「新包应该有什么」；
- 自持清单 `modpack-manifest.json`（来源快照 + 每文件 `{path, sha1, kind}`）—— 回答「磁盘实际是什么」。
- 分工：索引定目标、清单定改动。缺索引则推不出旧包被移除的文件；缺清单则分不清用户是否改过（Prism 的退化点）。
- 清单放实例版本目录**内部**：实例改名走 `rename_version_dir` 整目录 rename，清单自动随迁，无需迁移逻辑。

**2. 更新资格**白名单式全条件判定（`is_updatable_origin`）：`origin == "resource-center"` + source ∈ {modrinth, curseforge} + 有 projectId 与 versionId + 无 fileId/localPath + 版本隔离。任一不满足即不标记，判定为不可更新。宁可少判，也不要为来源不明的实例提供原地更新。

**3. 更新判定**用「平台 id 定身份、datePublished 定先后」，绝不用版本名/versionNumber 比较（CF 上 versionNumber 就是文件名，且平台返回列表不保证有序）。当前版本发布时间优先按 id 在列表中查找，被平台删除时回退到记录里的 `modpackVersionPublishedAt`。`datePublished` 缺失/非法者不参与判定。CF 分页失败时透出 `incomplete: true`，此时「没有更新」不可信，UI 必须提示。

**4. 用户改动处理**（比 Prism 更保守）：新包仍包含且用户改过 → **先备份再覆盖**；新包已移除且用户改过 → **保留**；不在清单中的文件 → **不动**；`saves/` → **恒跳过**（既不写也不删）。

**5. 落盘策略**取「原地逐文件替换 + journal.json」，而**非** Prism 的暂存整目录 `overrideFolder`。理由：本仓库版本隔离目录内混放 `saves/` 与用户自加的 mod，整目录替换会误伤存档。逐文件替换才能精确跳过 `saves/`。顺序为先写后删，保证中途崩溃时处于「新文件已就位 + 少量旧文件未清理」的可恢复状态，而非「旧文件已删 + 新文件未写」的不可用状态。

**6. 失败边界**：与 `try_delete` **完全隔离**。回滚按 journal 逆序（Create→删除；Overwrite/Remove→从备份复制回原位）。备份目录名记进 journal 的 `backupStamp`（自包含，不靠「猜最新目录」）。启动时扫描各实例 journal，状态为 `applying` 的自动回滚。回滚本身失败时返回 `MODPACK_UPDATE_ROLLBACK_FAILED` 并给出备份目录路径。

**7. 并发互斥**：`InstallTracker` 新增 `try_start`（检查+插入同锁内完成，消除 TOCTOU）与 `active_kind`；进度 DTO 新增 `kind` 字段透出任务类型。更新启动前还检查 `LaunchTracker`，实例运行中返回 `INSTANCE_RUNNING`。

舍弃方案：A（仅索引，Prism 原样）因分不清用户改动、一律覆盖，且无法给出「本地已修改」预览；B（仅清单，CodeRabbit issue 方案原样）因推不出旧包被移除的文件、用户改名/移动的文件会被当新增重下；Prism 的暂存整目录覆盖因其会误伤 `saves/`。

## 备选方案

### 方案 方案 A：仅留存包索引（Prism 原样复刻）
- 优点：实现量最小、与 Prism 语义一致、天然支持跨版本更新
- 缺点：分不清用户是否改动，覆盖一律无条件；无法生成「本地已修改」预览；Prism 源码自己留了 TODO 认账
- 为何不选：issue 明确要求「提醒玩家更新可能存在的隐患」，且用户改动保护是存档安全的核心；拒绝

### 方案 方案 B：仅自持清单 + 差异规划器（CodeRabbit issue 方案）
- 优点：能精确识别用户改动、能给出五分类预览、saves/ 天然排除
- 缺点：推不出旧包被移除的文件（只能「保留一切不在新包里的」）；用户改名/移动的文件会被当新增重新下载
- 为何不选：缺少包索引会导致删除判定失准、下载重复；拒绝

### 方案 Prism 的暂存整目录 overrideFolder 覆盖
- 优点：实现简单、原子性由目录替换保证、天然带指数退避重试
- 缺点：整目录替换会覆盖版本目录内的 saves/ 与用户自加文件 —— 对混放型版本隔离目录是数据丢失
- 为何不选：本仓库版本隔离目录内混放 saves/ 与用户内容，整目录替换会误伤存档；改为逐文件替换 + journal 回滚

## 影响
- src-backend/qomicex-backend/src/services/modpack_manifest.rs（新增：清单读写、路径安全校验、saves 保护、磁盘扫描基线）
- src-backend/qomicex-backend/src/services/modpack_update.rs（新增：暂存/备份/journal/回滚/崩溃恢复/清单重建）
- src-backend/qomicex-backend/src/endpoints/modpack_update.rs（新增：update-check / update-preview / update 三端点 + 差异规划器）
- src-backend/qomicex-backend/src/services/install_tracker.rs（try_start 原子互斥、active_kind、进度 DTO 增 kind）
- src-backend/qomicex-backend/src/services/instance.rs（GameInstance 增 5 个来源字段）
- src-backend/qomicex-backend/src/endpoints/modpack.rs（安装写来源字段 + 成功后落清单；ParsedModpack/parse_*/modpack_target_path 提升可见性）
- src-backend/qomicex-backend/src/endpoints/resource_center.rs（新增 cf_versions_all 未过滤全量版本查询 + incomplete 标记）
- src-backend/qomicex-backend/src/main.rs（启动时回滚未完成的更新）
- src/components/ModpackUpdateDialog.tsx（新增：检查→选版本→预览→风险确认四步）
- src/pages/InstanceDetail.tsx（概览页「检查更新」入口 + 禁用原因 + 完成后刷新）
- src/pages/DownloadCenter.tsx、src/lib/downloadGroups.ts（kind 标签、整合包分组、更新不提供暂停）
- src/api/instance.ts、src/types/index.ts、src/hooks/useDownloadSSE.ts
- qomicex-tauri-i18n/src/*/（7 语言新增 modpackUpdate 文案、stage/steps 键）

## 修订记录
| 日期 | 版本 | 修改内容 | 修改人 |
|---|---|---|---|
| 2026-10-02 | v1.0 | 初版创建 | AI Agent |