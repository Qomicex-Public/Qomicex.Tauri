using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Linq;
using System.Net.Http;
using System.Net.Http.Headers;
using System.Security.Policy;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Threading.Tasks;

namespace Qomicex.Launcher.Backend.Modules.Helpers.Resources.Expansion.Modrinth
{
    public class ModrinthBase
    {
        internal string BASEURL { get; set; } = "https://api.modrinth.com/";
        internal string StagingURL { get; set; } = "https://staging-api.modrinth.com/";
        private readonly HttpClient _httpClient;
        private static readonly JsonSerializerOptions _jsonOptions = new()
        {
            PropertyNameCaseInsensitive = true
        };

        public ModrinthBase()
        {
            _httpClient = new HttpClient();
            ConfigureHttpClient();
        }

        private void ConfigureHttpClient()
        {
            // 清空默认 UA 并设置自定义信息
            _httpClient.DefaultRequestHeaders.UserAgent.Clear();
            _httpClient.DefaultRequestHeaders.UserAgent.Add(new ProductInfoHeaderValue("TheMyceliumOfAntan", "Lenmei233"));
            _httpClient.DefaultRequestHeaders.UserAgent.Add(new ProductInfoHeaderValue("Qomicex-Project", "1.0"));
            _httpClient.DefaultRequestHeaders.UserAgent.Add(new ProductInfoHeaderValue("(tmoaminecraft@gmail.com; lenmei233@vip.qq.com)"));
            _httpClient.DefaultRequestHeaders.Accept.Add(new MediaTypeWithQualityHeaderValue("application/json"));
        }

        internal async Task<string> GetDataAsync(string url)
        {
            if (!url.StartsWith("http"))
            {
                url = BASEURL + url;
            }
            var response = await _httpClient.GetAsync(url);
            response.EnsureSuccessStatusCode();
            return await response.Content.ReadAsStringAsync();

        }
        /// <summary>
        /// 搜索Modrinth上的项目
        /// </summary>
        /// <param name="query">搜索关键词</param>
        /// <param name="projectType">项目类型（可选，默认搜索mod）</param>
        /// <param name="gameVersion">游戏版本（可选）</param>
        /// <param name="page">页码（从0开始）</param>
        /// <param name="pageSize">每页数量（最大100）</param>
        /// <returns>搜索结果</returns>
        internal async Task<SearchResult> SearchAsync(string query,
                                                          string projectType = "",
                                                          string gameVersion = "",
                                                          string[]? categories = null,
                                                          string[]? loaders = null,
                                                          string index = Index.Relevance,
                                                          int page = 0,
                                                          int pageSize = 20)
        {
            if (string.IsNullOrEmpty(query))
                throw new ArgumentNullException(nameof(query), "搜索关键词不能为空");

            if (pageSize < 1 || pageSize > 100)
                throw new ArgumentOutOfRangeException(nameof(pageSize), "每页数量必须在1-100之间");

            // 构建搜索URL
            var urlBuilder = new StringBuilder($"{BASEURL}v2/search?query={Uri.EscapeDataString(query)}");

            // 构建facets参数列表
            var facets = new List<string>();

            // 添加项目类型过滤
            if (!string.IsNullOrEmpty(projectType))
            {
                facets.Add($"[\"project_type:{Uri.EscapeDataString(projectType)}\"]");
            }

            // 添加分类过滤
            if (categories != null && categories.Length > 0)
            {
                foreach (var cat in categories)
                {
                    facets.Add($"[\"categories:{Uri.EscapeDataString(cat)}\"]");
                }
            }

            // 添加加载器过滤
            if (loaders != null && loaders.Length > 0)
            {
                foreach (var loader in loaders)
                {
                    facets.Add($"[\"categories:{Uri.EscapeDataString(loader)}\"]");
                }
            }

            // 添加游戏版本过滤
            if (!string.IsNullOrEmpty(gameVersion))
            {
                facets.Add($"[\"versions:{Uri.EscapeDataString(gameVersion)}\"]");
            }

            // 添加facets参数
            if (facets.Count > 0)
            {
                string formattedFacets = $"[{string.Join(",", facets)}]";
                urlBuilder.Append($"&facets={Uri.EscapeDataString(formattedFacets)}");
            }

            // 添加其他参数
            urlBuilder.Append($"&limit={pageSize}");
            urlBuilder.Append($"&offset={page * pageSize}");
            urlBuilder.Append($"&index={Uri.EscapeDataString(index)}");

            try
            {
                string response = await GetDataAsync(urlBuilder.ToString());
                if (string.IsNullOrEmpty(response))
                    throw new Exception("搜索失败，响应为空");

                return JsonSerializer.Deserialize<SearchResult>(response, _jsonOptions)
                    ?? throw new Exception("无法将响应转换为搜索结果模型");
            }
            catch (JsonException ex)
            {
                throw new Exception($"搜索结果解析失败: {ex.Message}", ex);
            }
            catch (Exception ex)
            {
                throw new Exception($"搜索Mod时发生错误: {ex.Message}", ex);
            }
        }

