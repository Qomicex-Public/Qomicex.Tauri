# Java 下载任务模型对齐下载中心 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 Java 下载生命周期从 "Settings 自管 + 下载中心半管" 彻底改成 "Settings 只建任务，下载中心统一接管"，补齐 Pause/Resume/Cancel 完整任务生命周期。

**Architecture:** 后端 `JavaDownloadService` 新增 Pause/Resume 方法和 PendingRequest 存储、`RunTaskAsync` 改造支持 Resume 跳过 resolving；Controller 新增 pause/resume 路由。前端 Settings 删除自管 Java 下载轮询和 `getJavaDownloadProgress`/`cancelJavaDownload`/`updateTask` 导入；DownloadCenter 对 `type === 'java'` 补齐 pause/resume/cancel/remove 完整分支。

**Tech Stack:** ASP.NET Core (.NET 10), React 19 + TypeScript + Vite 7

## Global Constraints

- **Core 不可改动**：`Qomicex.Avalonia/Qomicex.Core/` 和 `Qomicex.Avalonia/Qomicex.Downloader/` 是共享 submodule
- **首版 Java 下载不支持 msi/exe/pkg**
- **下载目录固定**：`QML/Runtime/Java`
- **无测试框架**：用 `dotnet build` 和 `npx tsc --noEmit` 验证
- **前端导入必须带扩展名**

---
## File Structure

| 文件 | 操作 | 职责 |
|------|------|------|
| `src-backend/.../Services/JavaDownloadService.cs` | 修改 | 新增 Pause/Resume，RunTaskAsync 存储 PendingRequest |
| `src-backend/.../Controllers/JavaDownloadController.cs` | 修改 | 新增 pause/resume 路由 |
| `src/api/java.ts` | 修改 | 新增 pauseJavaDownload / resumeJavaDownload |
| `src/pages/Settings.tsx` | 修改 | 删除自管 Java 下载轮询和多余导入 |
| `src/pages/DownloadCenter.tsx` | 修改 | 对 java 类型补齐 pause/resume/cancel/remove，改用 faCoffee |
| `src/types/index.ts` | 修改 | 检查 DownloadTask.status 是否需补充 'resolving'（已确认：DownloadTask.status 包含状态枚举，后端 pending/resolving 映射到 queued） |

---

### Task 1: 后端 Pause/Resume + RunTaskAsync 改造

**Files:**
- Modify: `src-backend/Qomicex.Launcher.Backend/Services/JavaDownloadService.cs`

**Interfaces:**
- Consumes: existing `JavaDownloadTaskState` (needs `PendingRequest` field added), existing `RunTaskAsync`
- Produces: `Pause(string taskId): bool`, `Resume(string taskId): bool`, modified `JavaDownloadTaskState` with `PendingRequest`

- [ ] **Step 1: 给 JavaDownloadTaskState 加 PendingRequest 字段**

在 `src-backend/Qomicex.Launcher.Backend/Services/JavaDownloadService.cs` 的 `JavaDownloadTaskState` 类中，`Cancellation` 字段之后添加：

```csharp
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
        public JavaDownloadStartRequest? PendingRequest { get; set; }
    }
```

- [ ] **Step 2: 在 Cancel 方法之后添加 Pause 和 Resume 方法**

在 `Cancel` 方法之后、`GetBaseDir` 之前插入：

```csharp
    public bool Pause(string taskId)
    {
        if (_tasks.TryGetValue(taskId, out var state) && state.Status == "downloading")
        {
            state.Status = "paused";
            state.Cancellation.Cancel();
            return true;
        }
        return false;
    }

    public bool Resume(string taskId)
    {
        if (_tasks.TryGetValue(taskId, out var state) && (state.Status == "paused" || state.Status == "queued"))
        {
            if (state.PendingRequest == null) return false;
            // 创建一个新的 CancellationTokenSource 供新的后台任务使用
            typeof(JavaDownloadTaskState)
                .GetField($"<{nameof(JavaDownloadTaskState.Cancellation)}>k__BackingField",
                    System.Reflection.BindingFlags.Instance | System.Reflection.BindingFlags.NonPublic)
                ?.SetValue(state, new CancellationTokenSource());
            _ = Task.Run(() => RunTaskAsync(state, state.PendingRequest, resumeFromDownload: state.Status == "paused"));
            return true;
        }
        return false;
    }
```

> 注意：以上反射代码是为了绕过 `Cancellation` 的 `{ get; }` 只读自动属性。如果编译不过，改用以下更简单的方案：
>
> 把 `Cancellation` 从 `public CancellationTokenSource Cancellation { get; } = new();` 改为 `public CancellationTokenSource Cancellation { get; set; } = new();`，然后 `Resume` 中直接 `state.Cancellation = new CancellationTokenSource();`

