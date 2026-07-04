### Task 7: SSE 统一进度推送 + 前端轮询改 SSE

**Files:**
- Create: `src-backend/Qomicex.Launcher.Backend/Controllers/ProgressSseController.cs`
- Create: `src/hooks/useDownloadSSE.ts`
- Modify: `src/pages/DownloadCenter.tsx` (replace polling with SSE subscription)

**Interfaces:**
- Consumes: `InstanceInstallService.GetAllActiveStates()`, `JavaDownloadService.GetAllActiveStates()`, `ResourceDownloadService.GetAllActiveStates()` (from Tasks 3-5)
- Produces: `GET /api/progress/stream` SSE endpoint
- Frontend: `useDownloadSSE()` hook → `ProgressPayload | null`

- [ ] **Step 1: Create ProgressSseController.cs**

```csharp
using System.Text.Json;
using Microsoft.AspNetCore.Mvc;
using Qomicex.Launcher.Backend.Services;

namespace Qomicex.Launcher.Backend.Controllers;

[ApiController]
[Route("api/progress")]
public class ProgressSseController : ControllerBase
{
    [HttpGet("stream")]
    public async Task StreamProgress(
        [FromServices] InstanceInstallService installService,
        [FromServices] JavaDownloadService javaService,
        [FromServices] ResourceDownloadService resourceService,
        CancellationToken ct)
    {
        Response.Headers.ContentType = "text/event-stream";
        Response.Headers.CacheControl = "no-cache";
        Response.Headers.Connection = "keep-alive";

        while (!ct.IsCancellationRequested)
        {
            await Task.Delay(300, ct);

            var installs = installService.GetAllActiveStates();
            var javaDownloads = javaService.GetAllActiveStates();
            var resources = resourceService.GetAllActiveStates();

            double totalBytes = 0;
            double totalDownloaded = 0;
            double totalSpeed = 0;

            foreach (var i in installs) { totalSpeed += i.Speed; }
            foreach (var j in javaDownloads) { totalSpeed += j.Speed; }
            foreach (var r in resources) { totalSpeed += r.Speed; }

            var payload = new
            {
                type = "progress",
                installs,
                javaDownloads,
                resources,
                summary = new
                {
                    activeCount = installs.Count + javaDownloads.Count + resources.Count,
                    totalSpeed
                }
            };

            var json = JsonSerializer.Serialize(payload, new JsonSerializerOptions
            {
                PropertyNamingPolicy = JsonNamingPolicy.CamelCase
            });
            await Response.WriteAsync($"data: {json}\n\n", ct);
            await Response.Body.FlushAsync(ct);
        }
    }
}
```

- [ ] **Step 2: Verify backend build**

Run: `dotnet build src-backend/Qomicex.Launcher.Backend/Qomicex.Launcher.Backend.csproj`
Expected: Build succeeded.

- [ ] **Step 3: Create useDownloadSSE.ts hook**

```typescript
import { useEffect, useState } from 'react'

export interface InstallState {
  instanceId: string
  stage: string
  progress: number
  error: string | null
  totalFiles: number
  completedFiles: number
  failedFiles: number
  currentFile: string
  speed: number
  isPaused: boolean
}

export interface JavaDownloadState {
  taskId: string
  status: string
  progress: number
  speed: number
  fileName: string
  targetDir: string
  error: string | null
}

export interface ResourceDownloadState {
  taskId: string
  url: string
  targetPath: string
  fileName: string
  progress: number
  speed: number
  status: string
  error: string | null
  downloadedBytes: number
  totalBytes: number
}

export interface ProgressPayload {
  type: 'progress'
  installs: InstallState[]
  javaDownloads: JavaDownloadState[]
  resources: ResourceDownloadState[]
  summary: {
    activeCount: number
    totalSpeed: number
  }
}

export function useDownloadSSE() {
  const [data, setData] = useState<ProgressPayload | null>(null)

  useEffect(() => {
    const es = new EventSource('/api/progress/stream')
    es.onmessage = (e) => {
      try {
        const parsed = JSON.parse(e.data) as ProgressPayload
        setData(parsed)
      } catch { /* ignore malformed */ }
    }
    es.onerror = () => {
      // browser will auto-reconnect
    }
    return () => es.close()
  }, [])

  return data
}
```

- [ ] **Step 4: Modify DownloadCenter.tsx — replace polling with SSE**

