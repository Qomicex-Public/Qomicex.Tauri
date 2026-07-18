using System.Text.Json.Nodes;
using Microsoft.AspNetCore.Http.HttpResults;
using Qomicex.Core.AOT.Builder;
using Qomicex.Core.AOT.Core;
using Qomicex.Core.AOT.Interfaces;
using Qomicex.Core.AOT.Models.VersionMetadata;
using Qomicex.Core.AOT.Public.Models;
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

        group.MapPost("/{id}/launch", async (string id, InstanceService instances, DefaultGameCore core, LaunchTracker tracker, AccountService accountService, JavaRuntimeStore store) =>
        {
            var instance = instances.GetById(id);
            if (instance is null)
                throw ApiException.NotFound($"Instance {id} not found");

            var cts = tracker.GetOrCreateCts(id);

            tracker.SetProgress(id, new LaunchProgressState
            {
                Stage = "starting", Message = "准备启动...", Progress = 0
            });

            var authOptions = await ResolveAuthOptions(accountService, core.Auth);

            _ = Task.Run(async () =>
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
                                        {
                                            var failedNames = statuses
                                                .Where(s => s.Status == DownloadTask.FileStatus.Failed)
                                                .Select(s => s.Name ?? "?");
                                            throw new Exception($"文件补全失败: {string.Join(", ", failedNames)}");
                                        }
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

                    // 检测需要的 Java 版本
                    var verJsonPath = Path.Combine(instance.GameDir, "versions", versionId, $"{versionId}.json");
                    var requiredJava = 8;
                    if (File.Exists(verJsonPath))
                    {
                        var verDoc = JsonNode.Parse(await File.ReadAllTextAsync(verJsonPath, cts.Token));
                        requiredJava = GetRequiredJavaFromNode(verDoc, instance.GameDir);
                    }
                    Console.Error.WriteLine($"[启动] 需要 Java >= {requiredJava}");

                    // 选择 Java 运行时
                    string selectedJavaPath;
                    if (!string.IsNullOrEmpty(instance.JavaPath))
                    {
                        Console.Error.WriteLine($"[启动] 用户指定 Java: {instance.JavaPath}");
                        var javaList = await store.GetMergedAsync(JavaSearchMode.Quick);
                        var matched = javaList.FirstOrDefault(j =>
                            string.Equals(j.Path, instance.JavaPath, StringComparison.OrdinalIgnoreCase));
                        if (matched != null)
                            Console.Error.WriteLine($"[启动] 检测到 Java {matched.MajorVersion} (需要 {requiredJava})");
                        selectedJavaPath = instance.JavaPath;
                    }
                    else
                    {
                        Console.Error.WriteLine("[启动] 自动选择 Java...");
                        var javaList = await store.GetMergedAsync(JavaSearchMode.Quick);
                        Console.Error.WriteLine($"[启动] 扫描到 {javaList.Count} 个 Java 运行时");
                        foreach (var j in javaList)
                            Console.Error.WriteLine($"  {j.Name ?? "?"} (v{j.MajorVersion}) [{j.State}] {j.Path}");

                        var meta = new CompleteVersionMetadata(
                            Id: versionId, Type: "release", MainClass: "", InheritsFrom: null,
                            Jar: null, Arguments: null, Libraries: [], AssetIndex: null, Downloads: null,
                            JavaVersion: new JavaVersion("jre-legacy", requiredJava),
                            MinimumLauncherVersion: 0, ReleaseTime: DateTimeOffset.MinValue, Time: DateTimeOffset.MinValue
                        );

                        var recommended = await core.JavaProvider.Recommand(javaList, meta);
                        Console.Error.WriteLine($"[启动] 推荐 Java {recommended.MajorVersion} ({recommended.Path})");
                        selectedJavaPath = recommended.Path;
                    }

                    var launchOptions = new LaunchOptions
                    {
                        Version = versionId,
                        VersionIsolation = instance.VersionIsolation ?? SystemEndpoints.LoadSettings().VersionIsolation,
                        GameRoot = instance.GameDir,
                        JavaOptions = new JavaOptions
                        {
                            JavaPath = selectedJavaPath,
                            MaxMemoryMB = instance.MaxMemory,
                            ExtraJvmArgs = string.IsNullOrEmpty(instance.JvmArgs)
                                ? null
                                : instance.JvmArgs.Split(' ', StringSplitOptions.RemoveEmptyEntries),
                        },
                        AuthOptions = authOptions,
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
                            Error = result.Exception?.ToString() ?? result.Message,
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
                    Console.Error.WriteLine($"[启动] 错误: {ex}");
                    var logDir = System.IO.Path.Combine(Qomicex.Launcher.Backend.Neo.Common.AppPaths.BaseDir, "logs");
                    System.IO.Directory.CreateDirectory(logDir);
                    System.IO.File.AppendAllText(
                        System.IO.Path.Combine(logDir, "launch-errors.log"),
                        $"[{DateTime.UtcNow:O}] [{id}] {ex}\n\n");
                    tracker.SetProgress(id, new LaunchProgressState
                    {
                        Stage = "failed", Message = "启动失败", Error = ex.ToString(), Progress = 0
                    });
                }
                finally
                {
                    var p = tracker.GetProgress(id);
                    if (p != null && p.Stage is not ("running" or "failed" or "crashed"))
                        tracker.CancelAndRemove(id);
                }
            });

            return Results.Json(new LaunchResultDto(
                Success: true, ProcessId: 0, Stage: "starting"
            ), ApiJsonContext.Default.LaunchResultDto);
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

            if (progress.Stage == "running")
            {
                var ps = tracker.GetState(id);
                if (ps == null || ps.HasExited)
                {
                    tracker.CancelAndRemove(id);
                    return Results.Json(new LaunchProgressDto(
                        Stage: "completed", Message: "游戏已退出", Progress: 100, IsRunning: false,
                        ExitCode: ps?.ExitCode
                    ), ApiJsonContext.Default.LaunchProgressDto);
                }
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

        group.MapPost("/{id}/install", (string id, InstallerRequest req, InstanceService instances, InstallTracker tracker) =>
        {
            var instance = instances.GetById(id);
            if (instance is null)
                throw ApiException.NotFound($"Instance {id} not found");

            var threads = req.DownloadThreads ?? 64;
            var sourceId = req.DownloadSourceId ?? 0;

            tracker.Start(id, instance.GameVersion, instance.GameDir,
                req.Loader, req.LoaderVersion, req.Addons, threads,
                req.VersionIsolation ?? false, sourceId);

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
#pragma warning disable IL2026, IL3050
            return Results.Json(loaders);
#pragma warning restore IL2026, IL3050
        });
    }

    private static Qomicex.Core.AOT.Public.Models.ModLoaderType? MapLoaderType(string loader) => loader.ToLowerInvariant() switch
    {
        "fabric" => Qomicex.Core.AOT.Public.Models.ModLoaderType.Fabric,
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

    private static int GetRequiredJavaFromNode(JsonNode? node, string gameDir)
    {
        if (node?["javaVersion"]?["majorVersion"] is JsonNode mv)
            return mv.GetValue<int>();
        if (node?["inheritsFrom"]?.GetValue<string>() is string inheritsFrom)
        {
            var path = Path.Combine(gameDir, "versions", inheritsFrom, $"{inheritsFrom}.json");
            if (File.Exists(path))
                return GetRequiredJavaFromNode(JsonNode.Parse(File.ReadAllText(path)), gameDir);
        }
        return 8;
    }

    private static async Task<AuthOptions> ResolveAuthOptions(AccountService accountService, IAuthProvider authProvider)
    {
        var account = await accountService.GetDefaultAsync();
        if (account == null)
            return new AuthOptions();

        var mode = account.LoginMethod switch
        {
            "Microsoft" => AuthMode.Microsoft,
            "Yggdrasil" or "统一通行证" => AuthMode.Yggdrasil,
            _ => AuthMode.Offline
        };

        var name = account.Name;
        var uuid = account.Uuid;
        var accessToken = account.AccessToken;
        var serverUrl = mode == AuthMode.Yggdrasil ? account.ServerUrl : null;

        if (mode == AuthMode.Microsoft && !string.IsNullOrEmpty(account.RefreshToken))
        {
            try
            {
                var refreshed = await authProvider.RefreshLoginAsync(account.RefreshToken);
                if (refreshed.Success)
                {
                    accessToken = refreshed.AccessToken ?? accessToken;
                    name = refreshed.Username ?? name;
                    uuid = refreshed.Uuid ?? uuid;

                    account.AccessToken = accessToken;
                    account.Name = name;
                    account.Uuid = uuid;
                    if (refreshed.RefreshToken != null)
                        account.RefreshToken = refreshed.RefreshToken;
                    await accountService.SaveAccountAsync(account);
                }
            }
            catch { }
        }

        return new AuthOptions
        {
            Mode = mode,
            Name = name,
            Uuid = uuid,
            AccessToken = accessToken ?? "0",
            ServerUrl = serverUrl,
            AuthlibInjectorParam = mode == AuthMode.Yggdrasil ? $"--authlibInjector={serverUrl}" : ""
        };
    }
}
