using Newtonsoft.Json;
using Newtonsoft.Json.Linq;
using System.Diagnostics;
using System.Text;
using System.Text.RegularExpressions;
using static System.Net.WebRequestMethods;
using File = System.IO.File;

namespace Qomicex.Core.Modules.Helpers.Resources
{
    public class ModLoaderResourceHelper
    {
        public enum DownloadSources
        {
            Official, // 官方源
            BMCLAPI // BMCLAPI源
        }
        public enum ModLoaderType
        {
            All, // 全部类型
            Forge,
            Fabric,
            NeoForge,
            Quilt,
            LiteLoader,
            Optifine
        }
        public class DownloadSource
        {
            public string librariesSource = "https://libraries.minecraft.net/";
            public string mainJarSource = string.Empty;
            public string assetsIndexSource = string.Empty;
            public string assetsSource = "https://resources.download.minecraft.net/";
        }
        public class ModLoaderInfo
        {
            public ModLoaderType Type { get; set; }
            public string Version { get; set; } = string.Empty;
            public string MinecraftVersion { get; set; } = string.Empty;
            public string DownloadUrl { get; set; } = string.Empty;
            public string Sha1 { get; set; } = string.Empty;
            public bool IsRecommended { get; set; } = false;
            public DateTime? PublishedAt { get; set; }
            public string InstallerFileName => $"{Type.ToString().ToLower()}-{MinecraftVersion}-{Version}-installer.jar";
            public string VersionJsonPath => $"{MinecraftVersion}-{Type.ToString().ToLower()}-{Version}/{MinecraftVersion}-{Type.ToString().ToLower()}-{Version}.json";

            public override string ToString()
            {
                return Version;
            }
        }

        private readonly DownloadSource? _downloadSource;
        private readonly int _downloadSourceId;

        public ModLoaderResourceHelper(int downloadSourceId = 0)
        {
            _downloadSourceId = downloadSourceId;
            _downloadSource = SetDownloadSource(downloadSourceId);
        }

        public DownloadSource SetDownloadSource(int sourceId)
        {
            if (sourceId == (int)DownloadSources.BMCLAPI)
            {
                return new DownloadSource
                {
                    librariesSource = "https://bmclapi2.bangbang93.com/maven/",
                    mainJarSource = "https://bmclapi2.bangbang93.com/",
                    assetsIndexSource = "https://bmclapi2.bangbang93.com/"
                };
            }
            else
            {
                return new DownloadSource
                {
                    librariesSource = "https://libraries.minecraft.net/",
                    mainJarSource = "https://launcher.mojang.com/",
                    assetsIndexSource = "https://launchermeta.mojang.com/"
                };
            }
        }

        public async Task<List<ModLoaderInfo>> GetAvailableModLoaders(string minecraftVersion, ModLoaderType modLoaderType = ModLoaderType.All)
        {
            if (modLoaderType == ModLoaderType.All)
            {
                var allLoaders = new List<ModLoaderInfo>();

                // 并行获取各类型ModLoader版本
                var forgeTask = WithTimeout(GetForgeVersions(minecraftVersion));
                var fabricTask = WithTimeout(GetFabricVersions(minecraftVersion));
                var neoForgeTask = WithTimeout(GetNeoForgeVersions(minecraftVersion));
                var quiltTask = WithTimeout(GetQuiltVersions(minecraftVersion));
                var optifineTask = WithTimeout(GetOptifineVersions(minecraftVersion));
                var liteloaderTask = WithTimeout(GetLiteloaderVersions(minecraftVersion));

                await Task.WhenAll(forgeTask, fabricTask, neoForgeTask, optifineTask, liteloaderTask, quiltTask);
                // 合并结果,超时后可能是空列表
                allLoaders.AddRange(await forgeTask ?? new List<ModLoaderInfo>());
                allLoaders.AddRange(await fabricTask ?? new List<ModLoaderInfo>());
                allLoaders.AddRange(await neoForgeTask ?? new List<ModLoaderInfo>());
                allLoaders.AddRange(await optifineTask ?? new List<ModLoaderInfo>());
                allLoaders.AddRange(await liteloaderTask ?? new List<ModLoaderInfo>());
                allLoaders.AddRange(await quiltTask ?? new List<ModLoaderInfo>());

                return allLoaders.OrderByDescending(l => l.Version, new VersionComparer()).ToList();

            }
            else if (modLoaderType == ModLoaderType.Forge)
            {
                var forgeVersions = await GetForgeVersions(minecraftVersion);
                return forgeVersions.OrderByDescending(l => l.Version, new VersionComparer()).ToList();
            }
            else if (modLoaderType == ModLoaderType.Fabric)
            {
                var fabricVersions = await GetFabricVersions(minecraftVersion);
                return fabricVersions.OrderByDescending(l => l.Version, new VersionComparer()).ToList();
            }
            else if (modLoaderType == ModLoaderType.Quilt)
            {
                var quiltVersions = await GetQuiltVersions(minecraftVersion);
                return quiltVersions.OrderByDescending(l => l.Version, new VersionComparer()).ToList();
            }
            else if (modLoaderType == ModLoaderType.LiteLoader)
            {
                var liteloaderVersions = await GetLiteloaderVersions(minecraftVersion);
                return liteloaderVersions.OrderByDescending(l => l.Version, new VersionComparer()).ToList();
            }
            else if (modLoaderType == ModLoaderType.NeoForge)
            {
                var neoForgeVersions = await GetNeoForgeVersions(minecraftVersion);
                return neoForgeVersions.OrderByDescending(l => l.Version, new VersionComparer()).ToList();
            }
            else if (modLoaderType == ModLoaderType.Optifine)
            {
                var optifineVersions = await GetOptifineVersions(minecraftVersion);
                return optifineVersions.OrderByDescending(l => l.Version, new VersionComparer()).ToList();
            }
            else
            {
                throw new ArgumentException($"不支持的ModLoader类型: {modLoaderType}");
            }
        }
        private async Task<List<ModLoaderInfo>> WithTimeout(Task<List<ModLoaderInfo>> task, int timeoutMs = 10000) //10秒超时
        {
            var timeoutTask = Task.Delay(timeoutMs);
            var completedTask = await Task.WhenAny(task, timeoutTask);

            if (completedTask == timeoutTask)
            {
                return new List<ModLoaderInfo>();
                throw new TimeoutException("任务超时");
            }

            return await task; // 正常完成的任务
        }
        private async Task<List<ModLoaderInfo>> GetForgeVersions(string minecraftVersion)
        {
            // 根据下载源选择获取方式
            if (_downloadSourceId == (int)DownloadSources.Official)
            {
                return await GetForgeVersionsFromOfficialHtml(minecraftVersion);
            }
            else if (_downloadSourceId == (int)DownloadSources.BMCLAPI)
            {
                return await GetForgeVersionsFromJsonApi(minecraftVersion);
            }
            return new List<ModLoaderInfo>();
        }
        /// <summary>
        /// BMCLAPI 专用：从 JSON API 获取版本
        /// </summary>