        /// <summary>
        /// 异步获取Modrinth指定项目的信息
        /// </summary>
        /// <param name="projectIdOrSlug">项目ID（8位base62）或slug（别名）</param>
        /// <returns>项目详细信息(ProjectVersionInfo)</returns>
        /// <exception cref="ArgumentNullException">当项目ID或slug为空时抛出</exception>
        /// <exception cref="Exception">API请求或解析失败时抛出</exception>
        internal async Task<ProjectInfo> GetProjectAsync(string projectIdOrSlug)
        {
            if (string.IsNullOrEmpty(projectIdOrSlug))
                throw new ArgumentNullException(nameof(projectIdOrSlug), "项目ID或别名不能为空");

            // 构建getproject接口URL（支持ID或slug）
            string url = $"{BASEURL}v2/project/{Uri.EscapeDataString(projectIdOrSlug)}";

            try
            {
                string response = await GetDataAsync(url);
                if (string.IsNullOrEmpty(response))
                    throw new Exception("获取项目信息失败，响应为空");

                return JsonSerializer.Deserialize<ProjectInfo>(response, _jsonOptions)
                    ?? throw new Exception("无法将响应转换为项目信息模型");
            }
            catch (JsonException ex)
            {
                throw new Exception($"项目信息解析失败: {ex.Message}", ex);
            }
            catch (Exception ex)
            {
                throw new Exception($"获取项目信息时发生错误: {ex.Message}", ex);
            }
        }

        /// <summary>
        /// 异步获取指定项目的所有版本信息
        /// </summary>
        /// <param name="projectIdOrSlug">项目ID或slug</param>
        /// <returns>版本信息列表</returns>
        internal async Task<List<ProjectVersionInfo>> GetProjectVersionsAsync(string projectIdOrSlug)
        {
            if (string.IsNullOrEmpty(projectIdOrSlug))
                throw new ArgumentNullException(nameof(projectIdOrSlug), "项目ID或别名不能为空");

            string url = $"{BASEURL}v2/project/{Uri.EscapeDataString(projectIdOrSlug)}/version";

            try
            {
                string response = await GetDataAsync(url);
                return JsonSerializer.Deserialize<List<ProjectVersionInfo>>(response, _jsonOptions)
                    ?? new List<ProjectVersionInfo>();
            }
            catch (Exception)
            {
                throw;
            }
        }

        /// <summary>
        /// 异步获取指定版本的详细信息
        /// </summary>
        /// <param name="versionId">版本ID</param>
        /// <returns>版本详细信息</returns>
        internal async Task<VersionInfo> GetVersionAsync(string versionId)
        {
            if (string.IsNullOrEmpty(versionId))
                throw new ArgumentNullException(nameof(versionId), "版本ID不能为空");

            string url = $"{BASEURL}v2/version/{Uri.EscapeDataString(versionId)}";

            try
            {
                string response = await GetDataAsync(url);
                return JsonSerializer.Deserialize<VersionInfo>(response, _jsonOptions)
                    ?? throw new Exception("无法将响应转换为版本信息模型");
            }
            catch (JsonException)
            {
                throw;
            }
            catch (Exception)
            {
                throw;
            }
        }

