# Java 下载 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 Settings → Java 运行时页内提供多源 Java 下载对话框，支持 Temurin / Zulu / Microsoft JDK / Oracle 的目录化下载、解压、进度轮询、取消和自动注册到 Java 运行时列表。

**Architecture:** 后端新增 `JavaDownloadController`、`JavaDownloadService` 和统一 DTO，服务层内部按 vendor 聚合 catalog、解析下载链接、下载到 `QML/Runtime/Java/.tmp/<taskId>`、解压到 `QML/Runtime/Java/<vendor>/<version>/<platform>-<arch>`，然后调用 `JavaRuntimeStore.AddCustomAsync` 注册。前端在 Settings Java 页把“下载 Java”改为下载对话框，调用 catalog/start/progress/cancel API 并在完成后刷新 Java 列表。

**Tech Stack:** ASP.NET Core (.NET 10), React 19, TypeScript, Vite 7, Tailwind, shadcn/ui, `Qomicex.Downloader.DownloadManager`

## Global Constraints

- **Core 不可改动**：`Qomicex.Avalonia/Qomicex.Core/` 和 `Qomicex.Avalonia/Qomicex.Downloader/` 是共享 submodule，所有修改限制在 `src-backend/` 和 `src/` 内。
- **首版支持多源**：Temurin、Zulu、Microsoft JDK、Oracle。
- **首版支持三平台**：Windows、Linux、macOS。
- **下载目录固定**：`AppContext.BaseDirectory/QML/Runtime/Java`。
- **只支持可自动解压的包**：优先 zip / tar.gz；首版不支持 msi / exe / pkg。
- **Java 版本由用户手动选择**：不做按 Minecraft 版本自动推荐的下载入口。
- **系统代理即可**：不做代理配置 UI，由 .NET 默认使用系统代理。
- **前端导入必须带扩展名**：`import { foo } from './bar.ts'`。
- **无测试框架**：本仓库用 `dotnet build` 和 `npx tsc --noEmit` 验证。

---

## File Structure

| 文件 | 操作 | 职责 |
|------|------|------|
| `src-backend/Qomicex.Launcher.Backend/Models/JavaDownloadModels.cs` | 新增 | Java 下载 catalog/start/progress/cancel 统一 DTO |
| `src-backend/Qomicex.Launcher.Backend/Services/JavaDownloadService.cs` | 新增 | 多源 provider 聚合、下载、解压、注册逻辑 |
| `src-backend/Qomicex.Launcher.Backend/Controllers/JavaDownloadController.cs` | 新增 | catalog/start/progress/cancel API |
| `src-backend/Qomicex.Launcher.Backend/Program.cs` | 修改 | 注册 JavaDownloadService |
| `src/types/index.ts` | 修改 | Java 下载 catalog / task 类型 |
| `src/api/java.ts` | 修改 | 新增 Java 下载相关 API |
| `src/pages/Settings.tsx` | 修改 | “下载 Java”按钮改为下载对话框 + 进度轮询 |

---

### Task 1: Java 下载 DTO

**Files:**
- Create: `src-backend/Qomicex.Launcher.Backend/Models/JavaDownloadModels.cs`

**Interfaces:**
- Consumes: none
- Produces:
  - `JavaDownloadVendorInfo`
  - `JavaDownloadCatalogResponse`
  - `JavaDownloadStartRequest`
  - `JavaDownloadStartResponse`
  - `JavaDownloadProgressResponse`

- [ ] **Step 1: 创建 DTO 文件**

创建 `src-backend/Qomicex.Launcher.Backend/Models/JavaDownloadModels.cs`：

```csharp
namespace Qomicex.Launcher.Backend.Models;

public class JavaDownloadVendorInfo
{
    public string Id { get; set; } = string.Empty;
    public string Name { get; set; } = string.Empty;
    public List<string> Platforms { get; set; } = new();
    public List<string> Architectures { get; set; } = new();
    public List<int> Versions { get; set; } = new();
}

public class JavaDownloadCatalogResponse
{
    public List<JavaDownloadVendorInfo> Vendors { get; set; } = new();
}

public class JavaDownloadStartRequest
{
    public string Vendor { get; set; } = string.Empty;
    public int Version { get; set; }
    public string Platform { get; set; } = string.Empty;
    public string Architecture { get; set; } = string.Empty;
}

public class JavaDownloadStartResponse
{
    public string TaskId { get; set; } = string.Empty;
    public string Status { get; set; } = string.Empty;
    public string TargetDir { get; set; } = string.Empty;
}

public class JavaDownloadProgressResponse
{
    public string TaskId { get; set; } = string.Empty;
    public string Status { get; set; } = "queued";
    public double Progress { get; set; }
    public double Speed { get; set; }
    public string FileName { get; set; } = string.Empty;
    public string TargetDir { get; set; } = string.Empty;
    public string? Error { get; set; }
}
```

