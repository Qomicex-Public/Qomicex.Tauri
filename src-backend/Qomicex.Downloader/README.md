# Qomicex.Downloader

`Qomicex.Downloader` 是一个面向 .NET 10 的轻量级 HTTP 下载组件，提供：

- 单文件多线程分片下载
- 批量文件下载与任务管理
- 暂停、继续、取消
- 两套进度返回模式
  - 主动上报：下载器主动推送进度
  - 手动轮询：调用方按自己的刷新频率主动拉取当前进度

本文档面向只拿到 `Qomicex.Downloader.dll` 的使用者，不要求查看源码即可完成接入。

## 目标环境

- .NET: `net10.0`
- 依赖: 无第三方 NuGet 依赖，仅使用 .NET BCL

## 核心类型

### `DownloadProgress`

单个下载引擎返回的进度快照：

- `Progress`: 当前进度百分比，范围通常为 `0` 到 `100`
- `DownloadedBytes`: 当前已下载字节数
- `TotalBytes`: 文件总字节数
- `Speed`: 当前速度，单位为 `B/s`
- `IsCompleted`: 是否已完成

### `IDownloadEngine`

底层下载引擎接口，适合单文件场景或你需要完全掌控下载流程时使用。

主要成员：

- `DownloadFileAsync(...)`
- `Pause()`
- `Resume()`
- `Cancel()`
- `UpdateProgress()`

### `Core`

`IDownloadEngine` 的默认实现。

构造函数：

```csharp
var engine = new Core(threadCount: 4, maxRetries: 3, autoUpdate: true, ignoreRangeProbe200Ok: false);
```

参数说明：

- `threadCount`: 单个文件的分片线程数；传 `0` 时启用自动分片
- `maxRetries`: 下载失败后的最大重试次数
- `autoUpdate`: 是否主动推送进度
- `ignoreRangeProbe200Ok`: 是否忽略探测请求返回的 `200 OK`，默认 `false`

### `DownloadTask`

批量下载容器，管理一组文件。适合“一个任务包含多个文件”的场景。

主要能力：

- `AddFile(...)`: 添加文件
- `StartDownloadAsync(...)`: 开始批量下载
- `PauseDownload(...)`: 暂停指定文件或全部文件
- `ContinueDownload(...)`: 继续指定文件或全部文件
- `StopDownload(...)`: 取消指定文件或全部文件
- `UpdateProgress()`: 手动触发当前文件进度回调
- `GetTaskInfo()`: 获取聚合任务进度
- `GetFileStatuses()`: 获取所有文件当前状态

### `DownloadManager`

更高层的任务调度器，适合“多批任务并存”的场景。

主要能力：

- `CreateTask(...)`: 创建一个下载任务
- `AddFileToTask(...)`: 向任务中添加文件
- `StartTaskAsync(...)`: 启动任务
- `PauseTask(...)`
- `ContinueTask(...)`
- `StopTask(...)`
- `GetAllTaskInfos()`
- `GetTaskFileStatuses(...)`
- `GetFileMeta(...)`

事件：

- `OnTaskProgressUpdated`
- `OnTaskCompleted`
- `OnGlobalProgressUpdated`

## 两套进度模式

这是本组件的重要设计，请按场景选择。

### 模式 1: 主动上报

适合：

- 单文件下载
- 你希望 UI 或日志在下载过程中立即刷新
- 你不介意较高的回调频率

行为：

- `Core` 在下载过程中主动调用 `IProgress<DownloadProgress>.Report(...)`
- 需要将 `autoUpdate` 设为 `true`

示例：

```csharp
using Qomicex.Downloader;

var engine = new Core(threadCount: 4, maxRetries: 3, autoUpdate: true, ignoreRangeProbe200Ok: false);

var progress = new Progress<DownloadProgress>(p =>
{
    Console.WriteLine($"{p.Progress:F2}% | {p.DownloadedBytes}/{p.TotalBytes} | {p.Speed:F0} B/s");
});

await engine.DownloadFileAsync(
    url: "https://example.com/file.zip",
    outputPath: @"C:\Downloads\file.zip",
    progress: progress,
    cancellationToken: CancellationToken.None,
    userAgent: "MyApp/1.0");
```

### 模式 2: 手动轮询

适合：

- 多文件批量下载
- 多任务并行下载
- 你想自己控制刷新频率，避免 UI 或日志过度刷新

行为：

- 下载器内部持续更新最新快照
- 不主动推送进度
- 由调用方在合适时机调用 `UpdateProgress()` 触发一次进度回调

`DownloadTask` 默认按这个思路使用 `Core`。

示例：

```csharp
using Qomicex.Downloader;

var task = new DownloadTask(maxConcurrentFiles: 2, singleFileThreadCount: 0, maxRetries: 3, ignoreRangeProbe200Ok: false);
task.AddFile("https://example.com/a.zip", @"C:\Downloads\a.zip");
task.AddFile("https://example.com/b.zip", @"C:\Downloads\b.zip");

task.OnProgressUpdated += info =>
{
    Console.WriteLine($"Task Progress: {info.Progress:F2}% | Speed: {info.Speed:F0} B/s");
};

using var timer = new System.Threading.Timer(_ =>
{
    task.UpdateProgress();
}, null, 500, 500);

await task.StartDownloadAsync(CancellationToken.None, "MyApp/1.0");
```

