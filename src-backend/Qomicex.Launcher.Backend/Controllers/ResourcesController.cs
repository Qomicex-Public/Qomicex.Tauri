using System.Collections.Concurrent;
using Microsoft.AspNetCore.Mvc;
using Qomicex.Launcher.Backend.Services;
using Qomicex.Core.Modules.Helpers.Resources.Expansion.CurseForge;
using System.Net.Http.Json;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.Json.Serialization;

namespace Qomicex.Launcher.Backend.Controllers;

[ApiController]
[Route("api/[controller]")]
public class ResourcesController : ControllerBase
{
    private readonly HttpClient _modrinth;
    private readonly HttpClient _curseforge;
    private readonly string _cfApiKey;
    private readonly FtbService _ftbService;
    private readonly McmodService _mcmod;
    private readonly Mods _cfMods;

    private static readonly ConcurrentDictionary<string, CurseForgeVersionFetchState> CfFetchStates = new();

    private class CurseForgeVersionFetchState
    {
        public int TotalVersionCount { get; set; }
        public int LoadedVersionCount { get; set; }
        public bool Done { get; set; }
        public List<ResourceVersion>? Results { get; set; }
        public string? Error { get; set; }
    }

    public ResourcesController(IHttpClientFactory httpClientFactory, IConfiguration config, FtbService ftbService, McmodService mcmod)
    {
        _modrinth = httpClientFactory.CreateClient("Modrinth");
        _curseforge = httpClientFactory.CreateClient("CurseForge");
        _cfApiKey = config["CurseForge:ApiKey"] ?? "";
        _ftbService = ftbService;
        _mcmod = mcmod;
        _cfMods = new Mods(_cfApiKey);
    }

    [HttpGet("search")]
    public async Task<IActionResult> Search(
        [FromQuery] string category = "mod",
        [FromQuery] string? keyword = null,
        [FromQuery] int page = 1,
        [FromQuery] int pageSize = 20,
        [FromQuery] string sort = "relevance",
        [FromQuery] string source = "modrinth",
        [FromQuery] string? gameVersion = null,
        [FromQuery] string? loader = null)
    {
        // 中文搜索：仅对 Mod / 数据包（整合包等名称可能本就含中文），将中文关键词
        // 通过本地 MC 百科词库转换为对应 Mod 的英文 slug 再转发给上游 API。
        if ((string.Equals(category, "mod", StringComparison.OrdinalIgnoreCase) ||
             string.Equals(category, "datapack", StringComparison.OrdinalIgnoreCase)))
        {
            var alt = _mcmod.ResolveChineseSearch(keyword);
            if (!string.IsNullOrEmpty(alt)) keyword = alt;
        }

        return source.ToLowerInvariant() switch
        {
            "curseforge" => await SearchCurseForge(category, keyword, page, pageSize, sort),
            "ftb" => await SearchFtb(category, keyword, page, pageSize, sort),
            _ => await SearchModrinth(category, keyword, page, pageSize, sort, gameVersion, loader),
        };
    }

    [HttpGet("{id}")]
    public async Task<IActionResult> GetById(string id, [FromQuery] string source = "modrinth")
    {
        return source.ToLowerInvariant() switch
        {
            "curseforge" => await GetCurseForgeById(id),
            "ftb" => await GetFtbById(id),
            _ => await GetModrinthById(id),
        };
    }

    private async Task<IActionResult> SearchFtb(string category, string? keyword, int page, int pageSize, string sort)
    {
        if (!string.Equals(category, "modpack", StringComparison.OrdinalIgnoreCase))
            return BadRequest(new { error = "FTB source only supports modpack category" });

        try
        {
            var (packs, total) = await _ftbService.SearchAsync(keyword, page, pageSize, sort);
            var items = packs.Select(pack => new ResourceItem
            {
                Id = pack.Id.ToString(),
                Title = pack.Name,
                Description = pack.Synopsis,
                Author = string.Join(", ", pack.Authors.Select(author => author.Name).Where(name => !string.IsNullOrWhiteSpace(name)).Take(2)),
                IconUrl = GetFtbIconUrl(pack),
                DownloadCount = pack.Installs,
                Source = "ftb",
                Categories = pack.Tags.Select(tag => tag.Name).Where(name => !string.IsNullOrWhiteSpace(name)).ToList(),
                ProjectUrl = GetFtbProjectUrl(pack),
                Slug = pack.Slug,
                LatestVersion = GetFtbLatestVersionName(pack),
            }).ToList();

            return Ok(new ResourceSearchResponse { Items = items, Total = total, Page = page, PageSize = pageSize });
        }
        catch (Exception ex)
        {
            return StatusCode(502, new { error = $"FTB API error: {ex.Message}" });
        }
    }

