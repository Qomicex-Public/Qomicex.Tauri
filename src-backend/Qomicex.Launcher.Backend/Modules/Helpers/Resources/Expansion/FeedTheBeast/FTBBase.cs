using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Net.Http;
using System.Net.Http.Headers;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.Json.Serialization;
using System.Threading;
using System.Threading.Tasks;

namespace Qomicex.Launcher.Backend.Modules.Helpers.Resources.Expansion.FeedTheBeast
{
    public class FTBBase
    {
        internal string BASEURL { get; set; } = "https://api.feed-the-beast.com/v1/modpacks/public";
        private readonly HttpClient _httpClient;
        private List<ModpackInfo> _cache = new();
        private long _cacheSavedAt;
        private static readonly SemaphoreSlim _cacheLock = new(1, 1);
        private static readonly string _cacheFile = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            "Qomicex", "ftb_cache.json");
        private static readonly JsonSerializerOptions _jsonOptions = new()
        {
            PropertyNameCaseInsensitive = true
        };

        public FTBBase()
        {
            _httpClient = new HttpClient { Timeout = TimeSpan.FromSeconds(30) };
            _httpClient.DefaultRequestHeaders.UserAgent.Clear();
            _httpClient.DefaultRequestHeaders.UserAgent.Add(new ProductInfoHeaderValue("Qomicex-Project", "1.0"));
            _httpClient.DefaultRequestHeaders.Accept.Add(new MediaTypeWithQualityHeaderValue("application/json"));
        }

        internal async Task<string> GetDataAsync(string url)
        {
            if (!url.StartsWith("http"))
                url = BASEURL + url;
            var response = await _httpClient.GetAsync(url);
            response.EnsureSuccessStatusCode();
            return await response.Content.ReadAsStringAsync();
        }

        // ============ 缓存 ============

        /// <summary>
        /// 从API获取全部整合包数据（带本地缓存，1小时内不重复请求）
        /// </summary>
        internal async Task<List<ModpackInfo>> FetchAllPacksAsync()
        {
            await _cacheLock.WaitAsync();
            try
            {
                // 尝试读缓存
                if (_cache.Count == 0 && File.Exists(_cacheFile))
                {
                    try
                    {
                        var json = await File.ReadAllTextAsync(_cacheFile);
                        var cached = JsonSerializer.Deserialize<CacheData>(json, _jsonOptions);
                        if (cached?.Modpacks != null && cached.Modpacks.Count > 0)
                        {
                            _cache = cached.Modpacks;
                            _cacheSavedAt = cached.SavedAt;
                            if (DateTimeOffset.UtcNow.ToUnixTimeSeconds() - _cacheSavedAt < 3600)
                                return _cache;
                        }
                    }
                    catch { /* 缓存损坏，重新获取 */ }
                }

                // 从API获取
                var idsJson = await GetDataAsync("/modpack/all");
                var idsDoc = JsonNode.Parse(idsJson)?.AsObject();
                var ids = idsDoc?["packs"]?.Deserialize<List<int>>() ?? new List<int>();

                var semaphore = new SemaphoreSlim(8);
                var tasks = ids.Select(async id =>
                {
                    await semaphore.WaitAsync();
                    try
                    {
                        var packJson = await GetDataAsync($"/modpack/{id}");
                        return JsonSerializer.Deserialize<ModpackInfo>(packJson, _jsonOptions);
                    }
                    catch { return null; }
                    finally { semaphore.Release(); }
                });

                var results = await Task.WhenAll(tasks);
                _cache = results.Where(p => p != null).ToList()!;
                _cacheSavedAt = DateTimeOffset.UtcNow.ToUnixTimeSeconds();

                // 写缓存
                try
                {
                    var dir = Path.GetDirectoryName(_cacheFile);
                    if (!string.IsNullOrEmpty(dir))
                        Directory.CreateDirectory(dir);
                    var cacheData = new CacheData { SavedAt = _cacheSavedAt, Modpacks = _cache };
                    await File.WriteAllTextAsync(_cacheFile, JsonSerializer.Serialize(cacheData, _jsonOptions));
                }
                catch { /* 缓存写入失败不影响功能 */ }

                return _cache;
            }
            finally { _cacheLock.Release(); }
        }

        // ============ 搜索与筛选 ============

