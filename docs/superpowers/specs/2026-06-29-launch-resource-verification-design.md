# 启动前资源完整性检查与启动日志

## 背景与问题

1. **Forge 主 jar 缺失**：`InstallTask` 的 Forge/NeoForge 分支调用 `InstallModLoader` 后只调用 `GetMissForgeLibraries`（installer 自带库列表），没有调用 `GetMissMainJarAsync(_versionId)` 补全合并后版本的主 jar。Fabric/Quilt 分支有此步骤，Forge 缺失，导致 `1.12.2-Forge-14.23.5.2864.jar` 不存在，启动时 classpath 末尾变成 `versions\.jar`。
2. **启动前无资源检查**：`InstanceController.Launch` 直接 `SelectParam` → `UnzipNatives` → 启动进程，缺主 jar 也照样启动，报错信息不直观。
3. **启动无日志**：`Launch` 方法没有任何日志输出，无法知晓选了哪个 Java、内存、账户等启动详情。
4. **版本 ID 拼接问题**：`Launch` 用 `GameVersion`+`Loader`+`LoaderVersion` 拼接 versionId，用户改名后拼接结果可能与实际版本目录不匹配。

## 约束

- **Core 不可改动**（`Qomicex.Avalonia/Qomicex.Core/` 是共享 submodule，改动会影响其它项目）。所有修改限制在 `src-backend/` 和 `src/` 内。
- 复用 Core 已有 API：`LocalResourceHelper.GetAllMissFilesAsync`、`GetMissMainJarAsync`、`DownloadManager`。

## 设计

### 1. 后端启动日志

**文件**：`src-backend/Qomicex.Launcher.Backend/Controllers/InstanceController.cs`

`InstanceController` 注入 `ILogger<InstanceController>`。在 `Launch` 方法中，`SelectParam` 调用前用 `LogInformation` 输出：

- 实例名、版本 ID、GameDir
- Java 路径、VersionID
- 最大内存
- 账户名、UUID、登录方式（token 脱敏不输出）

### 2. Forge 主 jar 补全

**文件**：`src-backend/Qomicex.Launcher.Backend/Services/InstallTask.cs`

在 `isForgeLike` 分支的 `downloading-loader-libs` 阶段之后、`TryDelete(installerPath)` 之前，插入：

```
SetState("downloading-mainjar", 85, $"{_versionId}.jar");
var loaderMainJar = await resourceHelper.GetMissMainJarAsync(_versionId, _gameDir);
if (loaderMainJar != null && !string.IsNullOrEmpty(loaderMainJar.Path))
{
    var jarTid = _downloadManager.CreateTask(maxConcurrentFiles: 1, maxRetries: 3, ignoreRangeProbe200Ok: true);
    _downloadManager.AddFileToTask(jarTid, loaderMainJar.Url, loaderMainJar.Path);
    await RunDownloadManagerStage(jarTid, 85, 95);
}
else
{
    SetState("downloading-mainjar", 95);
}
```

与 Fabric/Quilt 分支（line 226-239）逻辑一致。

### 3. 版本 ID 统一

**文件**：`InstanceController.cs`

`Launch` 方法和新增的 verify-resources / repair-resources 接口统一使用 `instance.Name` 作为版本 ID（版本目录名），去掉 `GameVersion`+`Loader`+`LoaderVersion` 拼接逻辑。

### 4. verify-resources 接口

**文件**：`InstanceController.cs` + 新增 `Models/VerifyResourcesResult.cs`

**接口**：`GET /instance/{id}/verify-resources`

**逻辑**：
1. 获取实例，`versionId = instance.Name`
2. `new LocalResourceHelper().GetAllMissFilesAsync(versionId, instance.GameDir)` — 内部自动追 inheritsFrom 链
3. 返回缺失文件列表

**返回结构**：
```json
{
  "complete": false,
  "totalCount": 3,
  "missingFiles": [
    { "name": "1.12.2-Forge-14.23.5.2864.jar", "path": "...", "url": "...", "sha1": "..." }
  ]
}
```

`complete: true` 表示资源完整。`missingFiles` 为空数组时 `complete: true`。

