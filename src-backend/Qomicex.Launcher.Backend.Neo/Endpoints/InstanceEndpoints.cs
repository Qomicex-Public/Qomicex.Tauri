using Microsoft.AspNetCore.Http.HttpResults;
using Qomicex.Core.AOT.Builder;
using Qomicex.Core.AOT.Core;
using Qomicex.Launcher.Backend.Neo.JsonContext;
using Qomicex.Launcher.Backend.Neo.Models;
using Qomicex.Launcher.Backend.Neo.Services;
using Qomicex.Downloader;

namespace Qomicex.Launcher.Backend.Neo.Endpoints;

public static class InstanceEndpoints
{
    public static void MapInstanceEndpoints(this WebApplication app)
    {
        var group = app.MapGroup("/api/instance");

        group.MapGet("/", (InstanceService instances) =>
        {
            return Results.Json(instances.GetAll(), ApiJsonContext.Default.ListGameInstance);
        });

        group.MapGet("/default", (InstanceService instances) =>
        {
            var id = instances.GetDefaultId();
            if (id is null) return Results.NoContent();
            var inst = instances.GetById(id);
            return inst is not null
                ? Results.Json(inst, ApiJsonContext.Default.GameInstance)
                : Results.NoContent();
        });

        group.MapPut("/{id}/default", (string id, InstanceService instances) =>
        {
            instances.SetDefaultId(id);
            var inst = instances.GetById(id);
            return inst is not null
                ? Results.Json(inst, ApiJsonContext.Default.GameInstance)
                : Results.NoContent();
        });

        group.MapDelete("/{id}/default", (string id, InstanceService instances) =>
        {
            instances.ClearDefaultId();
            return Results.NoContent();
        });

        group.MapPost("/", (CreateInstanceRequest req, InstanceService instances) =>
        {
            var instance = new GameInstance
            {
                Name = req.Name,
                GameVersion = req.GameVersion,
                Loader = req.Loader,
                LoaderVersion = req.LoaderVersion,
                JavaPath = req.JavaPath,
                MaxMemory = req.MaxMemory,
                GameDir = req.GameDir,
            };
            var created = instances.Create(instance);
            return Results.Created($"/api/instance/{created.Id}", created);
        });

        group.MapGet("/{id}", (string id, InstanceService instances) =>
        {
            var instance = instances.GetById(id);
            return instance is not null
                ? Results.Json(instance, ApiJsonContext.Default.GameInstance)
                : Results.NotFound();
        });

        group.MapPut("/{id}", (string id, UpdateInstanceRequest req, InstanceService instances) =>
        {
            var existing = instances.GetById(id);
            if (existing is null)
                throw ApiException.NotFound($"Instance {id} not found");

            if (req.Name is not null) existing.Name = req.Name;
            if (req.GameVersion is not null) existing.GameVersion = req.GameVersion;
            if (req.Loader is not null) existing.Loader = req.Loader;
            if (req.LoaderVersion is not null) existing.LoaderVersion = req.LoaderVersion;
            if (req.JavaPath is not null) existing.JavaPath = req.JavaPath;
            if (req.MaxMemory.HasValue) existing.MaxMemory = req.MaxMemory.Value;
            if (req.JvmArgs is not null) existing.JvmArgs = req.JvmArgs;
            if (req.IsHidden.HasValue) existing.IsHidden = req.IsHidden.Value;
            if (req.VersionIsolation.HasValue) existing.VersionIsolation = req.VersionIsolation.Value;

            var updated = instances.Update(id, existing);
            return Results.Json(updated, ApiJsonContext.Default.GameInstance);
        });

        group.MapDelete("/{id}", (string id, InstanceService instances) =>
        {
            var deleted = instances.Delete(id);
            if (deleted is not null)
                return Results.Json(new MessageResponse($"Instance {id} deleted"), ApiJsonContext.Default.MessageResponse);
            return Results.NotFound();
        });

        group.MapPost("/{id}/launch", (string id, InstanceService instances, DefaultGameCore core, LaunchTracker tracker) =>
        {
            var instance = instances.GetById(id);
            if (instance is null)
                throw ApiException.NotFound($"Instance {id} not found");

            var cts = tracker.GetOrCreateCts(id);

            Task.Run(async () =>
            {
                try
                {
                    var versionId = !string.IsNullOrEmpty(instance.VersionDirName)
                        ? instance.VersionDirName : instance.Name;

                    if (!instance.SkipIntegrityCheck)
                    {
                        cts.Token.ThrowIfCancellationRequested();
                        tracker.SetProgress(id, new LaunchProgressState
                        {
                            Stage = "checking", Message = "正在检查文件完整性...", Progress = 5
                        });

                        var versionJsonPath = Path.Combine(instance.GameDir, "versions", versionId, $"{versionId}.json");
                        if (!File.Exists(versionJsonPath))
                            throw new FileNotFoundException($"版本 JSON 不存在: {versionJsonPath}");

                        var jsonContent = await File.ReadAllTextAsync(versionJsonPath, cts.Token);
                        var missFiles = FilterMissFiles(await core.Locator.GetMissFilesAsync(jsonContent));
                        missFiles = RemapPaths(missFiles, core.GameRoot, instance.GameDir);

                        if (missFiles.Count > 0)
                        {
                            cts.Token.ThrowIfCancellationRequested();
                            tracker.SetProgress(id, new LaunchProgressState
                            {
                                Stage = "repairing",
                                Message = $"正在补全 {missFiles.Count} 个缺失文件...",
                                Progress = 10,
                                MissingFiles = missFiles.Select(f => f.Name).ToList(),
                                TotalFiles = missFiles.Count
                            });

                            using var dm = new DownloadManager(intervalMs: 500);
                            var tid = dm.CreateTask(maxConcurrentFiles: 4, maxRetries: 3);
                            foreach (var f in missFiles)
                                dm.AddFileToTask(tid, f.Url, f.Path);
                            var repairDownload = dm.StartTaskAsync(tid, cts.Token);

                            while (!cts.Token.IsCancellationRequested)
                            {
                                var infos = dm.GetAllTaskInfos();
                                if (infos.TryGetValue(tid, out var info))
                                {
                                    var statuses = dm.GetTaskFileStatuses(tid);
                                    var downloading = statuses.FirstOrDefault(s => s.Status == DownloadTask.FileStatus.Downloading);
                                    string currentFileName = downloading.Name ?? "";

                                    tracker.SetProgress(id, new LaunchProgressState
                                    {
                                        Stage = "repairing",
                                        Message = $"正在补全: {currentFileName} ({Math.Round(info.Progress)}%)",
                                        Progress = 10 + info.Progress * 0.20,
                                        CurrentFile = currentFileName,
                                        TotalFiles = missFiles.Count,
                                        CompletedFiles = info.CompletedFiles,
                                        MissingFiles = missFiles.Select(f => f.Name).ToList()
                                    });

                                    if (info.CompletedFiles + info.FailedFiles + info.CanceledFiles >= info.TotalFiles)
                                    {
                                        if (info.FailedFiles > 0)
                                            throw new Exception("文件补全失败");
                                        break;
                                    }
                                }
                                await Task.Delay(500, cts.Token);
                            }
                            await repairDownload;
                        }
                    }

                    cts.Token.ThrowIfCancellationRequested();
                    tracker.SetProgress(id, new LaunchProgressState
                    {
                        Stage = "preparing", Message = "正在准备环境...", Progress = 30
                    });

                    var launchOptions = new LaunchOptions
                    {
                        Version = instance.Name,
                        VersionIsolation = instance.VersionIsolation ?? false,
                        GameRoot = instance.GameDir,
                        JavaOptions = new JavaOptions
                        {
                            JavaPath = instance.JavaPath ?? "java",
                            MaxMemoryMB = instance.MaxMemory,
                            ExtraJvmArgs = string.IsNullOrEmpty(instance.JvmArgs)
                                ? null
                                : instance.JvmArgs.Split(' ', StringSplitOptions.RemoveEmptyEntries),
                        },
                    };

                    tracker.SetProgress(id, new LaunchProgressState
                    {
                        Stage = "launching", Message = "正在启动游戏...", Progress = 50
                    });

                    var result = await core.Launch.LaunchAsync(launchOptions);

                    if (result.Success)
                    {
                        tracker.Track(id, result.ProcessId);
                        tracker.SetProgress(id, new LaunchProgressState
                        {
                            Stage = "running",
                            Message = "游戏运行中",
                            Progress = 100,
                            ProcessId = result.ProcessId,
                            IsRunning = true
                        });
                    }
                    else
                    {
                        tracker.SetProgress(id, new LaunchProgressState
                        {
                            Stage = "failed",
                            Message = "启动失败",
                            Error = result.Exception?.Message ?? result.Message,
                            Progress = 100
                        });
                    }
                }
                catch (OperationCanceledException)
                {
                    tracker.SetProgress(id, new LaunchProgressState
                    {
                        Stage = "cancelled", Message = "已取消", Progress = 0
                    });
                }
                catch (Exception ex)
                {
                    tracker.SetProgress(id, new LaunchProgressState
                    {
                        Stage = "failed", Message = "启动失败", Error = ex.Message, Progress = 0
                    });
                }
                finally
                {
                    if (tracker.GetProgress(id)?.IsRunning != true)
                        tracker.CancelAndRemove(id);
                }
            });

            return Results.Json(new MessageResponse($"Launch started for {id}"), ApiJsonContext.Default.MessageResponse);
        });

        group.MapGet("/{id}/launch/progress", (string id, LaunchTracker tracker) =>
        {
            var progress = tracker.GetProgress(id);
            if (progress is null)
            {
                var procState = tracker.GetState(id);
                if (procState is null)
                    return Results.Json(new LaunchProgressDto(
                        Stage: "completed", Message: "进程已结束", Progress: 100, IsRunning: false
                    ), ApiJsonContext.Default.LaunchProgressDto);

                return Results.Json(new LaunchProgressDto(
                    Stage: "running", Message: "游戏运行中", Progress: 100,
                    IsRunning: !procState.HasExited, ProcessId: procState.ProcessId
                ), ApiJsonContext.Default.LaunchProgressDto);
            }

            return Results.Json(new LaunchProgressDto(
                Stage: progress.Stage, Message: progress.Message, Progress: progress.Progress,
                IsRunning: progress.IsRunning, ProcessId: progress.ProcessId,
                Error: progress.Error, MissingFiles: progress.MissingFiles,
                CurrentFile: progress.CurrentFile, TotalFiles: progress.TotalFiles,
                CompletedFiles: progress.CompletedFiles
            ), ApiJsonContext.Default.LaunchProgressDto);
        });

        group.MapPost("/{id}/launch/cancel", (string id, LaunchTracker tracker) =>
        {
            tracker.Stop(id);
            return Results.Json(new MessageResponse($"Launch cancelled for {id}"), ApiJsonContext.Default.MessageResponse);
        });

        group.MapPost("/{id}/install", (string id, InstallerRequest req, InstanceService instances, DefaultGameCore core, InstallTracker tracker) =>
        {
            var instance = instances.GetById(id);
            if (instance is null)
                throw ApiException.NotFound($"Instance {id} not found");

            var threads = req.DownloadThreads ?? 64;
            var sourceId = req.DownloadSourceId ?? 0;

            tracker.Start(id, instance.GameVersion, instance.GameDir,
                req.Loader, req.LoaderVersion, req.Addons, threads,
                req.VersionIsolation ?? false, sourceId, core);

            return Results.Json(new MessageResponse($"Install started for {id}"), ApiJsonContext.Default.MessageResponse);
        });

        group.MapGet("/{id}/install/progress", (string id, InstallTracker tracker) =>
        {
            var state = tracker.GetState(id);
            if (state is null)
                return Results.Json(new InstallProgressResponse(id, "not-started", 0), ApiJsonContext.Default.InstallProgressResponse);

            return Results.Json(state.ToResponse(id), ApiJsonContext.Default.InstallProgressResponse);
        });

        group.MapPost("/{id}/install/cancel", (string id, InstallTracker tracker) =>
        {
            tracker.Cancel(id);
            return Results.Json(new MessageResponse($"Install cancelled for {id}"), ApiJsonContext.Default.MessageResponse);
        });

        group.MapGet("/loaders", async (DefaultGameCore core, string gameVersion, string? type) =>
        {
            var loaderType = type is not null ? MapLoaderType(type) : null;
            var loaders = await core.InstallerProvider.GetAvailableModLoaders(
                gameVersion, loaderType ?? Qomicex.Core.AOT.Public.Models.ModLoaderType.All);
            return Results.Json(loaders);
        });
    }