        /// <summary>
        /// 搜索整合包（客户端筛选，API不支持服务端搜索）
        /// </summary>
        /// <param name="query">搜索关键词（匹配名称与简介）</param>
        /// <param name="tags">标签筛选（任意匹配）</param>
        /// <param name="mcVersion">Minecraft版本筛选</param>
        /// <param name="loader">Modloader筛选（如 neoforge, forge）</param>
        /// <param name="sort">排序方式：featured / trending / name / plays / downloads / released / updated</param>
        /// <param name="limit">最大返回数量</param>
        internal async Task<List<ModpackInfo>> SearchAsync(
            string? query = null,
            List<string>? tags = null,
            string? mcVersion = null,
            string? loader = null,
            string sort = "featured",
            int limit = 20)
        {
            var all = await FetchAllPacksAsync();

            IEnumerable<ModpackInfo> result = all;

            // 关键词搜索
            if (!string.IsNullOrEmpty(query))
            {
                var q = query.ToLower();
                result = result.Where(p =>
                    (p.Name?.ToLower().Contains(q) ?? false) ||
                    (p.Synopsis?.ToLower().Contains(q) ?? false));
            }

            // 标签筛选
            if (tags != null && tags.Count > 0)
            {
                result = result.Where(p =>
                    p.Tags?.Any(t => tags.Any(f => t.Name?.Equals(f, StringComparison.OrdinalIgnoreCase) ?? false)) ?? false);
            }

            // MC版本筛选
            if (!string.IsNullOrEmpty(mcVersion))
            {
                result = result.Where(p =>
                {
                    var latest = GetLatestVersion(p);
                    return latest?.Targets?.Any(t => t.Type == "game" && t.Version == mcVersion) ?? false;
                });
            }

            // Modloader筛选
            if (!string.IsNullOrEmpty(loader))
            {
                result = result.Where(p =>
                {
                    var latest = GetLatestVersion(p);
                    return latest?.Targets?.Any(t =>
                        t.Type == "modloader" && t.Name?.Equals(loader, StringComparison.OrdinalIgnoreCase) == true) ?? false;
                });
            }

            // 排序
            result = sort switch
            {
                "trending" => result.OrderByDescending(p => p.Plays14d),
                "name" => result.OrderBy(p => p.Name),
                "plays" => result.OrderByDescending(p => p.Plays),
                "downloads" => result.OrderByDescending(p => p.Installs),
                "released" => result.OrderByDescending(p => p.Released),
                "updated" => result.OrderByDescending(p => p.Updated),
                _ => result.OrderByDescending(p => p.Featured == true)
                         .ThenByDescending(p => p.Plays)
            };

            return result.Take(limit).ToList();
        }

        // ============ 详情获取 ============

        /// <summary>
        /// 从API获取整合包最新详情（含版本列表）
        /// </summary>
        internal async Task<ModpackInfo?> GetPackDetailAsync(int id)
        {
            try
            {
                var json = await GetDataAsync($"/modpack/{id}");
                return JsonSerializer.Deserialize<ModpackInfo>(json, _jsonOptions);
            }
            catch { return null; }
        }

        /// <summary>
        /// 获取整合包版本文件列表及下载链接
        /// </summary>
        internal async Task<VersionDetail?> GetVersionDetailAsync(int packId, int versionId)
        {
            try
            {
                var json = await GetDataAsync($"/modpack/{packId}/{versionId}");
                return JsonSerializer.Deserialize<VersionDetail>(json, _jsonOptions);
            }
            catch { return null; }
        }

        /// <summary>
        /// 获取版本更新日志
        /// </summary>
        internal async Task<ChangelogResult?> GetChangelogAsync(int packId, int versionId)
        {
            try
            {
                var json = await GetDataAsync($"/modpack/{packId}/{versionId}/changelog");
                return JsonSerializer.Deserialize<ChangelogResult>(json, _jsonOptions);
            }
            catch { return null; }
        }

        // ============ 辅助方法 ============

        /// <summary>
        /// 获取最新release版本信息
        /// </summary>
        public static VersionInfo? GetLatestVersion(ModpackInfo pack)
        {
            return pack.Versions?
                .Where(v => v.Type == "release")
                .OrderByDescending(v => v.Updated)
                .FirstOrDefault();
        }

        /// <summary>
        /// 格式化数字（1.5M / 2.3K）
        /// </summary>
        public static string FormatNumber(long n)
        {
            if (n >= 1_000_000) return $"{n / 1_000_000.0:F1}M";
            if (n >= 1_000) return $"{n / 1_000.0:F1}K";
            return n.ToString();
        }