        //从API获取所有分类
        public async Task<List<ModrinthTag>> GetCategoriesAsync()
        {
            return await GetTagsAsync("category");
        }

        // 从API获取所有加载器
        public async Task<List<ModrinthTag>> GetLoadersAsync()
        {
            return await GetTagsAsync("loader");
        }

        // 从API获取所有项目类型
        public async Task<List<ModrinthTag>> GetProjectTypesAsync()
        {
            return await GetTagsAsync("project_type");
        }

        // 通用标签获取方法
        private async Task<List<ModrinthTag>> GetTagsAsync(string tagType)
        {
            if (string.IsNullOrEmpty(tagType))
                throw new ArgumentNullException(nameof(tagType));

            string url = $"{BASEURL}v2/tag/{tagType}";

            try
            {
                string response = await GetDataAsync(url);
                if (string.IsNullOrEmpty(response))
                    throw new Exception($"获取{tagType}列表失败，响应为空");

                List<ModrinthTag> tags = new List<ModrinthTag>();

                // 项目类型API返回的是字符串数组，需要特殊处理
                if (tagType == "project_type")
                {
                    // 解析字符串数组
                    var stringTags = JsonSerializer.Deserialize<List<string>>(response, _jsonOptions);
                    if (stringTags != null)
                    {
                        tags.AddRange(stringTags.Select(t => new ModrinthTag
                        {
                            StringValue = t,
                            Name = t
                        }));
                    }
                }
                else
                {
                    // 分类和加载器返回的是对象数组
                    var objectTags = JsonSerializer.Deserialize<List<ModrinthTag>>(response, _jsonOptions);
                    if (objectTags != null)
                    {
                        tags.AddRange(objectTags);
                    }
                }

                return tags;
            }
            catch (JsonException ex)
            {
                throw new Exception($"解析{tagType}列表失败: {ex.Message}", ex);
            }
            catch (Exception ex)
            {
                throw new Exception($"获取{tagType}列表时发生错误: {ex.Message}", ex);
            }
        }


        // 标签通用模型（适用于分类、加载器、项目类型）
        public class ModrinthTag
        {
            // 用于直接存储字符串类型的标签
            public string StringValue { get; set; } = string.Empty;

            [JsonPropertyName("name")]
            public string Name { get; set; } = string.Empty;

            [JsonPropertyName("icon")]
            public string Icon { get; set; } = string.Empty;

            [JsonPropertyName("description")]
            public string Description { get; set; } = string.Empty;

            [JsonPropertyName("checked")]
            public bool IsChecked { get; set; } = false;
        }

        public static class ProjectType
        {
            public const string Mod = "mod";
            public const string Modpack = "modpack";
            public const string ResourcePack = "resourcepack";
            public const string Shader = "shader";
            public const string Datapack = "datapack";
        }

        // 客户端/服务器支持类型
        public static class SupportType
        {
            public const string Required = "required";
            public const string Optional = "optional";
            public const string Unsupported = "unsupported";
        }
        // 搜索结果模型
        public class SearchResult
        {
            [JsonPropertyName("hits")]
            public List<SearchResultInfo> Results { get; set; } = new List<SearchResultInfo>(); // 搜索结果列表

            [JsonPropertyName("total_hits")]
            public int TotalResults { get; set; } = 0; // 总结果数量
        }


        // 搜索结果详细信息
        public class SearchResultInfo
        {
            [JsonPropertyName("project_id")]
            public string Id { get; set; } = string.Empty; // 项目唯一ID（8位base62）

            [JsonPropertyName("slug")]
            public string Slug { get; set; } = string.Empty; // 项目别名（URL友好）

            [JsonPropertyName("title")]
            public string Name { get; set; } = string.Empty; // 项目名称

            [JsonPropertyName("description")]
            public string Description { get; set; } = string.Empty; // 简短描述

            [JsonPropertyName("body")]
            public string FullDescription { get; set; } = string.Empty; // 详细描述（HTML格式）

            [JsonPropertyName("project_type")]
            public string Type { get; set; } = string.Empty; // 项目类型（对应ProjectType常量）

