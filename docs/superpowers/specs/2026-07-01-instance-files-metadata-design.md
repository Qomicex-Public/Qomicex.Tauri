# 实例管理 — 全页签增强（接入 Local 模块元数据）

## 目标

将 `Qomicex.Core` Local 模块中已有的 `Resourcepack`、`Shaders`、`Saves`、`Screenshots`、`DataPacks` 类全部接入后端 API，前端各页签按照 ModsTab 模式使用富元数据卡片展示，替代当前仅显示文件名的简陋列表。

## 后端变更

### 文件：`src-backend/.../Controllers/InstanceFilesController.cs`

#### 新增 DTO（`Models/FileEntry.cs`）

| DTO | 字段 |
|-----|------|
| `ResourcePackMetadataDto` | FileName, Name, Description, PackFormat, Version, IconBase64, CurseForgeId, ModrinthId, Source |
| `ShaderMetadataDto` | FileName, Name, Description, Version, IconBase64, CurseForgeId, ModrinthId, Source |
| `SaveMetadataDto` | Name, FilePath, LastPlayed, IconBase64 |
| `ScreenshotMetadataDto` | FileName, FilePath, CreatedAt, FileSize, ThumbnailBase64 |
| `DataPackMetadataDto` | FileName, Name, Description, PackFormat, Version, IconBase64, CurseForgeId, ModrinthId, Source |

#### 新增端点

| 方法 | 路由 | 返回值 | 调用 Local 方法 |
|------|------|--------|----------------|
| `GET` | `resourcepacks/metadata` | `List<ResourcePackMetadataDto>` | `Resourcepack.GetResourcePackList()` |
| `GET` | `shaderpacks/metadata` | `List<ShaderMetadataDto>` | `Shaders.GetShaderList()` |
| `GET` | `saves/metadata` | `List<SaveMetadataDto>` | `Saves.GetSaveList()` |
| `POST` | `saves/rename` | `NoContent` | `Saves.RenameSave()` |
| `POST` | `saves/backup` | `NoContent` | `Saves.BackupSave()` |
| `GET` | `screenshots/metadata` | `List<ScreenshotMetadataDto>` | `Screenshots.GetScreenshotList()` |
| `GET` | `datapacks` | `List<FileEntry>` | — (基础文件列表) |
| `GET` | `datapacks/metadata` | `List<DataPackMetadataDto>` | `DataPacks.GetDataPackList()` |
| `DELETE` | `datapacks` | `NoContent` | — (删除文件) |

#### `GetPath()` 补充 datapacks 路由

```csharp
"datapacks" => "datapacks",
```

### 文件：`src-backend/.../Models/FileEntry.cs`

新增上述 5 个 DTO 类。

## 前端变更

### API 层（`src/api/instance-files.ts`）

新增函数：
- `getResourcePacksMetadata(instanceId)`
- `getShadersMetadata(instanceId)`
- `getSavesMetadata(instanceId)`
- `renameSave(instanceId, name, newName)`
- `backupSave(instanceId, name)`
- `getScreenshotsMetadata(instanceId)`
- `getDataPacks(instanceId)`
- `getDataPacksMetadata(instanceId)`
- `deleteDataPack(instanceId, name)`

### 类型层（`src/types/index.ts`）

新增接口：`ResourcePackMetadata`, `ShaderMetadata`, `SaveMetadata`, `ScreenshotMetadata`, `DataPackMetadata`

### 新组件

| 组件 | 文件 | 功能 |
|------|------|------|
| `ResourcePacksTab` | `src/pages/InstanceDetail.tsx` 内 | 加载 ResourcePackMetadata[]，搜索筛选，渲染 ResourcePackCard |
| `ResourcePackCard` | `src/components/ResourcePackCard.tsx` | 图标、名称、描述、pack_format、来源标签、删除 |
| `ShadersTab` | `src/pages/InstanceDetail.tsx` 内 | 加载 ShaderMetadata[]，搜索筛选，渲染 ShaderCard |
| `ShaderCard` | `src/components/ShaderCard.tsx` | 图标、名称、描述、来源标签、删除 |
| `SaveCard` | `src/components/SaveCard.tsx` | 图标、世界名、最后游玩时间、备份/重命名/删除 |
| `ScreenshotCard` | `src/components/ScreenshotCard.tsx` | 缩略图、文件名、大小、点击大图预览 |
| `DataPacksTab` | `src/pages/InstanceDetail.tsx` 内 | 加载 DataPackMetadata[]，搜索筛选，渲染 DataPackCard |
| `DataPackCard` | `src/components/DataPackCard.tsx` | 图标、名称、描述、pack_format、来源标签、删除 |

### InstanceDetail.tsx 改造

- 替换 `GenericFileTab`（资源包/光影包）为 `ResourcePacksTab` / `ShadersTab`
- 替换 `SavesTab` 内容为 `SaveCard` 列表 + 重命名/备份交互
- 替换 `ScreenshotsTab` 内容为 `ScreenshotCard` grid
- 新增 `DataPacksTab` 页签注册
- 各 tab 自带数据加载（参照 ModsTab），移除父组件 `loadFiles` 中对应项

### 公用功能（所有元数据页签）

- 搜索/筛选输入框（参照 ModsTab）
- 标题旁计数 badge（如 "资源包 (12)"）
- 刷新按钮
- 打开文件夹按钮（通过 Tauri `openPath`）

## 数据流

```
User clicks tab
  → Tab useEffect calls getXxxMetadata(instanceId)
  → GET /api/instance/{id}/files/xxx/metadata
  → Controller constructs Local.Xxx(baseDir, versionId, versionSegmented, apiKey)
  → calls Xxx.GetXxxList() or GetXxxListAsync()
  → Maps to XxxMetadataDto
  → Returns JSON
  → Frontend renders XxxCard list
```

## 不纳入范围

- DataPacks 的批量操作（当前无需求）
- 存档的线上匹配（CurseForge/Modrinth 不支持存档）
- 截图的批量操作
- 服务端列表页签（已有独立实现）
