using System;
using System.Collections.Generic;
using System.Linq;
using System.Net.Http;
using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.Json.Serialization;
using System.Threading.Tasks;

namespace Qomicex.Launcher.Backend.Modules.Helpers.Resources.Expansion.CurseForge
{
    public class CurseForgeBase
    {
        public CurseForgeBase(string ApiKey, string SearchUrl, string ModURL)
        {
            API_KEY = ApiKey;
            SEARCH_URL = SearchUrl;
            GET_MOD_URL = ModURL;
        }

        private string API_KEY { get; set; } = string.Empty;
        private string SEARCH_URL { get; set; } = string.Empty;
        private string GET_MOD_URL { get; set; } = string.Empty;

        public enum SortField
        {
            Featured = 1,
            Popularity = 2,
            LastUpdated = 3,
            Name = 4,
            Author = 5,
            TotalDownloads = 6,
            Category = 7,
            GameVersion = 8,
            EarlyAccess = 9,
            FeaturedReleased = 10,
            ReleasedDate = 11,
            Rating = 12
        }
        public static class ModLoaderType
        {
            public const string Any = "Any";
            public const string Forge = "Forge";
            public const string LiteLoader = "LiteLoader";
            public const string Fabric = "Fabric";
            public const string Quilt = "Quilt";
            public const string NeoForge = "NeoForge";

            public static readonly List<string> All = new()
            {
                Forge,
                LiteLoader,
                Fabric,
                Quilt,
                NeoForge
            };
        }

        internal string BASEURL { get; set; } = "https://api.curseforge.com";
        private static readonly JsonSerializerOptions _jsonOptions = new()
        {
            PropertyNameCaseInsensitive = true,
            NumberHandling = JsonNumberHandling.AllowReadingFromString
        };

        private static string GetNodeString(JsonNode? node)
        {
            if (node == null) return string.Empty;
            if (node is JsonValue val)
            {
                if (val.TryGetValue<string>(out var s)) return s;
                if (val.TryGetValue<int>(out var i)) return i.ToString();
                if (val.TryGetValue<long>(out var l)) return l.ToString();
                if (val.TryGetValue<bool>(out var b)) return b.ToString();
            }
            return node.ToString();
        }

        internal async Task<string> GetData(string url, string key)
        {
            var client = new HttpClient();
            client.DefaultRequestHeaders.Add("x-api-key", key);
            client.DefaultRequestHeaders.Accept.Clear();
            client.DefaultRequestHeaders.Accept.Add(MediaTypeWithQualityHeaderValue.Parse("application/json"));
            client.DefaultRequestHeaders.UserAgent.ParseAdd("Mozilla/5.0 (compatible; QomicexCore/1.0)");
            if (!url.StartsWith("http"))
            {
                url = BASEURL + url;
            }
            var response = await client.GetAsync(url);
            if (response.IsSuccessStatusCode)
            {
                return await response.Content.ReadAsStringAsync();
            }
            else
            {
                throw new Exception($"Error fetching data from CurseForge: {response.ReasonPhrase}");
            }
        }

