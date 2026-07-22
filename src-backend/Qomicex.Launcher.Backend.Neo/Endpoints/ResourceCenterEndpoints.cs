using System.Diagnostics;
using System.Net.Http;
using System.Text.Json.Nodes;
using Microsoft.AspNetCore.Http.HttpResults;
using Qomicex.Core.AOT.Core;
using Qomicex.Core.AOT.Models.Expansion.Modrinth;
using Qomicex.Core.AOT.Public.Expansion;
using Qomicex.Launcher.Backend.Neo.JsonContext;
using Qomicex.Launcher.Backend.Neo.Services;

namespace Qomicex.Launcher.Backend.Neo.Endpoints;

public static class ResourceCenterEndpoints
{
    public static void MapResourceCenterEndpoints(this WebApplication app, DefaultGameCore core, string curseForgeApiKey)
    {
        var logger = app.Services.GetRequiredService<ILoggerFactory>().CreateLogger("ResourceCenter");
        var mcmod = app.Services.GetRequiredService<McmodService>();
        var group = app.MapGroup("/api/resources");

        group.MapGet("/search", async (
            string? source, string? keyword, int? page, int? pageSize,
            string? gameVersion, string? loader, string? category, string? sort) =>
        {
            var src = source?.ToLowerInvariant() ?? "modrinth";
            var query = keyword;

            if ((string.Equals(category, "mod", StringComparison.OrdinalIgnoreCase) ||
                 string.Equals(category, "datapack", StringComparison.OrdinalIgnoreCase)))
            {
                var alt = mcmod.ResolveChineseSearch(keyword);
                if (!string.IsNullOrEmpty(alt)) query = alt;
            }

            if (src == "modrinth")
            {
                var mr = core.CreateModrinthSource();
                var result = await mr.SearchAsync(
                    query: query ?? "",
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
                var cfClassId = MapCfClassId(category);
                var cfUrlSlug = MapCfUrlSlug(category);
                var result = await cf.SearchAsync(
                    searchFilter: query ?? "",
                    gameVersions: gameVersion is not null ? [gameVersion] : null,
                    categories: null,
                    modLoaderTypes: loader is not null ? MapCfLoader(loader) : null,
                    sortField: MapCfSort(sort),
                    page: page ?? 1,
                    pageSize: pageSize ?? 25,
                    classId: cfClassId
                );

                var items = result.Select(r => new ResourceItemDto(
                    Id: r.Id, Title: r.Name, Description: r.Summary,
                    Author: r.Authors.FirstOrDefault()?.Name ?? "", IconUrl: r.IconUrl,
                    DownloadCount: int.TryParse(r.DownloadCount, out var dc) ? dc : 0,
                    Source: "curseforge",
                    Categories: r.Categories.Select(c => c.Slug ?? c.Name).ToList(),
                    ProjectUrl: $"https://www.curseforge.com/minecraft/{cfUrlSlug}/{r.Slug}",
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
                    query: query,
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
            Trace.WriteLine($"[versions] id={id} source={src} gameVersion={gameVersion} loader={loader}");

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
                Trace.WriteLine($"[CF versions] START id={id} apiKey={(string.IsNullOrEmpty(curseForgeApiKey) ? "EMPTY" : "SET")}");
                if (string.IsNullOrEmpty(curseForgeApiKey))
                    return Results.Json(new List<ResourceVersionDto>(), ApiJsonContext.Default.ListResourceVersionDto);

                var http = app.Services.GetRequiredService<IHttpClientFactory>().CreateClient("CurseForge");

                async Task<(List<JsonObject?> Data, int Total)> FetchPage(int index)
                {
                    var url = $"https://api.curseforge.com/v1/mods/{Uri.EscapeDataString(id)}/files?pageSize=50&index={index}";
                    if (!string.IsNullOrEmpty(gameVersion))
                        url += $"&gameVersion={Uri.EscapeDataString(gameVersion)}";
                    using var req = new HttpRequestMessage(HttpMethod.Get, url);
                    req.Headers.Add("x-api-key", curseForgeApiKey);
                    req.Headers.Accept.ParseAdd("application/json");
                    var resp = await http.SendAsync(req);
                    resp.EnsureSuccessStatusCode();
                    var json = JsonNode.Parse(await resp.Content.ReadAsStringAsync());
                    var total = json?["pagination"]?["totalCount"]?.GetValue<int>() ?? 0;
                    return (json?["data"]?.AsArray()?.Select(n => n?.AsObject()).ToList() ?? [], total);
                }

                try
                {
                    var (firstData, totalCount) = await FetchPage(0);
                    var firstItem = firstData.FirstOrDefault();
                    Trace.WriteLine($"[CF versions] totalCount={totalCount} firstDataCount={firstData.Count} firstKeys={(firstItem is not null ? string.Join(",", ((IDictionary<string, JsonNode?>)firstItem).Keys.Take(8)) : "null")}");
                    if (firstItem is not null)
                        Trace.WriteLine($"[CF versions] firstItem: id={firstItem["id"]} displayName={firstItem["displayName"]} downloadUrl={firstItem["downloadUrl"]}");
                    if (firstData.Count == 0 || totalCount == 0)
                        return Results.Json(new List<ResourceVersionDto>(), ApiJsonContext.Default.ListResourceVersionDto);

                    var allItems = new List<JsonObject?>(firstData);
                    var pageSize = 50;
                    var totalPages = (totalCount + pageSize - 1) / pageSize;
                    if (totalPages > 1)
                    {
                        var sem = new SemaphoreSlim(5);
                        var tasks = Enumerable.Range(1, totalPages - 1).Select(async p =>
                        {
                            await sem.WaitAsync();
                            try { var (data, _) = await FetchPage(p * pageSize); return data; }
                            finally { sem.Release(); }
                        }).ToList();
                        var pages = await Task.WhenAll(tasks);
                        foreach (var p in pages) allItems.AddRange(p);
                    }

                    var dtos = allItems.Select(f => new ResourceVersionDto(
                        Id: f?["id"]?.GetValue<int>().ToString() ?? "",
                        Name: f?["displayName"]?.GetValue<string>() ?? f?["fileName"]?.GetValue<string>() ?? "",
                        VersionNumber: f?["fileName"]?.GetValue<string>() ?? "",
                        GameVersions: f?["gameVersions"]?.AsArray()
                            ?.Select(gv => gv?.GetValue<string>())
                            .Where(v => !string.IsNullOrEmpty(v))
                            .Select(v => v!)
                            .ToList() ?? [],
                        Loaders: ExtractCFLoaders(f?["gameVersions"]?.AsArray(), f?["modLoader"]?.GetValue<int>()),
                        Downloads: [new ResourceFileDto(
                            f?["downloadUrl"]?.GetValue<string>() ?? "",
                            f?["fileName"]?.GetValue<string>() ?? "",
                            f?["fileLength"]?.GetValue<long>() ?? 0
                        )],
                        Dependencies: f?["dependencies"] is JsonArray depArr
                            ? depArr
                                .Where(d => d?["relationType"]?.GetValue<int>() == 3)
                                .Select(d => new ResourceDependencyDto(null, d!["modId"]?.GetValue<int>().ToString() ?? "", null, "required"))
                                .ToList()
                            : null,
                        DatePublished: f?["fileDate"]?.GetValue<DateTimeOffset>().ToString("o")
                    )).ToList();

                    if (!string.IsNullOrEmpty(gameVersion))
                        dtos = dtos.Where(v => v.GameVersions.Any(gv => gv == gameVersion)).ToList();
                    if (!string.IsNullOrEmpty(loader))
                    {
                        var norm = loader.Trim().ToLowerInvariant();
                        dtos = dtos.Where(v => v.Loaders.Count == 0 || v.Loaders.Any(l => l.Equals(norm, StringComparison.OrdinalIgnoreCase))).ToList();
                    }

                    return Results.Json(dtos, ApiJsonContext.Default.ListResourceVersionDto);
                }
                catch (Exception ex)
                {
                    Trace.WriteLine($"[CF versions] error: {ex.GetType().Name}: {ex.Message}");
                    return Results.Json(new List<ResourceVersionDto>(), ApiJsonContext.Default.ListResourceVersionDto);
                }
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
                var deps = await ResolveMRDeps(mr, id, versionId, gameVersion, loader);
                return Results.Json(deps, ApiJsonContext.Default.ListResolvedDependencyDto);
            }

            if (src == "curseforge")
            {
                var http = app.Services.GetRequiredService<IHttpClientFactory>().CreateClient("CurseForge");
                var deps = await ResolveCFDeps(http, id, versionId, gameVersion, loader, curseForgeApiKey);
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
            var taskId = fetchService.Start(id, gameVersion, loader, maxConcurrency);
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

        group.MapGet("/{id}/translate", async (string id, string? source) =>
        {
            try
            {
                using var client = new HttpClient { Timeout = TimeSpan.FromSeconds(10) };
                client.DefaultRequestHeaders.UserAgent.ParseAdd("QomicexLauncher/1.0");
                var src = source?.ToLowerInvariant() ?? "modrinth";
                var url = src switch
                {
                    "curseforge" => $"https://mod.mcimirror.top/translate/curseforge/{id}",
                    _ => $"https://mod.mcimirror.top/translate/modrinth/{id}",
                };
                var response = await client.GetAsync(url);
                if (!response.IsSuccessStatusCode)
                    return Results.Json(new TranslateResponse(null, null, null), ApiJsonContext.Default.TranslateResponse);

                var body = await response.Content.ReadAsStringAsync();
                using var doc = System.Text.Json.JsonDocument.Parse(body);
                var root = doc.RootElement;
                var original = root.TryGetProperty("original", out var o) ? o.GetString() : null;
                var translated = root.TryGetProperty("translated", out var t) ? t.GetString() : null;
                var translatedAt = root.TryGetProperty("translatedAt", out var ta) ? ta.GetString() : null;
                return Results.Json(new TranslateResponse(original, translated, translatedAt), ApiJsonContext.Default.TranslateResponse);
            }
            catch
            {
                return Results.Json(new TranslateResponse(null, null, null), ApiJsonContext.Default.TranslateResponse);
            }
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

    private static string MapCfUrlSlug(string? category) => category?.ToLowerInvariant() switch
    {
        "modpack" => "modpacks",
        "shader" => "shaders",
        "resourcepack" => "texture-packs",
        "datapack" => "data-packs",
        _ => "mc-mods"
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

    private static List<string> ExtractCFLoaders(JsonArray? gameVersions, int? modLoader)
    {
        var loaders = new List<string>();
        if (gameVersions is not null)
        {
            foreach (var gv in gameVersions)
            {
                var s = gv?.GetValue<string>()?.ToLowerInvariant();
                if (s is "forge" or "fabric" or "quilt" or "neoforge" or "liteloader")
                    loaders.Add(s);
                if (s is "fabric" or "quilt" or "neoforge")
                    loaders.Add(s);
            }
        }
        if (modLoader is 2) loaders.Add("forge");
        if (modLoader is 4) loaders.Add("fabric");
        if (modLoader is 5) loaders.Add("quilt");
        if (modLoader is 6) loaders.Add("neoforge");
        return loaders;
    }

    private static async Task<List<ResolvedDependencyDto>> ResolveCFDeps(
        HttpClient http, string modId, string? fileId, string? gameVersion, string? loader, string apiKey,
        HashSet<string>? visited = null, int depth = 0)
    {
    visited ??= [];
    if (depth > 8 || !visited.Add(modId)) return [];

        var result = new List<ResolvedDependencyDto>();

        if (fileId is not null && depth == 0)
        {
            // Root: get file's dependency list
            var url = $"https://api.curseforge.com/v1/mods/{Uri.EscapeDataString(modId)}/files/{Uri.EscapeDataString(fileId)}";
            using var req = new HttpRequestMessage(HttpMethod.Get, url);
            req.Headers.Add("x-api-key", apiKey);
            req.Headers.Accept.ParseAdd("application/json");
            var resp = await http.SendAsync(req);
            if (!resp.IsSuccessStatusCode) return result;
            var json = JsonNode.Parse(await resp.Content.ReadAsStringAsync());
            var data = json?["data"];

            if (data?["dependencies"] is JsonArray depArr)
            {
                var tasks = depArr
                    .Where(d => d?["relationType"]?.GetValue<int>() == 3)
                    .Select(d => ResolveCFDeps(http,
                        d!["modId"]?.GetValue<int>().ToString() ?? "",
                        null, gameVersion, loader, apiKey, visited, depth + 1));
                var subResults = await Task.WhenAll(tasks);
                foreach (var sr in subResults) result.AddRange(sr);
            }
            return result;
        }

        // Sub-level: fetch mod info + find best file
        try
        {
            var modUrl = $"https://api.curseforge.com/v1/mods/{Uri.EscapeDataString(modId)}";
            using var modReq = new HttpRequestMessage(HttpMethod.Get, modUrl);
            modReq.Headers.Add("x-api-key", apiKey);
            modReq.Headers.Accept.ParseAdd("application/json");
            var modResp = await http.SendAsync(modReq);
            if (!modResp.IsSuccessStatusCode) return result;
            var modJson = JsonNode.Parse(await modResp.Content.ReadAsStringAsync());
            var modData = modJson?["data"];
            var modName = modData?["name"]?.GetValue<string>() ?? modId;
            var modSlug = modData?["slug"]?.GetValue<string>() ?? modId;
            var modIcon = modData?["logo"]?["url"]?.GetValue<string>() ?? "";

            // Fetch best matching file
            var query = $"https://api.curseforge.com/v1/mods/{Uri.EscapeDataString(modId)}/files?pageSize=50";
            if (!string.IsNullOrEmpty(gameVersion))
                query += $"&gameVersion={Uri.EscapeDataString(gameVersion)}";
            using var filesReq = new HttpRequestMessage(HttpMethod.Get, query);
            filesReq.Headers.Add("x-api-key", apiKey);
            filesReq.Headers.Accept.ParseAdd("application/json");
            var filesResp = await http.SendAsync(filesReq);
            if (!filesResp.IsSuccessStatusCode) return result;
            var filesJson = JsonNode.Parse(await filesResp.Content.ReadAsStringAsync());
            var filesData = filesJson?["data"]?.AsArray();

            if (filesData is null || filesData.Count == 0) return result;

            var best = filesData
                .Select(f => f?.AsObject())
                .Where(f => f is not null)
                .Select(f => f!)
                .OrderByDescending(f => f["fileDate"]?.GetValue<DateTimeOffset>() ?? DateTimeOffset.MinValue)
                .FirstOrDefault();

            if (best is null) return result;

            var bestFileId = best["id"]?.GetValue<int>().ToString() ?? "";
            var bestFileName = best["fileName"]?.GetValue<string>() ?? best["displayName"]?.GetValue<string>() ?? "";
            var bestDownloadUrl = best["downloadUrl"]?.GetValue<string>() ?? "";

            result.Add(new ResolvedDependencyDto(
                ProjectId: modId, Name: modName, IconUrl: modIcon,
                VersionId: bestFileId, VersionNumber: best["displayName"]?.GetValue<string>() ?? best["fileName"]?.GetValue<string>() ?? "",
                DownloadUrl: bestDownloadUrl, FileName: bestFileName,
                Category: "mod", Source: "curseforge",
                CurseForgeId: modId
            ));

            // Recurse into sub-dependencies
            try
            {
                var depsUrl = $"https://api.curseforge.com/v1/mods/{Uri.EscapeDataString(modId)}/files/{Uri.EscapeDataString(bestFileId)}";
                using var depsReq = new HttpRequestMessage(HttpMethod.Get, depsUrl);
                depsReq.Headers.Add("x-api-key", apiKey);
                depsReq.Headers.Accept.ParseAdd("application/json");
                var depsResp = await http.SendAsync(depsReq);
                if (depsResp.IsSuccessStatusCode)
                {
                    var depsJson = JsonNode.Parse(await depsResp.Content.ReadAsStringAsync());
                    if (depsJson?["data"]?["dependencies"] is JsonArray subDeps)
                    {
                        var tasks = subDeps
                            .Where(d => d?["relationType"]?.GetValue<int>() == 3)
                            .Select(d => ResolveCFDeps(http,
                                d!["modId"]?.GetValue<int>().ToString() ?? "",
                                null, gameVersion, loader, apiKey, visited, depth + 1));
                        var subResults = await Task.WhenAll(tasks);
                        foreach (var sr in subResults) result.AddRange(sr);
                    }
                }
            }
            catch { }
        }
        catch { }

        return result;
    }

    private static async Task<List<ResolvedDependencyDto>> ResolveMRDeps(
        IModrinthSource mr, string projectId, string? versionId, string? gameVersion, string? loader,
        HashSet<string>? visited = null, int depth = 0)
    {
        if (depth > 5) return [];
        visited ??= [];
        if (!visited.Add(projectId)) return [];

        var result = new List<ResolvedDependencyDto>();

        try
        {
            var versions = await mr.GetProjectVersionInfoAsync(projectId);
            if (versions.Count == 0) return result;

            var best = versionId is not null && depth == 0
                ? versions.FirstOrDefault(v => v.Id == versionId)
                : versions
                    .Where(v => (gameVersion == null || v.GameVersionIds?.Contains(gameVersion) == true)
                             && (loader == null || v.Loaders == null || v.Loaders.Count == 0 || v.Loaders.Contains(loader)))
                    .MaxBy(v => v.PublishedAt)
                    ?? versions.MaxBy(v => v.PublishedAt);
            if (best is null) return result;

            if (depth > 0)
            {
                var primaryFile = best.Files?.FirstOrDefault(f => !string.IsNullOrEmpty(f.DownloadUrl));
                if (primaryFile is not null)
                {
                    string name = projectId, iconUrl = "";
                    var category = "mods";
                    try
                    {
                        var proj = await mr.GetProjectInfoAsync(projectId);
                        if (proj is not null)
                        {
                            name = proj.Name ?? projectId;
                            iconUrl = proj.IconUrl ?? "";
                            category = proj.Type switch { "resourcepack" => "resourcepacks", "shader" => "shaderpacks", _ => "mods" };
                        }
                    }
                    catch { }

                    result.Add(new ResolvedDependencyDto(
                        ProjectId: projectId, Name: name, IconUrl: iconUrl,
                        VersionId: best.Id, VersionNumber: best.VersionNumber ?? "",
                        DownloadUrl: primaryFile.DownloadUrl, FileName: primaryFile.Filename ?? "",
                        Category: category, Source: "modrinth",
                        ModrinthId: projectId
                    ));
                }
            }

            if (best.DependenciesInfos is not null)
            {
                var tasks = best.DependenciesInfos
                    .Where(d => d.DependencyType == "required" && d.ProjectId is not null)
                    .Select(d => ResolveMRDeps(mr, d.ProjectId!, null, gameVersion, loader, visited, depth + 1));
                var subResults = await Task.WhenAll(tasks);
                foreach (var sr in subResults) result.AddRange(sr);
            }
        }
        catch { }

        return result;
    }
}
