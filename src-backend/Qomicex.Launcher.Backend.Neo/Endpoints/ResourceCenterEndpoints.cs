using Qomicex.Core.AOT.Core;
using Qomicex.Core.AOT.Public.Expansion;
using Qomicex.Launcher.Backend.Neo.JsonContext;
using Qomicex.Launcher.Backend.Neo.Services;

namespace Qomicex.Launcher.Backend.Neo.Endpoints;

public static class ResourceCenterEndpoints
{
    public static void MapResourceCenterEndpoints(this WebApplication app, DefaultGameCore core, string curseForgeApiKey)
    {
        var logger = app.Services.GetRequiredService<ILoggerFactory>().CreateLogger("ResourceCenter");
        var group = app.MapGroup("/api/resources");

        group.MapGet("/search", async (
            string? source, string? keyword, int? page, int? pageSize,
            string? gameVersion, string? loader, string? category, string? sort) =>
        {
            var src = source?.ToLowerInvariant() ?? "modrinth";

            if (src == "modrinth")
            {
                var mr = core.CreateModrinthSource();
                var result = await mr.SearchAsync(
                    query: keyword ?? "",
                    projectType: category,
                    gameVersion: gameVersion,
                    categories: null,
                    loaders: loader is not null ? [loader] : null,
                    index: MapMrSort(sort),
                    page: (page ?? 1) - 1,
                    pageSize: pageSize ?? 20
                );

                var items = result.Results.Select(r => new ResourceItemDto(
                    Id: r.Id, Title: r.Name, Description: r.Description,
                    Author: r.Author, IconUrl: r.IconUrl ?? "",
                    DownloadCount: r.DownloadCount, Source: "modrinth",
                    Categories: r.Categories ?? [],
                    ProjectUrl: $"https://modrinth.com/project/{r.Slug ?? r.Id}",
                    Slug: r.Slug ?? r.Id
                )).ToList();

                return Results.Json(new ResourceSearchResponse(items, result.TotalResults, page ?? 1, pageSize ?? 20),
                    ApiJsonContext.Default.ResourceSearchResponse);
            }

            if (src == "curseforge")
            {
                var cf = core.CreateCurseForgeSource(curseForgeApiKey);
                var result = await cf.SearchAsync(
                    searchFilter: keyword ?? "",
                    gameVersions: gameVersion is not null ? [gameVersion] : null,
                    categories: null,
                    modLoaderTypes: loader is not null ? MapCfLoader(loader) : null,
                    sortField: MapCfSort(sort),
                    page: page ?? 1,
                    pageSize: pageSize ?? 25
                );

                var items = result.Select(r => new ResourceItemDto(
                    Id: r.Id, Title: r.Name, Description: r.Summary,
                    Author: r.Authors.FirstOrDefault()?.Name ?? "", IconUrl: r.IconUrl,
                    DownloadCount: int.TryParse(r.DownloadCount, out var dc) ? dc : 0,
                    Source: "curseforge",
                    Categories: r.Categories.Select(c => c.Slug ?? c.Name).ToList(),
                    ProjectUrl: $"https://www.curseforge.com/minecraft/mc-mods/{r.Slug}",
                    Slug: r.Slug
                )).ToList();

                return Results.Json(new ResourceSearchResponse(items, items.Count, page ?? 1, pageSize ?? 25),
                    ApiJsonContext.Default.ResourceSearchResponse);
            }

            if (src == "ftb")
            {
                if (!string.Equals(category, "modpack", StringComparison.OrdinalIgnoreCase))
                    return Results.Json(new ResourceSearchResponse([], 0, 1, 20), ApiJsonContext.Default.ResourceSearchResponse);

                var ftb = core.CreateFTBSource();
                var packs = await ftb.SearchAsync(
                    query: keyword,
                    mcVersion: gameVersion,
                    loader: loader,
                    sort: MapFtSort(sort),
                    limit: pageSize ?? 20
                );

                var items = packs.Select(p => new ResourceItemDto(
                    Id: p.Id.ToString(),
                    Title: p.Name,
                    Description: p.Synopsis ?? "",
                    Author: string.Join(", ", p.Authors?.Select(a => a.Name).Take(2) ?? []),
                    IconUrl: p.Art?.FirstOrDefault(a => a.Type == "square")?.Url ?? "",
                    DownloadCount: (int)p.Installs,
                    Source: "ftb",
                    Categories: p.Tags?.Select(t => t.Name).ToList() ?? [],
                    ProjectUrl: $"https://www.feed-the-beast.com/modpacks/{p.Slug ?? p.Id.ToString()}",
                    Slug: p.Slug ?? p.Id.ToString()
                )).ToList();

                return Results.Json(new ResourceSearchResponse(items, items.Count, page ?? 1, pageSize ?? 20),
                    ApiJsonContext.Default.ResourceSearchResponse);
            }

            return Results.Json(new ResourceSearchResponse([], 0, 1, 20), ApiJsonContext.Default.ResourceSearchResponse);
        });

        group.MapGet("/{id}", async (string id, string? source) =>
        {
            var src = source?.ToLowerInvariant() ?? "modrinth";

            if (src == "modrinth")
            {
                var mr = core.CreateModrinthSource();
                var info = await mr.GetProjectInfoAsync(id);
                return Results.Json(new ResourceDetailDto(
                    Id: info.Id, Title: info.Name, Description: info.Description,
                    Author: "", IconUrl: info.IconUrl ?? "",
                    DownloadCount: info.DownloadCount, Source: "modrinth",
                    Categories: info.Categories ?? [],
                    ProjectUrl: $"https://modrinth.com/project/{info.Slug ?? info.Id}",
                    Slug: info.Slug ?? info.Id,
                    Body: info.FullDescription ?? ""
                ), ApiJsonContext.Default.ResourceDetailDto);
            }

            if (src == "curseforge")
            {
                var cf = core.CreateCurseForgeSource(curseForgeApiKey);
                var info = await cf.GetModInfoAsync(id);
                return Results.Json(new ResourceDetailDto(
                    Id: info.Id.ToString(), Title: info.Name, Description: info.Summary ?? "",
                    Author: info.Authors?.FirstOrDefault()?.Name ?? "", IconUrl: info.Screenshots?.FirstOrDefault()?.ThumbnailUrl ?? "",
                    DownloadCount: info.DownloadCount, Source: "curseforge",
                    Categories: info.Categories?.Select(c => c.Slug ?? c.Name).ToList() ?? [],
                    ProjectUrl: $"https://www.curseforge.com/minecraft/mc-mods/{info.Slug ?? info.Id.ToString()}",
                    Slug: info.Slug ?? info.Id.ToString(),
                    Body: ""
                ), ApiJsonContext.Default.ResourceDetailDto);
            }

            return Results.NotFound();
        });

        group.MapGet("/{id}/versions", async (string id, string? source, string? gameVersion, string? loader) =>
        {
            var src = source?.ToLowerInvariant() ?? "modrinth";

            if (src == "modrinth")
            {
                var mr = core.CreateModrinthSource();
                var versions = await mr.GetProjectVersionInfoAsync(id);

                var filtered = versions.AsEnumerable();
                if (!string.IsNullOrEmpty(gameVersion))
                    filtered = filtered.Where(v => v.GameVersionIds?.Contains(gameVersion) == true);
                if (!string.IsNullOrEmpty(loader))
                    filtered = filtered.Where(v => v.Loaders?.Contains(loader) == true);

                var dtos = filtered.Select(v => new ResourceVersionDto(
                    Id: v.Id, Name: v.Name, VersionNumber: v.VersionNumber ?? v.Name,
                    GameVersions: v.GameVersionIds ?? [],
                    Loaders: v.Loaders ?? [],
                    Downloads: v.Files?.Select(f => new ResourceFileDto(f.DownloadUrl, f.Filename, f.Size)).ToList() ?? [],
                    Dependencies: v.DependenciesInfos?.Select(d => new ResourceDependencyDto(d.VersionId, d.ProjectId ?? "", d.FileName, d.DependencyType ?? "")).ToList(),
                    DatePublished: v.PublishedAt.ToString("o")
                )).ToList();

                return Results.Json(dtos, ApiJsonContext.Default.ListResourceVersionDto);
            }

            if (src == "curseforge")
            {
                var cf = core.CreateCurseForgeSource(curseForgeApiKey);
                var info = await cf.GetModInfoAsync(id);
                var files = info.Files ?? [];
                var filtered = files.AsEnumerable();
                if (!string.IsNullOrEmpty(gameVersion))
                    filtered = filtered.Where(f => f.GameVersion == gameVersion);

                var dtos = filtered.Select(f => new ResourceVersionDto(
                    Id: f.FileId.ToString(), Name: f.FileName ?? f.FileId.ToString(),
                    VersionNumber: f.GameVersion ?? "",
                    GameVersions: f.GameVersion is not null ? [f.GameVersion] : [],
                    Loaders: [],
                    Downloads: [new ResourceFileDto("", f.FileName ?? "", 0)],
                    DatePublished: null
                )).ToList();

                return Results.Json(dtos, ApiJsonContext.Default.ListResourceVersionDto);
            }

            return Results.Json(new List<ResourceVersionDto>(), ApiJsonContext.Default.ListResourceVersionDto);
        });

        group.MapGet("/{id}/versions/{versionId}/downloads", async (string id, string versionId, string? source) =>
        {
            var src = source?.ToLowerInvariant() ?? "modrinth";

            if (src == "modrinth")
            {
                var mr = core.CreateModrinthSource();
                var info = await mr.GetVersionInfoAsync(versionId);
                var files = info.Files?.Select(f => new ResourceFileDto(f.DownloadUrl, f.Filename, f.Size)).ToList() ?? [];
                return Results.Json(files, ApiJsonContext.Default.ListResourceFileDto);
            }

            if (src == "curseforge")
            {
                var cf = core.CreateCurseForgeSource(curseForgeApiKey);
                var url = await cf.GetDownloadUrlAsync(id, versionId);
                return Results.Json(new List<ResourceFileDto> { new(url, "", 0) }, ApiJsonContext.Default.ListResourceFileDto);
            }

            return Results.Json(new List<ResourceFileDto>(), ApiJsonContext.Default.ListResourceFileDto);
        });

        group.MapGet("/{id}/dependencies", async (string id, string? source, string? versionId, string? gameVersion, string? loader) =>
        {
            var src = source?.ToLowerInvariant() ?? "modrinth";

            if (src == "modrinth")
            {
                var mr = core.CreateModrinthSource();
                var versions = await mr.GetProjectVersionInfoAsync(id);
                var target = !string.IsNullOrEmpty(versionId)
                    ? versions.FirstOrDefault(v => v.Id == versionId)
                    : versions.FirstOrDefault();

                if (target?.DependenciesInfos is null)
                    return Results.Json(new List<ResolvedDependencyDto>(), ApiJsonContext.Default.ListResolvedDependencyDto);

                var deps = target.DependenciesInfos
                    .Where(d => d.DependencyType == "required" && d.ProjectId is not null)
                    .Select(d => new ResolvedDependencyDto(
                        ProjectId: d.ProjectId!, Name: "", IconUrl: "",
                        VersionId: d.VersionId ?? "", VersionNumber: "",
                        DownloadUrl: "", FileName: d.FileName ?? "",
                        Category: "mod", Source: "modrinth"
                    )).ToList();

                return Results.Json(deps, ApiJsonContext.Default.ListResolvedDependencyDto);
            }

            return Results.Json(new List<ResolvedDependencyDto>(), ApiJsonContext.Default.ListResolvedDependencyDto);
        });

        // CurseForge async version fetch — uses GetModInfoAsync().Files (no pagination available in AOT)
        group.MapPost("/{id}/versions/start-fetch", async (
            string id, string? gameVersion, string? loader) =>
        {
            var fetchService = app.Services.GetRequiredService<CurseForgeVersionFetchService>();
            var settings = SystemEndpoints.LoadSettings();
            var maxConcurrency = Math.Max(1, settings.DownloadThreads);
            var cf = core.CreateCurseForgeSource(curseForgeApiKey);
            var taskId = fetchService.Start(id, gameVersion, loader, cf, logger, maxConcurrency);
            return Results.Json(new CurseForgeVersionFetchStartResponse(taskId, 0, 0),
                ApiJsonContext.Default.CurseForgeVersionFetchStartResponse);
        });

        group.MapGet("/versions/fetch-progress/{taskId}", (string taskId) =>
        {
            var fetchService = app.Services.GetRequiredService<CurseForgeVersionFetchService>();
            var state = fetchService.GetProgress(taskId);
            if (state == null) return Results.NotFound();
            return Results.Json(
                new CurseForgeVersionFetchProgressResponse(state.LoadedVersionCount, state.TotalVersionCount, state.Done),
                ApiJsonContext.Default.CurseForgeVersionFetchProgressResponse);
        });

        group.MapGet("/versions/fetch-result/{taskId}", (string taskId) =>
        {
            var fetchService = app.Services.GetRequiredService<CurseForgeVersionFetchService>();
            var state = fetchService.GetResult(taskId);
            if (state == null) return Results.NotFound();
            return Results.Json(state.Results, ApiJsonContext.Default.ListResourceVersionDto);
        });
    }

    private static string[]? MapCfLoader(string loader) => loader.ToLowerInvariant() switch
    {
        "forge" => ["Forge"],
        "fabric" => ["Fabric"],
        "quilt" => ["Quilt"],
        "neoforge" => ["NeoForge"],
        _ => null
    };

    private static int? MapCfClassId(string? category) => category?.ToLowerInvariant() switch
    {
        "mod" => 6,
        "modpack" => 4471,
        "shader" => 6552,
        "resourcepack" => 12,
        "datapack" => 6945,
        _ => null
    };

    private static string MapMrSort(string? sort) => sort?.ToLowerInvariant() switch
    {
        "downloads" => "downloads",
        "updated" => "updated",
        "newest" => "newest",
        _ => "relevance"
    };

    private static int MapCfSort(string? sort) => sort?.ToLowerInvariant() switch
    {
        "downloads" => 6,
        "updated" => 3,
        "name" => 4,
        "newest" => 11,
        _ => 6
    };

    private static string MapFtSort(string? sort) => sort?.ToLowerInvariant() switch
    {
        "downloads" => "downloads",
        "updated" => "updated",
        "newest" => "released",
        "name" => "name",
        _ => "downloads"
    };
}