**`Models/VerifyResourcesResult.cs`**：
```csharp
public class VerifyResourcesResult
{
    public bool Complete { get; set; }
    public int TotalCount { get; set; }
    public List<MissingFileInfo> MissingFiles { get; set; } = new();
}

public class MissingFileInfo
{
    public string Name { get; set; } = "";
    public string Path { get; set; } = "";
    public string Url { get; set; } = "";
    public string Sha1 { get; set; } = "";
}
```

### 5. repair-resources 接口

**文件**：`InstanceController.cs` + `InstanceInstallService.cs` + 新增 `Services/RepairResourcesTask.cs`

**接口**：`POST /instance/{id}/repair-resources`

**逻辑**：
1. 获取实例，`versionId = instance.Name`
2. `GetAllMissFilesAsync(versionId, gameDir)` 扫描缺失文件
3. 无缺失 → 返回 `{ status: "complete", missingCount: 0 }`
4. 有缺失 → 创建 `RepairResourcesTask`，注册到 `InstanceInstallService._tasks`，返回 `{ status: "repairing", missingCount: N }`
5. 前端用现有 `GET /instance/{id}/install/progress` 轮询进度

**`Services/RepairResourcesTask.cs`**：
- 轻量类，构造接收 instanceId、versionId、gameDir、缺失文件列表、IHttpClientFactory
- 内部创建 `DownloadManager`，添加所有缺失文件到一个下载任务
- 暴露与 `InstallTask` 相同的进度状态字段（Stage/Progress/TotalFiles/CompletedFiles/FailedFiles/Speed/IsPaused/Error/IsCompleted）
- Stage: `"repairing-resources"`（进行中）、`"completed"`（完成）、`"failed"`（失败）
- 支持 Cancel

**`InstanceInstallService` 新增方法**：
```csharp
public void StartRepairResources(string instanceId, string versionId, string gameDir, List<MissFileData> missingFiles)
```

### 6. 前端

**文件**：`src/api/instance.ts` + `src/types/index.ts` + `src/pages/InstanceDetail.tsx`

**API（`instance.ts`）**：
```ts
export async function verifyResources(id: string): Promise<VerifyResourcesResult>
export async function repairResources(id: string): Promise<{ status: string; missingCount: number }>
```

**类型（`types/index.ts`）**：
```ts
export interface MissingFile {
  name: string
  path: string
  url: string
  sha1: string
}
export interface VerifyResourcesResult {
  complete: boolean
  totalCount: number
  missingFiles: MissingFile[]
}
```

**InstanceDetail.tsx**：
- 在设置页（Java 运行时选择附近）加"检查资源完整性"按钮
- 点击后调用 `verifyResources(id)`：
  - `complete: true` → toast "资源完整"
  - `complete: false` → 显示缺失列表（missingFiles 的 name），自动调用 `repairResources(id)`
- 修复时复用现有 `install/progress` 轮询，显示"正在补全 N 个文件..."
- 完成后 toast "资源补全完成"

## 涉及文件汇总

| 文件 | 改动 |
|------|------|
| `src-backend/.../Controllers/InstanceController.cs` | 注入 ILogger、Launch 日志、versionId 用 Name、新增 verify-resources + repair-resources |
| `src-backend/.../Services/InstallTask.cs` | Forge 分支补 GetMissMainJarAsync |
| `src-backend/.../Services/InstanceInstallService.cs` | 新增 StartRepairResources |
| `src-backend/.../Services/RepairResourcesTask.cs` | 新增轻量修复任务 |
| `src-backend/.../Models/VerifyResourcesResult.cs` | 新增返回模型 |
| `src/api/instance.ts` | 新增 verifyResources + repairResources |
| `src/types/index.ts` | 新增 MissingFile + VerifyResourcesResult |
| `src/pages/InstanceDetail.tsx` | 加"检查资源完整性"按钮 + 缺失列表 + 自动修复进度 |

## 不改动

- `Qomicex.Avalonia/Qomicex.Core/`（Core submodule，共享项目）
- `Qomicex.Avalonia/Qomicex.Downloader/`（Downloader submodule）