            [JsonPropertyName("client_side")]
            public string ClientSide { get; set; } = string.Empty; // 客户端支持类型

            [JsonPropertyName("server_side")]
            public string ServerSide { get; set; } = string.Empty; // 服务器支持类型

            [JsonPropertyName("downloads")]
            public int DownloadCount { get; set; } = 0; // 总下载量

            [JsonPropertyName("follows")]
            public int FollowCount { get; set; } = 0; // 关注数

            [JsonPropertyName("icon_url")]
            public string IconUrl { get; set; } = string.Empty; // 图标URL

            [JsonPropertyName("date_created")]
            public DateTime CreatedAt { get; set; } = DateTime.MinValue; // 创建时间

            [JsonPropertyName("date_modified")]
            public DateTime UpdatedAt { get; set; } = DateTime.MinValue; // 最后更新时间

            [JsonPropertyName("license")]
            public string License { get; set; } = string.Empty; // 许可证信息

            [JsonPropertyName("author")]
            public string Author { get; set; } = string.Empty; // 作者

            [JsonPropertyName("categories")]
            public List<string> Categories { get; set; } = new List<string>(); // 分类标签（如"technology"）

            [JsonPropertyName("tags")]
            public List<string> Tags { get; set; } = new List<string>(); // 自定义标签

            [JsonPropertyName("versions")]
            public List<string> VersionIds { get; set; } = new List<string>(); // 版本ID列表

            [JsonPropertyName("gallery")]
            public List<string> GalleryUrls { get; set; } = new List<string>(); // 画廊图片URL列表
        }

        // 项目信息模型（用于获取项目详细信息）
        public class ProjectInfo
        {
            [JsonPropertyName("client_side")]
            public string ClientSide { get; set; } = string.Empty; // 客户端支持类型

            [JsonPropertyName("server_side")]
            public string ServerSide { get; set; } = string.Empty; // 服务器支持类型

            [JsonPropertyName("game_versions")]
            public List<string> GameVersionIds { get; set; } = new List<string>(); // 版本ID列表

            [JsonPropertyName("id")]
            public string Id { get; set; } = string.Empty; // 项目唯一ID（8位base62）

            [JsonPropertyName("slug")]
            public string Slug { get; set; } = string.Empty; // 项目别名

            [JsonPropertyName("project_type")]
            public string Type { get; set; } = string.Empty; // 项目类型

            [JsonPropertyName("team")]
            public string Team { get; set; } = string.Empty; // 团队ID
            [JsonPropertyName("organization")]
            public string Organization { get; set; } = string.Empty; // 组织

            [JsonPropertyName("title")]
            public string Name { get; set; } = string.Empty; // 项目名称

            [JsonPropertyName("description")]
            public string Description { get; set; } = string.Empty; // 简短描述

            [JsonPropertyName("body")]
            public string FullDescription { get; set; } = string.Empty; // 详细描述（MarkDown格式）

            //body_url不保留，因为Modrinth已经不再使用该字段body_url The link to the long description of the project.Always null, only kept for legacy compatibility.
            [JsonPropertyName("published")]
            public DateTime PublishAt { get; set; } = DateTime.MinValue; // 创建时间

            [JsonPropertyName("updated")]
            public DateTime UpdatedAt { get; set; } = DateTime.MinValue; // 最后更新时间

            [JsonPropertyName("approved")]
            public DateTime ApprovedAt { get; set; } = DateTime.MinValue; // 审核时间
            //queued不保留因为不需要
            //[JsonProperty("license")]
            //public string License { get; set; } = string.Empty; // 许可证信息

            [JsonPropertyName("downloads")]
            public int DownloadCount { get; set; } = 0; // 总下载量

            [JsonPropertyName("followers")]
            public int FollowCount { get; set; } = 0; // 关注数

            [JsonPropertyName("categories")]
            public List<string> Categories { get; set; } = new List<string>(); // 分类标签（如"technology"）

            [JsonPropertyName("additional_categories")]
            public List<string> AdditionalCategories { get; set; } = new List<string>(); // 附加分类标签

            [JsonPropertyName("loaders")]
            public List<string> Loaders { get; set; } = new List<string>(); // 加载器支持列表（如"forge", "fabric"）