        private async Task<List<ModLoaderInfo>> GetForgeVersionsFromJsonApi(string minecraftVersion)
        {
            var forgeLoaders = new List<ModLoaderInfo>();
            using (var client = CreateHttpClient())

                try
                {
                    string url = $"https://bmclapi2.bangbang93.com/forge/minecraft/{minecraftVersion}";
                    var response = await client.GetAsync(url);

                    // 仅当状态码成功时才解析（BMCLAPI 不存在时返回空列表）
                    if (response.IsSuccessStatusCode)
                    {
                        var json = await response.Content.ReadAsStringAsync();
                        var versionsArray = JArray.Parse(json);

                        foreach (var version in versionsArray.Children<JObject>())
                        {
                            string apiMcVersion = version["mcversion"]?.ToString() ?? string.Empty;
                            if (!apiMcVersion.Equals(minecraftVersion, StringComparison.OrdinalIgnoreCase))
                                continue;

                            // 提取安装器信息
                            var installerFile = version["files"]?.Children<JObject>()
                            .FirstOrDefault(f => f["category"]?.ToString().Equals("installer", StringComparison.OrdinalIgnoreCase) == true);

                            if (installerFile == null)
                                continue;

                            forgeLoaders.Add(new ModLoaderInfo
                            {
                                Type = ModLoaderType.Forge,
                                Version = version["version"]?.ToString() ?? string.Empty,
                                MinecraftVersion = minecraftVersion,
                                DownloadUrl = GetForgeDownloadUrl(minecraftVersion, version["build"]?.ToString() ?? string.Empty), //使用build为了BMCLAPI的获取下载链接方式
                                Sha1 = installerFile["hash"]?.ToString() ?? string.Empty,
                                IsRecommended = IsRecommendedVersion(version["build"]?.ToString() ?? string.Empty, forgeLoaders),
                                PublishedAt = version["modified"]?.ToObject<DateTime?>()
                            });
                        }
                    }
                }
                catch (Exception ex)
                {
                    Trace.WriteLine($"BMCLAPI JSON 获取 Forge 版本失败: {ex.Message}");
                }

            return forgeLoaders;
        }
        /// <summary>
        /// 官方源专用：从 HTML 页面解析版本
        /// </summary>
        private async Task<List<ModLoaderInfo>> GetForgeVersionsFromOfficialHtml(string minecraftVersion)
        {
            var forgeLoaders = new List<ModLoaderInfo>();
            var cacheFilePath = GetCacheFilePath(minecraftVersion);
            const int cacheExpiryHours = 24;

            // 尝试使用缓存
            if (File.Exists(cacheFilePath) &&
                (DateTime.Now - File.GetLastWriteTime(cacheFilePath)).TotalHours < cacheExpiryHours)
            {
                try
                {
                    var cachedHtml = File.ReadAllText(cacheFilePath);
                    return ParseForgeVersions(minecraftVersion, cachedHtml);
                }
                catch (Exception ex)
                {
                    Trace.WriteLine($"使用缓存失败: {ex.Message}，将重新获取");
                }
            }

            var sourceUrls = new List<string>
    {
        $"https://files.minecraftforge.net/net/minecraftforge/forge/index_{minecraftVersion}.html",
        //其他备用源（如果有镜像，目前没找到）
    };

            using (var client = CreateHttpClient())
            {
                foreach (var url in sourceUrls)
                {
                    try
                    {
                        var response = await client.GetAsync(url);
                        if (!response.IsSuccessStatusCode)
                        {
                            Trace.WriteLine($"源 {url} 请求失败: {response.StatusCode}");
                            continue;
                        }

                        var htmlBytes = await response.Content.ReadAsByteArrayAsync();
                        var htmlContent = Encoding.UTF8.GetString(htmlBytes);

                        // 缓存HTML内容
                        try
                        {
                            var cacheDir = Path.GetDirectoryName(cacheFilePath);
                            if (!Directory.Exists(cacheDir))
                                Directory.CreateDirectory(cacheDir!);
                            File.WriteAllText(cacheFilePath, htmlContent);
                            Trace.WriteLine($"已缓存html到{cacheFilePath}");
                        }
                        catch (Exception ex)
                        {
                            Trace.WriteLine($"缓存写入失败: {ex.Message}");
                        }

                        // 解析并返回结果
                        var result = ParseForgeVersions(minecraftVersion, htmlContent);
                        if (result.Any())
                            return result;
                    }
                    catch (Exception ex)
                    {
                        Trace.WriteLine($"从源 {url} 提取数据失败: {ex.Message}");
                    }
                }
            }

            // 所有源都失败时尝试使用缓存（即使已过期）
            if (File.Exists(cacheFilePath))
            {
                try
                {
                    var cachedHtml = File.ReadAllText(cacheFilePath);
                    Trace.WriteLine($"读取已缓存html到{cacheFilePath}中的数据");
                    return ParseForgeVersions(minecraftVersion, cachedHtml);
                }
                catch (Exception ex)
                {
                    Trace.WriteLine($"使用过期缓存失败: {ex.Message}");
                }
            }

            return forgeLoaders;
        }
        /// <summary>
        /// 解析HTML内容提取版本信息
        /// </summary>
        private List<ModLoaderInfo> ParseForgeVersions(string minecraftVersion, string htmlContent)
        {
            var forgeLoaders = new List<ModLoaderInfo>();

            // 匹配包含所有版本的表格
            var tableMatch = Regex.Match(
                htmlContent,
                @"<table[^>]+class=""[^""]*download-list[^""]*""[^>]*>.*?</table>",
                RegexOptions.Singleline
            );

            if (!tableMatch.Success)
            {
                Trace.WriteLine("未找到版本表格");
                return forgeLoaders;
            }

            // 提取所有版本行
            var rowMatches = Regex.Matches(
                tableMatch.Value,
                @"<tr[^>]*>.*?<td[^>]+class=""[^""]*download-version[^""]*""[^>]*>.*?</tr>",
                RegexOptions.Singleline
            );

            Trace.WriteLine($"找到 {rowMatches.Count} 个版本行");

            foreach (Match rowMatch in rowMatches)
            {
                if (!rowMatch.Success) continue;
                var rowHtml = rowMatch.Value;

                // 提取版本号
                var versionMatch = Regex.Match(
                    rowHtml,
                    @"(?<=<td[^>]+class=""[^""]*download-version[^""]*""[^>]*>\s*)[\d.]+(?:-[a-zA-Z0-9_]+)?(?=\s*<)",
                    RegexOptions.IgnoreCase
                );
                if (!versionMatch.Success)
                {
                    Trace.WriteLine($"未提取到版本号: {GetSnippet(rowHtml)}");
                    continue;
                }
                var forgeVersion = versionMatch.Value;

                // 提取文件类型（installer/universal/client）
                var categoryMatch = Regex.Match(
                    rowHtml,
                    @"classifier-(installer|universal|client)",
                    RegexOptions.IgnoreCase
                );
                var fileCategory = categoryMatch.Success ? categoryMatch.Groups[1].Value : "installer";

                // 提取下载链接
                var urlPattern = $@"href=""([^""]*?forge-(?:{minecraftVersion.Replace(".", "\\.")}|.{minecraftVersion.Replace(".", "\\.")})-{forgeVersion}.*?{fileCategory}\.(jar|zip)[^""]*)""";
                var urlMatch = Regex.Match(rowHtml, urlPattern, RegexOptions.IgnoreCase);

                if (!urlMatch.Success)
                {
                    urlMatch = Regex.Match(
                        rowHtml,
                        @"href=""([^""]*?forge-.*?\.jar[^""]*)""",
                        RegexOptions.IgnoreCase
                    );
                }

                if (!urlMatch.Success)
                {
                    Trace.WriteLine($"版本 {forgeVersion} 未找到下载链接: {GetSnippet(rowHtml)}");
                    continue;
                }
                var rawDownloadUrl = urlMatch.Groups[1].Value;

                var cleanDownloadUrl = CleanDownloadUrl(rawDownloadUrl);

                var sha1Match = Regex.Match(
                    rowHtml,
                    @"(?i)sha1[:=]\s*([a-f0-9]{40})",
                    RegexOptions.IgnoreCase
                );
                var sha1 = sha1Match.Success ? sha1Match.Groups[1].Value.Trim() : string.Empty;

                // 识别版本类型
                var isLatest = rowHtml.Contains("promo-latest", StringComparison.OrdinalIgnoreCase);
                var isRecommended = rowHtml.Contains("promo-recommended", StringComparison.OrdinalIgnoreCase) || isLatest;

                forgeLoaders.Add(new ModLoaderInfo
                {
                    Type = ModLoaderType.Forge,
                    Version = forgeVersion,
                    MinecraftVersion = minecraftVersion,
                    DownloadUrl = cleanDownloadUrl,
                    Sha1 = sha1,
                    IsRecommended = isRecommended
                });
            }

            // 按版本号降序排序
            forgeLoaders.Sort((a, b) => VersionSortInteger(b.Version, a.Version));
            Trace.WriteLine($"最终提取到 {forgeLoaders.Count} 个有效版本");

            return forgeLoaders;
        }

