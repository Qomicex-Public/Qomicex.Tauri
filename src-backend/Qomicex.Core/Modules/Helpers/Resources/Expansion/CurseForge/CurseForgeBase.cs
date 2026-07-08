using Newtonsoft.Json;
using Newtonsoft.Json.Linq;
using System;
using System.Collections.Generic;
using System.Linq;
using System.Net.Http;
using System.Net.Http.Headers;
using System.Text;
using System.Threading.Tasks;
using static System.Runtime.InteropServices.JavaScript.JSType;

namespace Qomicex.Core.Modules.Helpers.Resources.Expansion.CurseForge
{
    public class CurseForgeBase
    {
        private static readonly HttpClient _http = new();

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

        internal async Task<string> GetData(string url, string key)
        {
            using var request = new HttpRequestMessage(HttpMethod.Get, url.StartsWith("http") ? url : BASEURL + url);
            request.Headers.Add("x-api-key", key);
            request.Headers.Accept.Add(MediaTypeWithQualityHeaderValue.Parse("application/json"));
            request.Headers.UserAgent.ParseAdd("Mozilla/5.0 (compatible; QomicexCore/1.0)");
            var response = await _http.SendAsync(request);
            if (response.IsSuccessStatusCode)
            {
                return await response.Content.ReadAsStringAsync();
            }
            else
            {
                throw new Exception($"Error fetching data from CurseForge: {response.ReasonPhrase}");
            }
        }

        internal async Task<string> POSTData(string url, string key, object data)
        {
            string fullUrl = url.StartsWith("http") ? url : BASEURL + url;

            using var request = new HttpRequestMessage(HttpMethod.Post, fullUrl);
            request.Headers.Add("x-api-key", key);
            request.Headers.Accept.Add(MediaTypeWithQualityHeaderValue.Parse("application/json"));
            request.Headers.UserAgent.ParseAdd("Mozilla/5.0 (compatible; QomicexCore/1.0)");

            var jsonData = JsonConvert.SerializeObject(data);
            request.Content = new StringContent(jsonData, Encoding.UTF8, "application/json");
            var response = await _http.SendAsync(request);
            response.EnsureSuccessStatusCode();
            return await response.Content.ReadAsStringAsync();
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
            [JsonProperty("id")]
            public int Id { get; set; } = 0;
            [JsonProperty("modId")]
            public int ModId { get; set; } = 0;
            [JsonProperty("title")]
            public string Title { get; set; } = string.Empty;
            [JsonProperty("description")]
            public string Description { get; set; } = string.Empty;
            [JsonProperty("thumbnailUrl")]
            public string ThumbnailUrl { get; set; } = string.Empty;
            [JsonProperty("url")]
            public string Url { get; set; } = string.Empty;
        }
        public class CategoryMeta
        {
            [JsonProperty("id")]
            public int Id { get; set; }
            [JsonProperty("name")]
            public string Name { get; set; } = string.Empty;
            [JsonProperty("slug")]
            public string Slug { get; set; } = string.Empty;
            [JsonProperty("url")]
            public string Url { get; set; } = string.Empty;
        }
        public class AuthorMeta
        {
            [JsonProperty("id")]
            public string Id { get; set; } = string.Empty;
            [JsonProperty("name")]
            public string Name { get; set; } = string.Empty;
            [JsonProperty("url")]
            public string Url { get; set; } = string.Empty;
        }
        public class CurseForgeInfo
        {
            [JsonProperty("id")]
            public string Id { get; set; } = string.Empty;
            [JsonProperty("name")]
            public string Name { get; set; } = string.Empty;
            [JsonProperty("slug")]
            public string Slug { get; set; } = string.Empty;
            [JsonProperty("summary")]
            public string Summary { get; set; } = string.Empty;
            [JsonProperty("status")]
            public int Status { get; set; } = 1;
            [JsonProperty("downloadCount")]
            public int DownloadCount { get; set; } = 0;
            [JsonProperty("isFeatured")]
            public bool IsFeatured { get; set; } = false;
            [JsonProperty("categories")]
            public List<CategoryMeta> Categories { get; set; } = new List<CategoryMeta>();
            [JsonProperty("iconUrl")]
            public string IconUrl { get; set; } = string.Empty;
            [JsonProperty("authors")]
            public List<AuthorMeta> Authors { get; set; } = new List<AuthorMeta>();
            [JsonProperty("screenshots")]
            public List<ScreenshotsMeta> Screenshots { get; set; } = new List<ScreenshotsMeta>();
            [JsonProperty("latestFilesIndexes")]
            public List<CurseForgeFilesMeta> Files { get; set; } = new List<CurseForgeFilesMeta>();
            public List<CurseForgeDependenciesMeta> Dependencies { get; set; } = new List<CurseForgeDependenciesMeta>();
        }
        public class CurseForgeFilesMeta
        {

