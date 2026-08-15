# ADR-019：实例自定义分组（独立 groups.json + 实例多对多引用）

| 属性 | 内容 |
|---|---|
| 状态 | 已采纳 |
| 日期 | 2026-08-15 |
| 决策者 | AI Agent |

## 背景

实例列表已有基于加载器/版本类型的**过滤 tabs**（全部/模组/原版/快照/愚人节/错误，`filterType` 驱动），但实例无法归入用户自定义分类。需求：**新增自定义分组功能，实例可添加到多个自定义分组中，原有过滤分组不变**。

需求澄清结果：
- **存储**：独立分组定义文件（groups.json 存 `{id, name, color}`），实例存分组 id 数组（多对多）。
- **管理入口**：实例列表工具条"管理分组"按钮 → 弹窗创建/重命名/改色/删除。
- **分配入口**：实例详情页分组卡片（多选 chip）+ 实例卡片 hover 菜单快捷入口。
- **列表展示**：现有过滤 tabs 后追加自定义分组 tabs，点击只显示该分组实例；实例卡片显示所属分组彩色徽章。

## 决策

### 1. 后端：InstanceGroupService + 新端点

- 新增 `services/instance_group.rs`：`InstanceGroup { id, name, color }` 存 `{BaseDir}/data/groups.json`；提供 `get_all/get_by_id/create/update/delete`，name 忽略大小写查重（重复返回 None → 400）。
- `GameInstance` 新增 `custom_group_ids: Vec<String>`（`#[serde(default)]`，老数据兼容），`Default` 空数组。
- 新端点（`endpoints/instance.rs`）：
  - `GET /api/instance-groups` — 分组列表
  - `POST /api/instance-groups` — 创建（`{name, color}`，空名/重名 400）
  - `PUT /api/instance-groups/{id}` — 重命名/改色
  - `DELETE /api/instance-groups/{id}` — 删除分组并**清理所有实例对该分组的引用**
- `PUT /api/instance/{id}` 的 `UpdateInstanceRequest` 新增 `custom_group_ids: Option<Vec<String>>`。

### 2. 前端：管理弹窗 + tabs + 徽章 + 详情卡片

- `src/api/instance.ts`：`InstanceGroup` 类型 + `getInstanceGroups/createInstanceGroup/updateInstanceGroup/deleteInstanceGroup`。
- `src/pages/Instances.tsx`：
  - 过滤 tabs 在原有 6 个后追加 `group:{id}` 自定义分组 tab（色点 + 名称），点击切换 `groupFilter`（与 `filterType` 互斥）；右侧"管理分组"按钮（faFolderPlus）。
  - `ManageGroupsDialog`：新建（名称 + 4 色选择）/重命名/改色/删除。
  - `AssignGroupDialog`：hover 菜单快捷分配（多选 chip）。
  - 网格/列表卡片显示所属分组彩色徽章（`borderColor: color55` + `backgroundColor: color1a`）。
- `src/pages/InstanceDetail.tsx`：QuickActions 卡片下新增"自定义分组"卡片（多选 chip，点击即时 `PUT /instance/{id}` 保存）。

### 3. i18n

- submodule `qomicex-tauri-i18n`：`instances.ts` 加 `groups/manageGroups/groupNamePlaceholder/noGroups/groupsHint`；`common.ts` 加 `create`（zh/en）。

## 备选方案

### 方案 实例直接存分组名数组（无独立 groups.json）
- 优点：改动更小，无新 service/文件。
- 缺点：分组名即唯一标识，改名需遍历所有实例；无法存颜色等元数据；空分组无法表示。
- 为何不选：独立 groups.json 支持颜色/元数据/空分组，删除时集中清理引用，语义更清晰。

### 方案 分组管理放设置页
- 优点：设置页集中管理。
- 缺点：实例分组属于高频实例管理场景，放实例页操作路径更短。
- 为何不选：用户选择实例页工具条入口。

## 影响

- 后端：`services/instance_group.rs`（新）、`services/instance.rs`（custom_group_ids）、`services/mod.rs`、`endpoints/instance.rs`（分组端点 + update 支持）、`state.rs`（注册 service）。
- 前端：`src/api/instance.ts`、`src/types/index.ts`、`src/pages/Instances.tsx`、`src/pages/InstanceDetail.tsx`。
- i18n submodule：`instances.ts` + `common.ts`（需单独提交推送）。
- 无新依赖、无构建命令变更。

## 修订记录
| 日期 | 版本 | 修改内容 | 修改人 |
|---|---|---|---|
| 2026-08-15 | v1.0 | 初版创建 | AI Agent |