        private string CleanDownloadUrl(string rawUrl)
        {
            if (rawUrl.Contains("adfoc.us"))
            {
                var decodedUrl = System.Web.HttpUtility.UrlDecode(rawUrl);
                var directUrlMatch = Regex.Match(decodedUrl, @"https://maven\.minecraftforge\.net/.*?\.jar");
                if (directUrlMatch.Success)
                    return directUrlMatch.Value;
            }

            if (!rawUrl.StartsWith("http"))
            {
                return "https://files.minecraftforge.net" +
                       (rawUrl.StartsWith("/") ? "" : "/") +
                       rawUrl;
            }

            return rawUrl;
        }

        private string GetSnippet(string html, int maxLength = 200)
        {
            return html.Length <= maxLength
                ? html
                : html.Substring(0, maxLength) + "...";
        }

        private string GetCacheFilePath(string minecraftVersion)
        {
            var cacheDir = Path.Combine(Path.GetTempPath(), "ForgeVersionCache");
            return Path.Combine(cacheDir, $"{minecraftVersion}_forge.html");
        }


        //获取下载链接
        private string GetForgeDownloadUrl(string mcVersion, string forgeVersion)
        {
            if (string.IsNullOrEmpty(forgeVersion))
                return string.Empty;
            return _downloadSourceId == (int)LocalResourceHelper.DownloadSources.BMCLAPI
            ? $"https://bmclapi2.bangbang93.com/forge/download/{forgeVersion}" //https://bmclapi2.bangbang93.com/forge/download/:build
            : $"https://maven.minecraftforge.net/net/minecraftforge/forge/{mcVersion}-{forgeVersion}/forge-{mcVersion}-{forgeVersion}-installer.jar";
        }
        private class VersionComparer : IComparer<string>
        {
            public int Compare(string? x, string? y)
            {
                return VersionSortInteger(x!, y!);
            }
        }
        // 判断是否为推荐版本（仅用于BMCLAPI）
        private bool IsRecommendedVersion(string buildNumber, List<ModLoaderInfo> existingLoaders)
        {
            if (!int.TryParse(buildNumber, out int currentBuild))
                return false;

            // 检查当前 build 是否为已收集版本中的最高值
            foreach (var loader in existingLoaders)
            {
                if (int.TryParse(loader.Version.Split('.').LastOrDefault(), out int existingBuild))
                {
                    if (currentBuild <= existingBuild)
                        return false;
                }
            }
            return true;
        }
        //专用于MCLib版本对比的方法，思路来源于PCL
        private static int VersionSortInteger(string left, string right)
        {
            if (left == "未知版本" || right == "未知版本")
            {
                if (left == "未知版本" && right != "未知版本") return 1;
                if (left != "未知版本" && right == "未知版本") return -1;
                return 0;
            }

            left = left.ToLowerInvariant().Replace("快照", "snapshot").Replace("预览版", "pre");
            right = right.ToLowerInvariant().Replace("快照", "snapshot").Replace("预览版", "pre");

            var leftParts = Regex.Matches(left, "[a-z]+|[0-9]+").Select(m => m.Value).ToList();
            var rightParts = Regex.Matches(right, "[a-z]+|[0-9]+").Select(m => m.Value).ToList();

            for (int i = 0; ; i++)
            {
                if (i >= leftParts.Count && i >= rightParts.Count)
                {
                    return string.Compare(left, right, StringComparison.Ordinal);
                }

                string lVal = i < leftParts.Count ? leftParts[i] : "-1";
                string rVal = i < rightParts.Count ? rightParts[i] : "-1";

                if (lVal == rVal) continue;

                lVal = ConvertSpecialLabel(lVal);
                rVal = ConvertSpecialLabel(rVal);

                if (!int.TryParse(lVal, out int lNum) || !int.TryParse(rVal, out int rNum))
                {
                    return string.Compare(lVal, rVal, StringComparison.Ordinal);
                }

                if (lNum > rNum) return 1;
                if (lNum < rNum) return -1;
            }
        }
        private static string ConvertSpecialLabel(string label)
        {
            return label switch
            {
                "pre" or "snapshot" => "-3",
                "rc" => "-2",
                "experimental" => "-4",
                _ => label
            };
        }