- [ ] **Step 2: 编译验证**

Run: `dotnet build src-backend/Qomicex.Launcher.Backend/Qomicex.Launcher.Backend.csproj`

Expected: 成功，0 错误

- [ ] **Step 3: Commit**

```bash
git add src-backend/Qomicex.Launcher.Backend/Models/JavaDownloadModels.cs
git commit -m "feat: add java download DTOs"
```

---

### Task 2: JavaDownloadService 任务状态与公用骨架

**Files:**
- Create: `src-backend/Qomicex.Launcher.Backend/Services/JavaDownloadService.cs`

**Interfaces:**
- Consumes:
  - `JavaRuntimeStore.AddCustomAsync(string path): Task<JavaHelper.JavaInfoExtended>`
  - `JavaDownloadCatalogResponse`, `JavaDownloadVendorInfo`, `JavaDownloadStartRequest`, `JavaDownloadStartResponse`, `JavaDownloadProgressResponse` from Task 1
  - `DownloadManager` from `Qomicex.Downloader`
- Produces:
  - `Task<JavaDownloadCatalogResponse> GetCatalogAsync()`
  - `Task<JavaDownloadStartResponse> StartAsync(JavaDownloadStartRequest request)`
  - `JavaDownloadProgressResponse? GetProgress(string taskId)`
  - `bool Cancel(string taskId)`

- [ ] **Step 1: 创建服务骨架和状态模型**

创建 `src-backend/Qomicex.Launcher.Backend/Services/JavaDownloadService.cs`，先放任务状态、字段和方法签名：

```csharp
using System.Collections.Concurrent;
using Qomicex.Downloader;
using Qomicex.Launcher.Backend.Common;
using Qomicex.Launcher.Backend.Models;

namespace Qomicex.Launcher.Backend.Services;

public class JavaDownloadService
{
    private readonly JavaRuntimeStore _javaRuntimeStore;
    private readonly ConcurrentDictionary<string, JavaDownloadTaskState> _tasks = new();

    private sealed class JavaDownloadTaskState
    {
        public string TaskId { get; init; } = string.Empty;
        public string Status { get; set; } = "queued";
        public double Progress { get; set; }
        public double Speed { get; set; }
        public string FileName { get; set; } = string.Empty;
        public string TargetDir { get; set; } = string.Empty;
        public string? Error { get; set; }
        public CancellationTokenSource Cancellation { get; } = new();
    }

    public JavaDownloadService(JavaRuntimeStore javaRuntimeStore)
    {
        _javaRuntimeStore = javaRuntimeStore;
    }

    public Task<JavaDownloadCatalogResponse> GetCatalogAsync()
    {
        throw new NotImplementedException();
    }

    public Task<JavaDownloadStartResponse> StartAsync(JavaDownloadStartRequest request)
    {
        throw new NotImplementedException();
    }

    public JavaDownloadProgressResponse? GetProgress(string taskId)
    {
        if (!_tasks.TryGetValue(taskId, out var state)) return null;
        return new JavaDownloadProgressResponse
        {
            TaskId = state.TaskId,
            Status = state.Status,
            Progress = state.Progress,
            Speed = state.Speed,
            FileName = state.FileName,
            TargetDir = state.TargetDir,
            Error = state.Error,
        };
    }

    public bool Cancel(string taskId)
    {
        if (_tasks.TryGetValue(taskId, out var state))
        {
            state.Cancellation.Cancel();
            state.Status = "cancelled";
            return true;
        }
        return false;
    }
}
```

- [ ] **Step 2: 注册服务**

在 `src-backend/Qomicex.Launcher.Backend/Program.cs` 的 service registration 处添加：

```csharp
builder.Services.AddSingleton<JavaDownloadService>();
```

放在 `JavaRuntimeStore` 附近：

```csharp
builder.Services.AddSingleton<ResourceDownloadService>();
builder.Services.AddSingleton<JavaRuntimeStore>();
builder.Services.AddSingleton<JavaDownloadService>();
builder.Services.AddSingleton(_ => new AccountService(AppContext.BaseDirectory));
```

- [ ] **Step 3: 编译验证**

Run: `dotnet build src-backend/Qomicex.Launcher.Backend/Qomicex.Launcher.Backend.csproj`

Expected: 成功，0 错误

- [ ] **Step 4: Commit**

```bash
git add src-backend/Qomicex.Launcher.Backend/Services/JavaDownloadService.cs src-backend/Qomicex.Launcher.Backend/Program.cs
git commit -m "feat: add java download service skeleton"
```

---

### Task 3: Catalog 聚合

**Files:**
- Modify: `src-backend/Qomicex.Launcher.Backend/Services/JavaDownloadService.cs`

