# ADR-111：实例身份键改用版本目录名（dirName），修复扫描覆盖导致的 JVM 设置丢失（issue #244）

| 属性 | 内容 |
|---|---|
| 状态 | 已采纳 |
| 日期 | 2026-10-10 |
| 决策者 | AI Agent |

## 背景

issue #244：实例设置（`jvmArgs` / `maxMemory` / 整合包元数据等）写在 `instances.json`，但会被实例列表扫描覆盖，导致 GTNH 等要求特定 JVM 参数的实例无法启动。用户实测：导入 GTNH 后正常游玩数天，某次打开实例设置发现 JVM 参数被清空，游戏直接无法启动。

根因（已实测复现）：实例的身份键在两侧不一致。

- 扫描（`GET /api/versions/scan`）产出的 `name` 取自**版本 JSON 的 `id`**（`endpoints/version.rs` 的 `ScannedVersionEntry.name = id`），目录名只在内部用于定位文件。
- 实例记录的 `name` 是**版本目录名**（`VersionDirName`，见 `rename_version_dir` 的注释与实现）。
- `sync_from_disk` 却按 `(game_dir, name)` 匹配（`services/instance.rs`）。二者漂移时（GTNH 实测：目录 `GTNH 2.8.4`，JSON `id` 为 `GT New Horizons`）匹配失败 → 原记录被判「磁盘残留」删除 → 第 4 步用 `..Default::default()` 重建 → `jvm_args=None`、`max_memory=4096`、整合包元数据全丢且 `id` 被更换。

日志实证同一目录下曾并存多个名字不同的记录（`GT New Horizons` / `GT New Horizons 2.8.4` / `GTNH 2.8.4`）。10 分钟「安装中宽限期」挡不住：它只在 `created_at` 存在时生效，而重建记录的 `created_at` 为 `None`（且该字段是后加的，存量记录多为空）。

端到端对照（真实后端 + 临时 `QOMICEX_HOME`）：记录已「游玩 3 天」（`created_at` 拨回 3 天前）时，无修复会丢记录并重置为 `maxMemory=4096`/无 `jvmArgs`；有修复则 `id` 不变、`maxMemory=8192`、`jvmArgs` 完整保留。

## 决策

采用「版本目录名 = 身份键」，并叠加一层「目录存在即不丢」的防御网（两处同时落地）。

**A. 身份键彻底改用目录名**

- 后端扫描 DTO `ScannedVersionEntry` 新增 `dirName`（版本目录名），与 `name`（JSON `id`）并列回传；前端 `ScannedVersion.dirName` 承接。
- `sync_scan` 请求体新增 `dirName`，一路传到 `ScannedVersionInfo.dir_name`；`sync_from_disk` 的身份键改为 `(game_dir, dirName)`，新建记录时 `name` 也取目录名（`name` 是路径基座，用 JSON `id` 会让记录指向不存在的目录）。
- `fix_instance_game_versions` / `fix_instance_loaders` 同样改按 `dirName` 匹配（原先按 `name`，漂移时会漏改甚至改错实例）。
- 前端 `getInstanceForVersion`（实例匹配）、`ensureInstance`/`openVersionSettings`/`handleToggleDefault`（补建记录的 `name`）、浏览文件夹路径拼接，全部改用 `dirName`。

兼容：`dirName` 在后端为 `Option`，缺省（旧客户端）回退用 `name`，即旧行为；前端 `dirName ?? name` 亦然。

**B. 防御网：目录存在即保留**

`sync_from_disk` 第 5 步丢弃「未被扫描命中」的记录前，先检查 `{game_dir}/versions/{记录.name}` 是否真实存在；存在则一律保留。判「是不是磁盘残留」的可靠依据是**目录本身在不在**，而不是名字对不对得上——名字匹配本身就可能因上游数据形态而变化。

**不采用**的方案：仅放宽 10 分钟宽限期（时间启发式仍是「猜」，慢网/大包照样踩到，且对 `created_at` 为空的存量记录无效）；仅让管线写入在 `get_by_id` 返回 `None` 时报错（只是暴露问题，不阻止设置丢失）。

## 备选方案

### 方案 仅放宽安装中宽限期（10 分钟 → 更大）
- 优点：改动最小，一行常量
- 缺点：仍是时间启发式：慢网/大包必超时；对 created_at 为空的存量记录完全不生效
- 为何不选：只把悬崖推远，不解决「身份键不可靠」这个根因

### 方案 仅让安装管线写入静默失败变为报错
- 优点：能暴露问题，改动小
- 缺点：不阻止设置丢失，用户仍无法启动
- 为何不选：治标不治本

### 方案 sync_from_disk 不再删除任何记录，只标记不可见
- 优点：彻底消除扫描丢数据
- 缺点：需重定义既有「幽灵记录」清理语义，影响删除/回收路径，回归面大
- 为何不选：本轮以最小可靠改动修复 #244；目录存在性检查已覆盖「误删」这一实际危害

## 影响
- src-backend/qomicex-backend/src/services/instance.rs（ScannedVersionInfo.dir_name、sync_from_disk 身份键与第 5 步防御网、回归测试）
- src-backend/qomicex-backend/src/endpoints/version.rs（ScannedVersionEntry.dir_name、fix_instance_game_versions/fix_instance_loaders 匹配键）
- src-backend/qomicex-backend/src/endpoints/instance.rs（SyncScanVersion.dir_name 透传）
- src/types/index.ts（ScannedVersion.dirName）
- src/api/instance.ts（syncScan 回传 dirName）
- src/pages/Instances.tsx（实例匹配、补建 name、浏览目录路径改用 dirName）
- docs/junsi-dev-docs/3-API规范/API列表.md（/api/instance/sync-scan 新增 dirName 契约、/api/versions/scan 响应说明）

## 修订记录
| 日期 | 版本 | 修改内容 | 修改人 |
|---|---|---|---|
| 2026-10-10 | v1.0 | 初版创建 | AI Agent |