        private async Task<List<ModLoaderInfo>> GetFabricVersions(string minecraftVersion)
        {
            if (_downloadSourceId == (int)DownloadSources.Official)
            {
                return await GetFabricFromOfficialApi(minecraftVersion);
            }
            else if (_downloadSourceId == (int)DownloadSources.BMCLAPI)
            {
                return await GetFabricFromBmclApi(minecraftVersion);
            }
            return new List<ModLoaderInfo>();
        }
        private async Task<List<ModLoaderInfo>> GetFabricFromOfficialApi(string minecraftVersion)
        {
            {
                var versions = new List<ModLoaderInfo>();
                var baseUrl = "https://meta.fabricmc.net/v2/versions";

                using (var client = CreateHttpClient())
                {
                    try
                    {
                        // 1. 验证游戏版本是否支持
                        var gameVersions = await GetSupportedGameVersions(client, $"{baseUrl}/game");
                        if (!SupportsMinecraftVersion(gameVersions, minecraftVersion))
                        {
                            Trace.WriteLine($"Fabric官方 API：Fabric 不支持 MC 版本 {minecraftVersion}");
                            return versions;
                        }

                        // 2. 获取指定 MC 版本的 Loader 列表（使用 /v2/versions/loader/:game_version 端点）
                        var encodedMcVersion = Uri.EscapeDataString(minecraftVersion);
                        var loaderResponse = await client.GetAsync($"{baseUrl}/loader/{encodedMcVersion}");
                        loaderResponse.EnsureSuccessStatusCode();

                        var loaderJson = await loaderResponse.Content.ReadAsStringAsync();
                        var loaderArray = JArray.Parse(loaderJson);

                        // 3. 解析 Loader 版本信息
                        foreach (var item in loaderArray.Children<JObject>())
                        {
                            var loaderInfo = item["loader"] as JObject;
                            var intermediaryInfo = item["intermediary"] as JObject;

                            if (loaderInfo == null || intermediaryInfo == null)
                            {
                                Trace.WriteLine("跳过无效的 Loader 条目（缺少必要字段）");
                                continue;
                            }

                            // 提取核心字段
                            var loaderVersion = loaderInfo["version"]?.ToString();
                            var isStable = loaderInfo["stable"]?.ToString().Equals("true", StringComparison.OrdinalIgnoreCase) == true;

                            if (string.IsNullOrEmpty(loaderVersion))
                            {
                                Trace.WriteLine($"跳过无效的 Loader 版本：{loaderVersion}");
                                continue;
                            }

                            versions.Add(new ModLoaderInfo
                            {
                                Type = ModLoaderType.Fabric,
                                Version = loaderVersion,
                                MinecraftVersion = minecraftVersion,
                                DownloadUrl = "API未提供",
                                Sha1 = string.Empty,
                                IsRecommended = isStable
                            });
                        }

                        Trace.WriteLine($"Fabric官方API：成功解析 {versions.Count} 个Fabric版本");
                    }
                    catch (HttpRequestException ex)
                    {
                        Trace.WriteLine($"Fabric官方 API 请求失败：{ex.StatusCode} - {ex.Message}");
                    }
                    catch (JsonException ex)
                    {
                        Trace.WriteLine($"Fabric官方API JSON解析失败：{ex.Message}");
                    }
                    catch (Exception ex)
                    {
                        Trace.WriteLine($"Fabric官方 API 处理失败：{ex.Message}");
                    }
                }

                return SortAndDeduplicate(versions);
            }
        }
        private async Task<List<ModLoaderInfo>> GetFabricFromBmclApi(string minecraftVersion)
        {
            {
                var versions = new List<ModLoaderInfo>();
                var baseUrl = "https://bmclapi2.bangbang93.com/fabric-meta/v2/versions";

                using (var client = CreateHttpClient())
                {
                    try
                    {
                        // 1. 验证游戏版本是否支持
                        var gameVersions = await GetSupportedGameVersions(client, $"{baseUrl}/game");
                        if (!SupportsMinecraftVersion(gameVersions, minecraftVersion))
                        {
                            Trace.WriteLine($"BMCLAPI：Fabric 不支持 MC 版本 {minecraftVersion}");
                            return versions;
                        }

                        // 2. 获取指定 MC 版本的 Loader 列表（使用 /v2/versions/loader/:game_version 端点）
                        var encodedMcVersion = Uri.EscapeDataString(minecraftVersion);
                        var loaderResponse = await client.GetAsync($"{baseUrl}/loader/{encodedMcVersion}");
                        loaderResponse.EnsureSuccessStatusCode();

                        var loaderJson = await loaderResponse.Content.ReadAsStringAsync();
                        var loaderArray = JArray.Parse(loaderJson);

                        // 3. 解析 Loader 版本信息
                        foreach (var item in loaderArray.Children<JObject>())
                        {
                            var loaderInfo = item["loader"] as JObject;
                            var intermediaryInfo = item["intermediary"] as JObject;

                            if (loaderInfo == null || intermediaryInfo == null)
                            {
                                Trace.WriteLine("跳过无效的 Loader 条目（缺少必要字段）");
                                continue;
                            }

                            // 提取核心字段
                            var loaderVersion = loaderInfo["version"]?.ToString();
                            var isStable = loaderInfo["stable"]?.ToString().Equals("true", StringComparison.OrdinalIgnoreCase) == true;

                            if (string.IsNullOrEmpty(loaderVersion))
                            {
                                Trace.WriteLine($"跳过无效的 Loader 版本：{loaderVersion}");
                                continue;
                            }

                            versions.Add(new ModLoaderInfo
                            {
                                Type = ModLoaderType.Fabric,
                                Version = loaderVersion,
                                MinecraftVersion = minecraftVersion,
                                DownloadUrl = "API未提供",
                                Sha1 = string.Empty,
                                IsRecommended = isStable
                            });
                        }

                        Trace.WriteLine($"BMCLAPI：成功解析 {versions.Count} 个Fabric版本");
                    }
                    catch (HttpRequestException ex)
                    {
                        Trace.WriteLine($"BMCLAPI Fabric 请求失败：{ex.StatusCode} - {ex.Message}");
                    }
                    catch (JsonException ex)
                    {
                        Trace.WriteLine($"BMCLAPI Fabric JSON解析失败：{ex.Message}");
                    }
                    catch (Exception ex)
                    {
                        Trace.WriteLine($"BMCLAPI Fabric 处理失败：{ex.Message}");
                    }
                }

                return SortAndDeduplicate(versions);
            }
        }


        /// <summary>
        /// 获取支持的游戏版本列表
        /// </summary>
        private async Task<HashSet<string>> GetSupportedGameVersions(HttpClient client, string gameVersionsUrl)
        {
            var response = await client.GetAsync(gameVersionsUrl);
            response.EnsureSuccessStatusCode();

            var json = await response.Content.ReadAsStringAsync();
            var gameVersions = JArray.Parse(json)
            .Children<JObject>()
            .Select(j => j["version"]?.ToString())
            .Where(v => !string.IsNullOrEmpty(v))
            .ToHashSet();

            return gameVersions!;
        }

        private static string NormalizeMinecraftVersion(string version)
        {
            if (string.IsNullOrWhiteSpace(version))
            {
                return string.Empty;
            }

            version = version.Trim();

            if (version.StartsWith("1.", StringComparison.Ordinal))
            {
                return version;
            }

            var dashIndex = version.IndexOf('-');
            var baseVersion = dashIndex >= 0 ? version[..dashIndex] : version;
            var parts = baseVersion.Split('.', StringSplitOptions.RemoveEmptyEntries);

            if (parts.Length < 2)
            {
                return version;
            }

            return int.TryParse(parts[0], out var major) && major >= 22
                ? $"1.{baseVersion}"
                : version;
        }

