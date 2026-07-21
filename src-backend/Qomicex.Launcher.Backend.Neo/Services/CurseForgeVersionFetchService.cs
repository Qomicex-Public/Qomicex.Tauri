using System.Collections.Concurrent;
using System.Text.Json.Nodes;
using Qomicex.Launcher.Backend.Neo.JsonContext;

namespace Qomicex.Launcher.Backend.Neo.Services;

public sealed class CurseForgeVersionFetchService
{
    private readonly ConcurrentDictionary<string, FetchState> _states = new();
    private readonly IHttpClientFactory _httpClientFactory;
    private readonly string _apiKey;

    public CurseForgeVersionFetchService(IHttpClientFactory httpClientFactory, string apiKey)
    {
        _httpClientFactory = httpClientFactory;
        _apiKey = apiKey;
    }

    public string Start(string modId, string? gameVersion, string? loader, int maxConcurrency = 5)
    {
        var taskId = Guid.NewGuid().ToString();
        var normalizedLoader = loader?.Trim().ToLowerInvariant();

        var state = new FetchState();
        _states[taskId] = state;

        Task.Run(async () =>
        {
            try
            {
                var http = _httpClientFactory.CreateClient("CurseForge");

                async Task<(List<JsonObject?> Data, int Total)> FetchPage(int index)
                {
                    var url = $"https://api.curseforge.com/v1/mods/{Uri.EscapeDataString(modId)}/files?pageSize=50&index={index}";
                    if (!string.IsNullOrEmpty(gameVersion))
                        url += $"&gameVersion={Uri.EscapeDataString(gameVersion)}";
                    using var req = new HttpRequestMessage(HttpMethod.Get, url);
                    req.Headers.Add("x-api-key", _apiKey);
                    req.Headers.Accept.ParseAdd("application/json");
                    var resp = await http.SendAsync(req);
                    resp.EnsureSuccessStatusCode();
                    var json = JsonNode.Parse(await resp.Content.ReadAsStringAsync());
                    var total = json?["pagination"]?["totalCount"]?.GetValue<int>() ?? 0;
                    return (json?["data"]?.AsArray()?.Select(n => n?.AsObject()).ToList() ?? [], total);
                }

                var (firstData, totalCount) = await FetchPage(0);
                var allItems = new List<JsonObject?>(firstData);

                if (totalCount > 50)
                {
                    var totalPages = (totalCount + 49) / 50;
                    var sem = new SemaphoreSlim(maxConcurrency);
                    var tasks = Enumerable.Range(1, totalPages - 1).Select(async p =>
                    {
                        await sem.WaitAsync();
                        try { var (data, _) = await FetchPage(p * 50); return data; }
                        finally { sem.Release(); }
                    }).ToList();
                    var pages = await Task.WhenAll(tasks);
                    foreach (var p in pages) allItems.AddRange(p);
                }

                var parsed = allItems
                    .Where(f => f is not null)
                    .Select(f => ParseCfFile(modId, f!))
                    .Where(v => MatchVersionLoader(v, gameVersion, normalizedLoader))
                    .ToList();

                state.Results.AddRange(parsed);
                state.LoadedVersionCount = parsed.Count;
                state.TotalVersionCount = totalCount;
                state.Done = true;
            }
            catch (Exception ex)
            {
                state.Error = ex.Message;
                state.TotalVersionCount = state.LoadedVersionCount;
                state.Done = true;
            }
        });

        return taskId;
    }

    public FetchState? GetProgress(string taskId)
    {
        _states.TryGetValue(taskId, out var state);
        return state;
    }

    public FetchState? GetResult(string taskId)
    {
        if (_states.TryGetValue(taskId, out var state) && state.Done)
        {
            _states.TryRemove(taskId, out _);
            return state;
        }
        return null;
    }

    private static ResourceVersionDto ParseCfFile(string modId, JsonObject f)
    {
        return new ResourceVersionDto(
            Id: f["id"]?.GetValue<int>().ToString() ?? "",
            Name: f["displayName"]?.GetValue<string>() ?? f["fileName"]?.GetValue<string>() ?? f["id"]?.GetValue<int>().ToString() ?? "",
            VersionNumber: f["fileName"]?.GetValue<string>() ?? "",
            GameVersions: f["gameVersions"]?.AsArray()
                ?.Select(gv => gv?.GetValue<string>())
                .Where(v => !string.IsNullOrEmpty(v))
                .Select(v => v!)
                .ToList() ?? [],
            Loaders: ExtractCFLoaders(f["gameVersions"]?.AsArray(), f["modLoader"]?.GetValue<int>()),
            Downloads: [new ResourceFileDto(
                f["downloadUrl"]?.GetValue<string>() ?? "",
                f["fileName"]?.GetValue<string>() ?? "",
                f["fileLength"]?.GetValue<long>() ?? 0
            )],
            Dependencies: f["dependencies"] is JsonArray depArr
                ? depArr
                    .Where(d => d?["relationType"]?.GetValue<int>() == 3)
                    .Select(d => new ResourceDependencyDto(null, d!["modId"]?.GetValue<int>().ToString() ?? "", null, "required"))
                    .ToList()
                : null,
            DatePublished: f["fileDate"]?.GetValue<DateTimeOffset>().ToString("o")
        );
    }

    private static List<string> ExtractCFLoaders(JsonArray? gameVersions, int? modLoader)
    {
        var loaders = new List<string>();
        if (gameVersions is not null)
        {
            foreach (var gv in gameVersions)
            {
                var s = gv?.GetValue<string>()?.ToLowerInvariant().Trim();
                if (s is "forge" or "fabric" or "quilt" or "neoforge" or "liteloader" or "neo forge")
                    loaders.Add(s == "neo forge" ? "neoforge" : s);
            }
        }
        var ml = modLoader switch { 1 => "forge", 3 => "liteloader", 4 => "fabric", 5 => "quilt", 6 => "neoforge", _ => null };
        if (ml is not null) loaders.Add(ml);
        return loaders.Distinct(StringComparer.OrdinalIgnoreCase).ToList();
    }

    private static bool MatchVersionLoader(ResourceVersionDto v, string? gameVersion, string? loader)
    {
        if (!string.IsNullOrEmpty(gameVersion) &&
            !v.GameVersions.Contains(gameVersion, StringComparer.OrdinalIgnoreCase))
            return false;
        if (!string.IsNullOrEmpty(loader) &&
            v.Loaders.Count > 0 &&
            !v.Loaders.Any(l => l.Equals(loader, StringComparison.OrdinalIgnoreCase)))
            return false;
        return true;
    }
}

public sealed class FetchState
{
    public int TotalVersionCount { get; set; }
    public int LoadedVersionCount { get; set; }
    public bool Done { get; set; }
    public string? Error { get; set; }
    public List<ResourceVersionDto> Results { get; set; } = [];
}