**Interfaces:**
- Consumes: `JavaDownloadCatalogResponse`, `JavaDownloadVendorInfo` from Task 1
- Produces: `Task<JavaDownloadCatalogResponse> GetCatalogAsync()` returning the four supported vendors

- [ ] **Step 1: 实现静态 catalog**

在 `JavaDownloadService.cs` 中，将 `GetCatalogAsync` 替换为首版静态实现（先不接真实远端 API，保证对话框可工作；后续任务再为下载解析真实 URL）：

```csharp
    public Task<JavaDownloadCatalogResponse> GetCatalogAsync()
    {
        var response = new JavaDownloadCatalogResponse
        {
            Vendors = new List<JavaDownloadVendorInfo>
            {
                new()
                {
                    Id = "temurin",
                    Name = "Temurin",
                    Platforms = new() { "windows", "linux", "macos" },
                    Architectures = new() { "x64", "arm64", "x86" },
                    Versions = new() { 8, 11, 17, 21 },
                },
                new()
                {
                    Id = "zulu",
                    Name = "Zulu",
                    Platforms = new() { "windows", "linux", "macos" },
                    Architectures = new() { "x64", "arm64", "x86" },
                    Versions = new() { 8, 11, 17, 21 },
                },
                new()
                {
                    Id = "microsoft-jdk",
                    Name = "Microsoft JDK",
                    Platforms = new() { "windows", "linux", "macos" },
                    Architectures = new() { "x64", "arm64" },
                    Versions = new() { 11, 17, 21 },
                },
                new()
                {
                    Id = "oracle",
                    Name = "Oracle",
                    Platforms = new() { "windows", "linux", "macos" },
                    Architectures = new() { "x64", "arm64" },
                    Versions = new() { 8, 17, 21 },
                },
            }
        };

        return Task.FromResult(response);
    }
```

- [ ] **Step 2: 编译验证**

Run: `dotnet build src-backend/Qomicex.Launcher.Backend/Qomicex.Launcher.Backend.csproj`

Expected: 成功，0 错误

- [ ] **Step 3: Commit**

```bash
git add src-backend/Qomicex.Launcher.Backend/Services/JavaDownloadService.cs
git commit -m "feat: add java download catalog"
```

---

### Task 4: 下载 URL 解析与下载/解压/注册流程

**Files:**
- Modify: `src-backend/Qomicex.Launcher.Backend/Services/JavaDownloadService.cs`

**Interfaces:**
- Consumes:
  - `JavaRuntimeStore.AddCustomAsync(string path)`
  - `DownloadManager.CreateTask`, `AddFileToTask`, `StartTaskAsync`
  - `JavaDownloadStartRequest`, `JavaDownloadStartResponse`
- Produces:
  - `Task<JavaDownloadStartResponse> StartAsync(JavaDownloadStartRequest request)`
  - private helpers:
    - `string GetBaseDir()`
    - `Task<(string url, string fileName)> ResolvePackageAsync(JavaDownloadStartRequest request)`
    - `Task RunTaskAsync(JavaDownloadTaskState state, JavaDownloadStartRequest request, string url, string fileName)`
    - `Task<string> ExtractAsync(JavaDownloadTaskState state, string archivePath, JavaDownloadStartRequest request)`
    - `string? FindJavaExecutable(string rootDir)`

- [ ] **Step 1: 添加路径 helper**

在 `JavaDownloadService.cs` 类中 `Cancel` 方法之后添加：

```csharp
    private static string GetBaseDir()
    {
        var dir = Path.Combine(AppContext.BaseDirectory, "QML", "Runtime", "Java");
        Directory.CreateDirectory(dir);
        return dir;
    }
```

- [ ] **Step 2: 实现真实下载 URL 解析**

在 `JavaDownloadService.cs` 中添加：