        private static IEnumerable<string> GetMinecraftVersionAliases(string version)
        {
            var aliases = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            if (string.IsNullOrWhiteSpace(version))
            {
                return aliases;
            }

            aliases.Add(version);

            var normalized = NormalizeMinecraftVersion(version);
            aliases.Add(normalized);

            if (normalized.StartsWith("1.", StringComparison.Ordinal))
            {
                aliases.Add(normalized[2..]);
            }
            else
            {
                aliases.Add($"1.{normalized}");
            }

            return aliases;
        }

        private static bool MatchesMinecraftVersion(string candidateVersion, string requestedVersion)
        {
            if (string.IsNullOrWhiteSpace(candidateVersion) || string.IsNullOrWhiteSpace(requestedVersion))
            {
                return false;
            }

            var candidateAliases = GetMinecraftVersionAliases(candidateVersion);
            var requestedAliases = GetMinecraftVersionAliases(requestedVersion);

            return candidateAliases.Intersect(requestedAliases, StringComparer.OrdinalIgnoreCase).Any();
        }

        private static bool SupportsMinecraftVersion(IEnumerable<string> supportedVersions, string requestedVersion)
        {
            var normalizedSupportedVersions = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            foreach (var supportedVersion in supportedVersions)
            {
                foreach (var alias in GetMinecraftVersionAliases(supportedVersion))
                {
                    normalizedSupportedVersions.Add(alias);
                }
            }

            return GetMinecraftVersionAliases(requestedVersion).Any(normalizedSupportedVersions.Contains);
        }


        /// <summary>
        /// 创建配置好的 HttpClient
        /// </summary>
        private HttpClient CreateHttpClient()
        {
            var client = new HttpClient();
            client.DefaultRequestHeaders.UserAgent.ParseAdd("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36");
            client.Timeout = TimeSpan.FromSeconds(15);
            return client;
        }

        /// <summary>
        /// 版本去重和排序
        /// </summary>
        private List<ModLoaderInfo> SortAndDeduplicate(List<ModLoaderInfo> versions)
        {
            return versions
            .GroupBy(v => v.Version)
            .Select(g => g.First())
            .OrderByDescending(v => v.Version, new VersionComparer())
            .ToList();
        }

        private async Task<List<ModLoaderInfo>> GetNeoForgeVersions(string minecraftVersion)
        {
            if (_downloadSourceId == (int)DownloadSources.Official)
            {
                return await GetNeoForgeFromOfficialApi(minecraftVersion);
            }
            else if (_downloadSourceId == (int)DownloadSources.BMCLAPI)
            {
                return await GetNeoForgeFromBmclApi(minecraftVersion);
            }
            return new List<ModLoaderInfo>();
        }

        private async Task<List<ModLoaderInfo>> GetNeoForgeFromOfficialApi(string minecraftVersion)
        {
            const string OLD_URL = "https://maven.neoforged.net/api/maven/versions/releases/net/neoforged/forge";
            const string META_URL = "https://maven.neoforged.net/api/maven/versions/releases/net/neoforged/neoforge";
            using (var client = CreateHttpClient())
            {
                try
                {
                    var oldTask = GetOfficialApiResult(client, OLD_URL);
                    var metaTask = GetOfficialApiResult(client, META_URL);
                    await Task.WhenAll(oldTask, metaTask);

                    var oldResult = await oldTask;
                    var metaResult = await metaTask;

                    var versions = new List<ModLoaderInfo>();
                    if (MatchesMinecraftVersion("1.20.1", minecraftVersion))
                    {

                        // 处理 1.20.1 专用版本（旧 API）
                        foreach (var version in oldResult.Versions)
                        {
                            versions.Add(CreateNeoForgeModLoaderInfo(
                            version,
                            "1.20.1",
                            "forge" // 旧版使用 forge 包名
                            ));
                        }


                    }

                    // 解析并合并版本列表


                    foreach (var version in metaResult.Versions)
                    {
                        // 解析版本号对应的 Minecraft 版本
                        var mcVersion = ParseMinecraftVersion(version);
                        if (string.IsNullOrEmpty(mcVersion)) continue;

                        if (!string.IsNullOrEmpty(minecraftVersion) && !MatchesMinecraftVersion(mcVersion, minecraftVersion))
                            continue;

                        versions.Add(CreateNeoForgeModLoaderInfo(
                        version,
                        mcVersion,
                        "neoforge" // 新版使用 neoforge 包名
                        ));
                    }

                    // 去重并排序
                    return versions
                    .GroupBy(v => v.Version)
                    .Select(g => g.First())
                    .OrderByDescending(v => v.Version, new VersionComparer())
                    .ToList();
                }
                catch (Exception ex)
                {
                    Trace.WriteLine($"NeoForge 版本获取失败: {ex.Message}");
                    return new List<ModLoaderInfo>();
                }
            }
        }

        /// <summary>
        /// 从官方 API 获取版本列表
        /// </summary>
        private async Task<OfficialApiResult> GetOfficialApiResult(HttpClient client, string url)
        {
            var response = await client.GetAsync(url);
            response.EnsureSuccessStatusCode();

            var json = await response.Content.ReadAsStringAsync();
            return JsonConvert.DeserializeObject<OfficialApiResult>(json) ?? new OfficialApiResult();
        }

        /// <summary>
        /// 解析 NeoForge 版本号对应的 Minecraft 版本
        /// </summary>
        private string ParseMinecraftVersion(string neoForgeVersion)
        {
            try
            {
                // 示例：版本号格式 20.4.30-beta -> 对应 MC 1.20.4
                // 新版本格式 26.2.0.0-beta -> 对应 MC 26.2
                var firstDot = neoForgeVersion.IndexOf('.');
                var secondDot = neoForgeVersion.IndexOf('.', firstDot + 1);
                if (firstDot == -1 || secondDot == -1)
                    return null!;

                // 提取主版本号
                var majorVersion = int.Parse(neoForgeVersion.Substring(0, firstDot));
                if (majorVersion >= 22)
                {
                    return neoForgeVersion.Substring(0, secondDot);
                }

                if (majorVersion == 0)
                {
                    // 快照版本处理
                    return neoForgeVersion.Substring(firstDot + 1, secondDot - firstDot - 1);
                }
                else
                {
                    // 稳定版本处理
                    var minorVersion = int.Parse(neoForgeVersion.Substring(firstDot + 1, secondDot - firstDot - 1));
                    return minorVersion == 0
                    ? $"1.{majorVersion}"
                    : $"1.{majorVersion}.{minorVersion}";
                }
            }
            catch (Exception ex)
            {
                Trace.WriteLine($"解析 NeoForge 版本号失败 {neoForgeVersion}: {ex.Message}");
                return null!;
            }
        }
        /// <summary>
        /// 创建 NeoForge 的 ModLoaderInfo 对象
        /// </summary>
        private ModLoaderInfo CreateNeoForgeModLoaderInfo(string version, string mcVersion, string packageName)
        {
            return new ModLoaderInfo
            {
                Type = ModLoaderType.NeoForge,
                Version = version,
                MinecraftVersion = mcVersion,
                DownloadUrl = $"https://maven.neoforged.net/releases/net/neoforged/{packageName}/{version}/{packageName}-{version}-installer.jar",
                IsRecommended = !version.Contains("beta", StringComparison.OrdinalIgnoreCase)
            };
        }