            [JsonPropertyName("versions")]
            public List<string> Versions { get; set; } = new List<string>(); // 项目版本ID列表(8位base62)

            [JsonPropertyName("icon_url")]
            public string IconUrl { get; set; } = string.Empty; // 图标URL

            [JsonPropertyName("issues_url")]
            public string IssuesUrl { get; set; } = string.Empty; // IssuesURL

            [JsonPropertyName("source_url")]
            public string SourceUrl { get; set; } = string.Empty; // 源码URL

            [JsonPropertyName("wiki_url")]
            public string WikiUrl { get; set; } = string.Empty; // Wiki URL

            [JsonPropertyName("discord_url")]
            public string DiscordUrl { get; set; } = string.Empty; // Discord URL


            [JsonPropertyName("gallery")]
            public List<GalleryItem> Gallery { get; set; } = new List<GalleryItem>(); // 画廊图片URL列表

            //剩下不需要
        }

        public class VersionInfo
        {
            [JsonPropertyName("game_versions")]
            public List<string> GameVersionIds { get; set; } = new List<string>(); // 游戏版本ID列表

            [JsonPropertyName("loaders")]
            public List<string> Loaders { get; set; } = new List<string>(); // 支持的加载器列表

            [JsonPropertyName("id")]
            public string Id { get; set; } = string.Empty; // 版本ID（8位base62）

            [JsonPropertyName("slug")]
            public string Slug { get; set; } = string.Empty; // 别名（URL友好）

            [JsonPropertyName("project_id")]
            public string ProjectId { get; set; } = string.Empty; // 所属项目ID

            [JsonPropertyName("title")]
            public string Name { get; set; } = string.Empty; // 版本名称

            [JsonPropertyName("versions")]
            public List<string> Versions { get; set; } = new List<string>(); // 项目版本ID列表(8位base62)

            [JsonPropertyName("changelog")]
            public string Changelog { get; set; } = string.Empty; // 更新日志

            [JsonPropertyName("published")]
            public DateTime PublishedAt { get; set; } = DateTime.MinValue; // 发布时间

            [JsonPropertyName("updated")]
            public DateTime UpdatedAt { get; set; } = DateTime.MinValue; // 更新时间

            [JsonPropertyName("approved")]
            public DateTime ApprovedAt { get; set; } = DateTime.MinValue; // 审核时间

            [JsonPropertyName("downloads")]
            public int DownloadCount { get; set; } = 0; // 该版本下载量

            [JsonPropertyName("icon_url")]
            public string IconUrl { get; set; } = string.Empty; // 图标URL

            [JsonPropertyName("files")]
            public List<VersionFileInfo> Files { get; set; } = new List<VersionFileInfo>(); // 版本文件列表

            [JsonPropertyName("dependencies")]
            public List<DependenciesInfo> DependenciesInfos { get; set; } = new List<DependenciesInfo>();
        }


        /// <summary>
        /// 表示Modrinth项目画廊中的单个图片项
        /// </summary>
        public class GalleryItem
        {
            /// <summary>
            /// 画廊图片的URL（必填）
            /// </summary>
            [JsonPropertyName("url")]
            [JsonRequired]
            public string? Url { get; set; }

            /// <summary>
            /// 图片是否在画廊中被标记为精选（必填）
            /// </summary>
            [JsonPropertyName("featured")]
            [JsonRequired]
            public bool Featured { get; set; }

            /// <summary>
            /// 画廊图片的标题（可选，可为null）
            /// </summary>
            [JsonPropertyName("title")]
            public string? Title { get; set; }

            /// <summary>
            /// 画廊图片的描述（可选，可为null）
            /// </summary>
            [JsonPropertyName("description")]
            public string? Description { get; set; }

            /// <summary>
            /// 画廊图片的创建日期和时间（必填，ISO-8601格式）
            /// </summary>
            [JsonPropertyName("created")]
            [JsonRequired]
            public DateTime Created { get; set; }

            /// <summary>
            /// 画廊图片的排序序号。画廊图片将按此字段排序，然后按标题字母顺序排序
            /// </summary>
            [JsonPropertyName("ordering")]
            public int? Ordering { get; set; }
        }