```csharp
    private static async Task<(string url, string fileName)> ResolvePackageAsync(JavaDownloadStartRequest request)
    {
        using var http = new HttpClient();

        if (request.Vendor == "temurin")
        {
            var imageType = request.Version == 8 ? "jre" : "jdk";
            var api = $"https://api.adoptium.net/v3/assets/latest/{request.Version}/hotspot?release_type=ga&os={request.Platform}&architecture={request.Architecture}&image_type={imageType}";
            var json = await http.GetStringAsync(api);
            using var doc = System.Text.Json.JsonDocument.Parse(json);
            var item = doc.RootElement.EnumerateArray().FirstOrDefault();
            if (item.ValueKind == System.Text.Json.JsonValueKind.Undefined)
                throw ApiException.NotFound("未找到可用的 Java 下载包", "JAVA_DOWNLOAD_PACKAGE_NOT_FOUND");
            var pkg = item.GetProperty("binary").GetProperty("package");
            return (pkg.GetProperty("link").GetString() ?? string.Empty, pkg.GetProperty("name").GetString() ?? string.Empty);
        }

        if (request.Vendor == "zulu")
        {
            var ext = request.Platform == "windows" ? "zip" : "tar.gz";
            var api = $"https://api.azul.com/metadata/v1/zulu/packages?java_version={request.Version}&os={request.Platform}&arch={request.Architecture}&archive_type={ext}&java_package_type=jdk&latest=true";
            var json = await http.GetStringAsync(api);
            using var doc = System.Text.Json.JsonDocument.Parse(json);
            var item = doc.RootElement.EnumerateArray().FirstOrDefault();
            if (item.ValueKind == System.Text.Json.JsonValueKind.Undefined)
                throw ApiException.NotFound("未找到可用的 Java 下载包", "JAVA_DOWNLOAD_PACKAGE_NOT_FOUND");
            return (item.GetProperty("download_url").GetString() ?? string.Empty, item.GetProperty("name").GetString() ?? string.Empty);
        }

        if (request.Vendor == "microsoft-jdk")
        {
            var api = "https://aka.ms/download-jdk/microsoft-jdk.json";
            var json = await http.GetStringAsync(api);
            using var doc = System.Text.Json.JsonDocument.Parse(json);
            foreach (var release in doc.RootElement.GetProperty("releases").EnumerateArray())
            {
                if (release.GetProperty("version").GetInt32() != request.Version) continue;
                foreach (var file in release.GetProperty("files").EnumerateArray())
                {
                    if (file.GetProperty("platform").GetString() == request.Platform &&
                        file.GetProperty("arch").GetString() == request.Architecture &&
                        (file.GetProperty("fileName").GetString()?.EndsWith(".zip") == true || file.GetProperty("fileName").GetString()?.EndsWith(".tar.gz") == true))
                    {
                        return (file.GetProperty("url").GetString() ?? string.Empty, file.GetProperty("fileName").GetString() ?? string.Empty);
                    }
                }
            }
            throw ApiException.NotFound("未找到可用的 Java 下载包", "JAVA_DOWNLOAD_PACKAGE_NOT_FOUND");
        }

        if (request.Vendor == "oracle")
        {
            var ext = request.Platform == "windows" ? "zip" : "tar.gz";
            var api = $"https://download.oracle.com/java/{request.Version}/latest/jdk-{request.Version}_{request.Platform}-{request.Architecture}_bin.{ext}";
            var fileName = Path.GetFileName(new Uri(api).AbsolutePath);
            return (api, fileName);
        }

        throw ApiException.NotFound("未找到可用的 Java 下载包", "JAVA_DOWNLOAD_PACKAGE_NOT_FOUND");
    }
```

- [ ] **Step 3: 实现下载/解压/注册骨架**

在 `JavaDownloadService.cs` 中，将 `StartAsync` 替换为：

```csharp
    public async Task<JavaDownloadStartResponse> StartAsync(JavaDownloadStartRequest request)
    {
        var (url, fileName) = await ResolvePackageAsync(request);
        var taskId = Guid.NewGuid().ToString("N")[..12];
        var targetDir = Path.Combine(GetBaseDir(), request.Vendor, request.Version.ToString(), $"{request.Platform}-{request.Architecture}");
        var state = new JavaDownloadTaskState
        {
            TaskId = taskId,
            Status = "queued",
            FileName = fileName,
            TargetDir = targetDir,
        };
        _tasks[taskId] = state;

        _ = Task.Run(() => RunTaskAsync(state, request, url, fileName));

        return new JavaDownloadStartResponse
        {
            TaskId = taskId,
            Status = state.Status,
            TargetDir = targetDir,
        };
    }

    private async Task RunTaskAsync(JavaDownloadTaskState state, JavaDownloadStartRequest request, string url, string fileName)
    {
        try
        {
            state.Status = "downloading";
            var tmpDir = Path.Combine(GetBaseDir(), ".tmp", state.TaskId);
            Directory.CreateDirectory(tmpDir);
            var archivePath = Path.Combine(tmpDir, fileName);

            using var manager = new DownloadManager(intervalMs: 500);
            var tid = manager.CreateTask(maxConcurrentFiles: 1, maxRetries: 3, ignoreRangeProbe200Ok: true);
            manager.AddFileToTask(tid, url, archivePath);
            manager.OnTaskProgressUpdated += (_, info) =>
            {
                state.Progress = info.Progress;
                state.Speed = info.Speed;
            };
            await manager.StartTaskAsync(tid, state.Cancellation.Token);

            state.Status = "extracting";
            var extractedRoot = await ExtractAsync(state, archivePath, request);

            state.Status = "registering";
            var javaExe = FindJavaExecutable(extractedRoot) ?? throw ApiException.NotFound("解压后未找到 Java 可执行文件", "JAVA_DOWNLOAD_REGISTER_FAILED");
            await _javaRuntimeStore.AddCustomAsync(javaExe);

            state.Progress = 100;
            state.Speed = 0;
            state.Status = "completed";
        }
        catch (OperationCanceledException)
        {
            state.Status = "cancelled";
        }
        catch (ApiException ex)
        {
            state.Status = "failed";
            state.Error = ex.Message;
        }
        catch (Exception ex)
        {
            state.Status = "failed";
            state.Error = ex.Message;
        }
    }
```

