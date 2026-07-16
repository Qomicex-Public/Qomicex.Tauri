using Qomicex.Core.AOT.Core;
using Qomicex.Core.AOT.Models.VersionMetadata;
using Qomicex.Core.AOT.Public.Models;
using Qomicex.Launcher.Backend.Neo.Models;
using Qomicex.Launcher.Backend.Neo.Services;

namespace Qomicex.Launcher.Backend.Neo.Endpoints;

public static class JavaEndpoints
{
    public static void MapJavaEndpoints(this WebApplication app)
    {
        var java = app.MapGroup("/api/java");

        java.MapGet("/search", async (DefaultGameCore core, string? mode) =>
        {
            var searchMode = ParseSearchMode(mode);
            var options = new JavaSearchOptions(
                CustomExcludePaths: [],
                CustomRootPath: null,
                GameDir: null,
                Mode: searchMode,
                IncludeJRE: true,
                IncludeJDK: true,
                MaxDepth: 5,
                MaxResults: 100,
                ScanHiddenFolders: false,
                IncludeNetworkDrives: false
            );
            return Results.Ok(await core.JavaProvider.Search(options));
        });

        java.MapGet("/custom", async (JavaRuntimeStore store) =>
            Results.Ok(await store.GetCustomAsync()));

        java.MapPost("/custom", async (JavaRuntimeStore store, JavaPathRequest req) =>
            Results.Ok(await store.AddCustomAsync(req.Path)));

        java.MapDelete("/custom", async (JavaRuntimeStore store, JavaPathRequest req) =>
        {
            await store.RemoveCustomAsync(req.Path);
            return Results.NoContent();
        });

        java.MapGet("/list", async (DefaultGameCore core, JavaRuntimeStore store, string? mode) =>
            Results.Ok(await store.GetMergedAsync(ParseSearchMode(mode))));

        java.MapPost("/validate", async (DefaultGameCore core, JavaPathRequest req) =>
        {
            var javaHome = Path.GetDirectoryName(Path.GetDirectoryName(req.Path));
            if (string.IsNullOrEmpty(javaHome))
                return Results.NotFound(new { message = "无法识别该路径下的 Java 运行时" });

            var options = new JavaSearchOptions(
                CustomExcludePaths: [],
                CustomRootPath: javaHome,
                GameDir: null,
                Mode: JavaSearchMode.Custom,
                IncludeJRE: true,
                IncludeJDK: true,
                MaxDepth: 2,
                MaxResults: 20,
                ScanHiddenFolders: true,
                IncludeNetworkDrives: false
            );

            var results = await core.JavaProvider.Search(options);
            var match = results.FirstOrDefault(r =>
            {
                var pathComparer = OperatingSystem.IsWindows() ? StringComparer.OrdinalIgnoreCase : StringComparer.Ordinal;
                return pathComparer.Equals(Path.GetFullPath(r.Path), Path.GetFullPath(req.Path));
            });

            if (match == null)
                return Results.NotFound(new { message = "无法识别该路径下的 Java 运行时" });

            return Results.Ok(match);
        });

        java.MapPost("/recommended", async (DefaultGameCore core, JavaRecommendRequest req) =>
        {
            var javaList = await core.JavaProvider.Search(new JavaSearchOptions(
                CustomExcludePaths: [],
                CustomRootPath: null,
                GameDir: null,
                Mode: JavaSearchMode.Quick,
                IncludeJRE: true,
                IncludeJDK: true,
                MaxDepth: 5,
                MaxResults: 100,
                ScanHiddenFolders: false,
                IncludeNetworkDrives: false
            ));

            var requireJava = MinecraftToJavaVersion(req.MinecraftVersion);
            var metadata = new CompleteVersionMetadata(
                Id: req.MinecraftVersion,
                Type: "release",
                MainClass: "",
                InheritsFrom: null,
                Jar: null,
                Arguments: null,
                Libraries: [],
                AssetIndex: null,
                Downloads: null,
                JavaVersion: new JavaVersion("jre-legacy", requireJava),
                MinimumLauncherVersion: 0,
                ReleaseTime: DateTimeOffset.MinValue,
                Time: DateTimeOffset.MinValue
            );

            var recommended = await core.JavaProvider.Recommand(javaList, metadata);
            return Results.Ok(recommended);
        });

        static int MinecraftToJavaVersion(string mcVersion)
        {
            if (!Version.TryParse(mcVersion.Split('-')[0], out var v)) return 17;
            if (v.Major >= 1 && v.Minor >= 21) return 21;
            if (v.Major >= 1 && v.Minor >= 20 && v.Build >= 5) return 21;
            if (v.Major >= 1 && v.Minor >= 18) return 17;
            if (v.Major >= 1 && v.Minor >= 17) return 16;
            if (v.Major >= 1 && v.Minor >= 16) return 11;
            return 8;
        }

        // Download endpoints
        var download = java.MapGroup("/download");

        download.MapGet("/catalog", async (JavaDownloadService svc) =>
            Results.Ok(await svc.GetCatalogAsync()));

        download.MapPost("/start", async (JavaDownloadService svc, JavaDownloadStartRequest req) =>
            Results.Ok(await svc.StartAsync(req)));

        download.MapGet("/progress/{taskId}", (JavaDownloadService svc, string taskId) =>
        {
            var p = svc.GetProgress(taskId);
            return p != null ? Results.Ok(p) : Results.NotFound();
        });

        download.MapDelete("/{taskId}", (JavaDownloadService svc, string taskId) =>
        {
            if (svc.Cancel(taskId)) return Results.NoContent();
            return Results.NotFound();
        });

        download.MapPost("/{taskId}/pause", (JavaDownloadService svc, string taskId) =>
        {
            if (svc.Pause(taskId)) return Results.NoContent();
            return Results.NotFound();
        });

        download.MapPost("/{taskId}/resume", (JavaDownloadService svc, string taskId) =>
        {
            if (svc.Resume(taskId)) return Results.NoContent();
            return Results.NotFound();
        });

        download.MapGet("/active", (JavaDownloadService svc) =>
            Results.Ok(svc.GetAllActiveStates()));
    }

    private static JavaSearchMode ParseSearchMode(string? mode)
    {
        if (string.IsNullOrWhiteSpace(mode) || string.Equals(mode, "quick", StringComparison.OrdinalIgnoreCase))
            return JavaSearchMode.Quick;
        if (string.Equals(mode, "deep", StringComparison.OrdinalIgnoreCase))
            return JavaSearchMode.Deep;
        throw ApiException.BadRequest("无效的 Java 搜索模式", "JAVA_SEARCH_MODE_INVALID");
    }
}

public sealed record JavaPathRequest(string Path);

public sealed record JavaRecommendRequest(string MinecraftVersion, string GameDir);