        private class OfficialApiResult
        {
            [JsonProperty("isSnapshot")]
            public bool IsSnapshot { get; set; }

            [JsonProperty("versions")]
            public List<string> Versions { get; set; } = new List<string>();
        }
        private const string BMCLAPI_BASE_URL = "https://bmclapi2.bangbang93.com/neoforge";
        /// <summary>
        ///  从BMCLAPI 获取 NeoForge 版本列表
        /// </summary>
        private async Task<List<ModLoaderInfo>> GetNeoForgeFromBmclApi(string minecraftVersion)
        {
            var neoForgeList = await GetNeoForgeListFromBmclapiAsync(minecraftVersion);
            var result = new List<ModLoaderInfo>();
            try
            {
                foreach (var info in neoForgeList)
                {
                    // 获取安装器下载链接
                    var downloadUrl = GetNeoForgeDownloadUrlFromBmclapi(info.Version);

                    if (!string.IsNullOrEmpty(downloadUrl))
                    {
                        result.Add(new ModLoaderInfo
                        {
                            Type = ModLoaderType.NeoForge,
                            Version = info.Version,
                            MinecraftVersion = info.MinecraftVersion,
                            DownloadUrl = downloadUrl,
                            IsRecommended = !info.Version.Contains("-beta") && !info.Version.Contains("-alpha")
                        });
                    }
                }
                // 去重,排序
                return result
                    .GroupBy(v => v.Version)
                    .Select(g => g.First())
                    .OrderByDescending(v => v.Version, new VersionComparer())
                    .ToList();
            }
            catch (Exception ex)
            {
                Trace.WriteLine($"NeoForge 版本获取失败: {ex.Message}");
            }


            return new List<ModLoaderInfo>();
        }
        /// <summary>
        /// 根据Minecraft版本获取NeoForge列表
        /// </summary>
        private async Task<List<NeoForgeVersionInfo>> GetNeoForgeListFromBmclapiAsync(string mcVersion)
        {
            if (string.IsNullOrEmpty(mcVersion))
                throw new ArgumentNullException(nameof(mcVersion));
            using (var client = CreateHttpClient())

                try
                {
                    string url = $"{BMCLAPI_BASE_URL}/list/{Uri.EscapeDataString(mcVersion)}";
                    var response = await client.GetAsync(url);
                    response.EnsureSuccessStatusCode();

                    string json = await response.Content.ReadAsStringAsync();
                    return JsonConvert.DeserializeObject<List<NeoForgeVersionInfo>>(json) ?? new List<NeoForgeVersionInfo>();
                }
                catch (Exception ex)
                {
                    Trace.WriteLine($"获取NeoForge列表失败 (MC版本: {mcVersion}): {ex.Message}");
                    return new List<NeoForgeVersionInfo>();
                }
        }
        /// <summary>
        /// 获取NeoForge文件下载链接
        /// </summary>
        private string? GetNeoForgeDownloadUrlFromBmclapi(string version)
        {
            if (string.IsNullOrEmpty(version))
                throw new ArgumentNullException(nameof(version));

            // 创建允许自动重定向的HttpClientHandler
            var handler = new HttpClientHandler
            {
                AllowAutoRedirect = true,  // 启用自动重定向
                MaxAutomaticRedirections = 5  // 限制最大重定向次数，防止循环重定向
            };

            using (var httpClient = new HttpClient(handler))
            {
                httpClient.DefaultRequestHeaders.UserAgent.ParseAdd("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36");
                httpClient.Timeout = TimeSpan.FromSeconds(15);

                try
                {
                    string url = $"{BMCLAPI_BASE_URL}/version/{Uri.EscapeDataString(version)}/download/installer.jar";
                    return url;
                }
                catch (HttpRequestException ex)
                {
                    Trace.WriteLine($"获取NeoForge下载链接失败 (版本: {version}): HTTP错误 {ex.StatusCode} - {ex.Message}");
                    return null;
                }
                catch (Exception ex)
                {
                    Trace.WriteLine($"获取NeoForge下载链接失败 (版本: {version}): {ex.Message}");
                    return null;
                }
            }
        }
        /// <summary>
        /// NeoForge版本信息模型
        /// </summary>
        public class NeoForgeVersionInfo
        {
            [JsonProperty("rawVersion")]
            public string RawVersion { get; set; } = string.Empty;

            [JsonProperty("version")]
            public string Version { get; set; } = string.Empty;

            [JsonProperty("mcversion")]
            public string MinecraftVersion { get; set; } = string.Empty;

            [JsonProperty("installerPath")]
            public string InstallerPath { get; set; } = string.Empty;
        }

        private async Task<List<ModLoaderInfo>> GetOptifineVersions(string minecraftVersion)
        {
            if (_downloadSourceId == (int)DownloadSources.Official)
            {
                //return await GetOptifineFromOffcialHtml(minecraftVersion);
                return await GetOptifineFromBmclApiAsync(minecraftVersion); //放弃因为Optifine官网没有提供API
            }
            else if (_downloadSourceId == (int)DownloadSources.BMCLAPI)
            {
                return await GetOptifineFromBmclApiAsync(minecraftVersion);
            }
            return new List<ModLoaderInfo>();
        }

        [Obsolete("因为Optifine官网没有提供API且下载链接非直连放弃，请使用 GetOptifineVersions 方法")]
        private List<ModLoaderInfo> GetOptifineFromOffcialApi(string minecraftVersion)
        {
            //放弃因为Optifine官网没有提供API
            return new List<ModLoaderInfo>();
        }