    private async Task<IActionResult> SearchModrinth(string category, string? keyword, int page, int pageSize, string sort, string? gameVersion = null, string? loader = null)
    {
        var typeMap = new Dictionary<string, string>
        {
            ["mod"] = "mod", ["modpack"] = "modpack", ["shader"] = "shader",
            ["resourcepack"] = "resourcepack", ["datapack"] = "datapack",
        };

        if (!typeMap.TryGetValue(category, out var projectType))
            return BadRequest(new { error = $"Unknown category: {category}" });

        var sortIndex = sort switch
        {
            "downloads" => "downloads", "updated" => "updated",
            "newest" => "newest", _ => "relevance",
        };

        var offset = (page - 1) * pageSize;
        var facetList = new List<List<string>> { new() { $"project_type:{projectType}" } };
        if (!string.IsNullOrWhiteSpace(gameVersion))
            facetList.Add(new() { $"versions:{gameVersion}" });
        if (!string.IsNullOrWhiteSpace(loader))
            facetList.Add(new() { $"categories:{loader}" });
        var facets = JsonSerializer.Serialize(facetList);
        var url = ModApiMirror.MirrorModrinth($"https://api.modrinth.com/v2/search?query={Uri.EscapeDataString(keyword ?? "")}&facets={Uri.EscapeDataString(facets)}&limit={pageSize}&offset={offset}&index={sortIndex}");

        try
        {
            var response = await _modrinth.GetFromJsonAsync<ModrinthSearchResponse>(url);
            if (response == null)
                return Ok(new ResourceSearchResponse { Items = [], Total = 0 });

            var items = response.Hits.Select(h => new ResourceItem
            {
                Id = h.ProjectId ?? h.Slug ?? "",
                Title = h.Title ?? "",
                Description = h.Description ?? "",
                Author = h.Author ?? "",
                IconUrl = h.IconUrl ?? "",
                DownloadCount = h.Downloads,
                Source = "modrinth",
                Categories = h.Categories ?? [],
                ProjectUrl = $"https://modrinth.com/{projectType}/{h.Slug ?? h.ProjectId}",
                Slug = h.Slug ?? "",
                LatestVersion = h.LatestVersion ?? "",
            }).ToList();

            return Ok(new ResourceSearchResponse { Items = items, Total = response.TotalHits, Page = page, PageSize = pageSize });
        }
        catch (Exception ex)
        {
            return StatusCode(502, new { error = $"Modrinth API error: {ex.Message}" });
        }
    }

    private async Task<IActionResult> SearchCurseForge(string category, string? keyword, int page, int pageSize, string sort)
    {
        if (string.IsNullOrEmpty(_cfApiKey))
            return BadRequest(new { error = "CurseForge API key not configured. Set CurseForge:ApiKey in appsettings.json" });

        var classIdMap = new Dictionary<string, int>
        {
            ["mod"] = 6, ["modpack"] = 4471, ["shader"] = 6552,
            ["resourcepack"] = 12, ["datapack"] = 6945,
        };

        if (!classIdMap.TryGetValue(category, out var classId))
            return BadRequest(new { error = $"Unknown category: {category}" });

        var sortField = sort switch
        {
            "downloads" => 6, "updated" => 3, "name" => 4, "newest" => 11, _ => 6,
        };

        var index = (page - 1) * pageSize;
        var url = ModApiMirror.MirrorCurseForge($"/v1/mods/search?gameId=432&classId={classId}&searchFilter={Uri.EscapeDataString(keyword ?? "")}&sortOrder=desc&pageSize={pageSize}&index={index}&sortField={sortField}");

        try
        {
            var request = new HttpRequestMessage(HttpMethod.Get, url);
            request.Headers.Add("x-api-key", _cfApiKey);
            var httpResponse = await _curseforge.SendAsync(request);
            httpResponse.EnsureSuccessStatusCode();

            var json = await httpResponse.Content.ReadFromJsonAsync<JsonObject>();
            if (json == null)
                return Ok(new ResourceSearchResponse { Items = [], Total = 0 });

            var data = json["data"]?.AsArray();
            if (data == null)
                return Ok(new ResourceSearchResponse { Items = [], Total = 0 });

            var pagination = json["pagination"];
            var total = pagination?["totalCount"]?.GetValue<long>() ?? 0;

            var items = new List<ResourceItem>();
            foreach (var entry in data)
            {
                if (entry == null) continue;
                var obj = entry.AsObject();
                var logo = obj["logo"]?.AsObject();

                var gameVersions = obj["latestFilesIndexes"]?.AsArray()
                    ?.Select(f => f?["gameVersion"]?.GetValue<string>())
                    .Where(v => v != null)
                    .Distinct()
                    .ToList() ?? [];

                var authors = obj["authors"]?.AsArray()
                    ?.Select(a => a?["name"]?.GetValue<string>())
                    .Where(n => n != null)
                    .ToList() ?? [];

                items.Add(new ResourceItem
                {
                    Id = obj["id"]?.GetValue<int>().ToString() ?? "",
                    Title = obj["name"]?.GetValue<string>() ?? "",
                    Description = obj["summary"]?.GetValue<string>() ?? "",
                    Author = authors.Count > 0 ? string.Join(", ", authors.Take(2)) : "",
                    IconUrl = logo?["url"]?.GetValue<string>() ?? "",
                    DownloadCount = obj["downloadCount"]?.GetValue<long>() ?? 0,
                    Source = "curseforge",
                    Categories = gameVersions!,
                    ProjectUrl = $"https://www.curseforge.com/minecraft/{category}-maven/{obj["slug"]?.GetValue<string>() ?? obj["id"]?.GetValue<string>()}",
                    Slug = obj["slug"]?.GetValue<string>() ?? "",
                    LatestVersion = gameVersions.Count > 0 ? gameVersions[^1]! : "",
                });
            }

            return Ok(new ResourceSearchResponse { Items = items, Total = total, Page = page, PageSize = pageSize });
        }
        catch (HttpRequestException ex)
        {
            return StatusCode(502, new { error = $"CurseForge API request failed: {ex.Message}", detail = ex.StatusCode?.ToString() ?? "" });
        }
        catch (Exception ex)
        {
            return StatusCode(502, new { error = $"CurseForge API error: {ex.Message}" });
        }
    }