        /// <summary>
        /// 格式化文件大小（1.24 GB / 3.52 MB）
        /// </summary>
        public static string FormatSize(long bytes)
        {
            if (bytes >= 1_073_741_824) return $"{bytes / 1_073_741_824.0:F2} GB";
            if (bytes >= 1_048_576) return $"{bytes / 1_048_576.0:F2} MB";
            if (bytes >= 1_024) return $"{bytes / 1_024.0:F2} KB";
            return $"{bytes} B";
        }

        /// <summary>
        /// Unix时间戳转日期字符串
        /// </summary>
        public static string FormatTimestamp(long ts)
        {
            try { return DateTimeOffset.FromUnixTimeSeconds(ts).ToString("yyyy-MM-dd"); }
            catch { return "?"; }
        }

        // ============ 数据模型 ============

        internal class CacheData
        {
            [JsonPropertyName("savedAt")]
            public long SavedAt { get; set; }

            [JsonPropertyName("modpacks")]
            public List<ModpackInfo> Modpacks { get; set; } = new();
        }

        /// <summary>
        /// 整合包基本信息（列表与详情共用）
        /// </summary>
        public class ModpackInfo
        {
            [JsonPropertyName("id")]
            public int Id { get; set; }

            [JsonPropertyName("name")]
            public string Name { get; set; } = string.Empty;

            [JsonPropertyName("slug")]
            public string Slug { get; set; } = string.Empty;

            [JsonPropertyName("synopsis")]
            public string Synopsis { get; set; } = string.Empty;

            [JsonPropertyName("description")]
            public string Description { get; set; } = string.Empty;

            [JsonPropertyName("type")]
            public string Type { get; set; } = string.Empty;

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

            [JsonPropertyName("private")]
            public bool Private { get; set; }

            [JsonPropertyName("tags")]
            public List<TagInfo>? Tags { get; set; }

            [JsonPropertyName("versions")]
            public List<VersionInfo>? Versions { get; set; }

            [JsonPropertyName("authors")]
            public List<AuthorInfo>? Authors { get; set; }

            [JsonPropertyName("links")]
            public List<LinkInfo>? Links { get; set; }

            [JsonPropertyName("art")]
            public List<ArtInfo>? Art { get; set; }

            [JsonPropertyName("meta")]
            public MetaInfo? Meta { get; set; }

            [JsonPropertyName("rating")]
            public RatingInfo? Rating { get; set; }
        }

        public class TagInfo
        {
            [JsonPropertyName("id")]
            public int Id { get; set; }

            [JsonPropertyName("name")]
            public string Name { get; set; } = string.Empty;
        }

        public class VersionInfo
        {
            [JsonPropertyName("id")]
            public int Id { get; set; }

            [JsonPropertyName("name")]
            public string Name { get; set; } = string.Empty;

            [JsonPropertyName("type")]
            public string Type { get; set; } = string.Empty;

            [JsonPropertyName("updated")]
            public long Updated { get; set; }

            [JsonPropertyName("released")]
            public long Released { get; set; }

            [JsonPropertyName("private")]
            public bool Private { get; set; }

            [JsonPropertyName("specs")]
            public SpecsInfo? Specs { get; set; }

            [JsonPropertyName("targets")]
            public List<TargetInfo>? Targets { get; set; }
        }

        public class SpecsInfo
        {
            [JsonPropertyName("id")]
            public int Id { get; set; }

            [JsonPropertyName("minimum")]
            public int Minimum { get; set; }

            [JsonPropertyName("recommended")]
            public int Recommended { get; set; }
        }

        public class TargetInfo
        {
            [JsonPropertyName("id")]
            public int Id { get; set; }

            [JsonPropertyName("name")]
            public string Name { get; set; } = string.Empty;

            [JsonPropertyName("version")]
            public string Version { get; set; } = string.Empty;

            [JsonPropertyName("type")]
            public string Type { get; set; } = string.Empty;

            [JsonPropertyName("updated")]
            public long Updated { get; set; }
        }

        public class AuthorInfo
        {
            [JsonPropertyName("id")]
            public int Id { get; set; }

            [JsonPropertyName("name")]
            public string Name { get; set; } = string.Empty;

            [JsonPropertyName("type")]
            public string Type { get; set; } = string.Empty;

            [JsonPropertyName("website")]
            public string Website { get; set; } = string.Empty;

            [JsonPropertyName("updated")]
            public long Updated { get; set; }
        }

        public class LinkInfo
        {
            [JsonPropertyName("id")]
            public int Id { get; set; }

            [JsonPropertyName("name")]
            public string Name { get; set; } = string.Empty;

            [JsonPropertyName("link")]
            public string Url { get; set; } = string.Empty;

