# Task 4 Report: ResourceDownloadService 接入 Core 引擎 + GetAllActiveStates

## Status: ✅ Complete

## Commits
- `2e15315` feat(resource-download): use Core engine, add pause/resume/cancel, GetAllActiveStates

## Build Summary
- **Build:** Succeeded (0 errors, 7 pre-existing warnings unrelated to this change)
- **File changed:** `src-backend/Qomicex.Launcher.Backend/Services/ResourceDownloadService.cs` (+53/-29)

## Changes Applied
1. **Added `using Qomicex.Downloader;`** and `using DownloadCore = Qomicex.Downloader.Core;` alias
2. **Added to `ResourceDownloadState`:** `CancellationTokenSource? Cts`, `DownloadCore? Engine`
3. **Added to `ResourceDownloadService`:** `ConcurrentDictionary<string, DownloadCore> _engines`
4. **Replaced `DownloadAsync`:** Now uses `DownloadCore` engine with multi-threaded download, progress callback, and `CancellationToken` support
5. **Updated `Cancel`:** Now calls `state.Cts?.Cancel()` to actually cancel the download
6. **Added `Pause`/`Resume`:** Delegate to `engine.Pause()`/`engine.Resume()`, update status accordingly
7. **Added `GetAllActiveStates()`:** Returns downloads with status "queued", "downloading", or "paused"

## Concerns
1. **`autoUpdate: false` — progress won't update:** The brief specifies `new DownloadCore(threadCount: 0, maxRetries: 3, autoUpdate: false)`. With `autoUpdate: false`, the `Progress<DownloadProgress>` callback passed to `DownloadFileAsync` is never invoked by the Core engine (it only reports progress internally when `_autoUpdate` is true). This means `state.Progress`, `state.Speed`, `state.DownloadedBytes`, and `state.TotalBytes` will not update during active download. The download still completes successfully, and `state.Progress = 100` is still set in the try block after `await`. To restore real-time progress, change to `autoUpdate: true` or call `engine.UpdateProgress()` periodically.
2. **Type naming deviation:** The brief uses `Core` as the type name, but this conflicts with the `Qomicex.Core` namespace from the Qomicex.Core project reference. Used `DownloadCore` alias instead. This is a naming difference only — the runtime type is still `Qomicex.Downloader.Core`.

## Report Path
`.superpowers/sdd/task-4-report.md`
