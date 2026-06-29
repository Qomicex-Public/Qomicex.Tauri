# 启动前资源完整性检查与启动日志 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在启动游戏前检查资源完整性、自动补全缺失文件，并输出启动详细信息日志；同时修复 Forge 安装流程缺失主 jar 的问题。

**Architecture:** 后端新增 `verify-resources`（只扫描返回缺失列表）和 `repair-resources`（启动轻量 `RepairResourcesTask` 下载缺失文件，复用现有 `install/progress` 进度轮询）两个接口；`Launch` 方法加 `ILogger` 日志并用 `instance.Name` 作为版本 ID；`InstallTask` Forge 分支补 `GetMissMainJarAsync`。前端在实例详情页加"检查资源完整性"按钮。

**Tech Stack:** ASP.NET Core (.NET 10), React 19 + TypeScript + Vite 7, Tailwind + shadcn/ui, Tauri v2

## Global Constraints

- **Core 不可改动**：`Qomicex.Avalonia/Qomicex.Core/` 和 `Qomicex.Avalonia/Qomicex.Downloader/` 是共享 submodule，所有修改限制在 `src-backend/` 和 `src/` 内
- **无测试框架**：本仓库无测试项目，用 `dotnet build` 和 `npx tsc --noEmit` 验证
- **前端导入必须带扩展名**：`import { foo } from './bar.ts'`（Vite 路径 bug）
- **后端错误处理**：不在 controller 加 try/catch 返回错误，让 `ErrorHandlingMiddleware` 处理；业务错误用 `ApiException`
- **版本 ID = `instance.Name`**：用实例名作为版本目录名，不再拼接 `gameVersion-loader-loaderVersion`

---

## File Structure

| 文件 | 操作 | 职责 |
|------|------|------|
| `src-backend/.../Controllers/InstanceController.cs` | 修改 | 注入 ILogger、Launch 日志、versionId 用 Name、新增 verify-resources + repair-resources |
| `src-backend/.../Services/InstallTask.cs` | 修改 | Forge 分支补 GetMissMainJarAsync |
| `src-backend/.../Services/InstanceInstallService.cs` | 修改 | 新增 StartRepairResources |
| `src-backend/.../Services/RepairResourcesTask.cs` | 新增 | 轻量修复任务，复用 DownloadManager |
| `src-backend/.../Models/VerifyResourcesResult.cs` | 新增 | verify-resources 返回模型 |
| `src/api/instance.ts` | 修改 | 新增 verifyResources + repairResources |
| `src/types/index.ts` | 修改 | 新增 MissingFile + VerifyResourcesResult |
| `src/pages/InstanceDetail.tsx` | 修改 | 加"检查资源完整性"按钮 + 缺失列表 + 自动修复进度 |

---

### Task 1: Forge 主 jar 补全

**Files:**
- Modify: `src-backend/Qomicex.Launcher.Backend/Services/InstallTask.cs:185-205`

**Interfaces:**
- Consumes: `LocalResourceHelper.GetMissMainJarAsync(version, gameDir)` from Core, `_downloadManager`, `RunDownloadManagerStage`
- Produces: Forge 安装时自动补全合并后版本的主 jar

- [ ] **Step 1: 定位 Forge 分支末尾**

打开 `src-backend/Qomicex.Launcher.Backend/Services/InstallTask.cs`，找到 `isForgeLike` 分支的 `downloading-loader-libs` 阶段之后、`TryDelete(installerPath)` 之前的位置（约 line 204）。

当前代码（line 185-205）：
```csharp
                    // Stage 7: DownloadManager - remaining loader libs (75-85%)
                    SetState("downloading-loader-libs", 75, "正在补全加载器库文件...");
                    List<LocalResourceHelper.MissFileData> remainingLibs;
                    if (loaderLower == "forge")
                    {
                        var fi = new ForgeInstaller(0, _gameDir, _gameVersion);
                        remainingLibs = fi.GetMissForgeLibraries(installerPath, _versionId);
                    }
                    else
                    {
                        var nfi = new NeoForgeInstaller(0, _gameDir, _gameVersion);
                        remainingLibs = nfi.GetMissNeoForgeLibraries(installerPath, _versionId);
                    }

                    if (remainingLibs.Count > 0)
                        await RunDownloadStage(_downloadThreads, remainingLibs, 75, 85);
                    else
                        SetState("downloading-loader-libs", 85);

                    TryDelete(installerPath);
```