- [ ] **Step 3: 改造 RunTaskAsync 签名和逻辑**

将 `RunTaskAsync` 签名从：

```csharp
    private async Task RunTaskAsync(JavaDownloadTaskState state, JavaDownloadStartRequest request)
```

改为：

```csharp
    private async Task RunTaskAsync(JavaDownloadTaskState state, JavaDownloadStartRequest request, bool resumeFromDownload = false)
```

在方法体开头（`try` 之前）存储 PendingRequest：

```csharp
    private async Task RunTaskAsync(JavaDownloadTaskState state, JavaDownloadStartRequest request, bool resumeFromDownload = false)
    {
        state.PendingRequest = request;
        try
        {
```

在 `try` 块内部，resolving 阶段加上跳过逻辑：

```csharp
            if (!resumeFromDownload)
            {
                state.Status = "resolving";
                var (url, fileName) = await ResolvePackageAsync(request);
                state.FileName = fileName;
            }
```

把后续的 `state.Status = "downloading";` 移到 resolving 之后（无论是否 resume 都要进入 downloading）：

```csharp
            state.Status = "downloading";
            var tmpDir = Path.Combine(GetBaseDir(), ".tmp", state.TaskId);
            Directory.CreateDirectory(tmpDir);
            var archivePath = Path.Combine(tmpDir, state.FileName);
```

完整的 `RunTaskAsync` 应为：

```csharp
    private async Task RunTaskAsync(JavaDownloadTaskState state, JavaDownloadStartRequest request, bool resumeFromDownload = false)
    {
        state.PendingRequest = request;
        try
        {
            if (!resumeFromDownload)
            {
                state.Status = "resolving";
                var (url, fileName) = await ResolvePackageAsync(request);
                state.FileName = fileName;
            }

            state.Status = "downloading";
            var tmpDir = Path.Combine(GetBaseDir(), ".tmp", state.TaskId);
            Directory.CreateDirectory(tmpDir);
            var archivePath = Path.Combine(tmpDir, state.FileName);

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
            state.Status = state.Status == "paused" ? "paused" : "cancelled";
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

注意 `url` 变量从 `resolving` 块移出后需要声明。把 `var (url, fileName)` 提取到 `try` 块开头且支持 resume 时已有值。改为：

```csharp
            string url;
            if (!resumeFromDownload)
            {
                state.Status = "resolving";
                (url, state.FileName) = await ResolvePackageAsync(request);
                // state.FileName already set via tuple; url is local
            }
```

但是 `url` 在 resumeFromDownload 时未赋值，下载阶段需要它。需要把 `url` 也存到 state 里。

- [ ] **Step 4: 给 JavaDownloadTaskState 加 DownloadUrl 字段，Resume 时从 state 取**

把 download url 也存下来。给 `JavaDownloadTaskState` 加 `DownloadUrl` 字段：

```csharp
        public string DownloadUrl { get; set; } = string.Empty;
```

`RunTaskAsync` 的 resolving 块改为：

```csharp
            if (!resumeFromDownload)
            {
                state.Status = "resolving";
                var (url, fileName) = await ResolvePackageAsync(request);
                state.DownloadUrl = url;
                state.FileName = fileName;
            }
```

下载阶段使用 `state.DownloadUrl`：

```csharp
            manager.AddFileToTask(tid, state.DownloadUrl, archivePath);
```

- [ ] **Step 5: 修改 `StartAsync` 中的 RunTaskAsync 调用**

当前调用 `_ = Task.Run(() => RunTaskAsync(state, request));` 无需修改（默认 `resumeFromDownload = false`）。

- [ ] **Step 6: 把 Cancellation 改成可 set**

将：

```csharp
        public CancellationTokenSource Cancellation { get; } = new();
```

改为：

```csharp
        public CancellationTokenSource Cancellation { get; set; } = new();
```

- [ ] **Step 7: 把 Resume 方法中的反射替换为直接赋值**

```csharp
    public bool Resume(string taskId)
    {
        if (_tasks.TryGetValue(taskId, out var state) && (state.Status == "paused" || state.Status == "queued"))
        {
            if (state.PendingRequest == null) return false;
            state.Cancellation = new CancellationTokenSource();
            _ = Task.Run(() => RunTaskAsync(state, state.PendingRequest, resumeFromDownload: state.Status == "paused"));
            return true;
        }
        return false;
    }