        public class CurseForgeSearchResult
        {
            public string Id { get; set; } = string.Empty;
            public string Name { get; set; } = string.Empty;
            public string Slug { get; set; } = string.Empty;
            public string Summary { get; set; } = string.Empty;
            public string Status { get; set; } = string.Empty;
            public string GameVersion { get; set; } = string.Empty;
            public string DownloadCount { get; set; } = string.Empty;
            public bool IsFeatured { get; set; } = false;
            public List<CategoryMeta> Categories { get; set; } = new List<CategoryMeta>();
            public string IconUrl { get; set; } = string.Empty;
            public List<AuthorMeta> Authors { get; set; } = new List<AuthorMeta>();
            public List<ScreenshotsMeta> Screenshots { get; set; } = new List<ScreenshotsMeta>();
        }
        public class ScreenshotsMeta
        {
            [JsonPropertyName("id")]
            public int Id { get; set; } = 0;
            [JsonPropertyName("modId")]
            public int ModId { get; set; } = 0;
            [JsonPropertyName("title")]
            public string Title { get; set; } = string.Empty;
            [JsonPropertyName("description")]
            public string Description { get; set; } = string.Empty;
            [JsonPropertyName("thumbnailUrl")]
            public string ThumbnailUrl { get; set; } = string.Empty;
            [JsonPropertyName("url")]
            public string Url { get; set; } = string.Empty;
        }
        public class CategoryMeta
        {
            [JsonPropertyName("id")]
            public int Id { get; set; }
            [JsonPropertyName("name")]
            public string Name { get; set; } = string.Empty;
            [JsonPropertyName("slug")]
            public string Slug { get; set; } = string.Empty;
            [JsonPropertyName("url")]
            public string Url { get; set; } = string.Empty;
        }
        public class AuthorMeta
        {
            [JsonPropertyName("id")]
            public string Id { get; set; } = string.Empty;
            [JsonPropertyName("name")]
            public string Name { get; set; } = string.Empty;
            [JsonPropertyName("url")]
            public string Url { get; set; } = string.Empty;
        }
        public class CurseForgeInfo
        {
            [JsonPropertyName("id")]
            public string Id { get; set; } = string.Empty;
            [JsonPropertyName("name")]
            public string Name { get; set; } = string.Empty;
            [JsonPropertyName("slug")]
            public string Slug { get; set; } = string.Empty;
            [JsonPropertyName("summary")]
            public string Summary { get; set; } = string.Empty;
            [JsonPropertyName("status")]
            public int Status { get; set; } = 1;
            [JsonPropertyName("downloadCount")]
            public int DownloadCount { get; set; } = 0;
            [JsonPropertyName("isFeatured")]
            public bool IsFeatured { get; set; } = false;
            [JsonPropertyName("categories")]
            public List<CategoryMeta> Categories { get; set; } = new List<CategoryMeta>();
            [JsonPropertyName("iconUrl")]
            public string IconUrl { get; set; } = string.Empty;
            [JsonPropertyName("authors")]
            public List<AuthorMeta> Authors { get; set; } = new List<AuthorMeta>();
            [JsonPropertyName("screenshots")]
            public List<ScreenshotsMeta> Screenshots { get; set; } = new List<ScreenshotsMeta>();
            [JsonPropertyName("latestFilesIndexes")]
            public List<CurseForgeFilesMeta> Files { get; set; } = new List<CurseForgeFilesMeta>();
            public List<CurseForgeDependenciesMeta> Dependencies { get; set; } = new List<CurseForgeDependenciesMeta>();
        }
        public class CurseForgeFilesMeta
        {

            [JsonPropertyName("fileId")]
            public string FileId { get; set; } = string.Empty;
            [JsonPropertyName("fileName")]
            public string FileName { get; set; } = string.Empty;
            [JsonPropertyName("releaseType")]
            public int releaseType { get; set; } = 1;
            [JsonPropertyName("gameVersion")]
            public string GameVersion { get; set; } = string.Empty;
            [JsonPropertyName("modLoader")]
            public int ModLoader { get; set; } = 1;
        }
        public class CurseForgeDependenciesMeta
        {
            [JsonPropertyName("modId")]
            public int Id { get; set; } = 0;
            [JsonPropertyName("relationType")]
            public int Type { get; set; } = 1;
        }

        /// <summary>
        /// 获取推荐的资源列表
        /// </summary>
        /// <param name="GameVersions">游戏版本</param>
        /// <param name="Categories">分类</param>
        /// <param name="ModLoaderTypes">模组加载器</param>
        /// <param name="SortField">排序方式</param>
        /// <param name="Page">页数</param>
        /// <param name="PageSize">页面大小</param>
        /// <returns>结果</returns>
        internal async Task<List<CurseForgeSearchResult>> GetRecommend(string?[] GameVersions, int?[] Categories, string[]? ModLoaderTypes, int? SortField = 0, int? Page = 1, int? PageSize = 25)
        {
            return await SearchAsync("", GameVersions, Categories, ModLoaderTypes, SortField, Page, PageSize);
        }