- [ ] **Step 2: 在 TryDelete 之前插入主 jar 补全**

在 `SetState("downloading-loader-libs", 85)` 块之后、`TryDelete(installerPath)` 之前插入：

```csharp
                    // Stage 7b: Core - ensure main jar for merged version (85-95%)
                    _cts.Token.ThrowIfCancellationRequested();
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

插入后完整代码应为：
```csharp
                    if (remainingLibs.Count > 0)
                        await RunDownloadStage(_downloadThreads, remainingLibs, 75, 85);
                    else
                        SetState("downloading-loader-libs", 85);

                    // Stage 7b: Core - ensure main jar for merged version (85-95%)
                    _cts.Token.ThrowIfCancellationRequested();
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

                    TryDelete(installerPath);
```

- [ ] **Step 3: 编译验证**

Run: `dotnet build src-backend/Qomicex.Launcher.Backend/Qomicex.Launcher.Backend.csproj`
Expected: 成功，0 错误

- [ ] **Step 4: Commit**

```bash
git add src-backend/Qomicex.Launcher.Backend/Services/InstallTask.cs
git commit -m "fix: 补全 Forge/NeoForge 安装时缺失的主 jar"
```

---

### Task 2: verify-resources 返回模型

**Files:**
- Create: `src-backend/Qomicex.Launcher.Backend/Models/VerifyResourcesResult.cs`

**Interfaces:**
- Consumes: `LocalResourceHelper.MissFileData` from Core (fields: Name, Path, Url, Sha1 — all string)
- Produces: `VerifyResourcesResult`, `MissingFileInfo` 类型供 controller 使用

- [ ] **Step 1: 创建模型文件**

创建 `src-backend/Qomicex.Launcher.Backend/Models/VerifyResourcesResult.cs`：

```csharp
namespace Qomicex.Launcher.Backend.Models;

public class VerifyResourcesResult
{
    public bool Complete { get; set; }
    public int TotalCount { get; set; }
    public List<MissingFileInfo> MissingFiles { get; set; } = new();
}

public class MissingFileInfo
{
    public string Name { get; set; } = string.Empty;
    public string Path { get; set; } = string.Empty;
    public string Url { get; set; } = string.Empty;
    public string Sha1 { get; set; } = string.Empty;
}
```

- [ ] **Step 2: 编译验证**

Run: `dotnet build src-backend/Qomicex.Launcher.Backend/Qomicex.Launcher.Backend.csproj`
Expected: 成功

- [ ] **Step 3: Commit**

```bash
git add src-backend/Qomicex.Launcher.Backend/Models/VerifyResourcesResult.cs
git commit -m "feat: 添加 verify-resources 返回模型"
```

---

### Task 3: RepairResourcesTask

**Files:**
- Create: `src-backend/Qomicex.Launcher.Backend/Services/RepairResourcesTask.cs`

**Interfaces:**
- Consumes: `DownloadManager` from `Qomicex.Downloader`, `LocalResourceHelper.MissFileData` from Core, `IHttpClientFactory`
- Produces: `RepairResourcesTask` 类，暴露与 `InstallTask` 相同的进度状态字段，供 `InstanceInstallService` 注册和 `install/progress` 轮询

- [ ] **Step 1: 创建 RepairResourcesTask**

创建 `src-backend/Qomicex.Launcher.Backend/Services/RepairResourcesTask.cs`：

```csharp
using System.Diagnostics;
using Qomicex.Downloader;
using Qomicex.Core.Modules.Helpers.Resources;

namespace Qomicex.Launcher.Backend.Services;

public class RepairResourcesTask
{
    private readonly string _gameDir;
    private readonly List<LocalResourceHelper.MissFileData> _missingFiles;
    private readonly CancellationTokenSource _cts = new();
    private readonly DownloadManager _downloadManager = new(intervalMs: 500);