    private async Task<IActionResult> GetModrinthById(string id)
    {
        var url = ModApiMirror.MirrorModrinth($"https://api.modrinth.com/v2/project/{Uri.EscapeDataString(id)}");
        try
        {
            var project = await _modrinth.GetFromJsonAsync<ModrinthProject>(url);
            if (project == null)
                return NotFound(new { error = "Project not found" });

            var author = project.Author ?? "";
            if (string.IsNullOrWhiteSpace(author) && !string.IsNullOrWhiteSpace(project.Team))
            {
                author = await GetModrinthPrimaryAuthorAsync(project.Team);
            }

            return Ok(new ResourceDetail
            {
                Id = project.Id ?? "",
                Title = project.Title ?? "",
                Description = project.Description ?? "",
                Body = project.Body ?? "",
                Author = author,
                IconUrl = project.IconUrl ?? "",
                DownloadCount = project.Downloads,
                Source = "modrinth",
                Categories = project.Categories ?? [],
                ProjectUrl = $"https://modrinth.com/{project.ProjectType}/{project.Slug ?? project.Id}",
                Slug = project.Slug ?? "",
                LatestVersion = project.LatestVersion ?? "",
            });
        }
        catch (Exception ex)
        {
            return StatusCode(502, new { error = $"Modrinth API error: {ex.Message}" });
        }
    }

    private async Task<IActionResult> GetCurseForgeById(string id)
    {
        if (string.IsNullOrEmpty(_cfApiKey))
            return BadRequest(new { error = "CurseForge API key not configured." });

        try
        {
            var request = new HttpRequestMessage(HttpMethod.Get, ModApiMirror.MirrorCurseForge($"/v1/mods/{Uri.EscapeDataString(id)}"));
            request.Headers.Add("x-api-key", _cfApiKey);
            var httpResponse = await _curseforge.SendAsync(request);
            httpResponse.EnsureSuccessStatusCode();

            var json = await httpResponse.Content.ReadFromJsonAsync<JsonObject>();
            var data = json?["data"]?.AsObject();
            if (data == null)
                return NotFound(new { error = "Project not found" });

            var logo = data["logo"]?.AsObject();
            return Ok(new ResourceDetail
            {
                Id = data["id"]?.GetValue<int>().ToString() ?? "",
                Title = data["name"]?.GetValue<string>() ?? "",
                Description = data["summary"]?.GetValue<string>() ?? "",
                Body = data["description"]?.GetValue<string>() ?? "",
                Author = data["authors"]?.AsArray()?.FirstOrDefault()?["name"]?.GetValue<string>() ?? "",
                IconUrl = logo?["url"]?.GetValue<string>() ?? "",
                DownloadCount = data["downloadCount"]?.GetValue<long>() ?? 0,
                Source = "curseforge",
                ProjectUrl = $"https://www.curseforge.com/minecraft/mc-mods/{data["slug"]?.GetValue<string>()}",
            });
        }
        catch (Exception ex)
        {
            return StatusCode(502, new { error = $"CurseForge API error: {ex.Message}" });
        }
    }

    private async Task<IActionResult> GetFtbById(string id)
    {
        if (!int.TryParse(id, out var packId))
            return BadRequest(new { error = "FTB pack id must be numeric" });

        try
        {
            var pack = await _ftbService.GetPackAsync(packId);
            if (pack == null)
                return NotFound(new { error = "Project not found" });

            return Ok(new ResourceDetail
            {
                Id = pack.Id.ToString(),
                Title = pack.Name,
                Description = pack.Synopsis,
                Body = pack.Description,
                Author = string.Join(", ", pack.Authors.Select(author => author.Name).Where(name => !string.IsNullOrWhiteSpace(name)).Take(2)),
                IconUrl = GetFtbIconUrl(pack),
                DownloadCount = pack.Installs,
                Source = "ftb",
                Categories = pack.Tags.Select(tag => tag.Name).Where(name => !string.IsNullOrWhiteSpace(name)).ToList(),
                ProjectUrl = GetFtbProjectUrl(pack),
                Slug = pack.Slug,
                LatestVersion = GetFtbLatestVersionName(pack),
            });
        }
        catch (Exception ex)
        {
            return StatusCode(502, new { error = $"FTB API error: {ex.Message}" });
        }
    }

    [HttpGet("{id}/versions")]
    public async Task<IActionResult> GetVersions(string id, [FromQuery] string source = "modrinth",
        [FromQuery] string? gameVersion = null, [FromQuery] string? loader = null)
    {
        return source.ToLowerInvariant() switch
        {
            "curseforge" => await GetCurseForgeVersions(id, gameVersion, loader),
            "ftb" => await GetFtbVersions(id),
            _ => await GetModrinthVersions(id, gameVersion, loader),
        };
    }

    [HttpGet("{id}/versions/{versionId}/downloads")]
    public async Task<IActionResult> GetVersionDownloads(string id, string versionId, [FromQuery] string source = "modrinth")
    {
        return source.ToLowerInvariant() switch
        {
            "ftb" => await GetFtbVersionDownloads(id, versionId),
            _ => NotFound(new { error = "Version downloads endpoint is only implemented for FTB." }),
        };
    }

