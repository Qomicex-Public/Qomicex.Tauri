# Task 7 报告: SSE 统一进度推送 + 前端轮询改 SSE

## 状态: 完成

## 提交

| Hash | 信息 |
|------|------|
| `e66a103` | `feat(progress): SSE unified progress streaming, replace frontend polling` |

## 变更文件

| 文件 | 操作 |
|------|------|
| `src-backend/.../Controllers/ProgressSseController.cs` | 新建 |
| `src/hooks/useDownloadSSE.ts` | 新建 |
| `src/pages/DownloadCenter.tsx` | 修改 |

## 构建总结

| 目标 | 结果 |
|------|------|
| `dotnet build` (后端) | **0 错误**, 7 个预先存在的警告 |
| `npx tsc --noEmit` (前端) | **无错误** |

## 变更详情

### 1. ProgressSseController.cs (新建)
- `GET /api/progress/stream` — SSE 端点，每 300ms 推送合并的进度负载
- 聚合来自 `InstanceInstallService`、`JavaDownloadService` 和 `ResourceDownloadService` 的 `GetAllActiveStates()`
- 输出带有 `installs`、`javaDownloads`、`resources` 和 `summary`（`activeCount`、`totalSpeed`）的 JSON
- 对客户端断开连接使用 `CancellationToken` 妥善处理

### 2. useDownloadSSE.ts (新建)
- 使用 `EventSource` 连接到 `/api/progress/stream` 的 React hook
- 返回 `ProgressPayload | null`
- 导出了包含 `InstallState`、`JavaDownloadState`、`ResourceDownloadState` 的完整 TypeScript 接口
- 组件卸载时通过 `es.close()` 进行清理
- 通过 `onerror` 处理程序实现浏览器自动重连

### 3. DownloadCenter.tsx (已修改)
**已移除:**
- `useRef` 导入（不再需要）
- 轮询 API 导入：`getInstallProgress`、`getResourceDownloadProgress`、`getJavaDownloadProgress`、`ApiError`
- 包含 `pollingRef` 的 `applyJavaProgress` 函数和两个轮询 `useEffect` 块（~130 行）
- 重试按钮中的异步 `getResourceDownloadProgress` 调用 —— 现仅调用 `removeTask()`

**已添加:**
- `useDownloadSSE` hook 导入和使用
- 单个 SSE 响应式效果：对 `getTasks()` 进行迭代，通过 `taskId`/`instanceId` 匹配 SSE 数据，并以进度/速度/阶段/错误更新调用 `updateTask`
- 效果依赖于 `[sseData]`，每次 SSE 推送间隔约 300ms 触发

**已保留:** 所有操作 API — `pauseInstall`、`resumeInstall`、`cancelInstall`、`cancelResourceDownload`、`cancelJavaDownload`、`pauseJavaDownload`、`resumeJavaDownload`（按钮使用）。

## 关注点

无。后端和前端构建均无错误通过。所有依赖项（Tasks 3-5 中的 `GetAllActiveStates()`）均已到位且经过验证。