            [JsonProperty("fileId")]
            public string FileId { get; set; } = string.Empty;
            [JsonProperty("fileName")]
            public string FileName { get; set; } = string.Empty;
            [JsonProperty("releaseType")]
            public int releaseType { get; set; } = 1;
            [JsonProperty("gameVersion")]
            public string GameVersion { get; set; } = string.Empty;
            [JsonProperty("modLoader")]
            public int ModLoader { get; set; } = 1;
        }
        public class FingerprintsFilesMeta
        {
            [JsonProperty("modId")]
            public string ModId { get; set; } = string.Empty;
            [JsonProperty("id")]
            public string FileId { get; set; } = string.Empty;
            [JsonProperty("dependencies")]
            public CurseForgeDependenciesMeta Dependencies { get; set; }
        }
        public class CurseForgeDependenciesMeta
        {
            [JsonProperty("modId")]
            public int Id { get; set; } = 0;
            [JsonProperty("relationType")]
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
                var result = JObject.Parse(data);
                if (result != null)
                {
                    var mods = result["data"]?.ToArray();
                    if (mods != null)
                    {
                        foreach (var mod in mods)
                        {
                            var modData = (JObject)mod;
                            var latestFilesIndexes = modData["latestFilesIndexes"]?.ToArray();
                            List<string> gameVersionsList = latestFilesIndexes?
                                .Select(node => node["gameVersion"]?.ToString())
                                .OfType<string>()
                                .Distinct()
                                .OrderBy(v => v)
                                .ToList() ?? new List<string>();
                            var modResult = new CurseForgeSearchResult
                            {
                                Id = modData["id"]?.ToString() ?? string.Empty,
                                Name = modData["name"]?.ToString() ?? string.Empty,
                                Slug = modData["slug"]?.ToString() ?? string.Empty,
                                Summary = modData["summary"]?.ToString() ?? string.Empty,
                                Status = modData["status"]?.ToString() ?? string.Empty,
                                GameVersion = string.Join(", ", gameVersionsList),
                                DownloadCount = modData["downloadCount"]?.ToString() ?? string.Empty,
                                IconUrl = modData["logo"]?["url"]?.ToString() ?? string.Empty,
                                IsFeatured = modData["isFeatured"]?.Value<bool>() ?? false,
                                Authors = modData["authors"]?.Select(a => new AuthorMeta
                                {
                                    Id = a["id"]?.ToString() ?? string.Empty,
                                    Name = a["name"]?.ToString() ?? string.Empty,
                                    Url = a["url"]?.ToString() ?? string.Empty
                                }).ToList() ?? new List<AuthorMeta>(),
                                Categories = modData["categories"]?.Select(c => new CategoryMeta
                                {
                                    Id = (int)c["id"]!,
                                    Name = c["name"]?.ToString() ?? string.Empty,
                                    Slug = c["slug"]?.ToString() ?? string.Empty,
                                    Url = c["url"]?.ToString() ?? string.Empty
                                }).ToList() ?? new List<CategoryMeta>(),
                                Screenshots = modData["screenshots"]?.Select(s => new ScreenshotsMeta
                                {
                                    Id = (int)s["id"]!,
                                    ModId = (int)s["modId"]!,
                                    Title = s["title"]?.ToString() ?? string.Empty,
                                    Description = s["description"]?.ToString() ?? string.Empty,
                                    ThumbnailUrl = s["thumbnailUrl"]?.ToString() ?? string.Empty,
                                    Url = s["url"]?.ToString() ?? string.Empty
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
                var result = JObject.Parse(data);
                if (result != null)
                {
                    var modInfo = result["data"];
                    if (modInfo != null)
                    {
                        var returnData = new CurseForgeInfo();
                        returnData = modInfo.ToObject<CurseForgeInfo>() ?? throw new Exception("无法反序列化为 CurseForgeInfo");
                        returnData.Dependencies = modInfo["latestFiles"]?.SelectMany(file => file["dependencies"] ?? new JArray())
                            .Select(dep => new CurseForgeDependenciesMeta
                            {
                                Id = (int)(dep["modId"] ?? 0),
                                Type = (int)(dep["relationType"] ?? 0)
                            })
                            .ToList() ?? new List<CurseForgeDependenciesMeta>();
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

        public async Task<List<FingerprintsFilesMeta>> GetInfoFromHashesAsync(List<long> Hashes)
        {
            var dict = await GetInfoFromHashesDictAsync(Hashes);
            return dict.Values.ToList();
        }

        public async Task<Dictionary<long, FingerprintsFilesMeta>> GetInfoFromHashesDictAsync(List<long> Hashes)
        {
            if (Hashes == null || Hashes.Count == 0)
                throw new ArgumentNullException(nameof(Hashes), "Hashs cannot be null or empty.");
            var url = "/v1/fingerprints/432";

            var payload = new
            {
                fingerprints = Hashes
            };

            var data = await POSTData(url, API_KEY, payload);

            if (!string.IsNullOrEmpty(data))
            {
                var result = JObject.Parse(data);
                if (result != null)
                {
                    var modInfo = result["data"];
                    if (modInfo != null)
                    {
                        var exactMatches = modInfo["exactMatches"]?.ToArray();
                        if (exactMatches != null)
                        {
                            var returnData = new Dictionary<long, FingerprintsFilesMeta>();
                            foreach (var match in exactMatches)
                            {
                                var fingerprint = match["fingerprint"]?.Value<long>();
                                var modData = match["file"];
                                if (modData != null && fingerprint.HasValue)
                                {
                                    var fingerprintsFilesMeta = modData.ToObject<FingerprintsFilesMeta>()
                                        ?? throw new Exception("无法反序列化为 FingerprintsFilesMeta");
                                    returnData[fingerprint.Value] = fingerprintsFilesMeta;
                                }
                            }
                            return returnData;
                        }
                        else
                        {
                            return new Dictionary<long, FingerprintsFilesMeta>();
                        }
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
            return JObject.Parse(url)["data"]!.ToString() ?? throw new Exception("提取Url失败");
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
            return JObject.Parse(url)["data"]!.ToString() ?? throw new Exception("提取Url失败");
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
                var result = JObject.Parse(data);
                if (result != null)
                {
                    var mods = result["data"]?.ToArray();
                    if (mods != null)
                    {
                        foreach (var mod in mods)
                        {
                            var modData = (JObject)mod;
                            var modResult = new CurseForgeSearchResult
                            {
                                Id = modData["id"]?.ToString() ?? string.Empty,
                                Name = modData["name"]?.ToString() ?? string.Empty,
                                Slug = modData["slug"]?.ToString() ?? string.Empty,
                                Summary = modData["summary"]?.ToString() ?? string.Empty,
                                Status = modData["status"]?.ToString() ?? string.Empty,
                                GameVersion = modData["gameVersion"]?.ToString() ?? string.Empty,
                                DownloadCount = modData["downloadCount"]?.ToString() ?? string.Empty,
                                IconUrl = modData["iconUrl"]?.ToString() ?? string.Empty,
                                IsFeatured = modData["isFeatured"]?.Value<bool>() ?? false,
                                Authors = modData["authors"]?.Select(a => new AuthorMeta
                                {
                                    Id = a["id"]?.ToString() ?? string.Empty,
                                    Name = a["name"]?.ToString() ?? string.Empty,
                                    Url = a["url"]?.ToString() ?? string.Empty
                                }).ToList() ?? new List<AuthorMeta>(),
                                Categories = modData["categories"]?.Select(c => new CategoryMeta
                                {
                                    Id = (int)c["id"]!,
                                    Name = c["name"]?.ToString() ?? string.Empty,
                                    Slug = c["slug"]?.ToString() ?? string.Empty,
                                    Url = c["url"]?.ToString() ?? string.Empty
                                }).ToList() ?? new List<CategoryMeta>(),
                                Screenshots = modData["screenshots"]?.Select(s => new ScreenshotsMeta
                                {
                                    Id = (int)s["id"]!,
                                    ModId = (int)s["modId"]!,
                                    Title = s["title"]?.ToString() ?? string.Empty,
                                    Description = s["description"]?.ToString() ?? string.Empty,
                                    ThumbnailUrl = s["thumbnailUrl"]?.ToString() ?? string.Empty,
                                    Url = s["url"]?.ToString() ?? string.Empty
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