## 单文件使用示例

```csharp
using Qomicex.Downloader;

var engine = new Core(threadCount: 0, maxRetries: 5, autoUpdate: true, ignoreRangeProbe200Ok: false);
var progress = new Progress<DownloadProgress>(p =>
{
    Console.WriteLine($"Progress={p.Progress:F2}% Speed={p.Speed:F0}B/s");
});

await engine.DownloadFileAsync(
    "https://example.com/archive.zip",
    @"D:\Data\archive.zip",
    progress,
    CancellationToken.None,
    "MyClient/2.0");
```

暂停、继续、取消：

```csharp
engine.Pause();
engine.Resume();
engine.Cancel();
```

## 批量下载示例

```csharp
using Qomicex.Downloader;

var task = new DownloadTask(maxConcurrentFiles: 2, singleFileThreadCount: 0, maxRetries: 3, ignoreRangeProbe200Ok: false);

task.AddFile("https://example.com/1.jar", @"D:\Downloads\1.jar");
task.AddFile("https://example.com/2.jar", @"D:\Downloads\2.jar");

task.OnProgressUpdated += info =>
{
    Console.WriteLine(
        $"Progress={info.Progress:F2}% " +
        $"Downloading={info.DownloadingFiles} " +
        $"Completed={info.CompletedFiles} " +
        $"Failed={info.FailedFiles} " +
        $"Speed={info.Speed:F0}B/s");
};

await task.StartDownloadAsync(CancellationToken.None, "BatchClient/1.0");
```

获取文件级状态：

```csharp
foreach (var file in task.GetFileStatuses())
{
    Console.WriteLine($"{file.Id} {file.Name} {file.Progress:F2}% {file.Status}");
}
```

## 多任务管理示例

```csharp
using Qomicex.Downloader;

using var manager = new DownloadManager(intervalMs: 500);

manager.OnTaskProgressUpdated += (taskId, info) =>
{
    Console.WriteLine($"Task {taskId}: {info.Progress:F2}% {info.Speed:F0}B/s");
};

manager.OnGlobalProgressUpdated += global =>
{
    Console.WriteLine(
        $"Global: {global.TotalProgress:F2}% " +
        $"Speed={global.TotalSpeed:F0}B/s " +
        $"Running={global.RunningTasks}/{global.TotalTasks}");
};

var taskId = manager.CreateTask(maxConcurrentFiles: 2, singleFileThreadCount: 0, maxRetries: 3, ignoreRangeProbe200Ok: false);
manager.AddFileToTask(taskId, "https://example.com/a.zip", @"D:\Downloads\a.zip");
manager.AddFileToTask(taskId, "https://example.com/b.zip", @"D:\Downloads\b.zip");

await manager.StartTaskAsync(taskId, CancellationToken.None, "ManagerClient/1.0");
```

## 暂停、继续、取消说明

### `Core`

- `Pause()`: 暂停当前文件下载
- `Resume()`: 继续当前文件下载
- `Cancel()`: 取消当前文件下载

### `DownloadTask`

通过文件 `id` 控制：

- `PauseDownload(id)`
- `ContinueDownload(id)`
- `StopDownload(id)`

传入 `-1` 表示“作用于当前任务中的所有文件”。

### `DownloadManager`

通过任务 `taskId` 控制：

- `PauseTask(taskId)`
- `ContinueTask(taskId)`
- `StopTask(taskId)`

## `User-Agent` 说明

所有公开启动方法都支持传入 `userAgent` / `ua` 参数：

- `Core.DownloadFileAsync(...)`
- `DownloadTask.StartDownloadAsync(...)`
- `DownloadManager.StartTaskAsync(...)`

该值会应用到下载请求中。若你的下载源对请求头有要求，建议显式传入。

## 线程数说明

这是最容易误解的地方。

### 文件并发数

- 作用对象：`DownloadTask` / `DownloadManager`
- 表示同一个任务中，最多允许多少个文件同时下载

示例：

```csharp
var task = new DownloadTask(maxConcurrentFiles: 3, singleFileThreadCount: 0, maxRetries: 3, ignoreRangeProbe200Ok: false);
```

上面的含义是：

- 最多 `3` 个文件同时下载
- 每个文件的分片数由 `singleFileThreadCount` 决定

### 单文件分片线程数

- 作用对象：`Core`，以及 `DownloadTask` / `DownloadManager` 向下传递的参数
- 表示单个文件内部使用多少个 HTTP Range 分片并发下载
- 传 `0` 时启用自动分片

示例：

```csharp
var engine = new Core(threadCount: 8, maxRetries: 3, autoUpdate: true, ignoreRangeProbe200Ok: false);
var autoEngine = new Core(threadCount: 0, maxRetries: 3, autoUpdate: true, ignoreRangeProbe200Ok: false);
```