            [JsonPropertyName("type")]
            public string Type { get; set; } = string.Empty;
        }

        public class ArtInfo
        {
            [JsonPropertyName("id")]
            public int Id { get; set; }

            [JsonPropertyName("url")]
            public string Url { get; set; } = string.Empty;

            [JsonPropertyName("type")]
            public string Type { get; set; } = string.Empty;

            [JsonPropertyName("width")]
            public int Width { get; set; }

            [JsonPropertyName("height")]
            public int Height { get; set; }

            [JsonPropertyName("compressed")]
            public bool Compressed { get; set; }

            [JsonPropertyName("sha1")]
            public string Sha1 { get; set; } = string.Empty;

            [JsonPropertyName("size")]
            public long Size { get; set; }

            [JsonPropertyName("updated")]
            public long Updated { get; set; }
        }

        public class MetaInfo
        {
            [JsonPropertyName("supportsWorlds")]
            public bool SupportsWorlds { get; set; }

            [JsonPropertyName("curseforgeProjectId")]
            public int? CurseforgeProjectId { get; set; }

            [JsonPropertyName("isLegacy")]
            public bool IsLegacy { get; set; }
        }

        public class RatingInfo
        {
            [JsonPropertyName("id")]
            public int Id { get; set; }

            [JsonPropertyName("configured")]
            public bool Configured { get; set; }

            [JsonPropertyName("verified")]
            public bool Verified { get; set; }

            [JsonPropertyName("age")]
            public int Age { get; set; }

            [JsonPropertyName("gambling")]
            public bool Gambling { get; set; }

            [JsonPropertyName("frightening")]
            public bool Frightening { get; set; }

            [JsonPropertyName("alcoholdrugs")]
            public bool AlcoholDrugs { get; set; }

            [JsonPropertyName("nuditysexual")]
            public bool NuditySexual { get; set; }

            [JsonPropertyName("sterotypeshate")]
            public bool StereotypesHate { get; set; }

            [JsonPropertyName("language")]
            public bool Language { get; set; }

            [JsonPropertyName("violence")]
            public bool Violence { get; set; }
        }

        /// <summary>
        /// 版本文件详情（含下载链接）
        /// </summary>
        public class VersionDetail
        {
            [JsonPropertyName("id")]
            public int Id { get; set; }

            [JsonPropertyName("parent")]
            public int Parent { get; set; }

            [JsonPropertyName("name")]
            public string Name { get; set; } = string.Empty;

            [JsonPropertyName("type")]
            public string Type { get; set; } = string.Empty;

            [JsonPropertyName("plays")]
            public long Plays { get; set; }

            [JsonPropertyName("installs")]
            public long Installs { get; set; }

            [JsonPropertyName("updated")]
            public long Updated { get; set; }

            [JsonPropertyName("changelog")]
            public string ChangelogUrl { get; set; } = string.Empty;

            [JsonPropertyName("specs")]
            public SpecsInfo? Specs { get; set; }

            [JsonPropertyName("targets")]
            public List<TargetInfo>? Targets { get; set; }

            [JsonPropertyName("files")]
            public List<FileInfo>? Files { get; set; }
        }

        public class FileInfo
        {
            [JsonPropertyName("id")]
            public long Id { get; set; }

            [JsonPropertyName("type")]
            public string Type { get; set; } = string.Empty;

            [JsonPropertyName("path")]
            public string Path { get; set; } = string.Empty;

            [JsonPropertyName("name")]
            public string Name { get; set; } = string.Empty;

            [JsonPropertyName("version")]
            public string Version { get; set; } = string.Empty;

            [JsonPropertyName("url")]
            public string Url { get; set; } = string.Empty;

            [JsonPropertyName("sha1")]
            public string Sha1 { get; set; } = string.Empty;

            [JsonPropertyName("size")]
            public long Size { get; set; }

            [JsonPropertyName("clientonly")]
            public bool ClientOnly { get; set; }

            [JsonPropertyName("serveronly")]
            public bool ServerOnly { get; set; }

            [JsonPropertyName("optional")]
            public bool Optional { get; set; }

            [JsonPropertyName("updated")]
            public long Updated { get; set; }
        }

        public class ChangelogResult
        {
            [JsonPropertyName("status")]
            public string Status { get; set; } = string.Empty;

            [JsonPropertyName("content")]
            public string Content { get; set; } = string.Empty;

            [JsonPropertyName("html")]
            public string Html { get; set; } = string.Empty;

            [JsonPropertyName("updated")]
            public long Updated { get; set; }
        }
    }
}