    public string InstanceId { get; }
    public string Stage { get; private set; } = "queued";
    public double Progress { get; private set; }
    public string? Error { get; private set; }
    public int TotalFiles { get; private set; }
    public int CompletedFiles { get; private set; }
    public int FailedFiles { get; private set; }
    public string CurrentFile { get; private set; } = string.Empty;
    public double Speed { get; private set; }
    public bool IsPaused { get; private set; }
    public bool IsCompleted { get; private set; }

    public event Action<RepairResourcesTask>? OnStateChanged;

    public RepairResourcesTask(string instanceId, string gameDir, List<LocalResourceHelper.MissFileData> missingFiles)
    {
        InstanceId = instanceId;
        _gameDir = gameDir;
        _missingFiles = missingFiles;

        _downloadManager.OnTaskProgressUpdated += (taskId, info) =>
        {
            TotalFiles = info.TotalFiles;
            CompletedFiles = info.CompletedFiles;
            FailedFiles = info.FailedFiles;
            Speed = info.Speed;
        };
    }

    private void SetState(string stage, double progress, string currentFile = "")
    {
        Stage = stage;
        Progress = progress;
        if (!string.IsNullOrEmpty(currentFile))
            CurrentFile = currentFile;
        OnStateChanged?.Invoke(this);
    }

    public async Task StartAsync()
    {
        try
        {
            SetState("repairing-resources", 0, "正在补全缺失资源...");

            var tid = _downloadManager.CreateTask(maxConcurrentFiles: 4, maxRetries: 3, ignoreRangeProbe200Ok: true);
            foreach (var file in _missingFiles)
            {
                if (!string.IsNullOrEmpty(file.Url) && !string.IsNullOrEmpty(file.Path))
                    _downloadManager.AddFileToTask(tid, file.Url, file.Path);
            }

            var downloadTask = _downloadManager.StartTaskAsync(tid, _cts.Token);

            int lastCompleted = 0;
            while (!downloadTask.IsCompleted && !_cts.Token.IsCancellationRequested)
            {
                var infos = _downloadManager.GetAllTaskInfos();
                if (infos.TryGetValue(tid, out var info))
                {
                    Progress = info.Progress;
                    TotalFiles = info.TotalFiles;
                    CompletedFiles = info.CompletedFiles;
                    FailedFiles = info.FailedFiles;
                    Speed = info.Speed;

                    if (info.CompletedFiles > lastCompleted)
                    {
                        var statuses = _downloadManager.GetTaskFileStatuses(tid);
                        var lastDone = statuses.LastOrDefault(s =>
                            s.Status == DownloadTask.FileStatus.Completed ||
                            s.Status == DownloadTask.FileStatus.Failed);
                        if (lastDone.Name != null)
                            CurrentFile = lastDone.Name;
                        lastCompleted = info.CompletedFiles;
                    }
                    OnStateChanged?.Invoke(this);
                }
                try { await Task.Delay(100, _cts.Token); } catch (OperationCanceledException) { break; }
            }

            await downloadTask;

            var finalInfos = _downloadManager.GetAllTaskInfos();
            if (finalInfos.TryGetValue(tid, out var finalInfo) && finalInfo.FailedFiles > 0)
            {
                var statuses = _downloadManager.GetTaskFileStatuses(tid);
                var failed = statuses.FirstOrDefault(s => s.Status == DownloadTask.FileStatus.Failed);
                throw new Exception($"补全失败: {failed.Name} (共 {finalInfo.FailedFiles} 个文件失败)");
            }

            IsCompleted = true;
            SetState("completed", 100);
        }
        catch (OperationCanceledException)
        {
            SetState("cancelled", Progress);
        }
        catch (Exception ex)
        {
            Error = ex.Message;
            SetState("failed", Progress);
            Debug.WriteLine($"[RepairResourcesTask] 补全失败: {ex}");
        }
        finally
        {
            _downloadManager.StopTask(-1);
        }
    }