Remove the existing polling `useEffect` blocks (lines 93-203) and replace with SSE subscription.

Remove imports (only the polling-related ones — keep action APIs used by buttons):
```typescript
// REMOVE these (polling):
import { getInstallProgress } from '../api/instance.ts'
import { getResourceDownloadProgress } from '../api/resource-download.ts'
import { getJavaDownloadProgress } from '../api/java.ts'
import { ApiError } from '../api/client.ts'

// KEEP these (used by pause/resume/cancel buttons):
// import { pauseInstall, resumeInstall, cancelInstall } from '../api/instance.ts'
// import { cancelResourceDownload, startResourceDownload } from '../api/resource-download.ts'
// import { cancelJavaDownload, pauseJavaDownload, resumeJavaDownload } from '../api/java.ts'
```

Replace lines 93-203 (the two `useEffect` polling blocks + the `applyJavaProgress` function) with a single effect:

```typescript
  useEffect(() => {
    if (!sseData) return

    const ts = getTasks()
    for (const task of ts) {
      if (task.status !== 'queued' && task.status !== 'downloading' && task.status !== 'paused') continue

      if (task.type === 'java' && task.taskId) {
        const match = sseData.javaDownloads.find((j) => j.taskId === task.taskId)
        if (match) {
          let newStatus: DownloadTask['status'] = 'downloading'
          if (match.status === 'completed') newStatus = 'completed'
          else if (match.status === 'cancelled') newStatus = 'cancelled'
          else if (match.status === 'failed') newStatus = 'failed'
          else if (match.status === 'paused') newStatus = 'paused'
          else if (match.status === 'queued' || match.status === 'resolving') newStatus = 'queued'
          updateTask(task.id, {
            status: newStatus,
            stage: match.status,
            progress: Math.round(match.progress),
            speed: match.speed,
            currentFile: match.fileName || undefined,
            error: match.error || undefined,
            completedAt: newStatus === 'completed' ? new Date().toISOString() : undefined,
          })
        }
        continue
      }

      if (task.type === 'file' && task.taskId) {
        const match = sseData.resources.find((r) => r.taskId === task.taskId)
        if (match) {
          let newStatus: DownloadTask['status'] = 'downloading'
          if (match.status === 'completed') newStatus = 'completed'
          else if (match.status === 'cancelled') newStatus = 'cancelled'
          else if (match.status === 'failed') newStatus = 'failed'
          updateTask(task.id, {
            status: newStatus,
            progress: Math.round(match.progress),
            speed: match.speed,
            error: match.error || undefined,
            currentFile: match.fileName || undefined,
            completedAt: newStatus === 'completed' ? new Date().toISOString() : undefined,
          })
        }
        continue
      }

      if (task.instanceId) {
        const match = sseData.installs.find((i) => i.instanceId === task.instanceId)
        if (match) {
          let newStatus: DownloadTask['status'] = 'downloading'
          if (match.stage === 'completed') newStatus = 'completed'
          else if (match.stage === 'cancelled') newStatus = 'cancelled'
          else if (match.stage === 'failed') newStatus = 'failed'
          else if (match.isPaused) newStatus = 'paused'
          updateTask(task.id, {
            status: newStatus,
            stage: match.stage,
            progress: Math.round(match.progress),
            speed: match.speed,
            currentFile: match.currentFile || undefined,
            totalFiles: match.totalFiles || undefined,
            completedFiles: match.completedFiles || undefined,
            error: match.error || undefined,
            completedAt: newStatus === 'completed' ? new Date().toISOString() : undefined,
          })
        }
      }
    }
  }, [sseData])
```

Remove the `pollingRef` field and the `applyJavaProgress` function (lines 74-91, 93, 95-203).

- [ ] **Step 6: Verify TypeScript compilation**

Run: `npx tsc --noEmit`
Expected: No errors (may have unused import warnings for removed polling APIs — clean those up).

- [ ] **Step 7: Verify Vite build**

Run: `npm run build`
Expected: Build succeeded.

- [ ] **Step 8: Commit**

```bash
git add src-backend/Qomicex.Launcher.Backend/Controllers/ProgressSseController.cs src/hooks/useDownloadSSE.ts src/pages/DownloadCenter.tsx
git commit -m "feat(progress): SSE unified progress streaming, replace frontend polling"
```