```

- [ ] **Step 8: Cancel 方法也支持 paused 状态**

当前 Cancel 在 paused 状态下设 `cancelled` 但 token 已被 cancel。修改 Cancel 以显式处理 paused：

```csharp
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
```

（当前实现已正确处理，无需改动。但需要确认在 paused 状态下调用 Cancel 不会抛异常——因为 paused 时 token 已被 cancel，再 cancel 一次没问题。）

- [ ] **Step 9: 编译验证**

Run: `dotnet build src-backend/Qomicex.Launcher.Backend/Qomicex.Launcher.Backend.csproj`

Expected: 成功，0 错误

- [ ] **Step 10: Commit**

```bash
git add src-backend/Qomicex.Launcher.Backend/Services/JavaDownloadService.cs
git commit -m "feat: add Pause/Resume to JavaDownloadService"
```

---

### Task 2: 后端 Controller 新增 pause/resume 路由

**Files:**
- Modify: `src-backend/Qomicex.Launcher.Backend/Controllers/JavaDownloadController.cs`

**Interfaces:**
- Consumes: `JavaDownloadService.Pause(string): bool`, `JavaDownloadService.Resume(string): bool`
- Produces: `POST /api/java/download/{taskId}/pause`, `POST /api/java/download/{taskId}/resume`

- [ ] **Step 1: 添加路由**

在 `Cancel` Action 之后、类结束 `}` 之前添加：

```csharp
    [HttpPost("{taskId}/pause")]
    public IActionResult Pause(string taskId)
    {
        if (_service.Pause(taskId)) return NoContent();
        return NotFound();
    }

    [HttpPost("{taskId}/resume")]
    public IActionResult Resume(string taskId)
    {
        if (_service.Resume(taskId)) return NoContent();
        return NotFound();
    }
```

- [ ] **Step 2: 编译验证**

Run: `dotnet build src-backend/Qomicex.Launcher.Backend/Qomicex.Launcher.Backend.csproj`

Expected: 成功，0 错误

- [ ] **Step 3: Commit**

```bash
git add src-backend/Qomicex.Launcher.Backend/Controllers/JavaDownloadController.cs
git commit -m "feat: add pause/resume routes to JavaDownloadController"
```

---

### Task 3: 前端新增 pause/resume API

**Files:**
- Modify: `src/api/java.ts`

**Interfaces:**
- Consumes: `post`, `del` from `./client.ts`
- Produces: `pauseJavaDownload(taskId): Promise<void>`, `resumeJavaDownload(taskId): Promise<void>`

- [ ] **Step 1: 添加 API 函数**

在 `api/java.ts` 的 `cancelJavaDownload` 之后添加：

```ts
export function pauseJavaDownload(taskId: string): Promise<void> {
  return post<void>(`/java/download/${taskId}/pause`)
}

export function resumeJavaDownload(taskId: string): Promise<void> {
  return post<void>(`/java/download/${taskId}/resume`)
}
```

- [ ] **Step 2: 类型检查**

Run: `npx tsc --noEmit`

Expected: 无错误

- [ ] **Step 3: Commit**

```bash
git add src/api/java.ts
git commit -m "feat: add pauseJavaDownload/resumeJavaDownload API"
```

---

### Task 4: Settings 清理自管 Java 下载代码

**Files:**
- Modify: `src/pages/Settings.tsx`

**Spec 要求**：
- 删除 Java 下载轮询 useEffect
- 删除不再需要的导入：`getJavaDownloadProgress`、`cancelJavaDownload`、`getTasks`、`updateTask`

**当前状态确认**：`downloadTaskId` 和 `downloadProgress` 已在之前删除。

- [ ] **Step 1: 删除轮询 useEffect**

找到 `useEffect(() => { ... const javaTasks = getTasks()... }, [])` 并删除整个块。

当前代码（~line 273-300）：
```tsx
  useEffect(() => {
    const javaTasks = getTasks().filter((t) => t.type === 'java' && (t.status === 'queued' || t.status === 'downloading'))
    if (javaTasks.length === 0) return
    const timer = setInterval(async () => {
      for (const t of javaTasks) {
        if (!t.taskId) continue
        try {
          const progress = await getJavaDownloadProgress(t.taskId)
          let newStatus: DownloadTask['status'] = 'downloading'
          if (progress.status === 'completed') newStatus = 'completed'
          else if (progress.status === 'failed') newStatus = 'failed'
          else if (progress.status === 'cancelled') newStatus = 'cancelled'
          else if (progress.status === 'queued' || progress.status === 'resolving') newStatus = 'queued'
          updateTask(t.id, {
            status: newStatus,
            progress: Math.round(progress.progress),
            speed: progress.speed,
            currentFile: progress.fileName || undefined,
            error: progress.error || undefined,
            completedAt: newStatus === 'completed' ? new Date().toISOString() : undefined,
          })
          if (newStatus === 'completed') {
            await scanRuntimes('quick').catch(() => {})
          }
        } catch { /* skip */ }
      }
    }, 1000)
    return () => clearInterval(timer)
  }, [])