- [ ] **Step 4: 实现解压和 Java 路径查找 helper**

在 `JavaDownloadService.cs` 中添加：

```csharp
    private static async Task<string> ExtractAsync(JavaDownloadTaskState state, string archivePath, JavaDownloadStartRequest request)
    {
        Directory.CreateDirectory(state.TargetDir);
        if (archivePath.EndsWith(".zip", StringComparison.OrdinalIgnoreCase))
        {
            System.IO.Compression.ZipFile.ExtractToDirectory(archivePath, state.TargetDir, overwriteFiles: true);
            await Task.CompletedTask;
            return state.TargetDir;
        }

        if (archivePath.EndsWith(".tar.gz", StringComparison.OrdinalIgnoreCase))
        {
            System.IO.Compression.ZipFile.ExtractToDirectory(archivePath, state.TargetDir, overwriteFiles: true);
            await Task.CompletedTask;
            return state.TargetDir;
        }

        throw ApiException.BadRequest("当前仅支持 zip / tar.gz 自动解压", "JAVA_DOWNLOAD_EXTRACT_FAILED");
    }

    private static string? FindJavaExecutable(string rootDir)
    {
        var javaName = OperatingSystem.IsWindows() ? "java.exe" : "java";
        var candidates = Directory.GetFiles(rootDir, javaName, SearchOption.AllDirectories);
        return candidates.FirstOrDefault(path => path.Contains($"{Path.DirectorySeparatorChar}bin{Path.DirectorySeparatorChar}", StringComparison.OrdinalIgnoreCase));
    }
```

> 注意：`ZipFile.ExtractToDirectory` 不能处理 tar.gz。这一步在实现时必须改用真实 tar.gz 解压逻辑（例如 `SharpCompress`）。本任务不能留下假实现。

- [ ] **Step 5: 用 `SharpCompress` 实现真实 tar.gz 解压**

在 `src-backend/Qomicex.Launcher.Backend/Qomicex.Launcher.Backend.csproj` 添加包：

```xml
<PackageReference Include="SharpCompress" Version="0.39.0" />
```

然后把 `ExtractAsync` 完整替换为：

```csharp
    private static async Task<string> ExtractAsync(JavaDownloadTaskState state, string archivePath, JavaDownloadStartRequest request)
    {
        Directory.CreateDirectory(state.TargetDir);
        if (archivePath.EndsWith(".zip", StringComparison.OrdinalIgnoreCase))
        {
            System.IO.Compression.ZipFile.ExtractToDirectory(archivePath, state.TargetDir, overwriteFiles: true);
            await Task.CompletedTask;
            return state.TargetDir;
        }

        if (archivePath.EndsWith(".tar.gz", StringComparison.OrdinalIgnoreCase))
        {
            using var stream = System.IO.File.OpenRead(archivePath);
            using var archive = SharpCompress.Archives.Tar.TarArchive.Open(stream, new SharpCompress.Readers.ReaderOptions { LeaveStreamOpen = false });
            foreach (var entry in archive.Entries.Where(e => !e.IsDirectory))
            {
                entry.WriteToDirectory(state.TargetDir, new SharpCompress.Common.ExtractionOptions
                {
                    ExtractFullPath = true,
                    Overwrite = true,
                });
            }
            await Task.CompletedTask;
            return state.TargetDir;
        }

        throw ApiException.BadRequest("当前仅支持 zip / tar.gz 自动解压", "JAVA_DOWNLOAD_EXTRACT_FAILED");
    }
```

并在文件顶部添加 using：

```csharp
using SharpCompress.Archives.Tar;
using SharpCompress.Common;
```

- [ ] **Step 6: 编译验证**

Run: `dotnet build src-backend/Qomicex.Launcher.Backend/Qomicex.Launcher.Backend.csproj`

Expected: 成功，0 错误

- [ ] **Step 7: Commit**

```bash
git add src-backend/Qomicex.Launcher.Backend/Services/JavaDownloadService.cs src-backend/Qomicex.Launcher.Backend/Qomicex.Launcher.Backend.csproj
git commit -m "feat: implement java download resolve/download/extract/register flow"
```

---

### Task 5: JavaDownloadController

**Files:**
- Create: `src-backend/Qomicex.Launcher.Backend/Controllers/JavaDownloadController.cs`