    public void Cancel()
    {
        _cts.Cancel();
        _downloadManager.StopTask(-1);
        SetState("cancelled", Progress);
    }
}
```

- [ ] **Step 2: 编译验证**

Run: `dotnet build src-backend/Qomicex.Launcher.Backend/Qomicex.Launcher.Backend.csproj`
Expected: 成功，0 错误

- [ ] **Step 3: Commit**

```bash
git add src-backend/Qomicex.Launcher.Backend/Services/RepairResourcesTask.cs
git commit -m "feat: 添加 RepairResourcesTask 轻量资源修复任务"
```

---

### Task 4: InstanceInstallService 注册 RepairResourcesTask

**Files:**
- Modify: `src-backend/Qomicex.Launcher.Backend/Services/InstanceInstallService.cs`

**Interfaces:**
- Consumes: `RepairResourcesTask` from Task 3, `LocalResourceHelper.MissFileData` from Core
- Produces: `StartRepairResources(instanceId, gameDir, missingFiles)` 方法，注册到 `_tasks` 字典供 `GetState` 轮询

- [ ] **Step 1: 修改 _tasks 字典类型以支持两种任务**

`InstanceInstallService` 的 `_tasks` 当前是 `ConcurrentDictionary<string, InstallTask>`。`RepairResourcesTask` 是独立类，需要统一存储。

将 `_tasks` 改为存储 `object`，`GetState` 用反射或模式匹配读取。但更简洁的方式是：让 `RepairResourcesTask` 和 `InstallTask` 实现同一个接口。

在 `InstanceInstallService.cs` 顶部添加接口定义：

```csharp
public interface IInstallTask
{
    string InstanceId { get; }
    string Stage { get; }
    double Progress { get; }
    string? Error { get; }
    int TotalFiles { get; }
    int CompletedFiles { get; }
    int FailedFiles { get; }
    string CurrentFile { get; }
    double Speed { get; }
    bool IsPaused { get; }
    bool IsCompleted { get; }
    void Pause();
    void Resume();
    void Cancel();
}
```

- [ ] **Step 2: 让 InstallTask 实现 IInstallTask**

在 `InstallTask.cs` 的类声明改为：
```csharp
public class InstallTask : IInstallTask
```
（所有字段已是 public get，`Pause()`/`Resume()`/`Cancel()` 已存在，无需其它改动）

- [ ] **Step 3: 让 RepairResourcesTask 实现 IInstallTask 并补 Pause/Resume**

在 `RepairResourcesTask.cs` 的类声明改为：
```csharp
public class RepairResourcesTask : IInstallTask
```

在 `RepairResourcesTask` 类中 `Cancel()` 方法之前添加空实现：

```csharp
    public void Pause() { }
    public void Resume() { }
```

- [ ] **Step 4: 修改 InstanceInstallService 的 _tasks 和 GetState**

将 `_tasks` 类型改为 `ConcurrentDictionary<string, IInstallTask>`：

```csharp
private readonly ConcurrentDictionary<string, IInstallTask> _tasks = new();
```

`GetState` 方法中 `out var task` 现在是 `IInstallTask`，字段读取无需改动（接口已定义所有字段）。

- [ ] **Step 5: 添加 StartRepairResources 方法**

在 `InstanceInstallService.cs` 的 `StartRepair` 方法之后添加：

```csharp
    public void StartRepairResources(string instanceId, string gameDir,
        List<LocalResourceHelper.MissFileData> missingFiles)
    {
        var task = new RepairResourcesTask(instanceId, gameDir, missingFiles);
        _tasks[instanceId] = task;

        _ = Task.Run(async () =>
        {
            try
            {
                await task.StartAsync();
            }
            finally { }
        });
    }