```

整个删除。

- [ ] **Step 2: 清理导入**

当前导入行：
```ts
import {
  addCustomJavaRuntime,
  removeCustomJavaRuntime,
  getJavaDownloadCatalog,
  startJavaDownload,
  getJavaDownloadProgress,
} from '../api/java.ts'
```

删除 `getJavaDownloadProgress`：

```ts
import {
  addCustomJavaRuntime,
  removeCustomJavaRuntime,
  getJavaDownloadCatalog,
  startJavaDownload,
} from '../api/java.ts'
```

当前 downloadStore 导入行：
```ts
import { addTask, updateTask, getTasks } from '../stores/downloadStore.ts'
```

删除 `updateTask` 和 `getTasks`（只保留 `addTask`）：

```ts
import { addTask } from '../stores/downloadStore.ts'
```

- [ ] **Step 3: 类型检查**

Run: `npx tsc --noEmit`

Expected: 无错误

- [ ] **Step 4: Commit**

```bash
git add src/pages/Settings.tsx
git commit -m "refactor: remove Settings self-managed java download code"
```

---

### Task 5: DownloadCenter 补齐 Java 完整生命周期

**Files:**
- Modify: `src/pages/DownloadCenter.tsx`

**Spec 要求**：
- `type === 'java'` 分支：
  - paused → 显示"继续"，调用 `resumeJavaDownload(taskId)`
  - downloading → 显示"暂停"，调用 `pauseJavaDownload(taskId)`
  - 取消按钮在 queued/resolving/downloading/paused 都可用
  - 图标使用 `faCoffee`

**当前代码状态**：DownloadCenter 已有 java 轮询分支，但 UI 按钮对 java 类型目前被 `task.type !== 'file' && task.type !== 'java'` 条件隐藏了暂停按钮，取消按钮逻辑已包含 java 分支。

- [ ] **Step 1: 更新导入**

添加 `pauseJavaDownload` 和 `resumeJavaDownload` 导入：

当前导入行：
```ts
import { getJavaDownloadProgress, cancelJavaDownload } from '../api/java.ts'
```

改为：

```ts
import { getJavaDownloadProgress, cancelJavaDownload, pauseJavaDownload, resumeJavaDownload } from '../api/java.ts'
```

在图标导入中添加 `faCoffee`。当前已有 `faDownload, faCube, faBox, faRotate, faTrashCan, faArrowRight, faPause, faPlay, faStop, faHammer`，添加 `faCoffee`：

```ts
import { faDownload, faCube, faBox, faRotate, faTrashCan, faArrowRight, faPause, faPlay, faStop, faHammer, faCoffee } from '@fortawesome/free-solid-svg-icons'
```

- [ ] **Step 2: 下载中心轮询中的 java 分支已正确，无需改动**

当前轮询逻辑（~line 92-111）已处理 java 类型。确认其正确处理了 `paused` 状态（`progress.status === 'paused'` → `newStatus = 'paused'`）。需要补充 paused 状态映射：

当前代码只在状态是 `completed`/`cancelled`/`failed` 时设 non-queued 状态，`paused` 状态没有被识别。需要在 java 轮询分支中增加 paused 状态映射：

在 `progress.status === 'cancelled'` 之后添加：

```ts
            else if (progress.status === 'paused') newStatus = 'paused'
```

完整的 java 轮询分支变为：

```ts
         if (task.type === 'java' && task.taskId) {
           try {
             const progress = await getJavaDownloadProgress(task.taskId)
             let newStatus: DownloadTask['status'] = 'downloading'
             if (progress.status === 'completed') newStatus = 'completed'
             else if (progress.status === 'cancelled') newStatus = 'cancelled'
             else if (progress.status === 'failed') newStatus = 'failed'
             else if (progress.status === 'paused') newStatus = 'paused'
             else if (progress.status === 'queued' || progress.status === 'resolving') newStatus = 'queued'

             updateTask(task.id, {
               status: newStatus,
               stage: progress.status,
               progress: Math.round(progress.progress),
               speed: progress.speed,
               currentFile: progress.fileName || undefined,
               error: progress.error || undefined,
               completedAt: newStatus === 'completed' ? new Date().toISOString() : undefined,
             })
           } catch { /* skip */ }
           continue
         }