    [HttpPost("{id}/versions/start-fetch")]
    public async Task<IActionResult> StartCurseForgeVersionFetch(string id,
        [FromQuery] string? gameVersion = null, [FromQuery] string? loader = null)
    {
        try
        {
            var query = $"/v1/mods/{Uri.EscapeDataString(id)}/files?pageSize=50";
            if (!string.IsNullOrWhiteSpace(gameVersion))
                query += $"&gameVersion={Uri.EscapeDataString(gameVersion)}";

            var normalizedLoader = !string.IsNullOrWhiteSpace(loader) ? loader.Trim().ToLowerInvariant() : null;

            async Task<JsonObject?> FetchJson(int index)
            {
                var req = new HttpRequestMessage(HttpMethod.Get, ModApiMirror.MirrorCurseForge($"{query}&index={index}"));
                req.Headers.Add("x-api-key", _cfApiKey);
                var resp = await _curseforge.SendAsync(req);
                resp.EnsureSuccessStatusCode();
                return await resp.Content.ReadFromJsonAsync<JsonObject>();
            }

            var firstJson = await FetchJson(0);
            var firstData = firstJson?["data"]?.AsArray();
            var totalCount = firstJson?["pagination"]?["totalCount"]?.GetValue<int>() ?? 0;

            var taskId = Guid.NewGuid().ToString();
            if (firstData == null || firstData.Count == 0 || totalCount == 0)
            {
                CfFetchStates[taskId] = new CurseForgeVersionFetchState
                { TotalVersionCount = 0, LoadedVersionCount = 0, Done = true, Results = [] };
                return Ok(new { taskId, totalVersionCount = 0, loadedVersionCount = 0 });
            }

            var parsedResults = new List<ResourceVersion>();
            foreach (var f in firstData)
                parsedResults.Add(ParseCurseForgeFile(id, f));
            if (normalizedLoader != null)
            {
                parsedResults = parsedResults.Where(v =>
                    v.Loaders.Count == 0 ||
                    v.Loaders.Any(l => l.Equals(normalizedLoader, StringComparison.OrdinalIgnoreCase))
                ).ToList();
            }
            var loadedCount = parsedResults.Count;
            var estimatedTotal = totalCount;
            if (normalizedLoader != null && firstData.Count > 0)
            {
                estimatedTotal = (int)Math.Ceiling((double)totalCount * loadedCount / firstData.Count);
            }

            var state = new CurseForgeVersionFetchState
            {
                TotalVersionCount = estimatedTotal,
                LoadedVersionCount = loadedCount,
                Results = parsedResults,
            };
            CfFetchStates[taskId] = state;

            var pageSize = 50;
            var totalPages = (totalCount + pageSize - 1) / pageSize;

            _ = Task.Run(async () =>
            {
                try
                {
                    var pageIndices = Enumerable.Range(1, totalPages - 1).Select(p => p * pageSize).ToArray();
                    var semaphore = new SemaphoreSlim(5);
                    var fetchTasks = pageIndices.Select(async index =>
                    {
                        await semaphore.WaitAsync();
                        try
                        {
                            var json = await FetchJson(index);
                            var data = json?["data"]?.AsArray();
                            if (data == null) return;
                            var batch = new List<ResourceVersion>();
                            foreach (var f in data)
                                batch.Add(ParseCurseForgeFile(id, f));
                            if (normalizedLoader != null)
                            {
                                batch = batch.Where(v =>
                                    v.Loaders.Count == 0 ||
                                    v.Loaders.Any(l => l.Equals(normalizedLoader, StringComparison.OrdinalIgnoreCase))
                                ).ToList();
                            }
                            lock (state)
                            {
                                state.Results!.AddRange(batch);
                                state.LoadedVersionCount += batch.Count;
                            }
                        }
                        finally { semaphore.Release(); }
                    }).ToList();

                    await Task.WhenAll(fetchTasks);
                    state.Done = true;
                }
                catch (Exception ex)
                {
                    state.Error = ex.Message;
                    state.Done = true;
                }
            });

            return Ok(new { taskId, totalVersionCount = estimatedTotal, loadedVersionCount = loadedCount });
        }
        catch (Exception ex)
        {
            return StatusCode(502, new { error = $"CurseForge API error: {ex.Message}" });
        }
    }

    [HttpGet("versions/fetch-progress/{taskId}")]
    public IActionResult GetCurseForgeVersionFetchProgress(string taskId)
    {
        if (CfFetchStates.TryGetValue(taskId, out var state))
            return Ok(new { loadedVersionCount = state.LoadedVersionCount, totalVersionCount = state.TotalVersionCount, done = state.Done });
        return NotFound();
    }

    [HttpGet("versions/fetch-result/{taskId}")]
    public IActionResult GetCurseForgeVersionFetchResult(string taskId)
    {
        if (CfFetchStates.TryGetValue(taskId, out var state) && state.Done)
        {
            var results = state.Results ?? [];
            CfFetchStates.TryRemove(taskId, out _);
            return Ok(results);
        }
        return NotFound();
    }

