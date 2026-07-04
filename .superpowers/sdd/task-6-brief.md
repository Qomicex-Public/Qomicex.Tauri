### Task 6: InstallTask 并行化

**Files:**
- Modify: `src-backend/Qomicex.Launcher.Backend/Services/InstallTask.cs` (entire flow)

**Interfaces:**
- Consumes: `CoreConfig` (from Task 1), `DownloadManager` (existing)
- Produces: Same public API, same events. Internal flow is the only change.

**Key design decisions:**
- Group A: Download JSON — unchanged, single Core call
- Group B: After JSON downloaded, create 4 DownloadTasks in parallel (libs, assets, mainJar, loaderJar)
- Group C: After loaderJar completes, create loaderLibs DownloadTask → after that, install loader
- Group D: Mod URL resolution + download — starts alongside Group A, runs in parallel
- Progress = weighted average of active sub-stages
- Pause/Cancel already works via `_downloadManager.PauseTask(-1)` / `StopTask(-1)`

- [ ] **Step 1: Add Group B progress tracking helper fields**

Add to `InstallTask` class fields (after line 26):

```csharp
    // Group B parallel progress tracking
    private double _libsProgress;
    private double _assetsProgress;
    private double _mainJarProgress;
    private double _loaderJarProgress;
```

- [ ] **Step 2: Add weighted progress calculation method**

Add after `SetState` method:

```csharp
    private double GroupBWeightedProgress()
    {
        return _libsProgress * 0.35 + _assetsProgress * 0.35 + _mainJarProgress * 0.15 + _loaderJarProgress * 0.15;
    }
```

- [ ] **Step 3: Add helper for running a single download task with progress callback**

Add after `RunDownloadManagerStage`:

```csharp
    private async Task RunDownloadTaskWithCallback(int taskId, Action<double> onProgress, CancellationToken ct)
    {
        var downloadTask = _downloadManager.StartTaskAsync(taskId, ct);
        int lastCompleted = 0;
        while (!downloadTask.IsCompleted && !ct.IsCancellationRequested)
        {
            var infos = _downloadManager.GetAllTaskInfos();
            if (infos.TryGetValue(taskId, out var info))
            {
                onProgress(info.Progress);

                TotalFiles += info.TotalFiles;
                CompletedFiles += info.CompletedFiles;
                FailedFiles += info.FailedFiles;
                Speed = info.Speed;

                if (info.CompletedFiles > lastCompleted)
                {
                    var statuses = _downloadManager.GetTaskFileStatuses(taskId);
                    var lastDone = statuses.LastOrDefault(s =>
                        s.Status == DownloadTask.FileStatus.Completed ||
                        s.Status == DownloadTask.FileStatus.Failed);
                    if (lastDone.Name != null)
                        CurrentFile = lastDone.Name;
                    lastCompleted = info.CompletedFiles;
                }
                OnStateChanged?.Invoke(this);
            }
            try { await Task.Delay(100, ct); } catch (OperationCanceledException) { break; }
        }
        await downloadTask;
    }
```

- [ ] **Step 4: Replace StartAsync with parallel Group flow**

Replace the entire `StartAsync` method (lines 97-310) with:

