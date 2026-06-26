using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Linq;
using System.Net.Http;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.Json.Serialization;
using System.Text.RegularExpressions;
using System.Threading.Tasks;
using static System.Net.WebRequestMethods;
using File = System.IO.File;

namespace Qomicex.Launcher.Backend.Modules.Helpers.Resources
{
    public class ModLoaderResourceHelper
    {
        public enum DownloadSources
        {
            Official,
            BMCLAPI
        }
        public enum ModLoaderType
        {
            All,
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
            public string assetsSource = "http://resources.download.minecraft.net/";
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

                var forgeTask = WithTimeout(GetForgeVersions(minecraftVersion));
                var fabricTask = WithTimeout(GetFabricVersions(minecraftVersion));
                var neoForgeTask = WithTimeout(GetNeoForgeVersions(minecraftVersion));
                var quiltTask = WithTimeout(GetQuiltVersions(minecraftVersion));
                var optifineTask = WithTimeout(GetOptifineVersions(minecraftVersion));
                var liteloaderTask = WithTimeout(GetLiteloaderVersions(minecraftVersion));

                await Task.WhenAll(forgeTask, fabricTask, neoForgeTask, optifineTask, liteloaderTask, quiltTask);
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
        private async Task<List<ModLoaderInfo>> WithTimeout(Task<List<ModLoaderInfo>> task, int timeoutMs = 10000)
        {
            var timeoutTask = Task.Delay(timeoutMs);
            var completedTask = await Task.WhenAny(task, timeoutTask);

            if (completedTask == timeoutTask)
            {
                return new List<ModLoaderInfo>();
                throw new TimeoutException("任务超时");
            }

            return await task;
        }
        private async Task<List<ModLoaderInfo>> GetForgeVersions(string minecraftVersion)
        {
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

        private async Task<List<ModLoaderInfo>> GetForgeVersionsFromJsonApi(string minecraftVersion)
        {
            var forgeLoaders = new List<ModLoaderInfo>();
            using (var client = CreateHttpClient())

                try
                {
                    string url = $"https://bmclapi2.bangbang93.com/forge/minecraft/{minecraftVersion}";
                    var response = await client.GetAsync(url);

                    if (response.IsSuccessStatusCode)
                    {
                        var json = await response.Content.ReadAsStringAsync();
                        var versionsArray = JsonNode.Parse(json)?.AsArray();

                        foreach (var version in versionsArray?.OfType<JsonObject>() ?? [])
                        {
                            string apiMcVersion = GetNodeString(version["mcversion"]);
                            if (!apiMcVersion.Equals(minecraftVersion, StringComparison.OrdinalIgnoreCase))
                                continue;

                            var installerFile = version["files"]?.AsArray()?.OfType<JsonObject>()
                            .FirstOrDefault(f => GetNodeString(f["category"]).Equals("installer", StringComparison.OrdinalIgnoreCase));

                            if (installerFile == null)
                                continue;

                            forgeLoaders.Add(new ModLoaderInfo
                            {
                                Type = ModLoaderType.Forge,
                                Version = GetNodeString(version["version"]),
                                MinecraftVersion = minecraftVersion,
                                DownloadUrl = GetForgeDownloadUrl(minecraftVersion, GetNodeString(version["build"])),
                                Sha1 = GetNodeString(installerFile["hash"]),
                                IsRecommended = IsRecommendedVersion(GetNodeString(version["build"]), forgeLoaders),
                                PublishedAt = version["modified"]?.GetValue<DateTime>()
                            });
                        }
                    }
                }
                catch (Exception ex)
                {
                    Debug.WriteLine($"BMCLAPI JSON 获取 Forge 版本失败: {ex.Message}");
                }

            return forgeLoaders;
        }

        private async Task<List<ModLoaderInfo>> GetForgeVersionsFromOfficialHtml(string minecraftVersion)
        {
            var forgeLoaders = new List<ModLoaderInfo>();
            var cacheFilePath = GetCacheFilePath(minecraftVersion);
            const int cacheExpiryHours = 24;

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
                    Debug.WriteLine($"使用缓存失败: {ex.Message}，将重新获取");
                }
            }

            var sourceUrls = new List<string>
    {
        $"https://files.minecraftforge.net/net/minecraftforge/forge/index_{minecraftVersion}.html",
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
                            Debug.WriteLine($"源 {url} 请求失败: {response.StatusCode}");
                            continue;
                        }