        private async Task<List<ModLoaderInfo>> GetOptifineFromBmclApiAsync(string minecraftVersion)
        {
            var optifineList = new List<OptifineVersionInfo>();
            foreach (var alias in GetMinecraftVersionAliases(minecraftVersion))
            {
                var list = await GetOptifineListFromBmclApiAsync(alias);
                if (list.Count > 0)
                {
                    optifineList = list;
                    break;
                }
            }
            var result = new List<ModLoaderInfo>();
            try
            {
                foreach (var info in optifineList)
                {

                    // 获取安装器下载链接
                    var downloadUrl = GetOptifineDownloadUrlFromBmclApi(info.MinecraftVersion, info.Type, info.Patch);

                    if (!string.IsNullOrEmpty(downloadUrl))
                    {
                        result.Add(new ModLoaderInfo
                        {
                            Type = ModLoaderType.Optifine,
                            Version = info.Type + "-" + info.Patch,
                            MinecraftVersion = info.MinecraftVersion,
                            DownloadUrl = downloadUrl,
                            IsRecommended = info.Forge.Contains("Forge N/A")
                        });
                    }
                }
                // 去重,排序
                return result
                    .GroupBy(v => v.Version)
                    .Select(g => g.First())
                    .OrderByDescending(v => v.Version, new VersionComparer())
                    .ToList();
            }
            catch (Exception ex)
            {
                Trace.WriteLine($"NeoForge 版本获取失败: {ex.Message}");
            }
            return new List<ModLoaderInfo>();

        }
        private async Task<List<OptifineVersionInfo>> GetOptifineListFromBmclApiAsync(string minecraftVersion)
        {
            if (string.IsNullOrEmpty(minecraftVersion))
                throw new ArgumentNullException(nameof(minecraftVersion));
            using (var client = CreateHttpClient())

                try
                {
                    string url = $"https://bmclapi2.bangbang93.com/optifine/{minecraftVersion}";
                    var response = await client.GetAsync(url);
                    response.EnsureSuccessStatusCode();

                    string json = await response.Content.ReadAsStringAsync();
                    return JsonConvert.DeserializeObject<List<OptifineVersionInfo>>(json) ?? new List<OptifineVersionInfo>();
                }
                catch (Exception ex)
                {
                    Trace.WriteLine($"获取Optifine列表失败 (MC版本: {minecraftVersion}): {ex.Message}");
                    return new List<OptifineVersionInfo>();
                }

        }
        public class OptifineVersionInfo
        {
            /*
              {
                "_id": "5ccc81c8871d9b9623c128b7",
                "mcversion": "1.12.2",
                "patch": "C6",
                "type": "HD_U",
                "__v": 0,
                "filename": "OptiFine_1.12.2_HD_U_C6.jar",
                "forge": "Forge #2493"
              }
            */
            [JsonProperty("mcversion")]
            public string MinecraftVersion { get; set; } = string.Empty;

            [JsonProperty("patch")]
            public string Patch { get; set; } = string.Empty;

            [JsonProperty("type")]
            public string Type { get; set; } = string.Empty;

            [JsonProperty("filename")]
            public string Filename { get; set; } = string.Empty;

            [JsonProperty("forge")]
            public string Forge { get; set; } = string.Empty;

        }
        private string? GetOptifineDownloadUrlFromBmclApi(string minecraftVersion, string type, string patch)
        {

            if (string.IsNullOrEmpty(minecraftVersion))
                throw new ArgumentNullException(nameof(minecraftVersion));
            else if (string.IsNullOrEmpty(type))
                throw new ArgumentNullException(nameof(type));
            else if (string.IsNullOrEmpty(patch))
                throw new ArgumentNullException(nameof(patch));

            // 创建允许自动重定向的HttpClientHandler
            var handler = new HttpClientHandler
            {
                AllowAutoRedirect = true,  // 启用自动重定向
                MaxAutomaticRedirections = 5  // 限制最大重定向次数，防止循环重定向
            };

            using (var httpClient = new HttpClient(handler))
            {
                httpClient.DefaultRequestHeaders.UserAgent.ParseAdd("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36");
                httpClient.Timeout = TimeSpan.FromSeconds(15);

                try
                {
                    string url = $"https://bmclapi2.bangbang93.com/optifine/{Uri.EscapeDataString(minecraftVersion)}/{type}/{patch}";  //https://bmclapi2.bangbang93.com/optifine/:mcversion/:type/:patch

                    return url;
                }
                catch (Exception ex)
                {
                    Trace.WriteLine($"获取Optifine下载链接失败 (版本: {minecraftVersion}): {ex.Message}");
                    return null;
                }
            }
        }

        private async Task<List<ModLoaderInfo>> GetLiteloaderVersions(string minecraftVersion)
        {
            if (_downloadSourceId == (int)DownloadSources.Official)
            {
                //return await GetOptifineFromOffcialHtml(minecraftVersion);
                return await GetLiteloaderFromBmclApiAsync(minecraftVersion); //放弃因为Liteloader官网已经gg了
            }
            else if (_downloadSourceId == (int)DownloadSources.BMCLAPI)
            {
                return await GetLiteloaderFromBmclApiAsync(minecraftVersion);
            }
            return new List<ModLoaderInfo>();
        }

        private async Task<List<LiteloaderVersionInfo>> GetLiteloaderListFromBmclApiAsync(string minecraftVersion)
        {
            if (string.IsNullOrEmpty(minecraftVersion))
                throw new ArgumentNullException(nameof(minecraftVersion));
            using (var client = CreateHttpClient())

                try
                {
                    string url = $"https://bmclapi2.bangbang93.com/liteloader/list/?mcversion={minecraftVersion}"; //like https://bmclapi2.bangbang93.com/liteloader/list/?mcversion=1.12.2
                    var response = await client.GetAsync(url);
                    response.EnsureSuccessStatusCode();

                    string json = await response.Content.ReadAsStringAsync();
                    //return JsonConvert.DeserializeObject<List<LiteloaderVersionInfo>>(json) ?? new List<LiteloaderVersionInfo>(); 因为liteloader的API有时候返回单个对象，有时候返回列表，所以需要特殊处理
                    try
                    {
                        // 先尝试按列表解析
                        var list = JsonConvert.DeserializeObject<List<LiteloaderVersionInfo>>(json);
                        return list ?? new List<LiteloaderVersionInfo>();
                    }
                    catch (JsonSerializationException)
                    {
                        // 解析失败则尝试按单个对象解析
                        var single = JsonConvert.DeserializeObject<LiteloaderVersionInfo>(json);
                        return single != null ? new List<LiteloaderVersionInfo> { single } : new List<LiteloaderVersionInfo>();
                    }
                }
                catch (Exception ex)
                {
                    Trace.WriteLine($"获取Liteloader列表失败 (MC版本: {minecraftVersion}): {ex.Message}");
                    return new List<LiteloaderVersionInfo>();
                }
        }
        private async Task<List<ModLoaderInfo>> GetLiteloaderFromBmclApiAsync(string minecraftVersion)
        {
            var liteloaderList = await GetLiteloaderListFromBmclApiAsync(minecraftVersion);
            var result = new List<ModLoaderInfo>();
            try
            {
                foreach (var info in liteloaderList)
                {

                    // 获取安装器（Forge Mod）下载链接
                    var downloadUrl = $"https://bmclapi2.bangbang93.com/liteloader/download/?version={info.Version}"; //like https://bmclapi2.bangbang93.com/liteloader/download/?version=1.12.2-SNAPSHOT

                    if (!string.IsNullOrEmpty(downloadUrl))
                    {
                        result.Add(new ModLoaderInfo
                        {
                            Type = ModLoaderType.LiteLoader,
                            Version = info.Version,
                            MinecraftVersion = info.MinecraftVersion,
                            DownloadUrl = downloadUrl,
                            Sha1 = info.Hash,
                            IsRecommended = true //因为基本都只有一个版本，所以默认推荐
                        });
                    }
                }
                // 去重,排序
                return result
                    .GroupBy(v => v.Version)
                    .Select(g => g.First())
                    .OrderByDescending(v => v.Version, new VersionComparer())
                    .ToList();
            }
            catch (Exception ex)
            {
                Trace.WriteLine($"Liteloader 版本获取失败: {ex.Message}");
            }
            return new List<ModLoaderInfo>();

        }
        public class LiteloaderVersionInfo
        {
            /*
                    {
                      "_id": "59c2244afaa4ba3b264f0d7e",
                      "mcversion": "1.12.2",
                      "build": {
                        "tweakClass": "com.mumfrey.liteloader.launch.LiteLoaderTweaker",
                        "libraries": [
                          {
                            "name": "net.minecraft:launchwrapper:1.12"
                          },
                          {
                            "name": "org.ow2.asm:asm-all:5.2"
                          }
                        ],
                        "stream": "SNAPSHOT",
                        "file": "liteloader-1.12.2-SNAPSHOT.jar",
                        "version": "1.12.2-SNAPSHOT",
                        "build": "1.12.2-SNAPSHOT-r4CC2BB0-b4-4",
                        "md5": "1420785ecbfed5aff4a586c5c9dd97eb",
                        "timestamp": "1511880271",
                        "lastSuccessfulBuild": 4
                      },
                      "hash": "1420785ecbfed5aff4a586c5c9dd97eb",
                      "type": "SNAPSHOT",
                      "version": "1.12.2-SNAPSHOT",
                      "__v": 0
                    }
            */
            [JsonProperty("mcversion")]
            public string MinecraftVersion { get; set; } = string.Empty;