    [HttpGet("{id}/translate")]
    public async Task<IActionResult> GetTranslate(string id, [FromQuery] string source = "modrinth")
    {
        try
        {
            using var client = new HttpClient { Timeout = TimeSpan.FromSeconds(10) };
            client.DefaultRequestHeaders.UserAgent.ParseAdd("QomicexLauncher/1.0");
            var url = source.ToLowerInvariant() switch
            {
                "curseforge" => $"https://mod.mcimirror.top/translate/curseforge/{id}",
                _ => $"https://mod.mcimirror.top/translate/modrinth/{id}",
            };
            var response = await client.GetAsync(url);
            if (!response.IsSuccessStatusCode)
                return NotFound(new { code = "TRANSLATE_NOT_FOUND", message = "Translation not found" });

            var json = await response.Content.ReadFromJsonAsync<JsonObject>();
            return Ok(json);
        }
        catch (Exception ex)
        {
            return StatusCode(502, new { code = "TRANSLATE_ERROR", message = $"Translation API error: {ex.Message}" });
        }
    }

    [HttpGet("{id}/dependencies")]
    public async Task<IActionResult> GetDependencies(string id,
        [FromQuery] string source = "modrinth",
        [FromQuery] string? versionId = null,
        [FromQuery] string? gameVersion = null,
        [FromQuery] string? loader = null)
    {
        if (source != "modrinth")
            return Ok(Array.Empty<object>()); // ponytail: only Modrinth deps for now

        try
        {
            var visited = new HashSet<string>();
            var result = new List<ResolvedDependency>();

            await ResolveModrinthDependencies(id, gameVersion, loader, visited, result, 0);
            return Ok(result);
        }
        catch (Exception ex)
        {
            return StatusCode(502, new { error = $"Modrinth API error: {ex.Message}" });
        }
    }

    private async Task ResolveModrinthDependencies(string projectId, string? gameVersion, string? loader,
        HashSet<string> visited, List<ResolvedDependency> result, int depth)
    {
        // ponytail: hard limit at depth 5 to prevent runaway recursion
        if (depth > 5 || !visited.Add(projectId)) return;

        List<ModrinthVersion>? versions;
        try
        {
            versions = await _modrinth.GetFromJsonAsync<List<ModrinthVersion>>(
                ModApiMirror.MirrorModrinth($"https://api.modrinth.com/v2/project/{Uri.EscapeDataString(projectId)}/version"));
        }
        catch
        {
            return;
        }

        if (versions == null || versions.Count == 0) return;

        var best = versions
            .Where(v => (gameVersion == null || v.GameVersions?.Contains(gameVersion) == true)
                     && (loader == null || v.Loaders == null || v.Loaders.Count == 0 || v.Loaders.Contains(loader)))
            .MaxBy(v => v.DatePublished);

        // fallback to latest overall
        best ??= versions.MaxBy(v => v.DatePublished);
        if (best == null) return;

        var primaryFile = best.Files?.FirstOrDefault(f => f.Url != null);
        if (primaryFile == null) return;

        // fetch project info for name/icon (skip root — depth 0 is the mod itself)
        string name = projectId, iconUrl = "";
        if (depth > 0)
        {
            try
            {
                var proj = await _modrinth.GetFromJsonAsync<ModrinthProject>(
                    ModApiMirror.MirrorModrinth($"https://api.modrinth.com/v2/project/{Uri.EscapeDataString(projectId)}"));
                if (proj != null)
                {
                    name = proj.Title ?? projectId;
                    iconUrl = proj.IconUrl ?? "";
                    var pt = proj.ProjectType ?? "mod";
                    var cat = pt switch { "mod" => "mods", "resourcepack" => "resourcepacks", "shader" => "shaderpacks", _ => "mods" };

                    result.Add(new ResolvedDependency
                    {
                        ProjectId = projectId,
                        Name = name,
                        IconUrl = iconUrl,
                        VersionId = best.Id ?? "",
                        VersionNumber = best.VersionNumber ?? "",
                        DownloadUrl = primaryFile.Url!,
                        FileName = primaryFile.Filename ?? Path.GetFileName(primaryFile.Url) ?? "unknown",
                        Category = cat,
                    });
                }
            }
            catch { /* skip if project info fails */ }
        }

        // recurse into required dependencies
        if (best.Dependencies != null)
        {
            var tasks = best.Dependencies
                .Where(d => d.DependencyType == "required" && d.ProjectId != null)
                .Select(d => ResolveModrinthDependencies(d.ProjectId!, gameVersion, loader, visited, result, depth + 1));
            await Task.WhenAll(tasks);
        }
    }

    private async Task<IActionResult> GetFtbVersions(string id)
    {
        if (!int.TryParse(id, out var packId))
            return BadRequest(new { error = "FTB pack id must be numeric" });

        try
        {
            var versions = await _ftbService.GetVersionsAsync(packId);
            var result = versions.Select(version => new ResourceVersion
            {
                Id = version.Id.ToString(),
                Name = version.Name,
                VersionNumber = version.Name,
                GameVersions = version.Targets
                    .Where(target => target.Type == "game" && !string.IsNullOrWhiteSpace(target.Version))
                    .Select(target => target.Version)
                    .Distinct()
                    .ToList(),
                Loaders = version.Targets
                    .Where(target => target.Type == "modloader" && !string.IsNullOrWhiteSpace(target.Name))
                    .Select(target => target.Name)
                    .Distinct(StringComparer.OrdinalIgnoreCase)
                    .ToList(),
                Downloads = [],
                DatePublished = DateTimeOffset.FromUnixTimeSeconds(version.Released).UtcDateTime,
            }).ToList();

            return Ok(result);
        }
        catch (Exception ex)
        {
            return StatusCode(502, new { error = $"FTB API error: {ex.Message}" });
        }
    }