```

- [ ] **Step 3: 修改暂停/继续按钮逻辑**

当前代码（~line 252）用 `task.type !== 'file' && task.type !== 'java'` 隐藏 Java 任务的暂停 UI。需要改为只给 Java 任务显示暂停按钮。

当前暂停/继续按钮块：
```tsx
                    {isActive && task.type !== 'file' && task.type !== 'java' && task.status !== 'queued' && (
                      <>
                        {task.status === 'paused' ? (
                          <Tooltip content="继续">
                            <Button variant="ghost" size="icon" className="h-8 w-8 text-muted-foreground hover:text-primary" onClick={() => task.instanceId && resumeInstall(task.instanceId)}>
                              <FontAwesomeIcon icon={faPlay} className="h-3.5 w-3.5" />
                            </Button>
                          </Tooltip>
                        ) : (
                          <Tooltip content="暂停">
                            <Button variant="ghost" size="icon" className="h-8 w-8 text-muted-foreground hover:text-amber-400" onClick={() => task.instanceId && pauseInstall(task.instanceId)}>
                              <FontAwesomeIcon icon={faPause} className="h-3.5 w-3.5" />
                            </Button>
                          </Tooltip>
                        )}
```

把 Java 任务的暂停/继续按钮作为独立分支加入。在 `isActive && task.type !== 'file' && task.type !== 'java' && ...` 块**之前**添加 Java 专属的暂停/继续块：

```tsx
                    {isActive && task.type === 'java' && task.status !== 'queued' && (
                      <>
                        {task.status === 'paused' ? (
                          <Tooltip content="继续">
                            <Button variant="ghost" size="icon" className="h-8 w-8 text-muted-foreground hover:text-primary" onClick={() => task.taskId && resumeJavaDownload(task.taskId)}>
                              <FontAwesomeIcon icon={faPlay} className="h-3.5 w-3.5" />
                            </Button>
                          </Tooltip>
                        ) : (
                          <Tooltip content="暂停">
                            <Button variant="ghost" size="icon" className="h-8 w-8 text-muted-foreground hover:text-amber-400" onClick={() => task.taskId && pauseJavaDownload(task.taskId)}>
                              <FontAwesomeIcon icon={faPause} className="h-3.5 w-3.5" />
                            </Button>
                          </Tooltip>
                        )}
                      </>
                    )}
```

然后在现有的通用暂停块前面插入这个 Java 专属块。

- [ ] **Step 4: 修改图标**

图标选择逻辑（~line 228-233）当前为：
```tsx
                      <FontAwesomeIcon
                        icon={task.type === 'resource' ? faBox : task.type === 'repair' ? faHammer : task.type === 'batch' ? faDownload : faCube}
```

添加 `task.type === 'java' ? faCoffee :` 在最前面：

```tsx
                      <FontAwesomeIcon
                        icon={task.type === 'java' ? faCoffee : task.type === 'resource' ? faBox : task.type === 'repair' ? faHammer : task.type === 'batch' ? faDownload : faCube}
```

- [ ] **Step 5: 确认 cancel 分支已正确包含 java**

当前 cancel onClick 已经在取消按钮中把 `task.type === 'java' && task.taskId` 放在最前面（先调 `cancelJavaDownload` 再 `removeTask`），不需要改动。

- [ ] **Step 6: 类型检查**

Run: `npx tsc --noEmit`

Expected: 无错误

- [ ] **Step 7: Commit**

```bash
git add src/pages/DownloadCenter.tsx
git commit -m "feat: add full java download lifecycle to DownloadCenter"
```

---

### Task 6: 最终验证

**Files:** 无修改，仅验证

- [ ] **Step 1: 后端编译**

Run: `dotnet build src-backend/Qomicex.Launcher.Backend/Qomicex.Launcher.Backend.csproj`

Expected: 成功，0 错误

- [ ] **Step 2: 前端类型检查**

Run: `npx tsc --noEmit`

Expected: 无错误

- [ ] **Step 3: 手动验证清单**

1. 打开 Settings → Java 运行时页，点击"下载 Java" → 选 vendor/version → 开始下载
2. 确认对话框关闭，显示"已加入下载中心"
3. 前往下载中心，Java 任务应显示 `faCoffee` 图标
4. 任务状态应流转：`queued` → `resolving` → `downloading`
5. downloadable 状态下点击"暂停"，应看到状态变为 `paused`
6. 暂停后点击"继续"，应回到 `downloading`
7. 下载中/暂停中点击"取消"，应正常取消
8. 下载完成后，Java 列表应自动刷新并出现新安装的 Java
