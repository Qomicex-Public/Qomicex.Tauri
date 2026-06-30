# 实例 Mod 管理优化 — 设计文档

**日期:** 2026-06-30
**状态:** 已确认

## 背景

当前 `InstanceDetail` 的 Mod Tab 只展示文件名、大小和删除按钮的简单文件列表。需要优化为带元数据的丰富模组卡片，支持启用/禁用、跳转详情、更换版本等操作。

## 目标

将实例 Mod 管理 Tab 从简单文件列表升级为：
- 展示元数据（名称、版本、作者、描述）的 Mod 卡片
- 支持启用/禁用 Mod（添加/移除 `.disabled` 后缀）
- 支持右键菜单操作（MC百科、详情、更换版本、删除、多选）
- 支持批量操作（批量启用/禁用/删除）

## 架构决策

采用**全后端驱动**方案：
- 后端引用 `Qomicex.Core`，调用 `Mods.GetModList()` 获取元数据
- 后端提供新增 API 端点处理所有业务逻辑
- 前端专注于渲染和调用 API

---

## 后端变更

### 1. 添加 Qomicex.Core 引用

`Qomicex.Launcher.Backend.csproj` 添加对 `Qomicex.Core` 的项目引用。

### 2. McmodService 扩展

`McmodEntry` 增加 `Id` 字段（`int?`），新增 `BatchLookupWithIds` 方法返回 `Dictionary<string, (string? cnName, int? id)>`。mod 名称匹配复用现有 Normalize+模糊匹配逻辑。

### 3. 新增 DTO

```csharp
public class ModMetadataDto
{
    public string FileName { get; set; }
    public string Name { get; set; }
    public string Version { get; set; }
    public string Description { get; set; }
    public string[] Authors { get; set; }
    public string? IconUrl { get; set; }
    public int? CurseForgeId { get; set; }
    public string? ModrinthId { get; set; }
    public string? Source { get; set; }        // "curseforge" | "modrinth"
    public int? McmodId { get; set; }
    public string? ChineseName { get; set; }
    public bool Active { get; set; }
}

public class ChangeModVersionRequest
{
    public string FileName { get; set; }
    public string DownloadUrl { get; set; }
    public string NewFileName { get; set; }
}
```

### 4. 新增 API 端点（InstanceFilesController）

| 方法 | 路由 | 请求 | 响应 | 说明 |
|------|------|------|------|------|
| `GET` | `.../mods/metadata` | — | `ModMetadataDto[]` | 返回完整元数据列表 |
| `POST` | `.../mods/enable` | `?name=xxx.jar.disabled` | `204` | 移除 `.disabled` 后缀 |
| `POST` | `.../mods/disable` | `?name=xxx.jar` | `204` | 添加 `.disabled` 后缀 |
| `POST` | `.../mods/change-version` | body: `ChangeModVersionRequest` | `204` | 删除旧文件 + 下载新版本 |
| `POST` | `.../mods/batch-enable` | body: `string[]` | `204` | 批量启用 |
| `POST` | `.../mods/batch-disable` | body: `string[]` | `204` | 批量禁用 |
| `POST` | `.../mods/batch-delete` | body: `string[]` | `204` | 批量删除 |

### 5. Mods 实例化

```
Mods(gameDir, version, versionSegmented, apiKey)
  → GetModList() // 扫描 mods 目录，解析元数据
  → CurseForge/Modrinth 查询（已有逻辑）
  → 匹配 McmodService 获取中文名和 mcmodId
  → 返回 ModMetadataDto[]
```

- `apiKey` 从 `IConfiguration["CurseForge:ApiKey"]` 注入
- Enable/Disable 调用 Core 已有的 `Mods.EnableMod/DisableMod`

---

## 前端变更

### 1. 类型定义

```ts
// src/types/index.ts
interface ModMetadata {
  fileName: string
  name: string
  version: string
  description: string
  authors: string[]
  iconUrl?: string | null
  curseForgeId?: number | null
  modrinthId?: string | null
  source?: string | null
  mcmodId?: number | null
  chineseName?: string | null
  active: boolean
}
```

### 2. API 函数

```ts
// src/api/instance-files.ts
getModsMetadata(instanceId: string): Promise<ModMetadata[]>
enableMod(instanceId: string, name: string): Promise<void>
disableMod(instanceId: string, name: string): Promise<void>
changeModVersion(instanceId: string, body: ChangeModVersionRequest): Promise<void>
batchEnableMods(instanceId: string, names: string[]): Promise<void>
batchDisableMods(instanceId: string, names: string[]): Promise<void>
batchDeleteMods(instanceId: string, names: string[]): Promise<void>
```

### 3. ModsTab 重写

**组件树：**
```
ModsTab
  ├── ModToolbar          搜索框 + "安装 Mod" 按钮 + 批量工具栏（多选模式时显示）
  ├── ModCard[]           逐个渲染
  │     ├── ToggleSwitch  启用/禁用开关
  │     └── ContextMenu   右键菜单
  └── VersionPickerDialog 更换版本弹窗（根据 mod 的 source 调用 Modrinth/CurseForge 版本列表 API，选择后提交 change-version）
```

**ModCard 布局：**
```
┌─────────────────────────────────────────────────────────────┐
│ [Icon]  Mod 名称（中文名）              [启用 ●━]             │
│         版本 1.0.0  ·  作者名                                │
│         描述文字最多两行...                                    │
└─────────────────────────────────────────────────────────────┘
```

**禁用态：** 整行半透明/变灰，toggle 关闭，文件名显示 `.disabled` 后缀。

**右键菜单（自定义实现，Portal + 绝对定位，点击外部关闭）：**
- `MC百科` — 有 `mcmodId` 时显示，`window.open("https://www.mcmod.cn/class/{id}")`
- `查看详情` — 有 `curseforgeId` 或 `modrinthId` 时显示，跳转 `/resource-center/:id?source=xxx&category=mod`
- `更换版本` — 打开 VersionPickerDialog
- `删除` — 确认弹窗后删除
- `──────────`
- `多选模式` — 进入批量选择模式

**交互行为：**
- Toggle 点击 → 乐观更新 UI → API 调用 → 失败则回滚
- 更换版本 → 弹窗选版本 → POST change-version → 完成后刷新列表
- 多选模式 → 显示 checkbox + 顶部批量工具栏（批量启用/禁用/删除）

### 4. 保留的功能

- "安装 Mod" 按钮跳转资源中心（保持现有逻辑）
- 无 loader 时的提示状态（保持现有逻辑）
- 搜索过滤功能

---

## 数据流

```
ModsTab mount
  → getModsMetadata(instanceId)
  → setMods(data)
  → 根据 fileName 判断 active 状态

Toggle 点击
  → setMods(乐观更新 active 状态)
  → POST enable/disable API
  → 成功: 保持  失败: 回滚 + toast

更换版本
  → 打开 VersionPickerDialog
  → 选中版本后 POST change-version
  → 轮询/等待下载完成 → getModsMetadata 刷新列表
```

---

## 不涉及的范围

- 不修改资源中心详情页代码（复用现有路由）
- 不修改 Core 中 Mods.cs 的元数据解析逻辑
- 不修改现有 Modrinth/CurseForge API 查询逻辑
- 光影包、资源包等其他 Tab 保持不变