    private async Task<IActionResult> GetFtbVersionDownloads(string id, string versionId)
    {
        if (!int.TryParse(id, out var packId))
            return BadRequest(new { error = "FTB pack id must be numeric" });
        if (!int.TryParse(versionId, out var parsedVersionId))
            return BadRequest(new { error = "FTB version id must be numeric" });

        try
        {
            var detail = await _ftbService.GetVersionDetailAsync(packId, parsedVersionId);
            if (detail == null)
                return NotFound(new { error = "FTB version not found" });

            var files = detail.Files
                .Where(file => !string.IsNullOrWhiteSpace(file.Url))
                .Select(file => new ResourceFile
                {
                    Url = file.Url,
                    Filename = file.Name,
                    Size = file.Size,
                })
                .ToList();

            return Ok(files);
        }
        catch (Exception ex)
        {
            return StatusCode(502, new { error = $"FTB API error: {ex.Message}" });
        }
    }

    private static string GetFtbLatestVersionName(FtbModpack pack)
    {
        return pack.Versions
            .Where(version => string.Equals(version.Type, "release", StringComparison.OrdinalIgnoreCase))
            .OrderByDescending(version => version.Updated)
            .Select(version => version.Name)
            .FirstOrDefault() ?? "";
    }

    private static string GetFtbIconUrl(FtbModpack pack)
    {
        return pack.Art.FirstOrDefault(art => string.Equals(art.Type, "square", StringComparison.OrdinalIgnoreCase))?.Url
            ?? pack.Art.FirstOrDefault(art => string.Equals(art.Type, "icon", StringComparison.OrdinalIgnoreCase))?.Url
            ?? pack.Art.FirstOrDefault()?.Url
            ?? "";
    }

    private static string GetFtbProjectUrl(FtbModpack pack)
    {
        return pack.Links.FirstOrDefault(link => string.Equals(link.Type, "website", StringComparison.OrdinalIgnoreCase))?.Url
            ?? pack.Links.FirstOrDefault(link => !string.IsNullOrWhiteSpace(link.Url))?.Url
            ?? "";
    }

    private async Task<IActionResult> GetModrinthVersions(string id, string? gameVersion, string? loader)
    {
        var url = ModApiMirror.MirrorModrinth($"https://api.modrinth.com/v2/project/{Uri.EscapeDataString(id)}/version");
        try
        {
            var versions = await _modrinth.GetFromJsonAsync<List<ModrinthVersion>>(url);
            if (versions == null)
                return Ok(Array.Empty<object>());

            var filtered = versions.AsEnumerable();
            if (!string.IsNullOrWhiteSpace(gameVersion))
                filtered = filtered.Where(v => v.GameVersions?.Contains(gameVersion) == true);
            if (!string.IsNullOrWhiteSpace(loader))
                filtered = filtered.Where(v => v.Loaders == null || v.Loaders.Count == 0 || v.Loaders.Contains(loader));

            var result = filtered.Select(v => new ResourceVersion
            {
                Id = v.Id ?? "",
                Name = v.Name ?? "",
                VersionNumber = v.VersionNumber ?? "",
                GameVersions = v.GameVersions ?? [],
                Loaders = v.Loaders ?? [],
                Downloads = v.Files?.Select(f => new ResourceFile
                {
                    Url = f.Url ?? "", Filename = f.Filename ?? "", Size = f.Size,
                }).ToList() ?? [],
                Dependencies = v.Dependencies?.Select(d => new ModrinthDependency
                {
                    VersionId = d.VersionId,
                    ProjectId = d.ProjectId,
                    FileName = d.FileName,
                    DependencyType = d.DependencyType,
                }).ToList() ?? [],
                DatePublished = v.DatePublished,
            }).ToList();

            return Ok(result);
        }
        catch (Exception ex)
        {
            return StatusCode(502, new { error = $"Modrinth API error: {ex.Message}" });
        }
    }

    private async Task<IActionResult> GetCurseForgeVersions(string id, string? gameVersion, string? loader)
    {
        try
        {
            var query = $"/v1/mods/{Uri.EscapeDataString(id)}/files?pageSize=50";
            if (!string.IsNullOrWhiteSpace(gameVersion))
                query += $"&gameVersion={Uri.EscapeDataString(gameVersion)}";

            async Task<(JsonArray? Data, int TotalCount)> FetchPage(int index)
            {
                var req = new HttpRequestMessage(HttpMethod.Get, ModApiMirror.MirrorCurseForge($"{query}&index={index}"));
                req.Headers.Add("x-api-key", _cfApiKey);
                var resp = await _curseforge.SendAsync(req);
                resp.EnsureSuccessStatusCode();
                var json = await resp.Content.ReadFromJsonAsync<JsonObject>();
                var totalCount = json?["pagination"]?["totalCount"]?.GetValue<int>() ?? 0;
                return (json?["data"]?.AsArray(), totalCount);
            }

            var (firstData, totalCount) = await FetchPage(0);
            if (firstData == null || firstData.Count == 0 || totalCount == 0)
                return Ok(Array.Empty<ResourceVersion>());

            var allResults = new List<ResourceVersion>();
            var pageSize = 50;
            var totalPages = (totalCount + pageSize - 1) / pageSize;
            var pageIndices = Enumerable.Range(0, totalPages).Select(p => p * pageSize).ToArray();

            var semaphore = new SemaphoreSlim(5);
            var fetchTasks = pageIndices.Select(async index =>
            {
                await semaphore.WaitAsync();
                try { return await FetchPage(index); }
                finally { semaphore.Release(); }
            }).ToList();

            var pages = await Task.WhenAll(fetchTasks);
            foreach (var (data, _) in pages)
            {
                if (data == null) continue;
                foreach (var f in data)
                    allResults.Add(ParseCurseForgeFile(id, f));
            }

            if (!string.IsNullOrWhiteSpace(loader))
            {
                var normalized = loader.Trim().ToLowerInvariant();
                allResults = allResults.Where(v =>
                    v.Loaders.Count == 0 ||
                    v.Loaders.Any(l => l.Equals(normalized, StringComparison.OrdinalIgnoreCase))
                ).ToList();
            }

            return Ok(allResults);
        }
        catch (Exception ex)
        {
            return StatusCode(502, new { error = $"CurseForge API error: {ex.Message}" });
        }
    }

