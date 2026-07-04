### Task 4: ResourceDownloadService 接入 Core 引擎 + GetAllActiveStates

**Files:**
- Modify: `src-backend/Qomicex.Launcher.Backend/Services/ResourceDownloadService.cs`

**Interfaces:**
- Consumes: `Qomicex.Downloader.Core`, `Qomicex.Downloader.CoreConfig`
- Produces: `PauseDownload(id)`, `ResumeDownload(id)`, `GetAllActiveStates()`

- [ ] **Step 1: Add using and fields for pause/resume/cancel support**

Add `using Qomicex.Downloader;` at the top of `ResourceDownloadService.cs` after the existing `using System.Collections.Concurrent;`.

Add fields to `ResourceDownloadState` class (after line 17):
```csharp
    public CancellationTokenSource? Cts { get; set; }
    public Core? Engine { get; set; }
```

Add to `ResourceDownloadService` class fields (after line 22):
```csharp
    private readonly ConcurrentDictionary<string, Core> _engines = new();
```

- [ ] **Step 2: Replace DownloadAsync with Core-based implementation**

Replace the entire `DownloadAsync` method (lines 73-125) with:

```csharp
    private async Task DownloadAsync(string taskId, ResourceDownloadState state)
    {
        state.Status = "downloading";
        var filePath = Path.Combine(state.TargetPath, state.FileName);
        state.Cts = new CancellationTokenSource();

        try
        {
            var core = new Core(threadCount: 0, maxRetries: 3, autoUpdate: false);
            state.Engine = core;
            _engines[taskId] = core;

            var progress = new Progress<DownloadProgress>(p =>
            {
                state.DownloadedBytes = p.DownloadedBytes;
                state.TotalBytes = p.TotalBytes;
                state.Speed = p.Speed;
                state.Progress = p.Progress;
            });

            await core.DownloadFileAsync(state.Url, filePath, progress, state.Cts.Token);

            state.Progress = 100;
            state.Speed = 0;
            state.Status = "completed";
        }
        catch (OperationCanceledException)
        {
            state.Status = "cancelled";
        }
        catch (Exception ex)
        {
            state.Status = "failed";
            state.Error = ex.Message;
        }
        finally
        {
            _engines.TryRemove(taskId, out _);
        }
    }
```

- [ ] **Step 3: Update Cancel method to cancel CancellationTokenSource**

Replace the `Cancel` method (lines 53-61) with:

```csharp
    public bool Cancel(string taskId)
    {
        if (_downloads.TryGetValue(taskId, out var state) && state.Status is "queued" or "downloading")
        {
            state.Cts?.Cancel();
            state.Status = "cancelled";
            return true;
        }
        return false;
    }
```

- [ ] **Step 4: Add Pause, Resume methods**

Add after `Cancel` method:

```csharp
    public bool Pause(string taskId)
    {
        if (_engines.TryGetValue(taskId, out var engine))
        {
            if (_downloads.TryGetValue(taskId, out var state))
                state.Status = "paused";
            engine.Pause();
            return true;
        }
        return false;
    }

    public bool Resume(string taskId)
    {
        if (_engines.TryGetValue(taskId, out var engine))
        {
            if (_downloads.TryGetValue(taskId, out var state))
                state.Status = "downloading";
            engine.Resume();
            return true;
        }
        return false;
    }
```

- [ ] **Step 5: Add GetAllActiveStates method**

Add after `GetAll` method:

```csharp
    public List<ResourceDownloadState> GetAllActiveStates()
    {
        return _downloads.Values
            .Where(s => s.Status is "queued" or "downloading" or "paused")
            .ToList();
    }
```

- [ ] **Step 6: Verify build**

Run: `dotnet build src-backend/Qomicex.Launcher.Backend/Qomicex.Launcher.Backend.csproj`
Expected: Build succeeded.

- [ ] **Step 7: Commit**

```bash
git add src-backend/Qomicex.Launcher.Backend/Services/ResourceDownloadService.cs
git commit -m "feat(resource-download): use Core engine, add pause/resume/cancel, GetAllActiveStates"
```

---

