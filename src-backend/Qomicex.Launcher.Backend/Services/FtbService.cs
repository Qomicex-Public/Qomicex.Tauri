using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text.Json.Serialization;
using System.Text.Json;

namespace Qomicex.Launcher.Backend.Services;

public class FtbService
{
    private readonly IHttpClientFactory _httpClientFactory;
    private readonly SemaphoreSlim _cacheLock = new(1, 1);
    private List<FtbModpack> _cache = [];
    private DateTimeOffset _cacheExpiresAt = DateTimeOffset.MinValue;
    private static readonly string CacheFilePath = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
        "Qomicex",
        "ftb_cache.json");

    public FtbService(IHttpClientFactory httpClientFactory)
    {
        _httpClientFactory = httpClientFactory;
    }

    public async Task<(List<FtbModpack> Items, long Total)> SearchAsync(string? keyword, int page, int pageSize, string sort)
    {
        var allPacks = await GetAllPacksAsync();
        IEnumerable<FtbModpack> query = allPacks;

        if (!string.IsNullOrWhiteSpace(keyword))
        {
            var normalizedKeyword = keyword.Trim();
            query = query.Where(pack =>
                pack.Name.Contains(normalizedKeyword, StringComparison.OrdinalIgnoreCase) ||
                pack.Synopsis.Contains(normalizedKeyword, StringComparison.OrdinalIgnoreCase));
        }

        query = sort.ToLowerInvariant() switch
        {
            "downloads" => query.OrderByDescending(pack => pack.Installs),
            "updated" => query.OrderByDescending(pack => pack.Updated),
            "newest" => query.OrderByDescending(pack => pack.Released),
            "name" => query.OrderBy(pack => pack.Name),
            _ => query.OrderByDescending(pack => pack.Featured ?? false)
                      .ThenByDescending(pack => pack.Plays14d)
                      .ThenByDescending(pack => pack.Plays),
        };

        var total = query.LongCount();
        var paged = query.Skip((page - 1) * pageSize).Take(pageSize).ToList();
        return (paged, total);
    }

    public async Task<FtbModpack?> GetPackAsync(int id)
    {
        var cached = await GetAllPacksAsync();
        var pack = cached.FirstOrDefault(item => item.Id == id);
        return pack ?? await GetJsonAsync<FtbModpack>($"modpack/{id}");
    }

    public async Task<List<FtbVersion>> GetVersionsAsync(int packId)
    {
        var pack = await GetPackAsync(packId);
        if (pack?.Versions == null || pack.Versions.Count == 0)
            return [];

        return pack.Versions
            .OrderByDescending(version => version.Updated)
            .Take(20)
            .ToList();
    }

    public async Task<FtbVersionDetail?> GetVersionDetailAsync(int packId, int versionId)
    {
        return await GetJsonAsync<FtbVersionDetail>($"modpack/{packId}/{versionId}");
    }

    private async Task<List<FtbModpack>> GetAllPacksAsync()
    {
        if (_cache.Count > 0 && DateTimeOffset.UtcNow < _cacheExpiresAt)
            return _cache;

        await _cacheLock.WaitAsync();
        try
        {
            if (_cache.Count > 0 && DateTimeOffset.UtcNow < _cacheExpiresAt)
                return _cache;

            if (_cache.Count == 0 && File.Exists(CacheFilePath))
            {
                try
                {
                    var json = await File.ReadAllTextAsync(CacheFilePath);
                    var cached = JsonSerializer.Deserialize<FtbCacheData>(json);
                    if (cached?.Modpacks != null && cached.Modpacks.Count > 0)
                    {
                        _cache = cached.Modpacks;
                        _cacheExpiresAt = DateTimeOffset.FromUnixTimeSeconds(cached.SavedAt).AddHours(1);
                        if (DateTimeOffset.UtcNow < _cacheExpiresAt)
                            return _cache;
                    }
                }
                catch
                {
                }
            }

            var idsResponse = await GetJsonAsync<FtbPackListResponse>("modpack/all");
            var ids = idsResponse?.Packs ?? [];
            if (ids.Count == 0)
            {
                _cache = [];
                _cacheExpiresAt = DateTimeOffset.UtcNow.AddHours(1);
                return _cache;
            }

            var semaphore = new SemaphoreSlim(8, 8);
            var tasks = ids.Select(async id =>
            {
                await semaphore.WaitAsync();
                try
                {
                    return await GetJsonAsync<FtbModpack>($"modpack/{id}");
                }
                catch
                {
                    return null;
                }
                finally
                {
                    semaphore.Release();
                }
            });

            var results = await Task.WhenAll(tasks);
            _cache = results.Where(result => result != null).Cast<FtbModpack>().ToList();
            _cacheExpiresAt = DateTimeOffset.UtcNow.AddHours(1);

            try
            {
                var directory = Path.GetDirectoryName(CacheFilePath);
                if (!string.IsNullOrWhiteSpace(directory))
                    Directory.CreateDirectory(directory);

                var payload = new FtbCacheData
                {
                    SavedAt = DateTimeOffset.UtcNow.ToUnixTimeSeconds(),
                    Modpacks = _cache,
                };
                await File.WriteAllTextAsync(CacheFilePath, JsonSerializer.Serialize(payload));
            }
            catch
            {
            }

            return _cache;
        }
        finally
        {
            _cacheLock.Release();
        }
    }

    private async Task<T?> GetJsonAsync<T>(string path)
    {
        var client = _httpClientFactory.CreateClient("FTB");
        return await client.GetFromJsonAsync<T>(path);
    }
}