    private static int? CurseForgeLoaderToId(string loader)
    {
        return loader.Trim().ToLowerInvariant() switch
        {
            "forge" => 1,
            "liteloader" => 3,
            "fabric" => 4,
            "quilt" => 5,
            "neoforge" => 6,
            _ => null,
        };
    }

    private static ResourceVersion ParseCurseForgeFile(string modId, JsonNode? f)
    {
        return new ResourceVersion
        {
            Id = f?["id"]?.GetValue<int>().ToString() ?? "",
            Name = f?["displayName"]?.GetValue<string>() ?? "",
            VersionNumber = f?["fileName"]?.GetValue<string>() ?? "",
            GameVersions = ExtractCurseForgeGameVersions(f?["gameVersions"]?.AsArray()),
            Loaders = ExtractCurseForgeLoaders(
                f?["gameVersions"]?.AsArray(),
                f?["sortableGameVersions"]?.AsArray(),
                f?["modLoader"]?.GetValue<int?>()),
            Downloads = [new ResourceFile
            {
                Url = f?["downloadUrl"]?.GetValue<string>() ?? "",
                Filename = f?["fileName"]?.GetValue<string>() ?? "",
                Size = f?["fileLength"]?.GetValue<long>() ?? 0,
            }],
            DatePublished = f?["fileDate"]?.GetValue<DateTime>() ?? DateTime.MinValue,
            Dependencies = f?["dependencies"] is JsonArray depArr
                ? depArr
                    .Where(d => d?["relationType"]?.GetValue<int>() == 1)
                    .Select(d => new ModrinthDependency
                    {
                        ProjectId = d!["modId"]?.GetValue<int>().ToString() ?? "",
                        DependencyType = "required",
                    }).ToList()
                : [],
        };
    }

    private async Task<string> GetModrinthPrimaryAuthorAsync(string teamId)
    {
        try
        {
            var members = await _modrinth.GetFromJsonAsync<List<ModrinthTeamMember>>($"https://api.modrinth.com/v2/team/{Uri.EscapeDataString(teamId)}/members");
            return members?.Select(member => member.User?.Username)
                .FirstOrDefault(username => !string.IsNullOrWhiteSpace(username)) ?? "";
        }
        catch
        {
            return "";
        }
    }

    private static List<string> ExtractCurseForgeGameVersions(JsonArray? gameVersions)
    {
        return gameVersions?
            .Select(version => version?.GetValue<string>())
            .Where(version => !string.IsNullOrWhiteSpace(version) && IsMinecraftVersion(version!))
            .Select(version => version!)
            .Distinct(StringComparer.OrdinalIgnoreCase)
            .ToList() ?? [];
    }

    private static List<string> ExtractCurseForgeLoaders(JsonArray? gameVersions, JsonArray? sortableGameVersions, int? modLoaderValue)
    {
        var loaders = new List<string>();

        loaders.AddRange(gameVersions?
            .Select(version => version?.GetValue<string>())
            .Where(version => !string.IsNullOrWhiteSpace(version) && !IsMinecraftVersion(version!))
            .Select(NormalizeCurseForgeLoader)
            .Where(loader => !string.IsNullOrWhiteSpace(loader))
            .Cast<string>() ?? []);

        loaders.AddRange(sortableGameVersions?
            .Select(item => item?.AsObject())
            .Where(item => item != null)
            .Select(item => item!["gameVersionPadded"]?.GetValue<string>() ?? item["gameVersion"]?.GetValue<string>())
            .Where(version => !string.IsNullOrWhiteSpace(version) && !IsMinecraftVersion(version!))
            .Select(NormalizeCurseForgeLoader)
            .Where(loader => !string.IsNullOrWhiteSpace(loader))
            .Cast<string>() ?? []);

        var modLoader = modLoaderValue switch
        {
            1 => "forge",
            3 => "liteloader",
            4 => "fabric",
            5 => "quilt",
            6 => "neoforge",
            _ => null,
        };

        if (!string.IsNullOrWhiteSpace(modLoader))
            loaders.Add(modLoader);

        return loaders
            .Distinct(StringComparer.OrdinalIgnoreCase)
            .ToList();
    }

    private static bool IsMinecraftVersion(string value)
    {
        return value.Length > 0 && char.IsDigit(value[0]);
    }