                        var htmlBytes = await response.Content.ReadAsByteArrayAsync();
                        var htmlContent = Encoding.UTF8.GetString(htmlBytes);

                        try
                        {
                            var cacheDir = Path.GetDirectoryName(cacheFilePath);
                            if (!Directory.Exists(cacheDir))
                                Directory.CreateDirectory(cacheDir!);
                            File.WriteAllText(cacheFilePath, htmlContent);
                            Debug.WriteLine($"已缓存html到{cacheFilePath}");
                        }
                        catch (Exception ex)
                        {
                            Debug.WriteLine($"缓存写入失败: {ex.Message}");
                        }

                        var result = ParseForgeVersions(minecraftVersion, htmlContent);
                        if (result.Any())
                            return result;
                    }
                    catch (Exception ex)
                    {
                        Debug.WriteLine($"从源 {url} 提取数据失败: {ex.Message}");
                    }
                }
            }

            if (File.Exists(cacheFilePath))
            {
                try
                {
                    var cachedHtml = File.ReadAllText(cacheFilePath);
                    Debug.WriteLine($"读取已缓存html到{cacheFilePath}中的数据");
                    return ParseForgeVersions(minecraftVersion, cachedHtml);
                }
                catch (Exception ex)
                {
                    Debug.WriteLine($"使用过期缓存失败: {ex.Message}");
                }
            }

            return forgeLoaders;
        }

        private List<ModLoaderInfo> ParseForgeVersions(string minecraftVersion, string htmlContent)
        {
            var forgeLoaders = new List<ModLoaderInfo>();

            var tableMatch = Regex.Match(
                htmlContent,
                @"<table[^>]+class=""[^""]*download-list[^""]*""[^>]*>.*?</table>",
                RegexOptions.Singleline
            );

            if (!tableMatch.Success)
            {
                Debug.WriteLine("未找到版本表格");
                return forgeLoaders;
            }

            var rowMatches = Regex.Matches(
                tableMatch.Value,
                @"<tr[^>]*>.*?<td[^>]+class=""[^""]*download-version[^""]*""[^>]*>.*?</tr>",
                RegexOptions.Singleline
            );

            Debug.WriteLine($"找到 {rowMatches.Count} 个版本行");

            foreach (Match rowMatch in rowMatches)
            {
                if (!rowMatch.Success) continue;
                var rowHtml = rowMatch.Value;

                var versionMatch = Regex.Match(
                    rowHtml,
                    @"(?<=<td[^>]+class=""[^""]*download-version[^""]*""[^>]*>\s*)[\d.]+(?:-[a-zA-Z0-9_]+)?(?=\s*<)",
                    RegexOptions.IgnoreCase
                );
                if (!versionMatch.Success)
                {
                    Debug.WriteLine($"未提取到版本号: {GetSnippet(rowHtml)}");
                    continue;
                }
                var forgeVersion = versionMatch.Value;

                var categoryMatch = Regex.Match(
                    rowHtml,
                    @"classifier-(installer|universal|client)",
                    RegexOptions.IgnoreCase
                );
                var fileCategory = categoryMatch.Success ? categoryMatch.Groups[1].Value : "installer";

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
                    Debug.WriteLine($"版本 {forgeVersion} 未找到下载链接: {GetSnippet(rowHtml)}");
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

            forgeLoaders.Sort((a, b) => VersionSortInteger(b.Version, a.Version));
            Debug.WriteLine($"最终提取到 {forgeLoaders.Count} 个有效版本");

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


        private string GetForgeDownloadUrl(string mcVersion, string forgeVersion)
        {
            if (string.IsNullOrEmpty(forgeVersion))
                return string.Empty;
            return _downloadSourceId == (int)LocalResourceHelper.DownloadSources.BMCLAPI
            ? $"https://bmclapi2.bangbang93.com/forge/download/{forgeVersion}"
            : $"https://maven.minecraftforge.net/net/minecraftforge/forge/{mcVersion}-{forgeVersion}/forge-{mcVersion}-{forgeVersion}-installer.jar";
        }
        private class VersionComparer : IComparer<string>
        {
            public int Compare(string? x, string? y)
            {
                return VersionSortInteger(x!, y!);
            }
        }
        private bool IsRecommendedVersion(string buildNumber, List<ModLoaderInfo> existingLoaders)
        {
            if (!int.TryParse(buildNumber, out int currentBuild))
                return false;

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
                        var gameVersions = await GetSupportedGameVersions(client, $"{baseUrl}/game");
                        if (!SupportsMinecraftVersion(gameVersions, minecraftVersion))
                        {
                            Debug.WriteLine($"Fabric官方 API：Fabric 不支持 MC 版本 {minecraftVersion}");
                            return versions;
                        }

                        var encodedMcVersion = Uri.EscapeDataString(minecraftVersion);
                        var loaderResponse = await client.GetAsync($"{baseUrl}/loader/{encodedMcVersion}");
                        loaderResponse.EnsureSuccessStatusCode();

                        var loaderJson = await loaderResponse.Content.ReadAsStringAsync();
                        var loaderArray = JsonNode.Parse(loaderJson)?.AsArray();

                        foreach (var item in loaderArray?.OfType<JsonObject>() ?? [])
                        {
                            var loaderInfo = item["loader"] as JsonObject;
                            var intermediaryInfo = item["intermediary"] as JsonObject;

                            if (loaderInfo == null || intermediaryInfo == null)
                            {
                                Debug.WriteLine("跳过无效的 Loader 条目（缺少必要字段）");
                                continue;
                            }

                            var loaderVersion = loaderInfo["version"]?.GetValue<string>();
                            var isStable = loaderInfo["stable"]?.GetValue<bool>() ?? false;

                            if (string.IsNullOrEmpty(loaderVersion))
                            {
                                Debug.WriteLine($"跳过无效的 Loader 版本：{loaderVersion}");
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

                        Debug.WriteLine($"Fabric官方API：成功解析 {versions.Count} 个Fabric版本");
                    }
                    catch (HttpRequestException ex)
                    {
                        Debug.WriteLine($"Fabric官方 API 请求失败：{ex.StatusCode} - {ex.Message}");
                    }
                    catch (JsonException ex)
                    {
                        Debug.WriteLine($"Fabric官方API JSON解析失败：{ex.Message}");
                    }
                    catch (Exception ex)
                    {
                        Debug.WriteLine($"Fabric官方 API 处理失败：{ex.Message}");
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
                        var gameVersions = await GetSupportedGameVersions(client, $"{baseUrl}/game");
                        if (!SupportsMinecraftVersion(gameVersions, minecraftVersion))
                        {
                            Debug.WriteLine($"BMCLAPI：Fabric 不支持 MC 版本 {minecraftVersion}");
                            return versions;
                        }

                        var encodedMcVersion = Uri.EscapeDataString(minecraftVersion);
                        var loaderResponse = await client.GetAsync($"{baseUrl}/loader/{encodedMcVersion}");
                        loaderResponse.EnsureSuccessStatusCode();

                        var loaderJson = await loaderResponse.Content.ReadAsStringAsync();
                        var loaderArray = JsonNode.Parse(loaderJson)?.AsArray();

                        foreach (var item in loaderArray?.OfType<JsonObject>() ?? [])
                        {
                            var loaderInfo = item["loader"] as JsonObject;
                            var intermediaryInfo = item["intermediary"] as JsonObject;

                            if (loaderInfo == null || intermediaryInfo == null)
                            {
                                Debug.WriteLine("跳过无效的 Loader 条目（缺少必要字段）");
                                continue;
                            }

                            var loaderVersion = loaderInfo["version"]?.GetValue<string>();
                            var isStable = loaderInfo["stable"]?.GetValue<bool>() ?? false;

                            if (string.IsNullOrEmpty(loaderVersion))
                            {
                                Debug.WriteLine($"跳过无效的 Loader 版本：{loaderVersion}");
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

                        Debug.WriteLine($"BMCLAPI：成功解析 {versions.Count} 个Fabric版本");
                    }
                    catch (HttpRequestException ex)
                    {
                        Debug.WriteLine($"BMCLAPI Fabric 请求失败：{ex.StatusCode} - {ex.Message}");
                    }
                    catch (JsonException ex)
                    {
                        Debug.WriteLine($"BMCLAPI Fabric JSON解析失败：{ex.Message}");
                    }
                    catch (Exception ex)
                    {
                        Debug.WriteLine($"BMCLAPI Fabric 处理失败：{ex.Message}");
                    }
                }

                return SortAndDeduplicate(versions);
            }
        }


        private async Task<HashSet<string>> GetSupportedGameVersions(HttpClient client, string gameVersionsUrl)
        {
            var response = await client.GetAsync(gameVersionsUrl);
            response.EnsureSuccessStatusCode();

            var json = await response.Content.ReadAsStringAsync();
            var gameVersions = JsonNode.Parse(json)?.AsArray()
            ?.OfType<JsonObject>()
            .Select(j => j["version"]?.GetValue<string>())
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


        private HttpClient CreateHttpClient()
        {
            var client = new HttpClient();
            client.DefaultRequestHeaders.UserAgent.ParseAdd("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36");
            client.Timeout = TimeSpan.FromSeconds(15);
            return client;
        }

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

                        foreach (var version in oldResult.Versions)
                        {
                            versions.Add(CreateNeoForgeModLoaderInfo(
                            version,
                            "1.20.1",
                            "forge"
                            ));
                        }


                    }

                    foreach (var version in metaResult.Versions)
                    {
                        var mcVersion = ParseMinecraftVersion(version);
                        if (string.IsNullOrEmpty(mcVersion)) continue;

                        if (!string.IsNullOrEmpty(minecraftVersion) && !MatchesMinecraftVersion(mcVersion, minecraftVersion))
                            continue;

                        versions.Add(CreateNeoForgeModLoaderInfo(
                        version,
                        mcVersion,
                        "neoforge"
                        ));
                    }

                    return versions
                    .GroupBy(v => v.Version)
                    .Select(g => g.First())
                    .OrderByDescending(v => v.Version, new VersionComparer())
                    .ToList();
                }
                catch (Exception ex)
                {
                    Debug.WriteLine($"NeoForge 版本获取失败: {ex.Message}");
                    return new List<ModLoaderInfo>();
                }
            }
        }

        private async Task<OfficialApiResult> GetOfficialApiResult(HttpClient client, string url)
        {
            var response = await client.GetAsync(url);
            response.EnsureSuccessStatusCode();

            var json = await response.Content.ReadAsStringAsync();
            return JsonSerializer.Deserialize<OfficialApiResult>(json) ?? new OfficialApiResult();
        }

        private string ParseMinecraftVersion(string neoForgeVersion)
        {
            try
            {
                var firstDot = neoForgeVersion.IndexOf('.');
                var secondDot = neoForgeVersion.IndexOf('.', firstDot + 1);
                if (firstDot == -1 || secondDot == -1)
                    return null!;

                var majorVersion = int.Parse(neoForgeVersion.Substring(0, firstDot));
                if (majorVersion >= 22)
                {
                    return neoForgeVersion.Substring(0, secondDot);
                }

                if (majorVersion == 0)
                {
                    return neoForgeVersion.Substring(firstDot + 1, secondDot - firstDot - 1);
                }
                else
                {
                    var minorVersion = int.Parse(neoForgeVersion.Substring(firstDot + 1, secondDot - firstDot - 1));
                    return minorVersion == 0
                    ? $"1.{majorVersion}"
                    : $"1.{majorVersion}.{minorVersion}";
                }
            }
            catch (Exception ex)
            {
                Debug.WriteLine($"解析 NeoForge 版本号失败 {neoForgeVersion}: {ex.Message}");
                return null!;
            }
        }
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
            [JsonPropertyName("isSnapshot")]
            public bool IsSnapshot { get; set; }

            [JsonPropertyName("versions")]
            public List<string> Versions { get; set; } = new List<string>();
        }
        private const string BMCLAPI_BASE_URL = "https://bmclapi2.bangbang93.com/neoforge";
        private async Task<List<ModLoaderInfo>> GetNeoForgeFromBmclApi(string minecraftVersion)
        {
            var neoForgeList = await GetNeoForgeListFromBmclapiAsync(minecraftVersion);
            var result = new List<ModLoaderInfo>();
            try
            {
                foreach (var info in neoForgeList)
                {
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
                return result
                    .GroupBy(v => v.Version)
                    .Select(g => g.First())
                    .OrderByDescending(v => v.Version, new VersionComparer())
                    .ToList();
            }
            catch (Exception ex)
            {
                Debug.WriteLine($"NeoForge 版本获取失败: {ex.Message}");
            }


            return new List<ModLoaderInfo>();
        }
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
                    return JsonSerializer.Deserialize<List<NeoForgeVersionInfo>>(json) ?? new List<NeoForgeVersionInfo>();
                }
                catch (Exception ex)
                {
                    Debug.WriteLine($"获取NeoForge列表失败 (MC版本: {mcVersion}): {ex.Message}");
                    return new List<NeoForgeVersionInfo>();
                }
        }
        private string? GetNeoForgeDownloadUrlFromBmclapi(string version)
        {
            if (string.IsNullOrEmpty(version))
                throw new ArgumentNullException(nameof(version));

            var handler = new HttpClientHandler
            {
                AllowAutoRedirect = true,
                MaxAutomaticRedirections = 5
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
                    Debug.WriteLine($"获取NeoForge下载链接失败 (版本: {version}): HTTP错误 {ex.StatusCode} - {ex.Message}");
                    return null;
                }
                catch (Exception ex)
                {
                    Debug.WriteLine($"获取NeoForge下载链接失败 (版本: {version}): {ex.Message}");
                    return null;
                }
            }
        }
        public class NeoForgeVersionInfo
        {
            [JsonPropertyName("rawVersion")]
            public string RawVersion { get; set; } = string.Empty;

            [JsonPropertyName("version")]
            public string Version { get; set; } = string.Empty;

            [JsonPropertyName("mcversion")]
            public string MinecraftVersion { get; set; } = string.Empty;

            [JsonPropertyName("installerPath")]
            public string InstallerPath { get; set; } = string.Empty;
        }

        private async Task<List<ModLoaderInfo>> GetOptifineVersions(string minecraftVersion)
        {
            if (_downloadSourceId == (int)DownloadSources.Official)
            {
                return await GetOptifineFromBmclApiAsync(minecraftVersion);
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
                return result
                    .GroupBy(v => v.Version)
                    .Select(g => g.First())
                    .OrderByDescending(v => v.Version, new VersionComparer())
                    .ToList();
            }
            catch (Exception ex)
            {
                Debug.WriteLine($"NeoForge 版本获取失败: {ex.Message}");
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
                    return JsonSerializer.Deserialize<List<OptifineVersionInfo>>(json) ?? new List<OptifineVersionInfo>();
                }
                catch (Exception ex)
                {
                    Debug.WriteLine($"获取Optifine列表失败 (MC版本: {minecraftVersion}): {ex.Message}");
                    return new List<OptifineVersionInfo>();
                }

        }
        public class OptifineVersionInfo
        {
            [JsonPropertyName("mcversion")]
            public string MinecraftVersion { get; set; } = string.Empty;

            [JsonPropertyName("patch")]
            public string Patch { get; set; } = string.Empty;

            [JsonPropertyName("type")]
            public string Type { get; set; } = string.Empty;

            [JsonPropertyName("filename")]
            public string Filename { get; set; } = string.Empty;

            [JsonPropertyName("forge")]
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

            var handler = new HttpClientHandler
            {
                AllowAutoRedirect = true,
                MaxAutomaticRedirections = 5
            };

            using (var httpClient = new HttpClient(handler))
            {
                httpClient.DefaultRequestHeaders.UserAgent.ParseAdd("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36");
                httpClient.Timeout = TimeSpan.FromSeconds(15);

                try
                {
                    string url = $"https://bmclapi2.bangbang93.com/optifine/{Uri.EscapeDataString(minecraftVersion)}/{type}/{patch}";

                    return url;
                }
                catch (Exception ex)
                {
                    Debug.WriteLine($"获取Optifine下载链接失败 (版本: {minecraftVersion}): {ex.Message}");
                    return null;
                }
            }
        }

        private async Task<List<ModLoaderInfo>> GetLiteloaderVersions(string minecraftVersion)
        {
            if (_downloadSourceId == (int)DownloadSources.Official)
            {
                return await GetLiteloaderFromBmclApiAsync(minecraftVersion);
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
                    string url = $"https://bmclapi2.bangbang93.com/liteloader/list/?mcversion={minecraftVersion}";
                    var response = await client.GetAsync(url);
                    response.EnsureSuccessStatusCode();

                    string json = await response.Content.ReadAsStringAsync();
                    try
                    {
                        var list = JsonSerializer.Deserialize<List<LiteloaderVersionInfo>>(json);
                        return list ?? new List<LiteloaderVersionInfo>();
                    }
                    catch (JsonException)
                    {
                        var single = JsonSerializer.Deserialize<LiteloaderVersionInfo>(json);
                        return single != null ? new List<LiteloaderVersionInfo> { single } : new List<LiteloaderVersionInfo>();
                    }
                }
                catch (Exception ex)
                {
                    Debug.WriteLine($"获取Liteloader列表失败 (MC版本: {minecraftVersion}): {ex.Message}");
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

                    var downloadUrl = $"https://bmclapi2.bangbang93.com/liteloader/download/?version={info.Version}";

                    if (!string.IsNullOrEmpty(downloadUrl))
                    {
                        result.Add(new ModLoaderInfo
                        {
                            Type = ModLoaderType.LiteLoader,
                            Version = info.Version,
                            MinecraftVersion = info.MinecraftVersion,
                            DownloadUrl = downloadUrl,
                            Sha1 = info.Hash,
                            IsRecommended = true
                        });
                    }
                }
                return result
                    .GroupBy(v => v.Version)
                    .Select(g => g.First())
                    .OrderByDescending(v => v.Version, new VersionComparer())
                    .ToList();
            }
            catch (Exception ex)
            {
                Debug.WriteLine($"Liteloader 版本获取失败: {ex.Message}");
            }
            return new List<ModLoaderInfo>();

        }
        public class LiteloaderVersionInfo
        {
            [JsonPropertyName("mcversion")]
            public string MinecraftVersion { get; set; } = string.Empty;

            [JsonPropertyName("hash")]
            public string Hash { get; set; } = string.Empty;

            [JsonPropertyName("type")]
            public string Type { get; set; } = string.Empty;

            [JsonPropertyName("version")]
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
                        var gameVersions = await GetSupportedGameVersions(client, $"{baseUrl}/game");
                        if (!SupportsMinecraftVersion(gameVersions, minecraftVersion))
                        {
                            Debug.WriteLine($"Quilt官方 API：Quilt 不支持 MC 版本 {minecraftVersion}");
                            return versions;
                        }

                        JsonArray loaderArray = [];

                        foreach (var alias in GetMinecraftVersionAliases(minecraftVersion))
                        {
                            var encodedMcVersion = Uri.EscapeDataString(alias);
                            var loaderResponse = await client.GetAsync($"{baseUrl}/loader/{encodedMcVersion}");
                            if (!loaderResponse.IsSuccessStatusCode)
                            {
                                continue;
                            }

                            var loaderJson = await loaderResponse.Content.ReadAsStringAsync();
                            loaderArray = JsonNode.Parse(loaderJson)?.AsArray() ?? [];
                            if (loaderArray.Count > 0)
                            {
                                break;
                            }
                        }

                        if (loaderArray.Count == 0)
                        {
                            var globalLoaderResponse = await client.GetAsync($"{baseUrl}/loader");
                            globalLoaderResponse.EnsureSuccessStatusCode();
                            var globalLoaderJson = await globalLoaderResponse.Content.ReadAsStringAsync();
                            var globalLoaderItems = JsonNode.Parse(globalLoaderJson)?.AsArray()?.OfType<JsonObject>() ?? [];

                            loaderArray = new JsonArray(globalLoaderItems.Where(item =>
                            {
                                var hashedVersion = item["hashed"]?["version"]?.GetValue<string>();
                                var intermediaryVersion = item["intermediary"]?["version"]?.GetValue<string>();

                                return MatchesMinecraftVersion(hashedVersion ?? string.Empty, minecraftVersion)
                                    || MatchesMinecraftVersion(intermediaryVersion ?? string.Empty, minecraftVersion);
                            }).ToArray());
                        }

                        foreach (var item in loaderArray.OfType<JsonObject>())
                        {
                            var loaderInfo = item["loader"] as JsonObject;
                            var intermediaryInfo = item["intermediary"] as JsonObject;
                            var hashedInfo = item["hashed"] as JsonObject;

                            if (loaderInfo == null || (intermediaryInfo == null && hashedInfo == null))
                            {
                                Debug.WriteLine("跳过无效的 Loader 条目（缺少必要字段）");
                                continue;
                            }

                            var loaderVersion = loaderInfo["version"]?.GetValue<string>();
                            var isStable = loaderInfo["stable"]?.GetValue<bool>() ?? false;

                            if (string.IsNullOrEmpty(loaderVersion))
                            {
                                Debug.WriteLine($"跳过无效的 Loader 版本：{loaderVersion}");
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

                        Debug.WriteLine($"Quilt官方API：成功解析 {versions.Count} 个Fabric版本");
                    }
                    catch (HttpRequestException ex)
                    {
                        Debug.WriteLine($"Quilt官方 API 请求失败：{ex.StatusCode} - {ex.Message}");
                    }
                    catch (JsonException ex)
                    {
                        Debug.WriteLine($"Quilt官方API JSON解析失败：{ex.Message}");
                    }
                    catch (Exception ex)
                    {
                        Debug.WriteLine($"Quilt官方 API 处理失败：{ex.Message}");
                    }
                }

                return SortAndDeduplicate(versions);
            }
        }

    }
}