```csharp
    public async Task StartAsync()
    {
        try
        {
            if (_loader is "forge" or "neoforge")
            {
                FindJavaExecutable();
            }

            // ===== Group A: Download JSON (3%) =====
            SetState("downloading-json", 0, $"{_gameVersion}.json");
            var versionJsonUrl = await ResolveVersionJsonUrl();
            if (string.IsNullOrEmpty(versionJsonUrl))
                throw new Exception($"无法解析版本 {_gameVersion} 的 JSON 下载地址");

            var vanillaVersionDir = Path.Combine(_gameDir, "versions", _gameVersion);
            Directory.CreateDirectory(vanillaVersionDir);
            var versionJsonPath = Path.Combine(vanillaVersionDir, $"{_gameVersion}.json");

            if (!File.Exists(versionJsonPath))
            {
                var core = new Core(threadCount: 4, maxRetries: 3, ignoreRangeProbe200Ok: true);
                await core.DownloadFileAsync(versionJsonUrl, versionJsonPath, null, _cts.Token);
            }
            SetState("downloading-json", 3);
            _cts.Token.ThrowIfCancellationRequested();

            // ===== Scan missing files (parallel) =====
            var resourceHelper = new LocalResourceHelper();
            var missLibs = await resourceHelper.GetMissLibrariesAsync(_gameVersion, _gameDir);
            var missAssets = await resourceHelper.GetMissAssetsAsync(_gameVersion, _gameDir);
            var missMainJar = await resourceHelper.GetMissMainJarAsync(_gameVersion, _gameDir);

            bool needLoaderJar = false;
            string loaderDownloadUrl = string.Empty;
            string installerPath = string.Empty;

            if (!string.IsNullOrEmpty(_loader) && !string.IsNullOrEmpty(_loaderVersion))
            {
                var loaderLower = _loader.ToLowerInvariant();
                if (loaderLower is "forge" or "neoforge")
                {
                    loaderDownloadUrl = await ResolveLoaderDownloadUrl(_loader, _gameVersion, _loaderVersion);
                    var tempDir = Path.Combine(_gameDir, "temp");
                    Directory.CreateDirectory(tempDir);
                    installerPath = Path.Combine(tempDir, $"{_loader}-{_gameVersion}-{_loaderVersion}-installer.jar");
                    needLoaderJar = !File.Exists(installerPath) || new FileInfo(installerPath).Length == 0;
                }
            }

            // ===== Group D: Mod download (starts immediately, runs in parallel) =====
            Task? modTask = null;
            if (_addons != null && _addons.Length > 0)
            {
                modTask = DownloadAddonsParallel();
            }

            // ===== Group B: Parallel download (libs + assets + mainJar + loaderJar) → 3%-53% =====
            SetState("downloading", 3);
            _libsProgress = missLibs.Count > 0 ? 0 : 100;
            _assetsProgress = missAssets.Count > 0 ? 0 : 100;
            _mainJarProgress = (missMainJar?.Path != null) ? 0 : 100;
            _loaderJarProgress = needLoaderJar ? 0 : 100;

            var groupBTasks = new List<Task>();

            if (missLibs.Count > 0)
            {
                var tid = _downloadManager.CreateTask(maxConcurrentFiles: _downloadThreads, maxRetries: 3, ignoreRangeProbe200Ok: true);
                foreach (var f in missLibs)
                    _downloadManager.AddFileToTask(tid, f.Url, f.Path);
                groupBTasks.Add(RunDownloadTaskWithCallback(tid, p => _libsProgress = p, _cts.Token));
            }

            if (missAssets.Count > 0)
            {
                var tid = _downloadManager.CreateTask(maxConcurrentFiles: _downloadThreads, maxRetries: 3, ignoreRangeProbe200Ok: true);
                foreach (var f in missAssets)
                    _downloadManager.AddFileToTask(tid, f.Url, f.Path);
                groupBTasks.Add(RunDownloadTaskWithCallback(tid, p => _assetsProgress = p, _cts.Token));
            }

            if (missMainJar != null && !string.IsNullOrEmpty(missMainJar.Path))
            {
                var tid = _downloadManager.CreateTask(maxConcurrentFiles: 1, maxRetries: 3, ignoreRangeProbe200Ok: true);
                _downloadManager.AddFileToTask(tid, missMainJar.Url, missMainJar.Path);
                groupBTasks.Add(RunDownloadTaskWithCallback(tid, p => _mainJarProgress = p, _cts.Token));
            }

            if (needLoaderJar)
            {
                var tid = _downloadManager.CreateTask(maxConcurrentFiles: 1, maxRetries: 3, ignoreRangeProbe200Ok: true);
                _downloadManager.AddFileToTask(tid, loaderDownloadUrl, installerPath);
                groupBTasks.Add(RunDownloadTaskWithCallback(tid, p => _loaderJarProgress = p, _cts.Token));
            }

            // Poll weighted progress while Group B runs
            var groupBPollCts = CancellationTokenSource.CreateLinkedTokenSource(_cts.Token);
            _ = Task.Run(async () =>
            {
                while (!groupBPollCts.IsCancellationRequested)
                {
                    Progress = 3 + GroupBWeightedProgress() / 100.0 * 50;
                    OnStateChanged?.Invoke(this);
                    try { await Task.Delay(100, groupBPollCts.Token); } catch { break; }
                }
            });

            await Task.WhenAll(groupBTasks);
            groupBPollCts.Cancel();

            // Check for failures in Group B
            var allInfos = _downloadManager.GetAllTaskInfos();
            foreach (var (_, info) in allInfos)
            {
                if (info.FailedFiles > 0)
                    throw new Exception($"下载阶段失败: {info.FailedFiles} 个文件");
            }

            SetState("downloading", 53);
            _cts.Token.ThrowIfCancellationRequested();

            // ===== Loader handling (53%-85%) =====
            if (!string.IsNullOrEmpty(_loader) && !string.IsNullOrEmpty(_loaderVersion))
            {
                await HandleLoaderInstall(
                    resourceHelper, installerPath, needLoaderJar);
            }
            else
            {
                SetState("completed", 85);
            }
            _cts.Token.ThrowIfCancellationRequested();

            // ===== Wait for Group D (mods) =====
            if (modTask != null)
            {
                SetState("downloading-addons", 85, "附加内容...");
                await modTask;
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
            Trace.WriteLine($"[InstallTask] 安装失败: {ex}");
        }
        finally
        {
            _downloadManager.StopTask(-1);
        }
    }
```