```

在文件顶部添加 using（如尚无）：
```csharp
using Qomicex.Core.Modules.Helpers.Resources;
```

- [ ] **Step 6: 编译验证**

Run: `dotnet build src-backend/Qomicex.Launcher.Backend/Qomicex.Launcher.Backend.csproj`
Expected: 成功，0 错误

- [ ] **Step 7: Commit**

```bash
git add src-backend/Qomicex.Launcher.Backend/Services/InstanceInstallService.cs src-backend/Qomicex.Launcher.Backend/Services/InstallTask.cs src-backend/Qomicex.Launcher.Backend/Services/RepairResourcesTask.cs
git commit -m "feat: InstanceInstallService 支持 RepairResourcesTask"
```

---

### Task 5: InstanceController — 启动日志 + verify-resources + repair-resources

**Files:**
- Modify: `src-backend/Qomicex.Launcher.Backend/Controllers/InstanceController.cs`

**Interfaces:**
- Consumes: `ILogger<T>` from ASP.NET Core, `LocalResourceHelper` from Core, `InstanceInstallService.StartRepairResources`, `VerifyResourcesResult` from Task 2
- Produces: `GET /instance/{id}/verify-resources`, `POST /instance/{id}/repair-resources`，Launch 方法日志输出

- [ ] **Step 1: 注入 ILogger**

在 `InstanceController` 的字段和构造函数添加 `ILogger<InstanceController>`：

```csharp
    private readonly IInstanceRepository _repository;
    private readonly InstanceInstallService _installService;
    private readonly AccountService _accountService;
    private readonly JavaRuntimeStore _javaRuntimeStore;
    private readonly ILogger<InstanceController> _logger;

    public InstanceController(IInstanceRepository repository, InstanceInstallService installService, AccountService accountService, JavaRuntimeStore javaRuntimeStore, ILogger<InstanceController> logger)
    {
        _repository = repository;
        _installService = installService;
        _accountService = accountService;
        _javaRuntimeStore = javaRuntimeStore;
        _logger = logger;
    }
```

在文件顶部添加 using：
```csharp
using Microsoft.Extensions.Logging;
```

- [ ] **Step 2: Launch 方法用 instance.Name 作 versionId + 添加日志**

在 `Launch` 方法中，将 versionId 拼接逻辑：

```csharp
            var versionId = !string.IsNullOrEmpty(instance.Loader) && !string.IsNullOrEmpty(instance.LoaderVersion)
                ? $"{instance.GameVersion}-{instance.Loader}-{instance.LoaderVersion}"
                : instance.GameVersion;
```

替换为：

```csharp
            var versionId = instance.Name;
```

在 `SelectParam` 调用前（Java 路径解析的 if/else 块之后、`if (param.Java.VersionID == 0)` 之前）添加日志：

```csharp
            _logger.LogInformation(
                "[Launch] 实例={Name} 版本={VersionId} GameDir={GameDir}",
                instance.Name, versionId, instance.GameDir);
            _logger.LogInformation(
                "[Launch] Java: path={JavaPath} versionId={VersionId}",
                javaPath, param.Java.VersionID);
            _logger.LogInformation(
                "[Launch] 内存: max={MaxMemory}MB",
                instance.MaxMemory);
            _logger.LogInformation(
                "[Launch] 账户: name={AccountName} uuid={Uuid} method={LoginMethod}",
                param.Account.Name, param.Account.Uuid, param.Account.LoginMethod);
```

- [ ] **Step 3: 添加 verify-resources 接口**

在 `InstanceController` 的 `StartRepair` 方法之后添加：

```csharp
    [HttpGet("{id}/verify-resources")]
    public async Task<ActionResult<VerifyResourcesResult>> VerifyResources(string id)
    {
        var instance = _repository.GetById(id);
        if (instance == null) return NotFound();

        var versionId = instance.Name;
        var resourceHelper = new LocalResourceHelper();
        var missFiles = await resourceHelper.GetAllMissFilesAsync(versionId, instance.GameDir);

        var result = new VerifyResourcesResult
        {
            TotalCount = missFiles.Count,
            Complete = missFiles.Count == 0,
            MissingFiles = missFiles.Select(f => new MissingFileInfo
            {
                Name = f.Name,
                Path = f.Path,
                Url = f.Url,
                Sha1 = f.Sha1,
            }).ToList(),
        };

        return Ok(result);
    }