- `threadCount: 8` 表示固定使用 `8` 个分片
- `threadCount: 0` 表示根据文件大小自动决定分片数

### 自动分片规则

- 每 `16MB` 一个分片
- 最少 `1` 个
- 最大 `16` 个

具体示例：

- `1MB` -> `1` 个分片
- `16MB` -> `1` 个分片
- `16MB + 1B` -> `2` 个分片
- `128MB` -> `8` 个分片
- `500MB` -> `16` 个分片

如果你的下载源不适合高并发，建议：

- 减小 `maxConcurrentFiles`
- 或者给 `singleFileThreadCount` 传入较小的固定值，例如 `1`、`2`、`4`

## 注意事项

- 组件依赖服务端支持获取文件大小；若服务端无法返回 `Content-Length`，下载会失败。
- 多线程分片下载依赖 HTTP Range 能力；若服务端不支持分片范围请求，当前文件会自动回退为单线程整文件下载。
- 这种回退只影响当前文件，不影响 `DownloadTask` 的其他文件并行下载，也不影响 `DownloadManager` 的多任务并行。
- 多分片是能力协商后启用的，不是无条件强制启用。
- `ignoreRangeProbe200Ok` 只影响探测请求阶段。
- 当 `ignoreRangeProbe200Ok = true` 时，探测请求返回 `200 OK` 仍允许继续尝试多分片。
- 它不会把后续真实分片请求返回的 `200 OK` 一律视为合法分片响应，因此这是一个兼容模式开关，默认建议保持 `false`。
- `Pause()` 是协作式暂停，不是中断线程；暂停生效点在读取循环中。
- `Cancel()` 是协作式取消；如果你同时传入 `CancellationToken`，也可能抛出 `OperationCanceledException`。
- 手动轮询模式下，必须自己定期调用 `UpdateProgress()`，否则上层不会收到新进度。
- `Speed` 为瞬时采样速度，单位 `B/s`，更适合展示趋势，不建议作为严格计费或统计依据。
- `maxConcurrentFiles <= 0` 会抛 `ArgumentOutOfRangeException`。
- `singleFileThreadCount < 0` 会抛 `ArgumentOutOfRangeException`。
- 目标文件会直接写入 `outputPath`，请确保目录存在且应用程序有写权限。
- 若输出路径已存在文件，当前实现会覆盖写入。
- 下载过程中如果某个文件失败，`DownloadTask` 会把该文件标记为 `Failed`，你需要自行决定是否重试整个任务或仅处理失败项。

## 建议使用方式

### 场景 1: 简单下载器 / 单文件下载

- 直接用 `Core`
- 设 `autoUpdate: true`
- 需要自动分片时传 `threadCount: 0`
- 用 `Progress<DownloadProgress>` 直接更新 UI

### 场景 2: 启动器 / 安装器 / 批量资源下载

- 用 `DownloadTask`
- 保持手动轮询思路
- 分别设置 `maxConcurrentFiles` 和 `singleFileThreadCount`
- 用定时器每 `300ms` 到 `1000ms` 调一次 `UpdateProgress()`

### 场景 3: 有多个批次下载任务

- 用 `DownloadManager`
- 订阅 `OnTaskProgressUpdated` 和 `OnGlobalProgressUpdated`
- `CreateTask(...)` 时分别设置两层并发参数
- 由 `DownloadManager` 的内部计时器完成聚合刷新

## 常见问题

### 1. 为什么没有收到进度回调？

可能原因：

- 你在使用手动轮询模式，但没有调用 `UpdateProgress()`
- 你没有传入 `Progress<DownloadProgress>` 实例
- 下载速度过快，文件已经直接完成

### 2. 为什么速度是 0？

可能原因：

- 刚开始下载，还没有足够的采样间隔
- 已经下载完成
- 轮询过于稀疏或过于频繁，导致显示不稳定

### 3. 为什么暂停后不是立即停？

暂停是协作式的，在读取循环下一个检查点才会生效，不是强制中断。

### 4. 可以只引用 DLL 吗？

可以。该项目没有第三方 NuGet 依赖，只要你的目标环境是 `.NET 10` 并且能解析 `Qomicex.Downloader.dll`，就可以直接使用其公开类型。

## API 选型速查

- 只下一个文件: `Core`
- 下多个文件: `DownloadTask`
- 同时管理多个下载任务: `DownloadManager`
- 想自动分片: `threadCount: 0` 或 `singleFileThreadCount: 0`
- 想实时刷新: `autoUpdate: true`
- 想控制刷新频率: `autoUpdate: false` + `UpdateProgress()`

## 最后建议

第一次接入时建议先用一个公开可访问的小文件做联调，确认：

- `Content-Length` 正常返回
- 输出路径权限正常
- 你的 UI 刷新节流策略合适
- 你设置的 `maxConcurrentFiles` 和 `singleFileThreadCount` 不会对目标源造成过大压力

如果你是面向最终用户的软件作者，建议在你的上层应用中补充：

- 失败重试策略
- 超时与网络异常提示
- 下载完成校验（如哈希）
- 持久化下载记录