**Interfaces:**
- Consumes:
  - `JavaDownloadService.GetCatalogAsync(): Task<JavaDownloadCatalogResponse>`
  - `JavaDownloadService.StartAsync(JavaDownloadStartRequest): Task<JavaDownloadStartResponse>`
  - `JavaDownloadService.GetProgress(string): JavaDownloadProgressResponse?`
  - `JavaDownloadService.Cancel(string): bool`
- Produces:
  - `GET /api/java/download/catalog`
  - `POST /api/java/download/start`
  - `GET /api/java/download/progress/{taskId}`
  - `DELETE /api/java/download/{taskId}`

- [ ] **Step 1: 创建 Controller**

创建 `src-backend/Qomicex.Launcher.Backend/Controllers/JavaDownloadController.cs`：

```csharp
using Microsoft.AspNetCore.Mvc;
using Qomicex.Launcher.Backend.Models;
using Qomicex.Launcher.Backend.Services;

namespace Qomicex.Launcher.Backend.Controllers;

[ApiController]
[Route("api/java/download")]
public class JavaDownloadController : ControllerBase
{
    private readonly JavaDownloadService _service;

    public JavaDownloadController(JavaDownloadService service)
    {
        _service = service;
    }

    [HttpGet("catalog")]
    public async Task<ActionResult<JavaDownloadCatalogResponse>> GetCatalog()
    {
        return Ok(await _service.GetCatalogAsync());
    }

    [HttpPost("start")]
    public async Task<ActionResult<JavaDownloadStartResponse>> Start([FromBody] JavaDownloadStartRequest request)
    {
        return Ok(await _service.StartAsync(request));
    }

    [HttpGet("progress/{taskId}")]
    public ActionResult<JavaDownloadProgressResponse> GetProgress(string taskId)
    {
        var progress = _service.GetProgress(taskId);
        if (progress == null) return NotFound();
        return Ok(progress);
    }

    [HttpDelete("{taskId}")]
    public IActionResult Cancel(string taskId)
    {
        if (_service.Cancel(taskId)) return NoContent();
        return NotFound();
    }
}
```

- [ ] **Step 2: 编译验证**

Run: `dotnet build src-backend/Qomicex.Launcher.Backend/Qomicex.Launcher.Backend.csproj`

Expected: 成功，0 错误

- [ ] **Step 3: Commit**

```bash
git add src-backend/Qomicex.Launcher.Backend/Controllers/JavaDownloadController.cs
git commit -m "feat: add java download controller"
```

---

### Task 6: 前端类型与 API

**Files:**
- Modify: `src/types/index.ts`
- Modify: `src/api/java.ts`

**Interfaces:**
- Consumes: backend DTO from Task 1
- Produces:
  - `JavaDownloadVendorInfo`
  - `JavaDownloadCatalogResponse`
  - `JavaDownloadStartRequest`
  - `JavaDownloadStartResponse`
  - `JavaDownloadProgressResponse`
  - `getJavaDownloadCatalog()`
  - `startJavaDownload()`
  - `getJavaDownloadProgress()`
  - `cancelJavaDownload()`

- [ ] **Step 1: 添加前端类型**

在 `src/types/index.ts` 中 `JavaRuntime` 之后添加：

```ts
export interface JavaDownloadVendorInfo {
  id: string
  name: string
  platforms: string[]
  architectures: string[]
  versions: number[]
}

export interface JavaDownloadCatalogResponse {
  vendors: JavaDownloadVendorInfo[]
}

export interface JavaDownloadStartRequest {
  vendor: string
  version: number
  platform: string
  architecture: string
}

export interface JavaDownloadStartResponse {
  taskId: string
  status: string
  targetDir: string
}

export interface JavaDownloadProgressResponse {
  taskId: string
  status: string
  progress: number
  speed: number
  fileName: string
  targetDir: string
  error: string | null
}
```

- [ ] **Step 2: 添加 API 函数**

在 `src/api/java.ts` 中新增类型导入：

```ts
import type {
  JavaRuntime,
  JavaDownloadCatalogResponse,
  JavaDownloadStartRequest,
  JavaDownloadStartResponse,
  JavaDownloadProgressResponse,
} from '../types/index.ts'
```

然后在文件末尾添加：

```ts
export function getJavaDownloadCatalog(): Promise<JavaDownloadCatalogResponse> {
  return get<JavaDownloadCatalogResponse>('/java/download/catalog')
}

export function startJavaDownload(body: JavaDownloadStartRequest): Promise<JavaDownloadStartResponse> {
  return post<JavaDownloadStartResponse>('/java/download/start', body)
}

export function getJavaDownloadProgress(taskId: string): Promise<JavaDownloadProgressResponse> {
  return get<JavaDownloadProgressResponse>(`/java/download/progress/${taskId}`)
}

export function cancelJavaDownload(taskId: string): Promise<void> {
  return del<void>(`/java/download/${taskId}`)
}
```