```

在文件顶部添加 using（如尚无）：
```csharp
using Qomicex.Launcher.Backend.Models;
using Qomicex.Core.Modules.Helpers.Resources;
```

- [ ] **Step 4: 添加 repair-resources 接口**

在 `VerifyResources` 方法之后添加：

```csharp
    [HttpPost("{id}/repair-resources")]
    public async Task<IActionResult> RepairResources(string id)
    {
        var instance = _repository.GetById(id);
        if (instance == null) return NotFound();

        var versionId = instance.Name;
        var resourceHelper = new LocalResourceHelper();
        var missFiles = await resourceHelper.GetAllMissFilesAsync(versionId, instance.GameDir);

        if (missFiles.Count == 0)
        {
            return Ok(new { status = "complete", missingCount = 0 });
        }

        _installService.StartRepairResources(id, instance.GameDir, missFiles);
        return Ok(new { status = "repairing", missingCount = missFiles.Count });
    }
```

- [ ] **Step 5: 编译验证**

Run: `dotnet build src-backend/Qomicex.Launcher.Backend/Qomicex.Launcher.Backend.csproj`
Expected: 成功，0 错误

- [ ] **Step 6: Commit**

```bash
git add src-backend/Qomicex.Launcher.Backend/Controllers/InstanceController.cs
git commit -m "feat: Launch 日志 + verify-resources + repair-resources 接口"
```

---

### Task 6: 前端类型和 API

**Files:**
- Modify: `src/types/index.ts`
- Modify: `src/api/instance.ts`

**Interfaces:**
- Consumes: `get`, `post` from `./client.ts`
- Produces: `MissingFile`, `VerifyResourcesResult` 类型，`verifyResources()`, `repairResources()` 函数

- [ ] **Step 1: 添加类型定义**

在 `src/types/index.ts` 的 `InstallProgressResponse` 接口之前添加：

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

export interface RepairResourcesResult {
  status: string
  missingCount: number
}
```

- [ ] **Step 2: 添加 API 函数**

在 `src/api/instance.ts` 的 `repairInstance` 函数之后添加：

```ts
export async function verifyResources(id: string): Promise<VerifyResourcesResult> {
  return get<VerifyResourcesResult>(`/instance/${id}/verify-resources`)
}

export async function repairResources(id: string): Promise<RepairResourcesResult> {
  return post<RepairResourcesResult>(`/instance/${id}/repair-resources`)
}
```

在文件顶部的 import 中添加新类型：

```ts
import type { GameInstance, CreateInstanceRequest, LaunchResult, InstallProgressResponse, VerifyResourcesResult, RepairResourcesResult } from '../types/index.ts'
```

- [ ] **Step 3: 类型检查**

Run: `npx tsc --noEmit`
Expected: 无错误

- [ ] **Step 4: Commit**

```bash
git add src/types/index.ts src/api/instance.ts
git commit -m "feat: 前端 verify-resources + repair-resources API"
```

---

### Task 7: InstanceDetail — 检查资源完整性按钮

**Files:**
- Modify: `src/pages/InstanceDetail.tsx`

**Interfaces:**
- Consumes: `verifyResources`, `repairResources`, `getInstallProgress` from `../api/instance.ts`, `MissingFile`, `VerifyResourcesResult` from `../types/index.ts`, `useMessageBox` for toast
- Produces: "检查资源完整性"按钮，点击后显示缺失列表并自动修复

- [ ] **Step 1: 添加 import**

在 `InstanceDetail.tsx` 顶部的 instance API import 行：

```ts
import { getInstance, updateInstance, launchInstance, deleteInstance, setDefaultInstance, clearDefaultInstance, getDefaultInstance } from '../api/instance.ts'
```

改为：

```ts
import { getInstance, updateInstance, launchInstance, deleteInstance, setDefaultInstance, clearDefaultInstance, getDefaultInstance, verifyResources, repairResources, getInstallProgress } from '../api/instance.ts'
```

在 types import 行添加 `MissingFile`：

```ts
import type { GameInstance, JavaRuntime, Account, SystemInfo, FileEntry, ServerEntry, ServerState, MissingFile } from '../types/index.ts'
```

- [ ] **Step 2: 添加状态变量**

在 `InstanceDetail` 组件内，`isDefault` state 之后（约 line 485）添加：

```ts
  const [verifying, setVerifying] = useState(false)
  const [verifyResult, setVerifyResult] = useState<{ complete: boolean; missingFiles: MissingFile[] } | null>(null)
  const [repairing, setRepairing] = useState(false)
  const [repairProgress, setRepairProgress] = useState(0)
```

