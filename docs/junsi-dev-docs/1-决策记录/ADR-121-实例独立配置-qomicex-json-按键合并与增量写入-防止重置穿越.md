# ADR-121：实例独立配置 qomicex.json——按键合并、增量写入与重置隔离

| 属性 | 内容 |
|---|---|
| 状态 | 已采纳 |
| 日期 | 2026-10-26 |
| 决策者 | AI Agent |

## 背景

实例设置（JVM 参数、Java 路径、内存、版本隔离、校验开关等）此前只保存在
`{数据目录}/data/instances.json`。该文件是**全实例共享**的单一 JSON：

- 文件被误删、写坏或迁移丢失时，所有实例的设置一起消失，只剩磁盘扫描出的默认记录；
- 实例目录本身（`versions/{name}`）明明还在，用户却要重新配置 JVM/内存；
- 实例复制/备份/换机时，设置无法随目录走。

需要把实例设置落到**实例自己的目录**，同时保持与现有统一文件的兼容，并避免两个
持久化位置之间出现「改一个字段把别的字段覆盖掉」的问题。后者尤其重要：重置内存
绝不能连带把额外 JVM 参数清空。

## 决策

1. **独立配置路径**：`{gameDir}/versions/{name}/qomicex.json`。路径解析与
   `rename_version_dir` 一致：`gameDir` 为相对路径时以 `resolve_base_dir()` 为基座。
2. **读取按键合并**：先读独立文件；缺失、`null`、空白字符串、空数组按**单个键**
   回退到 `instances.json`，绝不整文件回退。独立文件中的非空值优先。
3. **回退补写**：读取时把从统一文件回退到的**非默认值**补写进独立文件；显式保存时
   写全量允许字段。这样统一文件丢失后，实例目录仍保有恢复所需的关键设置。
4. **增量写入**：`update` 比较保存前后的实例快照，只把真正变化的键写入独立文件。
   重置 `maxMemory` 时 `jvmArgs` 没有变化，就完全不会被读取/重写。统一文件继续写，
   作为兼容镜像与兜底。
5. **空值语义**：更新接口用 `Option<Option<T>>` + `deserialize_double_option` 区分
   「字段缺失（不修改）」与「显式 null（清除）」。前端改为字段级补丁提交，清空
   JVM/Java/备注时发送 `null`，并把统一文件中的对应值同步清空。
6. **身份与本地数据边界**：独立文件不写 `accountName`/`accountUuid`/`accessToken`、
   `iconData`、`gameDir`、`resolvedGameDir`、`isDefault`；`lastPlayed`/`playTime`/
   `createdAt` 属于本地生命周期数据，也不落独立文件。读取时 `id`/`name`/`gameDir`
   始终以实例记录为准，避免整合包里的旧 id 覆盖本地记录。
7. **丢失恢复**：`sync_from_disk` 在第 4 步统一记录不存在时，用 `qomicex.json`
   恢复原 `id`、JVM、内存、Java 路径等；id 冲突（目录被复制）则分配新 id。
   首次升级时，`sync_from_disk` 为缺失独立文件的实例补一份完整快照。
8. **导出整合包**：CF/MR 格式把 `qomicex.json` 列入根文件排除项；Qomicex 格式
   额外写入 `overrides/qomicex.json`，内容仅含 `maxMemory`/`jvmArgs`/
   `versionIsolation`/`skipIntegrityCheck` 的脱敏子集，不含本地绝对路径、分组与统计。
   导出只读快照，不回写本地设置。导入时 `release_qml_overrides` 对
   `overrides/qomicex.json` 特判：无论实例是否开启版本隔离，都释放到
   `{gameDir}/versions/{name}/qomicex.json`，避免散落到共享游戏根目录被其他实例误读；
   同时在建实例与解压前读取包内 `versionIsolation`，让「实例记录的隔离方式」与
   「overrides 的解压位置」保持一致，再按读取合并自动采纳其余设置。

## 备选方案

### 方案 彻底停写 instances.json
- 优点：单一事实源，不可能出现两处不一致
- 缺点：改动面大，旧版本/插件/外部工具仍读统一文件；实例目录被删除后设置无法兜底
- 为何不选：兼容成本过高，且统一文件仍是有价值的镜像与扫描兜底

### 方案 独立文件整对象覆盖
- 优点：实现简单
- 缺点：重置内存时会把内存里可能不完整的 JVM 等字段一起写回，正是用户明确禁止的
  「重置穿越」
- 为何不选：必须按键增量写入，并让读取补写只补回退值

### 方案 只在前端按 diff 提交，后端仍整对象写
- 优点：改动集中在前端
- 缺点：任何其他调用方（崩溃结算、导入、插件）仍可能整对象写入；无法从存储层兜底
- 为何不选：前端补丁 + 后端按键增量双保险

### 方案 导出时直接复制本地 qomicex.json
- 优点：零转换
- 缺点：会泄露本机 Java 绝对路径、分组 id、游玩统计，换机后路径无效
- 为何不选：单独生成脱敏子集

## 影响

- `src-backend/qomicex-backend/src/services/instance_config.rs`（新增）：路径解析、
  按键合并/补写、增量写入、脱敏导出快照；进程内互斥串行化读改写
- `src-backend/qomicex-backend/src/services/instance.rs`：`get_all`/`get_by_id` 合并
  独立配置；`create` 采纳已有配置；`update` 增量写入；`sync_from_disk` 恢复与迁移；
  `GameInstance` 增加 `PartialEq`
- `src-backend/qomicex-backend/src/endpoints/instance.rs`：更新请求支持显式 `null`
  清除 Java 路径/JVM/版本隔离/备注；新增 `skipIntegrityCheck`
- `src/pages/InstanceDetail.tsx`：自动保存改为字段级补丁；重置分区只提交被重置字段；
  清空值发送 `null`
- `src/types/index.ts`：`CreateInstanceRequest.jvmArgs` 允许 `null`
- `src-backend/qomicex-backend/src/services/modpack_export.rs`：排除原文件；Qomicex
  导出写入脱敏 `overrides/qomicex.json`
- `src-backend/qomicex-backend/src/endpoints/modpack.rs`：Qomicex 导入时把
  `overrides/qomicex.json` 固定释放到版本目录，并在解压前读取包内
  `versionIsolation` 以对齐实例记录与解压位置（不受导入对话框的全局默认影响）

## 验证

- `instance_config` 单测：逐键回退、空值回退、独立文件优先、增量写入不碰未变键、
  敏感字段不落盘、导出脱敏、损坏文件回退重写、身份字段不被文件覆盖
- `instance` 单测：重置内存不连带重置 JVM；`instances.json` 丢失后从 `qomicex.json`
  恢复 id/JVM/内存；导入配置不覆盖新 id
- `modpack_export` / `modpack` 单测：CF/MR 不含原文件；Qomicex 导出的配置落到版本目录；
  包内 `versionIsolation` 可被导入流程提前读取
- `cargo test`：558 passed / 0 failed / 2 ignored；`cargo clippy --no-deps` 无新增告警；
  `pnpm run typecheck` 通过

## 修订记录
| 日期 | 版本 | 修改内容 | 修改者 |
|---|---|---|---|
| 2026-10-26 | v1.0 | 初版创建 | AI Agent |