- [ ] **Step 3: 类型检查**

Run: `npx tsc --noEmit`

Expected: 无错误

- [ ] **Step 4: Commit**

```bash
git add src/types/index.ts src/api/java.ts
git commit -m "feat: add frontend java download types and API"
```

---

### Task 7: Settings Java 下载对话框

**Files:**
- Modify: `src/pages/Settings.tsx`

**Interfaces:**
- Consumes:
  - `getJavaDownloadCatalog`, `startJavaDownload`, `getJavaDownloadProgress`, `cancelJavaDownload` from Task 6
  - `JavaDownloadVendorInfo`, `JavaDownloadProgressResponse` from Task 6
  - existing `scanRuntimes()` and `getRuntimes()` refresh pattern
- Produces: Java 下载对话框 UI + 进度轮询 + 完成后刷新列表

- [ ] **Step 1: 添加 import**

在 `Settings.tsx` 顶部的 Java API import 行：

```ts
import { addCustomJavaRuntime, removeCustomJavaRuntime } from '../api/java.ts'
```

改为：

```ts
import {
  addCustomJavaRuntime,
  removeCustomJavaRuntime,
  getJavaDownloadCatalog,
  startJavaDownload,
  getJavaDownloadProgress,
  cancelJavaDownload,
} from '../api/java.ts'
```

在 type import 行添加：

```ts
import type { SystemInfo, JavaDownloadVendorInfo, JavaDownloadProgressResponse } from '../types/index.ts'
```

- [ ] **Step 2: 添加状态**

在 Java 页面现有 state 附近添加：

```ts
  const [downloadDialogOpen, setDownloadDialogOpen] = useState(false)
  const [downloadVendors, setDownloadVendors] = useState<JavaDownloadVendorInfo[]>([])
  const [downloadLoading, setDownloadLoading] = useState(false)
  const [downloadTaskId, setDownloadTaskId] = useState<string | null>(null)
  const [downloadProgress, setDownloadProgress] = useState<JavaDownloadProgressResponse | null>(null)
  const [downloadVendor, setDownloadVendor] = useState('temurin')
  const [downloadVersion, setDownloadVersion] = useState('17')
  const [downloadPlatform, setDownloadPlatform] = useState(OperatingSystem === undefined ? 'windows' : 'windows')
  const [downloadArch, setDownloadArch] = useState('x64')
```

> 说明：`OperatingSystem` 不能在前端直接用，这一步在实现时改为硬编码默认 `'windows'`，不要留下不可编译代码。

- [ ] **Step 3: 修正平台默认值并添加 catalog 加载函数**

将平台默认值写成固定字符串，并添加：

```ts
  const [downloadPlatform, setDownloadPlatform] = useState('windows')

  async function handleOpenJavaDownload() {
    setDownloadLoading(true)
    try {
      const catalog = await getJavaDownloadCatalog()
      setDownloadVendors(catalog.vendors)
      if (catalog.vendors.length > 0) {
        setDownloadVendor(catalog.vendors[0].id)
        setDownloadVersion(String(catalog.vendors[0].versions[0] ?? 17))
        setDownloadPlatform(catalog.vendors[0].platforms[0] ?? 'windows')
        setDownloadArch(catalog.vendors[0].architectures[0] ?? 'x64')
      }
      setDownloadDialogOpen(true)
    } finally {
      setDownloadLoading(false)
    }
  }
```

- [ ] **Step 4: 添加下载/轮询/取消函数**

在 `Settings.tsx` 中添加：

```ts
  async function handleStartJavaDownload() {
    const task = await startJavaDownload({
      vendor: downloadVendor,
      version: parseInt(downloadVersion, 10),
      platform: downloadPlatform,
      architecture: downloadArch,
    })
    setDownloadTaskId(task.taskId)
  }

  async function handleCancelJavaDownload() {
    if (!downloadTaskId) return
    await cancelJavaDownload(downloadTaskId)
    setDownloadTaskId(null)
    setDownloadProgress(null)
  }

  useEffect(() => {
    if (!downloadTaskId) return
    const timer = setInterval(async () => {
      try {
        const progress = await getJavaDownloadProgress(downloadTaskId)
        setDownloadProgress(progress)
        if (progress.status === 'completed') {
          clearInterval(timer)
          setDownloadTaskId(null)
          await handleScan('quick')
        }
        if (progress.status === 'failed' || progress.status === 'cancelled') {
          clearInterval(timer)
          setDownloadTaskId(null)
        }
      } catch {
        clearInterval(timer)
        setDownloadTaskId(null)
      }
    }, 1000)
    return () => clearInterval(timer)
  }, [downloadTaskId])
```

- [ ] **Step 5: 把“下载 Java”按钮改为打开对话框**

将当前外链按钮：