- [ ] **Step 5: Add HandleLoaderInstall helper**

Add the new helper method that handles the loader sub-flow (Group C → install):

```csharp
    private async Task HandleLoaderInstall(
        LocalResourceHelper resourceHelper, string installerPath, bool needLoaderJar)
    {
        var loaderLower = _loader!.ToLowerInvariant();
        bool isForgeLike = loaderLower is "forge" or "neoforge";

        if (isForgeLike)
        {
            // Group C: Download loader libs BEFORE install (to speed up)
            SetState("downloading-loader-libs", 53, "正在补全加载器库文件...");
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
            {
                var tid = _downloadManager.CreateTask(maxConcurrentFiles: _downloadThreads, maxRetries: 3, ignoreRangeProbe200Ok: true);
                foreach (var f in remainingLibs)
                    _downloadManager.AddFileToTask(tid, f.Url, f.Path);
                double loaderLibProgress = 0;
                await RunDownloadTaskWithCallback(tid, p =>
                {
                    loaderLibProgress = p;
                    Progress = 53 + loaderLibProgress / 100.0 * 15;
                }, _cts.Token);
            }
            SetState("downloading-loader-libs", 68);
            _cts.Token.ThrowIfCancellationRequested();

            // Install loader (68%-80%)
            SetState("installing-loader", 68, $"{_loader} {_loaderVersion}");
            var httpClient = _httpClientFactory.CreateClient();
            await InstallModLoader(httpClient, _versionId, installerPath);
            SetState("installing-loader", 80);

            // Merged main jar (80%-85%)
            SetState("downloading-mainjar", 80, $"{_versionId}.jar");
            var loaderMainJar = await resourceHelper.GetMissMainJarAsync(_versionId, _gameDir);
            if (loaderMainJar != null && !string.IsNullOrEmpty(loaderMainJar.Path))
            {
                var tid = _downloadManager.CreateTask(maxConcurrentFiles: 1, maxRetries: 3, ignoreRangeProbe200Ok: true);
                _downloadManager.AddFileToTask(tid, loaderMainJar.Url, loaderMainJar.Path);
                double mainJarProgress = 0;
                await RunDownloadTaskWithCallback(tid, p =>
                {
                    mainJarProgress = p;
                    Progress = 80 + mainJarProgress / 100.0 * 5;
                }, _cts.Token);
            }
            SetState("downloading-mainjar", 85);

            TryDelete(installerPath);
        }
        else
        {
            // Fabric/Quilt/LiteLoader: install writes merged JSON, then scan + download remaining libs
            SetState("installing-loader", 53, $"{_loader} {_loaderVersion}");
            var loaderJsonPath = Path.Combine(_gameDir, "versions", _versionId, $"{_versionId}.json");
            if (!File.Exists(loaderJsonPath))
            {
                var httpClient = _httpClientFactory.CreateClient();
                await InstallModLoader(httpClient, _versionId);
            }
            SetState("installing-loader", 60);

            // Download loader libs (60%-75%)
            SetState("downloading-loader-libs", 60, "正在补全加载器库文件...");
            var loaderLibs = await resourceHelper.GetMissLibrariesAsync(_versionId, _gameDir);
            if (loaderLibs.Count > 0)
            {
                var tid = _downloadManager.CreateTask(maxConcurrentFiles: _downloadThreads, maxRetries: 3, ignoreRangeProbe200Ok: true);
                foreach (var f in loaderLibs)
                    _downloadManager.AddFileToTask(tid, f.Url, f.Path);
                double libProgress = 0;
                await RunDownloadTaskWithCallback(tid, p =>
                {
                    libProgress = p;
                    Progress = 60 + libProgress / 100.0 * 15;
                }, _cts.Token);
            }
            SetState("downloading-loader-libs", 75);

            // Merged main jar (75%-85%)
            SetState("downloading-mainjar", 75, $"{_versionId}.jar");
            var loaderMainJar = await resourceHelper.GetMissMainJarAsync(_versionId, _gameDir);
            if (loaderMainJar != null && !string.IsNullOrEmpty(loaderMainJar.Path))
            {
                var tid = _downloadManager.CreateTask(maxConcurrentFiles: 1, maxRetries: 3, ignoreRangeProbe200Ok: true);
                _downloadManager.AddFileToTask(tid, loaderMainJar.Url, loaderMainJar.Path);
                double mainJarProgress = 0;
                await RunDownloadTaskWithCallback(tid, p =>
                {
                    mainJarProgress = p;
                    Progress = 75 + mainJarProgress / 100.0 * 10;
                }, _cts.Token);
            }
            SetState("downloading-mainjar", 85);
        }
    }
```