    private static Qomicex.Core.AOT.Public.Models.ModLoaderType? MapLoaderType(string loader) => loader.ToLowerInvariant() switch
    {
        "fabric" => Qomicex.Core.AOT.Public.Models.ModLoaderType.Fabic,
        "quilt" => Qomicex.Core.AOT.Public.Models.ModLoaderType.Quilt,
        "forge" => Qomicex.Core.AOT.Public.Models.ModLoaderType.Forge,
        "neoforge" => Qomicex.Core.AOT.Public.Models.ModLoaderType.NeoForge,
        "liteloader" => Qomicex.Core.AOT.Public.Models.ModLoaderType.LiteLoader,
        "optifine" => Qomicex.Core.AOT.Public.Models.ModLoaderType.OptiFine,
        _ => null
    };

    private static List<Qomicex.Core.AOT.Public.Models.MissFileInfo> FilterMissFiles(
        List<Qomicex.Core.AOT.Public.Models.MissFileInfo> raw)
    {
        var comparer = OperatingSystem.IsWindows()
            ? StringComparer.OrdinalIgnoreCase
            : StringComparer.Ordinal;
        return raw
            .Where(f => !string.IsNullOrEmpty(f.Path) && !string.IsNullOrEmpty(f.Url))
            .DistinctBy(f => f.Path, comparer)
            .ToList();
    }

    private static List<Qomicex.Core.AOT.Public.Models.MissFileInfo> RemapPaths(
        List<Qomicex.Core.AOT.Public.Models.MissFileInfo> files, string fromRoot, string toRoot)
    {
        var absFrom = Path.GetFullPath(fromRoot);
        var absTo = Path.GetFullPath(toRoot);
        if (string.Equals(absFrom, absTo, OperatingSystem.IsWindows() ? StringComparison.OrdinalIgnoreCase : StringComparison.Ordinal))
            return files;

        return files.Select(f =>
        {
            var rel = Path.GetRelativePath(absFrom, f.Path);
            return new Qomicex.Core.AOT.Public.Models.MissFileInfo(f.Name, f.Url, f.Sha1, Path.Combine(absTo, rel));
        }).ToList();
    }
}