    private static string? NormalizeCurseForgeLoader(string? value)
    {
        if (string.IsNullOrWhiteSpace(value))
            return null;

        return value.Trim().ToLowerInvariant() switch
        {
            "forge" => "forge",
            "fabric" => "fabric",
            "quilt" => "quilt",
            "neoforge" => "neoforge",
            "neo forge" => "neoforge",
            "liteloader" => "liteloader",
            _ => null,
        };
    }
}

#pragma warning disable IDE1006

public class ResourceSearchResponse
{
    public List<ResourceItem> Items { get; set; } = [];
    public long Total { get; set; }
    public int Page { get; set; }
    public int PageSize { get; set; }
}

public class ResourceItem
{
    public string Id { get; set; } = "";
    public string Title { get; set; } = "";
    public string Description { get; set; } = "";
    public string Author { get; set; } = "";
    public string IconUrl { get; set; } = "";
    public long DownloadCount { get; set; }
    public string Source { get; set; } = "";
    public List<string> Categories { get; set; } = [];
    public string ProjectUrl { get; set; } = "";
    public string Slug { get; set; } = "";
    public string LatestVersion { get; set; } = "";
}

public class ResourceDetail : ResourceItem
{
    public string Body { get; set; } = "";
}

public class ResourceVersion
{
    public string Id { get; set; } = "";
    public string Name { get; set; } = "";
    public string VersionNumber { get; set; } = "";
    public List<string> GameVersions { get; set; } = [];
    public List<string> Loaders { get; set; } = [];
    public List<ResourceFile> Downloads { get; set; } = [];
    public List<ModrinthDependency> Dependencies { get; set; } = [];
    public DateTime DatePublished { get; set; }
}

public class ResourceFile
{
    public string Url { get; set; } = "";
    public string Filename { get; set; } = "";
    public long Size { get; set; }
}

public class ModrinthSearchResponse
{
    [JsonPropertyName("hits")]
    public List<ModrinthHit> Hits { get; set; } = [];
    [JsonPropertyName("total_hits")]
    public long TotalHits { get; set; }
}

public class ModrinthHit
{
    [JsonPropertyName("project_id")] public string? ProjectId { get; set; }
    [JsonPropertyName("title")] public string? Title { get; set; }
    [JsonPropertyName("description")] public string? Description { get; set; }
    [JsonPropertyName("author")] public string? Author { get; set; }
    [JsonPropertyName("icon_url")] public string? IconUrl { get; set; }
    [JsonPropertyName("downloads")] public long Downloads { get; set; }
    [JsonPropertyName("categories")] public List<string>? Categories { get; set; }
    [JsonPropertyName("slug")] public string? Slug { get; set; }
    [JsonPropertyName("latest_version")] public string? LatestVersion { get; set; }
}

public class ModrinthProject
{
    [JsonPropertyName("id")] public string? Id { get; set; }
    [JsonPropertyName("title")] public string? Title { get; set; }
    [JsonPropertyName("description")] public string? Description { get; set; }
    [JsonPropertyName("body")] public string? Body { get; set; }
    [JsonPropertyName("author")] public string? Author { get; set; }
    [JsonPropertyName("team")] public string? Team { get; set; }
    [JsonPropertyName("icon_url")] public string? IconUrl { get; set; }
    [JsonPropertyName("downloads")] public long Downloads { get; set; }
    [JsonPropertyName("categories")] public List<string>? Categories { get; set; }
    [JsonPropertyName("slug")] public string? Slug { get; set; }
    [JsonPropertyName("project_type")] public string? ProjectType { get; set; }
    [JsonPropertyName("latest_version")] public string? LatestVersion { get; set; }
}

public class ModrinthVersion
{
    [JsonPropertyName("id")] public string? Id { get; set; }
    [JsonPropertyName("name")] public string? Name { get; set; }
    [JsonPropertyName("version_number")] public string? VersionNumber { get; set; }
    [JsonPropertyName("game_versions")] public List<string>? GameVersions { get; set; }
    [JsonPropertyName("loaders")] public List<string>? Loaders { get; set; }
    [JsonPropertyName("files")] public List<ModrinthFile>? Files { get; set; }
    [JsonPropertyName("dependencies")] public List<ModrinthDependency>? Dependencies { get; set; }
    [JsonPropertyName("date_published")] public DateTime DatePublished { get; set; }
}

public class ModrinthDependency
{
    [JsonPropertyName("version_id")] public string? VersionId { get; set; }
    [JsonPropertyName("project_id")] public string? ProjectId { get; set; }
    [JsonPropertyName("file_name")] public string? FileName { get; set; }
    [JsonPropertyName("dependency_type")] public string? DependencyType { get; set; }
}

public class ResolvedDependency
{
    public string ProjectId { get; set; } = "";
    public string Name { get; set; } = "";
    public string IconUrl { get; set; } = "";
    public string VersionId { get; set; } = "";
    public string VersionNumber { get; set; } = "";
    public string DownloadUrl { get; set; } = "";
    public string FileName { get; set; } = "";
    public string Category { get; set; } = "mods";
}

public class ModrinthFile
{
    [JsonPropertyName("url")] public string? Url { get; set; }
    [JsonPropertyName("filename")] public string? Filename { get; set; }
    [JsonPropertyName("size")] public long Size { get; set; }
}

public class ModrinthTeamMember
{
    [JsonPropertyName("user")]
    public ModrinthTeamUser? User { get; set; }
}

public class ModrinthTeamUser
{
    [JsonPropertyName("username")]
    public string? Username { get; set; }
}