            [JsonProperty("hash")]
            public string Hash { get; set; } = string.Empty;

            [JsonProperty("type")]
            public string Type { get; set; } = string.Empty;

            [JsonProperty("version")]
            public string Version { get; set; } = string.Empty;

        }

        private async Task<List<ModLoaderInfo>> GetQuiltVersions(string minecraftVersion)
        {
            if (_downloadSourceId == (int)DownloadSources.Official)
            {
                return await GetQuiltFromOfficialApi(minecraftVersion);
            }
            else if (_downloadSourceId == (int)DownloadSources.BMCLAPI)
            {
                //return await GetQuiltFromBmclApi(minecraftVersion);
                return await GetQuiltFromOfficialApi(minecraftVersion);
            }
            return new List<ModLoaderInfo>();
        }
        private async Task<List<ModLoaderInfo>> GetQuiltFromOfficialApi(string minecraftVersion)
        {
            {
                var versions = new List<ModLoaderInfo>();
                var baseUrl = "https://meta.quiltmc.org/v3/versions";

                using (var client = CreateHttpClient())
                {
                    try
                    {
                        // 1. 验证游戏版本是否支持
                        var gameVersions = await GetSupportedGameVersions(client, $"{baseUrl}/game");
                        if (!SupportsMinecraftVersion(gameVersions, minecraftVersion))
                        {
                            Trace.WriteLine($"Quilt官方 API：Quilt 不支持 MC 版本 {minecraftVersion}");
                            return versions;
                        }

                        JArray loaderArray = new();

                        // 2. 优先尝试按版本端点获取 Loader 列表
                        foreach (var alias in GetMinecraftVersionAliases(minecraftVersion))
                        {
                            var encodedMcVersion = Uri.EscapeDataString(alias);
                            var loaderResponse = await client.GetAsync($"{baseUrl}/loader/{encodedMcVersion}");
                            if (!loaderResponse.IsSuccessStatusCode)
                            {
                                continue;
                            }

                            var loaderJson = await loaderResponse.Content.ReadAsStringAsync();
                            loaderArray = JArray.Parse(loaderJson);
                            if (loaderArray.Count > 0)
                            {
                                break;
                            }
                        }

                        // 3. 若版本端点没有数据，则回退到全量 Loader 列表做兼容过滤
                        if (loaderArray.Count == 0)
                        {
                            var globalLoaderResponse = await client.GetAsync($"{baseUrl}/loader");
                            globalLoaderResponse.EnsureSuccessStatusCode();
                            var globalLoaderJson = await globalLoaderResponse.Content.ReadAsStringAsync();
                            var globalLoaderItems = JArray.Parse(globalLoaderJson).Children<JObject>();

                            loaderArray = new JArray(globalLoaderItems.Where(item =>
                            {
                                var hashedVersion = item["hashed"]?["version"]?.ToString();
                                var intermediaryVersion = item["intermediary"]?["version"]?.ToString();

                                return MatchesMinecraftVersion(hashedVersion ?? string.Empty, minecraftVersion)
                                    || MatchesMinecraftVersion(intermediaryVersion ?? string.Empty, minecraftVersion);
                            }));
                        }

                        // 4. 解析 Loader 版本信息
                        foreach (var item in loaderArray.Children<JObject>())
                        {
                            var loaderInfo = item["loader"] as JObject;
                            var intermediaryInfo = item["intermediary"] as JObject;
                            var hashedInfo = item["hashed"] as JObject;

                            if (loaderInfo == null || (intermediaryInfo == null && hashedInfo == null))
                            {
                                Trace.WriteLine("跳过无效的 Loader 条目（缺少必要字段）");
                                continue;
                            }

                            // 提取核心字段
                            var loaderVersion = loaderInfo["version"]?.ToString();
                            var isStable = loaderInfo["stable"]?.ToString().Equals("true", StringComparison.OrdinalIgnoreCase) == true;

                            if (string.IsNullOrEmpty(loaderVersion))
                            {
                                Trace.WriteLine($"跳过无效的 Loader 版本：{loaderVersion}");
                                continue;
                            }

                            versions.Add(new ModLoaderInfo
                            {
                                Type = ModLoaderType.Quilt,
                                Version = loaderVersion,
                                MinecraftVersion = minecraftVersion,
                                DownloadUrl = "API未提供",
                                Sha1 = "API未提供",
                                IsRecommended = isStable
                            });
                        }

                        Trace.WriteLine($"Quilt官方API：成功解析 {versions.Count} 个Fabric版本");
                    }
                    catch (HttpRequestException ex)
                    {
                        Trace.WriteLine($"Quilt官方 API 请求失败：{ex.StatusCode} - {ex.Message}");
                    }
                    catch (JsonException ex)
                    {
                        Trace.WriteLine($"Quilt官方API JSON解析失败：{ex.Message}");
                    }
                    catch (Exception ex)
                    {
                        Trace.WriteLine($"Quilt官方 API 处理失败：{ex.Message}");
                    }
                }

                return SortAndDeduplicate(versions);
            }
        }
        //private async Task<List<ModLoaderInfo>> GetQuiltFromBmclApi(string minecraftVersion){} BMCLAPI目前没有提供Quilt的API

    }
}