public class FtbCacheData
{
    public long SavedAt { get; set; }
    public List<FtbModpack> Modpacks { get; set; } = [];
}

public class FtbPackListResponse
{
    [JsonPropertyName("packs")]
    public List<int> Packs { get; set; } = [];
}

public class FtbModpack
{
    [JsonPropertyName("id")]
    public int Id { get; set; }

    [JsonPropertyName("name")]
    public string Name { get; set; } = "";

    [JsonPropertyName("slug")]
    public string Slug { get; set; } = "";

    [JsonPropertyName("synopsis")]
    public string Synopsis { get; set; } = "";

    [JsonPropertyName("description")]
    public string Description { get; set; } = "";

    [JsonPropertyName("featured")]
    public bool? Featured { get; set; }

    [JsonPropertyName("plays")]
    public long Plays { get; set; }

    [JsonPropertyName("installs")]
    public long Installs { get; set; }

    [JsonPropertyName("plays_14d")]
    public long Plays14d { get; set; }

    [JsonPropertyName("updated")]
    public long Updated { get; set; }

    [JsonPropertyName("released")]
    public long Released { get; set; }

    [JsonPropertyName("tags")]
    public List<FtbTag> Tags { get; set; } = [];

    [JsonPropertyName("versions")]
    public List<FtbVersion> Versions { get; set; } = [];

    [JsonPropertyName("authors")]
    public List<FtbAuthor> Authors { get; set; } = [];

    [JsonPropertyName("links")]
    public List<FtbLink> Links { get; set; } = [];

    [JsonPropertyName("art")]
    public List<FtbArt> Art { get; set; } = [];
}

public class FtbTag
{
    [JsonPropertyName("name")]
    public string Name { get; set; } = "";
}

public class FtbVersion
{
    [JsonPropertyName("id")]
    public int Id { get; set; }

    [JsonPropertyName("name")]
    public string Name { get; set; } = "";

    [JsonPropertyName("type")]
    public string Type { get; set; } = "";

    [JsonPropertyName("updated")]
    public long Updated { get; set; }

    [JsonPropertyName("released")]
    public long Released { get; set; }

    [JsonPropertyName("targets")]
    public List<FtbTarget> Targets { get; set; } = [];
}

public class FtbTarget
{
    [JsonPropertyName("name")]
    public string Name { get; set; } = "";

    [JsonPropertyName("version")]
    public string Version { get; set; } = "";

    [JsonPropertyName("type")]
    public string Type { get; set; } = "";
}

public class FtbAuthor
{
    [JsonPropertyName("name")]
    public string Name { get; set; } = "";
}

public class FtbLink
{
    [JsonPropertyName("name")]
    public string Name { get; set; } = "";

    [JsonPropertyName("link")]
    public string Url { get; set; } = "";

    [JsonPropertyName("type")]
    public string Type { get; set; } = "";
}

public class FtbArt
{
    [JsonPropertyName("url")]
    public string Url { get; set; } = "";

    [JsonPropertyName("type")]
    public string Type { get; set; } = "";
}

public class FtbVersionDetail
{
    [JsonPropertyName("id")]
    public int Id { get; set; }

    [JsonPropertyName("parent")]
    public int Parent { get; set; }

    [JsonPropertyName("name")]
    public string Name { get; set; } = "";

    [JsonPropertyName("updated")]
    public long Updated { get; set; }

    [JsonPropertyName("released")]
    public long Released { get; set; }

    [JsonPropertyName("targets")]
    public List<FtbTarget> Targets { get; set; } = [];

    [JsonPropertyName("files")]
    public List<FtbVersionFile> Files { get; set; } = [];
}

public class FtbVersionFile
{
    [JsonPropertyName("name")]
    public string Name { get; set; } = "";

    [JsonPropertyName("url")]
    public string Url { get; set; } = "";

    [JsonPropertyName("size")]
    public long Size { get; set; }
}