        // 版本信息模型
        public class ProjectVersionInfo
        {
            [JsonPropertyName("game_versions")]
            public List<string> GameVersionIds { get; set; } = new List<string>(); // 游戏版本ID列表

            [JsonPropertyName("loaders")]
            public List<string> Loaders { get; set; } = new List<string>(); // 支持的加载器列表

            [JsonPropertyName("id")]
            public string Id { get; set; } = string.Empty; // 版本ID（8位base62）

            [JsonPropertyName("project_id")]
            public string ProjectId { get; set; } = string.Empty; // 所属项目ID

            [JsonPropertyName("name")]
            public string Name { get; set; } = string.Empty; // 版本名称

            [JsonPropertyName("version_number")]
            public string VersionNumber { get; set; } = string.Empty; // 版本号（如"1.0.0"）

            [JsonPropertyName("changelog")]
            public string Changelog { get; set; } = string.Empty; // 更新日志

            [JsonPropertyName("date_published")]
            public DateTime PublishedAt { get; set; } = DateTime.MinValue; // 发布时间

            [JsonPropertyName("downloads")]
            public int DownloadCount { get; set; } = 0; // 该版本下载量

            [JsonPropertyName("version_type")]
            public string VersionType { get; set; } = string.Empty; // 版本类型（如"release", "beta", "alpha"）

            [JsonPropertyName("files")]
            public List<VersionFileInfo> Files { get; set; } = new List<VersionFileInfo>(); // 版本文件列表

            [JsonPropertyName("dependencies")]
            public List<DependenciesInfo> DependenciesInfos { get; set; } = new List<DependenciesInfo>();

        }

        // 版本文件信息子模型
        public class VersionFileInfo
        {

            [JsonPropertyName("filename")]
            public string Filename { get; set; } = string.Empty; // 文件名

            [JsonPropertyName("url")]
            public string DownloadUrl { get; set; } = string.Empty; // 下载URL

            [JsonPropertyName("size")]
            public long Size { get; set; } = 0; // 文件大小（bytes字节）

            [JsonPropertyName("primary")]
            public bool IsPrimary { get; set; } = false; // 是否为主要文件

            [JsonPropertyName("file_type")]
            public string FileType { get; set; } = string.Empty; //  附加文件的类型，主要用于将资源包添加到数据包中Allowed values: required-resource-pack,optional-resource-pack

            [JsonPropertyName("hashes")]
            public FileHashes Hashes { get; set; } = new FileHashes(); // 文件哈希值
        }

        // 文件哈希子模型
        public class FileHashes
        {
            [JsonPropertyName("sha1")]
            public string Sha1 { get; set; } = string.Empty; // SHA1哈希

            [JsonPropertyName("sha512")]
            public string Sha512 { get; set; } = string.Empty; // SHA512哈希
        }

        public class DependenciesInfo
        {
            [JsonPropertyName("version_id")]
            public string VersionId { get; set; } = string.Empty; //当前版本所依赖的版本ID

            [JsonPropertyName("project_id")]
            public string ProjectId { get; set; } = string.Empty; //当前版本所依赖的项目ID

            [JsonPropertyName("file_name")]
            public string FileName { get; set; } = string.Empty; // 当前版本所依赖的文件名

            [JsonPropertyName("dependency_type")]
            public string DependencyType { get; set; } = string.Empty; // 当前版本所依赖的类型 required optional incompatible embedded
        }

        public class Index
        {
            // 按相关性排序(默认)
            public const string Relevance = "relevance";

            // 按下载量排序
            public const string Downloads = "downloads";

            // 按关注度/跟随数排序
            public const string Follows = "follows";

            // 按最新发布排序
            public const string Newest = "newest";

            // 按最近更新排序
            public const string Updated = "updated";
        }

        [JsonConverter(typeof(JsonStringEnumConverter))]
        public enum ModLoaderType
        {
            minecraft,
            forge,
            fabric,
            quilt,
            neoForge,
            rift,
            liteLoader,
            modLoader,
            nilloader,
            ornithe
        }
    }
}