        /// <summary>
        /// 异步搜索CurseForge上的资源
        /// </summary>
        /// <param name="SearchFilter">搜索关键词</param>
        /// <param name="SortField">排序方式</param>
        /// <param name="GameVersions">游戏版本</param>
        /// <param name="Categories">分类标签</param>
        /// <param name="ModLoaderTypes">ModLoader类型</param>
        /// <param name="Page">页数</param>
        /// <param name="PageSize">单页搜索结果条目数</param>
        /// <returns></returns>
        /// <exception cref="ArgumentOutOfRangeException"></exception>
        /// <exception cref="Exception"></exception>
        internal async Task<List<CurseForgeSearchResult>> SearchAsync(string SearchFilter, string?[] GameVersions, int?[] Categories, string[]? ModLoaderTypes, int? SortField = 0, int? Page = 1, int? PageSize = 25)
        {
            var index = ((Page - 1) * PageSize).ToString();
            if (int.Parse(index!) + PageSize > 10000)
                throw new ArgumentOutOfRangeException("PageSize cannot exceed 10,000 items.");
            var modLoaders = string.Join(",", ModLoaderTypes!);
            string categories = string.Empty;
            if (Categories.Length != 0)
                categories = $"&categoryIds=[{string.Join(",", Categories)}]";
            var gameVersions = string.Join(",", GameVersions.Select(v => $"\"{v}\""));
            var url = $"{SEARCH_URL}&searchFilter={SearchFilter}&sortOrder=desc&gameVersions=[{gameVersions}]&pageSize={PageSize.ToString()}&index={index}{categories}&modLoaderTypes=[{modLoaders}]&sortField={SortField.ToString()}";
            var data = await GetData(url, API_KEY);
            if (!string.IsNullOrEmpty(data))
            {
                var returnData = new List<CurseForgeSearchResult>();
                var result = JsonNode.Parse(data)?.AsObject();
                if (result != null)
                {
                    var mods = result["data"]?.AsArray();
                    if (mods != null)
                    {
                        foreach (var mod in mods)
                        {
                            var modData = mod as JsonObject;
                            if (modData == null) continue;
                            var latestFilesIndexes = modData["latestFilesIndexes"]?.AsArray();
                            List<string> gameVersionsList = latestFilesIndexes?
                                .Select(node => node?["gameVersion"]?.GetValue<string>())
                                .OfType<string>()
                                .Distinct()
                                .OrderBy(v => v)
                                .ToList() ?? new List<string>();
                            var modResult = new CurseForgeSearchResult
                            {
                                Id = GetNodeString(modData["id"]),
                                Name = modData["name"]?.GetValue<string>() ?? string.Empty,
                                Slug = modData["slug"]?.GetValue<string>() ?? string.Empty,
                                Summary = modData["summary"]?.GetValue<string>() ?? string.Empty,
                                Status = GetNodeString(modData["status"]),
                                GameVersion = string.Join(", ", gameVersionsList),
                                DownloadCount = GetNodeString(modData["downloadCount"]),
                                IconUrl = (modData["logo"] as JsonObject)?["url"]?.GetValue<string>() ?? string.Empty,
                                IsFeatured = modData["isFeatured"]?.GetValue<bool>() ?? false,
                                Authors = modData["authors"]?.AsArray()?.Select(a => new AuthorMeta
                                {
                                    Id = GetNodeString(a?["id"]),
                                    Name = a?["name"]?.GetValue<string>() ?? string.Empty,
                                    Url = a?["url"]?.GetValue<string>() ?? string.Empty
                                }).ToList() ?? new List<AuthorMeta>(),
                                Categories = modData["categories"]?.AsArray()?.Select(c => new CategoryMeta
                                {
                                    Id = c?["id"]?.GetValue<int>() ?? 0,
                                    Name = c?["name"]?.GetValue<string>() ?? string.Empty,
                                    Slug = c?["slug"]?.GetValue<string>() ?? string.Empty,
                                    Url = c?["url"]?.GetValue<string>() ?? string.Empty
                                }).ToList() ?? new List<CategoryMeta>(),
                                Screenshots = modData["screenshots"]?.AsArray()?.Select(s => new ScreenshotsMeta
                                {
                                    Id = s?["id"]?.GetValue<int>() ?? 0,
                                    ModId = s?["modId"]?.GetValue<int>() ?? 0,
                                    Title = s?["title"]?.GetValue<string>() ?? string.Empty,
                                    Description = s?["description"]?.GetValue<string>() ?? string.Empty,
                                    ThumbnailUrl = s?["thumbnailUrl"]?.GetValue<string>() ?? string.Empty,
                                    Url = s?["url"]?.GetValue<string>() ?? string.Empty
                                }).ToList() ?? new List<ScreenshotsMeta>()
                            };
                            returnData.Add(modResult);
                        }
                    }
                    return returnData;
                }
                else
                    throw new Exception("Error parsing CurseForge response.");
            }
            else
                throw new Exception("Error fetching data from CurseForge.");
        }