- [ ] **Step 6: Add DownloadAddonsParallel helper with parallel URL resolution**

```csharp
    private async Task DownloadAddonsParallel()
    {
        var httpClient = _httpClientFactory.CreateClient();
        var modsDir = Path.Combine(_effectiveGameDir, "mods");
        Directory.CreateDirectory(modsDir);

        var addonTid = _downloadManager.CreateTask(maxConcurrentFiles: 1, maxRetries: 3, ignoreRangeProbe200Ok: true);

        // Parallel URL resolution with SemaphoreSlim
        var semaphore = new SemaphoreSlim(12);
        var resolveTasks = _addons!.Select(async addonId =>
        {
            await semaphore.WaitAsync(_cts.Token);
            try
            {
                _cts.Token.ThrowIfCancellationRequested();
                var (url, filename) = await ResolveAddonDownload(httpClient, addonId, _gameVersion);
                if (url != null && filename != null)
                {
                    lock (addonTid)
                    {
                        _downloadManager.AddFileToTask(addonTid, url, Path.Combine(modsDir, filename));
                    }
                }
            }
            finally
            {
                semaphore.Release();
            }
        });

        await Task.WhenAll(resolveTasks);

        var infos = _downloadManager.GetAllTaskInfos();
        if (infos.TryGetValue(addonTid, out var info) && info.TotalFiles > 0)
        {
            double progress = 0;
            await RunDownloadTaskWithCallback(addonTid, p =>
            {
                progress = p;
                Progress = 85 + progress / 100.0 * 15;
            }, _cts.Token);
        }
    }
```

- [ ] **Step 7: Remove unused old methods**

Remove: `RunDownloadStage` (lines 312-319) and `RunDownloadManagerStage` (lines 321-361) — these are replaced by `RunDownloadTaskWithCallback`.

- [ ] **Step 8: Remove unused RunDownloadStage call in StartAsync fix paths**

Verify no other code references `RunDownloadStage` or `RunDownloadManagerStage`. Search with:
```
rg "RunDownloadStage|RunDownloadManagerStage" src-backend/
```
Expected: Only in InstallTask.cs (now removed).

- [ ] **Step 9: Verify build**

Run: `dotnet build src-backend/Qomicex.Launcher.Backend/Qomicex.Launcher.Backend.csproj`
Expected: Build succeeded.

- [ ] **Step 10: Commit**

```bash
git add src-backend/Qomicex.Launcher.Backend/Services/InstallTask.cs
git commit -m "feat(install): parallel Group B downloads, parallel mod resolution"
```

---