- [ ] **Step 3: 添加检查资源完整性处理函数**

在 `handleLaunch` 函数之后添加：

```ts
  const handleVerifyResources = useCallback(async () => {
    if (!id) return
    setVerifying(true)
    setVerifyResult(null)
    try {
      const result = await verifyResources(id)
      setVerifyResult({ complete: result.complete, missingFiles: result.missingFiles })
      if (!result.complete && result.missingFiles.length > 0) {
        await handleRepairResources()
      }
    } catch {
      setVerifyResult({ complete: true, missingFiles: [] })
    } finally {
      setVerifying(false)
    }
  }, [id])

  const handleRepairResources = useCallback(async () => {
    if (!id) return
    setRepairing(true)
    setRepairProgress(0)
    try {
      await repairResources(id)
      const poll = setInterval(async () => {
        try {
          const progress = await getInstallProgress(id)
          if (progress.status === 'completed') {
            setRepairProgress(100)
            clearInterval(poll)
            setRepairing(false)
            setVerifyResult(null)
          } else if (progress.status === 'failed') {
            clearInterval(poll)
            setRepairing(false)
          } else {
            setRepairProgress(Math.round(progress.progress))
          }
        } catch {
          clearInterval(poll)
          setRepairing(false)
        }
      }, 1000)
    } catch {
      setRepairing(false)
    }
  }, [id])
```

- [ ] **Step 4: 在设置页添加按钮和缺失列表 UI**

在 InstanceDetail.tsx 的设置 tab 内，Java 运行时选择区块（`<Label>Java 运行时</Label>` 的 div）之后添加：

```tsx
                <div className="space-y-2">
                  <Label>资源完整性</Label>
                  <div className="flex items-center gap-2">
                    <Button size="sm" variant="outline" onClick={handleVerifyResources} disabled={verifying || repairing}>
                      <FontAwesomeIcon icon={faRotate} className={cn('h-4 w-4', verifying && 'animate-spin')} />
                      检查资源完整性
                    </Button>
                    {repairing && (
                      <span className="text-sm text-muted-foreground">正在补全 {repairProgress}%</span>
                    )}
                  </div>
                  {verifyResult && !verifyResult.complete && (
                    <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-3">
                      <p className="text-sm font-medium text-destructive">缺失 {verifyResult.missingFiles.length} 个文件</p>
                      <ul className="mt-2 max-h-40 space-y-1 overflow-y-auto text-xs text-muted-foreground">
                        {verifyResult.missingFiles.map((f, i) => (
                          <li key={i} className="truncate">{f.name}</li>
                        ))}
                      </ul>
                      <p className="mt-2 text-xs text-muted-foreground">正在自动补全...</p>
                    </div>
                  )}
                  {verifyResult && verifyResult.complete && (
                    <p className="text-xs text-muted-foreground">资源完整</p>
                  )}
                </div>
```

- [ ] **Step 5: 类型检查**

Run: `npx tsc --noEmit`
Expected: 无错误

- [ ] **Step 6: Commit**

```bash
git add src/pages/InstanceDetail.tsx
git commit -m "feat: 实例详情页添加检查资源完整性按钮"
```

---

### Task 8: 最终验证

**Files:** 无修改，仅验证

- [ ] **Step 1: 后端编译**

Run: `dotnet build src-backend/Qomicex.Launcher.Backend/Qomicex.Launcher.Backend.csproj`
Expected: 成功，0 错误

- [ ] **Step 2: 前端类型检查**

Run: `npx tsc --noEmit`
Expected: 无错误

- [ ] **Step 3: 手动验证清单**

启动后端和前端后验证：
1. 启动 Forge 实例，观察控制台是否输出 `[Launch]` 日志（Java 路径、版本、内存、账户、GameDir）
2. 在实例详情页点击"检查资源完整性"，应显示缺失文件列表并自动修复
3. 修复完成后再次检查应显示"资源完整"
4. Forge 安装后检查 `versions/{versionId}/{versionId}.jar` 是否存在