        /// <summary>
        /// 异步获取指定资源的详细信息
        /// </summary>
        /// <param name="Id">ModId</param>
        /// <returns>Mod信息</returns>
        /// <exception cref="ArgumentNullException"></exception>
        /// <exception cref="Exception"></exception>
        internal async Task<CurseForgeInfo> GetInfoAsync(string Id)
        {
            if (string.IsNullOrEmpty(Id))
                throw new ArgumentNullException(nameof(Id), "ModId cannot be null or empty.");
            var url = $"{GET_MOD_URL}{Id}";
            var data = await GetData(url, API_KEY);
            if (!string.IsNullOrEmpty(data))
            {
                var result = JsonNode.Parse(data)?.AsObject();
                if (result != null)
                {
                    var modInfo = result["data"];
                    if (modInfo != null)
                    {
                        var returnData = JsonSerializer.Deserialize<CurseForgeInfo>(modInfo, _jsonOptions) ?? throw new Exception("无法反序列化为 CurseForgeInfo");
                        var files = modInfo["latestFiles"]?.AsArray();
                        if (files != null)
                        {
                            returnData.Dependencies = files
                                .SelectMany(file => (file?["dependencies"] as JsonArray) ?? [])
                                .Select(dep => new CurseForgeDependenciesMeta
                                {
                                    Id = dep?["modId"]?.GetValue<int>() ?? 0,
                                    Type = dep?["relationType"]?.GetValue<int>() ?? 0
                                })
                                .ToList();
                        }
                        return returnData;
                    }
                    else
                        throw new Exception("Error parsing CurseForge response.");
                }
                else
                    throw new Exception("Error parsing CurseForge response.");
            }
            else
                throw new Exception("Error fetching data from CurseForge.");
        }

        /// <summary>
        /// 获取指定资源的下载链接
        /// </summary>
        /// <param name="Id"></param>
        /// <param name="FileId"></param>
        /// <returns></returns>
        /// <exception cref="ArgumentNullException"></exception>
        /// <exception cref="Exception"></exception>
        public string GetDownloadUrl(string Id, string FileId)
        {
            if (string.IsNullOrEmpty(Id) || string.IsNullOrEmpty(FileId))
                throw new ArgumentNullException("ModId or FileId cannot be null or empty.");
            var url = GetData($"/v1/mods/{Id}/files/{FileId}/download-url", API_KEY).Result;
            return (JsonNode.Parse(url)?.AsObject())?["data"]?.GetValue<string>() ?? throw new Exception("提取Url失败");
        }

        /// <summary>
        /// 异步获取指定资源的下载链接
        /// </summary>
        /// <param name="Id"></param>
        /// <param name="FileId"></param>
        /// <returns></returns>
        /// <exception cref="ArgumentNullException"></exception>
        /// <exception cref="Exception"></exception>
        public async Task<string> GetDownloadUrlAsync(string Id, string FileId)
        {
            if (string.IsNullOrEmpty(Id) || string.IsNullOrEmpty(FileId))
                throw new ArgumentNullException("ModId or FileId cannot be null or empty.");
            var url = await GetData($"/v1/mods/{Id}/files/{FileId}/download-url", API_KEY);
            return (JsonNode.Parse(url)?.AsObject())?["data"]?.GetValue<string>() ?? throw new Exception("提取Url失败");
        }

        /// <summary>
        /// 获取推荐的资源列表
        /// </summary>
        /// <param name="GameVersions">游戏版本</param>
        /// <param name="Categories">分类</param>
        /// <param name="SortField">排序方式</param>
        /// <param name="Page">页数</param>
        /// <param name="PageSize">页面大小</param>
        /// <returns>结果</returns>
        internal async Task<List<CurseForgeSearchResult>> GetRecommend(string?[] GameVersions, int?[] Categories, int? SortField = 0, int? Page = 1, int? PageSize = 25)
        {
            return await SearchAsync("", GameVersions, Categories, SortField, Page, PageSize);
        }