```tsx
                    <Button size="sm" variant="ghost" asChild>
                      <a href="https://adoptium.net" target="_blank" rel="noreferrer">
                        <FontAwesomeIcon icon={faDownload} className="h-4 w-4" />
                        下载 Java
                      </a>
                    </Button>
```

替换为：

```tsx
                    <Button size="sm" variant="ghost" onClick={handleOpenJavaDownload} disabled={downloadLoading}>
                      <FontAwesomeIcon icon={faDownload} className="h-4 w-4" />
                      下载 Java
                    </Button>
```

- [ ] **Step 6: 添加对话框 UI**

在文件底部现有 Dialog 们附近添加：

```tsx
      <Dialog open={downloadDialogOpen} onClose={() => setDownloadDialogOpen(false)}>
        <DialogHeader>
          <DialogTitle>下载 Java</DialogTitle>
        </DialogHeader>
        <DialogBody className="space-y-4">
          <div className="space-y-2">
            <Label>发行版</Label>
            <Select value={downloadVendor} onChange={setDownloadVendor}>
              {downloadVendors.map((vendor) => (
                <SelectOption key={vendor.id} value={vendor.id}>{vendor.name}</SelectOption>
              ))}
            </Select>
          </div>
          <div className="space-y-2">
            <Label>Java 主版本</Label>
            <Select value={downloadVersion} onChange={setDownloadVersion}>
              {(downloadVendors.find((v) => v.id === downloadVendor)?.versions ?? []).map((version) => (
                <SelectOption key={version} value={String(version)}>{version}</SelectOption>
              ))}
            </Select>
          </div>
          <div className="space-y-2">
            <Label>平台</Label>
            <Select value={downloadPlatform} onChange={setDownloadPlatform}>
              {(downloadVendors.find((v) => v.id === downloadVendor)?.platforms ?? []).map((platform) => (
                <SelectOption key={platform} value={platform}>{platform}</SelectOption>
              ))}
            </Select>
          </div>
          <div className="space-y-2">
            <Label>架构</Label>
            <Select value={downloadArch} onChange={setDownloadArch}>
              {(downloadVendors.find((v) => v.id === downloadVendor)?.architectures ?? []).map((arch) => (
                <SelectOption key={arch} value={arch}>{arch}</SelectOption>
              ))}
            </Select>
          </div>
          <div className="space-y-2">
            <Label>目标目录</Label>
            <Input value="QML/Runtime/Java" disabled />
          </div>
          {downloadProgress && (
            <div className="space-y-2 rounded-lg border p-3 text-sm">
              <div className="flex items-center justify-between">
                <span>{downloadProgress.status}</span>
                <span>{Math.round(downloadProgress.progress)}%</span>
              </div>
              <div className="h-2 rounded-full bg-muted overflow-hidden">
                <div className="h-full bg-primary transition-all" style={{ width: `${downloadProgress.progress}%` }} />
              </div>
              <div className="text-xs text-muted-foreground truncate">{downloadProgress.fileName}</div>
              {downloadProgress.error && <div className="text-xs text-destructive">{downloadProgress.error}</div>}
            </div>
          )}
        </DialogBody>
        <DialogFooter>
          {downloadTaskId ? (
            <Button variant="outline" onClick={handleCancelJavaDownload}>取消下载</Button>
          ) : (
            <Button onClick={handleStartJavaDownload}>开始下载</Button>
          )}
        </DialogFooter>
      </Dialog>
```

- [ ] **Step 7: 类型检查**

Run: `npx tsc --noEmit`

Expected: 无错误

- [ ] **Step 8: Commit**

```bash
git add src/pages/Settings.tsx
git commit -m "feat: add java download dialog"
```

---

### Task 8: 最终验证

**Files:**
- Verify only

**Interfaces:**
- Consumes: Tasks 1-7 outputs
- Produces: Verified end-to-end flow

- [ ] **Step 1: 后端编译**

Run: `dotnet build src-backend/Qomicex.Launcher.Backend/Qomicex.Launcher.Backend.csproj`

Expected: 成功，0 错误

- [ ] **Step 2: 前端类型检查**

Run: `npx tsc --noEmit`

Expected: 无错误

- [ ] **Step 3: 手动验证清单**

1. 打开 Settings → Java 运行时页，点击“下载 Java”应弹出对话框
2. catalog 中应看到 Temurin / Zulu / Microsoft JDK / Oracle 四个 vendor
3. 选择 vendor/version/platform/architecture，点击开始下载
4. 对话框内应显示 `downloading` → `extracting` → `registering` → `completed`
5. 完成后 Java 列表应自动刷新，新增下载的 Java，`discoveredBy` 显示 `Custom`
6. 下载中的任务可取消，状态变为 `cancelled`
7. 失败时显示错误，并保留当前选项可重试
