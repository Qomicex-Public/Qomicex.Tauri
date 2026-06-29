## Task 2 Report: JavaDownloadService 骨架

### 变更内容

- 新增 `src-backend/Qomicex.Launcher.Backend/Services/JavaDownloadService.cs`
  - 按简报创建 `JavaDownloadService`
  - 包含内部 `JavaDownloadTaskState` 状态模型
  - 暴露以下骨架方法：
    - `Task<JavaDownloadCatalogResponse> GetCatalogAsync()`
    - `Task<JavaDownloadStartResponse> StartAsync(JavaDownloadStartRequest request)`
    - `JavaDownloadProgressResponse? GetProgress(string taskId)`
    - `bool Cancel(string taskId)`
- 更新 `src-backend/Qomicex.Launcher.Backend/Program.cs`
  - 在 `JavaRuntimeStore` 附近注册 `builder.Services.AddSingleton<JavaDownloadService>();`

### 实现说明

- 严格按 `task-2-brief.md` 中给出的代码骨架创建服务。
- 未修改 `Qomicex.Avalonia/Qomicex.Core/` 或 `Qomicex.Avalonia/Qomicex.Downloader/`。
- 仅修改了 `src-backend/` 下要求的代码文件。

### 构建验证

执行命令：

```bash
dotnet build src-backend/Qomicex.Launcher.Backend/Qomicex.Launcher.Backend.csproj
```

结果：

- Build 成功
- 0 errors
- 5 warnings

警告来源：

- `src-backend/Qomicex.Launcher.Backend/Controllers/AccountController.cs` 第 176-180 行已有空引用警告
- 与本次 JavaDownloadService 骨架改动无关

### 自检结果

- `JavaDownloadService.cs` 与简报给出的骨架一致
- `Program.cs` 已按要求完成单例注册
- `git diff` 仅包含本任务要求的代码改动

### 提交信息

- 计划提交信息：`feat: add java download service skeleton`

### 关注点

- `GetCatalogAsync()` 与 `StartAsync()` 仍为 `NotImplementedException`，这是本任务要求的骨架状态，后续任务应补全实际目录拉取和下载逻辑。
