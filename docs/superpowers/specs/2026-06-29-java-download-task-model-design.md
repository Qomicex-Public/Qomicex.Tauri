# Java 下载任务模型对齐下载中心设计

## 背景与问题

当前 Java 下载没有完全对齐 Mod 下载 / 游戏安装的下载中心统一管理模式，导致：
1. Settings 页面自维护了一套 Java 下载轮询和进度 UI，与下载中心重复
2. 下载队列中 Java 任务的 progress 始终为 0，且卡在排队/下载阶段不变
3. Java 任务无法在下载中心内正常取消
4. Java 任务不支持暂停/继续
5. 整体上 Java 下载和 Mod/文件下载走了不同的生命周期管理，行为不一致

## 目标

将 Java 下载生命周期从 "Settings 自管 + 下载中心半管" 彻底改成 "Settings 只建任务，下载中心统一接管"，与 Mod 下载 / 游戏安装的 `downloadStore → DownloadCenter` 模式完全一致。

## 约束

- **Core 不可改动**：`Qomicex.Avalonia/Qomicex.Core/` 和 `Qomicex.Avalonia/Qomicex.Downloader/` 是共享 submodule。
- 首版 Java 下载不支持 msi / exe / pkg 安装器。
- 下载目录固定：`QML/Runtime/Java`。
- 无测试框架，用 `dotnet build` 和 `npx tsc --noEmit` 验证。

## 设计

### 1. 职责重新切分

**Settings.tsx**：
- 只负责 catalog 加载、vendor/version/platform/arch 选择、调 `startJavaDownload`
- `addTask()` 到下载中心后关闭对话框，显示 "已加入下载中心"
- 不再维护 `downloadTaskId`、`downloadProgress` 状态、Java 下载轮询、Java 下载 cancel

**DownloadCenter.tsx**：
- 成为 Java 下载唯一状态来源
- 对 `task.type === 'java'` 完整负责：
  - 轮询 `getJavaDownloadProgress(taskId)`
  - pause / resume
  - cancel
  - 终态后 remove

### 2. 后端任务状态机

`JavaDownloadService` 状态扩展为：

| 状态 | 含义 | 可转换到 |
|------|------|---------|
| `queued` | 任务已创建，等待后台执行 | `resolving`, `cancelled` |
| `resolving` | 正在请求 vendor API 解析下载链接 | `downloading`, `failed`, `cancelled` |
| `downloading` | DownloadManager 正在下载归档 | `paused`, `extracting`, `failed`, `cancelled` |
| `paused` | 下载阶段被暂停 | `downloading`, `cancelled` |
| `extracting` | 正在解压 | `registering`, `failed`, `cancelled` |
| `registering` | 正在调用 JavaRuntimeStore.AddCustomAsync | `completed`, `failed` |
| `completed` | 终态 | — |
| `failed` | 终态 | — |
| `cancelled` | 终态 | — |

### 3. 后端 Pause/Resume 和任务生命周期

`JavaDownloadService` 新增：

```csharp
public bool Pause(string taskId)
{
    if (_tasks.TryGetValue(taskId, out var state) && state.Status == "downloading")
    {
        state.Status = "paused";
        state.Cancellation.Cancel(); // 复用 CancellationToken 中断当前下载
        return true;
    }
    return false;
}

public bool Resume(string taskId)
{
    if (_tasks.TryGetValue(taskId, out var state) && state.Status == "paused")
    {
        state.Status = "downloading";
        _ = Task.Run(() => RunTaskAsync(state, state.PendingRequest!));
        return true;
    }
    return false;
}
```

- `RunTaskAsync` 改造：下载阶段把 `request` 存到 `state.PendingRequest`，Resume 时跳过 resolving 直接进入 downloading
- `Cancel`：在所有非终态状态下都有效，通过 token 取消当前操作
- Controller 新增 `POST /api/java/download/{taskId}/pause` 和 `POST /api/java/download/{taskId}/resume`

### 4. 前端改造

**Settings.tsx**：
- 删除 `downloadTaskId`、`downloadProgress` 状态
- 删除 Java 下载轮询 useEffect
- 删除对话框内进度 UI 和取消按钮
- 删除 `cancelJavaDownload` 导入
- `handleStartJavaDownload` 简化为：调 `startJavaDownload` → `addTask()` → 关闭对话框

**DownloadCenter.tsx**：
- `type === 'java'` 完整支持：
  - `paused` → 显示"继续"，调用 `resumeJavaDownload(taskId)`
  - `downloading` → 显示"暂停"，调用 `pauseJavaDownload(taskId)`
  - 取消按钮：ququed/resolving/downloading/paused 都走 `cancelJavaDownload(taskId)` → `removeTask(id)`
  - 终态 → 显示"移除"，调用 `removeTask(id)`
- 图标：`type === 'java'` 显示 `faCoffee`

**DownloadTask 类型**：
- `DownloadTask.type` 已支持 `'java'`

### 5. 错误与边界处理

**后端**：
- ResolvePackageAsync 失败 → 任务 failed，error 记录具体原因
- 下载中网络断开 → 任务 failed，error 记录 HTTP 异常
- 解压失败 → 任务 failed，error 记录 "解压失败"
- 注册失败 → 任务 failed，error 记录 "注册失败"
- 所有失败后清理 `.tmp/<taskId>` 临时目录
- Pause 时不在 downloading 状态 → 返回 false

**前端**：
- catalog 加载失败 → Settings 页显示错误提示
- startJavaDownload 失败 → 显示错误提示，不添加任务

**首版不做**：
- 断点续传
- 下载后自动删除归档

## 涉及文件汇总

| 文件 | 改动 |
|------|------|
| `src-backend/.../Services/JavaDownloadService.cs` | 补齐 Pause/Resume，状态 state 存 request 供 Resume 使用，RunTaskAsync 改造 |
| `src-backend/.../Controllers/JavaDownloadController.cs` | 新增 pause/resume 路由 |
| `src/pages/Settings.tsx` | 删除自管下载状态，只建任务并交给下载中心 |
| `src/pages/DownloadCenter.tsx` | 对 java 类型补齐 pause/resume/cancel 完整分支 |
| `src/api/java.ts` | 新增 pauseJavaDownload / resumeJavaDownload |

## 自检

- 无 TBD / TODO / 占位符
- 状态机完整且互不冲突
- 职责切分明确：Settings 只建任务，DownloadCenter 完全接管生命周期
- 对齐 Mod/文件下载的 downloadStore + DownloadCenter 模式