        /// <summary>
        /// 异步搜索CurseForge上的资源
        /// </summary>
        /// <param name="SearchFilter">搜索关键词</param>
        /// <param name="SortField">排序方式</param>
        /// <param name="GameVersions">游戏版本</param>
        /// <param name="Categories">分类标签</param>
        /// <param name="Page">页数</param>
        /// <param name="PageSize">单页搜索结果条目数</param>
        /// <returns></returns>
        /// <exception cref="ArgumentOutOfRangeException"></exception>
        /// <exception cref="Exception"></exception>
        internal async Task<List<CurseForgeSearchResult>> SearchAsync(string SearchFilter, string?[] GameVersions, int?[] Categories, int? SortField = 0, int? Page = 1, int? PageSize = 25)
        {
            var index = ((Page - 1) * PageSize).ToString();
            if (int.Parse(index!) + PageSize > 10000)
                throw new ArgumentOutOfRangeException("PageSize cannot exceed 10,000 items.");
            string categories = string.Empty;
            if (Categories.Length != 0)
                categories = $"&categoryIds=[{string.Join(",", Categories)}]";
            var gameVersions = string.Join(",", GameVersions.Select(v => $"\"{v}\""));
            var url = $"{SEARCH_URL}&searchFilter={SearchFilter}&sortOrder=desc&gameVersions=[{gameVersions}]&pageSize={PageSize.ToString()}&index={index}{categories}&sortField={SortField.ToString()}";
            var data = await GetData(url, API_KEY);
            if (!string.IsNullOrEmpty(data))
            {
                var returnData = new List<CurseForgeSearchResult>();
                var result = JsonNode.Parse(data)?.AsObject();
                if (result != null)
                {
                    var mods = result["data"]?.AsArray();
                    if (mods != null)
                    {
                        foreach (var mod in mods)
                        {
                            var modData = mod as JsonObject;
                            if (modData == null) continue;
                            var modResult = new CurseForgeSearchResult
                            {
                                Id = GetNodeString(modData["id"]),
                                Name = modData["name"]?.GetValue<string>() ?? string.Empty,
                                Slug = modData["slug"]?.GetValue<string>() ?? string.Empty,
                                Summary = modData["summary"]?.GetValue<string>() ?? string.Empty,
                                Status = GetNodeString(modData["status"]),
                                GameVersion = modData["gameVersion"]?.GetValue<string>() ?? string.Empty,
                                DownloadCount = GetNodeString(modData["downloadCount"]),
                                IconUrl = modData["iconUrl"]?.GetValue<string>() ?? string.Empty,
                                IsFeatured = modData["isFeatured"]?.GetValue<bool>() ?? false,
                                Authors = modData["authors"]?.AsArray()?.Select(a => new AuthorMeta
                                {
                                    Id = GetNodeString(a?["id"]),
                                    Name = a?["name"]?.GetValue<string>() ?? string.Empty,
                                    Url = a?["url"]?.GetValue<string>() ?? string.Empty
                                }).ToList() ?? new List<AuthorMeta>(),
                                Categories = modData["categories"]?.AsArray()?.Select(c => new CategoryMeta
                                {
                                    Id = c?["id"]?.GetValue<int>() ?? 0,
                                    Name = c?["name"]?.GetValue<string>() ?? string.Empty,
                                    Slug = c?["slug"]?.GetValue<string>() ?? string.Empty,
                                    Url = c?["url"]?.GetValue<string>() ?? string.Empty
                                }).ToList() ?? new List<CategoryMeta>(),
                                Screenshots = modData["screenshots"]?.AsArray()?.Select(s => new ScreenshotsMeta
                                {
                                    Id = s?["id"]?.GetValue<int>() ?? 0,
                                    ModId = s?["modId"]?.GetValue<int>() ?? 0,
                                    Title = s?["title"]?.GetValue<string>() ?? string.Empty,
                                    Description = s?["description"]?.GetValue<string>() ?? string.Empty,
                                    ThumbnailUrl = s?["thumbnailUrl"]?.GetValue<string>() ?? string.Empty,
                                    Url = s?["url"]?.GetValue<string>() ?? string.Empty
                                }).ToList() ?? new List<ScreenshotsMeta>()
                            };
                            returnData.Add(modResult);
                        }
                    }
                    return returnData;
                }
                else
                    throw new Exception("Error parsing CurseForge response.");
            }
            else
                throw new Exception("Error fetching data from CurseForge.");
        }
    }
}
