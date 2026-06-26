using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Net.Http;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Threading;
using System.Threading.Tasks;

namespace Qomicex.Launcher.Backend.Modules.Helpers.Installers
{
    public class LiteloaderInstaller : InstallerBase, IInstaller
    {
        private readonly string _baseRepoUrl = "https://dl.liteloader.com/versions/";
        private int _sourceId = (int)DownloadSource.Official;
        private string _gameDir = string.Empty;
        private string _gameVersion = string.Empty;

        public LiteloaderInstaller(int sourceId, string gameDir, string gameVersion)
        {
            _sourceId = sourceId;
            _gameDir = gameDir;
            _gameVersion = gameVersion;

            if (sourceId == (int)DownloadSource.Bmclapi)
            {
                _baseRepoUrl = "https://bmclapi2.bangbang93.com/maven/";
            }
            else
            {
                _baseRepoUrl = "https://dl.liteloader.com/versions";
            }
        }

        public async Task InstallAsync(string versionId, string inheritsFromJson, string? modLoaderVersion, string? gameVersion, string? para3, string? para4)
        {
            if (string.IsNullOrEmpty(modLoaderVersion))
                throw new ArgumentNullException(nameof(modLoaderVersion), "modLoaderVersion不能为空");
            if (string.IsNullOrEmpty(gameVersion))
                throw new ArgumentNullException(nameof(gameVersion), "gameVersion不能为空");

            string mcVersion = gameVersion;

            Debug.WriteLine($"开始LiteLoader安装 - 目标版本ID: {versionId}, MC版本: {mcVersion}, LiteLoader版本: {modLoaderVersion}");

            bool installResult = await InstallLiteLoaderAsync(versionId, mcVersion, modLoaderVersion);

            if (!installResult)
            {
                throw new Exception($"LiteLoader安装失败 - 版本ID: {versionId}");
            }

            Debug.WriteLine($"LiteLoader安装成功 - 版本ID: {versionId}");
        }

        public async Task<bool> InstallLiteLoaderAsync(string versionId, string mcVersion, string liteVersion, IProgress<InstallProgress>? progress = null, CancellationToken cancellationToken = default)
        {
            Debug.WriteLine($"启动LiteLoader安装流程 - 版本ID: {versionId}, MC版本: {mcVersion}, LiteLoader版本: {liteVersion}");
            progress?.Report(new InstallProgress { Percentage = 0, Message = "开始准备安装Liteloader..." });

            try
            {
                if (string.IsNullOrEmpty(mcVersion) || string.IsNullOrEmpty(liteVersion))
                {
                    throw new ArgumentException("MC版本和LiteLoader版本不能为空");
                }
                progress?.Report(new InstallProgress { Percentage = 5, Message = "输入验证通过，准备获取版本信息..." });

                progress?.Report(new InstallProgress { Percentage = 10, Message = $"正在获取LiteLoader {liteVersion}（对应MC {mcVersion}）的远程信息..." });

                var remoteVersion = await GetRemoteVersionByVersionsAsync(mcVersion, liteVersion, _sourceId);
                progress?.Report(new InstallProgress { Percentage = 25, Message = "远程版本信息获取完成" });

                if (remoteVersion == null)
                {
                    throw new Exception($"无法获取LiteLoader {liteVersion}（对应MC {mcVersion}）的版本信息");
                }

                progress?.Report(new InstallProgress { Percentage = 30, Message = $"正在检查MC {mcVersion}的本地基础版本..." });

                var baseVersion = GetBaseMcVersion(_gameDir, mcVersion);
                if (baseVersion == null)
                {
                    throw new Exception($"未找到MC {mcVersion}的基础版本配置");
                }
                progress?.Report(new InstallProgress { Percentage = 40, Message = "本地MC版本验证通过" });

                bool success = await InstallLiteLoaderCoreAsync(versionId, _gameDir, baseVersion, remoteVersion, progress, cancellationToken);
                if (!success)
                {
                    throw new Exception("核心安装流程未成功完成");
                }

                progress?.Report(new InstallProgress
                {
                    Percentage = 100,
                    Message = $"LiteLoader {liteVersion} 安装完成",
                    IsCompleted = true
                });
                Debug.WriteLine($"LiteLoader安装全流程完成 - 版本ID: {versionId}");
                return true;
            }
            catch (OperationCanceledException)
            {
                string errMsg = "安装任务被用户取消";
                progress?.Report(new InstallProgress { Percentage = 5, Message = errMsg, IsError = true });
                return false;
            }
            catch (Exception ex)
            {
                string errMsg = $"安装失败: {ex.Message}";
                progress?.Report(new InstallProgress { Percentage = 5, Message = errMsg, IsError = true });
                Debug.WriteLine($"LiteLoader安装失败: {ex.Message}");
                return false;
            }
        }

        private async Task<bool> InstallLiteLoaderCoreAsync(
            string versionId,
            string gameDir,
            Version baseVersion,
            LiteLoaderRemoteVersion remoteVersion,
            IProgress<InstallProgress>? progress,
            CancellationToken cancellationToken)
        {
            Debug.WriteLine("进入核心安装流程，开始处理依赖与配置");
            try
            {
                progress?.Report(new InstallProgress { Percentage = 40, Message = "准备核心库信息..." });

                var coreLibrary = CreateCoreLibrary(remoteVersion);
                if (coreLibrary.Artifact == null || coreLibrary.DownloadInfo == null)
                {
                    throw new Exception("核心库信息构建异常");
                }
                Debug.WriteLine($"核心库创建完成 - 坐标: {coreLibrary.Artifact.ToString()}");
                progress?.Report(new InstallProgress { Percentage = 45, Message = "核心库信息准备完成" });

                var mergedLibraries = MergeLibraries(remoteVersion.Libraries, coreLibrary);
                int totalLibraries = mergedLibraries.Count;
                Debug.WriteLine($"合并后库总数: {totalLibraries}");

                progress?.Report(new InstallProgress
                {
                    Percentage = 50,
                    Message = $"共需下载 {totalLibraries} 个依赖库文件..."
                });

                if (totalLibraries > 0)
                {
                    int downloadedCount = 0;
                    foreach (var lib in mergedLibraries)
                    {
                        cancellationToken.ThrowIfCancellationRequested();

                        if (lib.DownloadInfo?.Path == null || lib.DownloadInfo.Url == null || lib.Artifact == null)
                        {
                            Debug.WriteLine($"跳过无效库（信息不完整）: {lib.Artifact?.ToString() ?? "未知库"}");
                            continue;
                        }

                        string localPath = Path.Combine(gameDir, "libraries", lib.DownloadInfo.Path);
                        string libName = lib.Artifact.ToString();

                        if (File.Exists(localPath))
                        {
                            Debug.WriteLine($"库文件已存在，跳过下载: {libName}");
                            downloadedCount++;
                            continue;
                        }

                        string directory = Path.GetDirectoryName(localPath)!;
                        if (!Directory.Exists(directory))
                        {
                            Directory.CreateDirectory(directory);
                        }

                        Debug.WriteLine($"开始下载库文件: {libName}");
                        try
                        {
                            await DownloadFileAsync(lib.DownloadInfo.Url, localPath);
                            Debug.WriteLine($"库文件下载成功: {libName}");
                            downloadedCount++;
                        }
                        catch (Exception e)
                        {
                            throw new Exception($"下载依赖库 {libName} 失败: {e.Message}");
                        }

                        int downloadProgress = 50 + (int)((double)downloadedCount / totalLibraries * 30);
                        progress?.Report(new InstallProgress
                        {
                            Percentage = downloadProgress,
                            Message = $"已下载 {downloadedCount}/{totalLibraries} 个库文件"
                        });
                    }

                    progress?.Report(new InstallProgress
                    {
                        Percentage = 80,
                        Message = $"依赖库下载完成，共处理 {downloadedCount}/{totalLibraries} 个文件"
                    });
                }
                else
                {
                    progress?.Report(new InstallProgress { Percentage = 80, Message = "无依赖库需要下载" });
                }

                progress?.Report(new InstallProgress { Percentage = 80, Message = "开始构建版本配置文件..." });

                var versionJson = await BuildVersionJsonAsync(versionId, baseVersion, remoteVersion, mergedLibraries, gameDir);
                if (string.IsNullOrEmpty(versionJson))
                {
                    throw new Exception("构建版本配置失败");
                }
                Debug.WriteLine("版本JSON配置构建完成");
                progress?.Report(new InstallProgress { Percentage = 90, Message = "版本配置文件构建完成" });

                SaveVersionJson(versionId, gameDir, versionJson);
                Debug.WriteLine($"版本文件保存成功");
                progress?.Report(new InstallProgress { Percentage = 95, Message = "安装完成" });

                Debug.WriteLine("LiteLoader核心安装流程执行成功");
                return true;
            }
            catch (OperationCanceledException)
            {
                Debug.WriteLine("核心安装流程被取消");
                throw;
            }
            catch (Exception ex)
            {
                Debug.WriteLine($"核心安装流程失败: {ex.Message}");
                throw new Exception($"核心安装流程失败: {ex.Message}");
            }
        }

        private async Task<LiteLoaderRemoteVersion?> GetRemoteVersionByVersionsAsync(string mcVersion, string liteVersion, int downloadSource)
        {
            const string LITELOADER_GROUP = "com.mumfrey:liteloader";
            Debug.WriteLine($"获取远程版本信息 - MC: {mcVersion}, LiteLoader: {liteVersion}");

            try
            {
                using (var client = new HttpClient())
                {
                    client.Timeout = TimeSpan.FromSeconds(5);
                    string jsonUrl;

                    if (downloadSource == (int)DownloadSource.Official)
                    {
                        jsonUrl = "https://dl.liteloader.com/versions/versions.json";
                    }
                    else if (downloadSource == (int)DownloadSource.Bmclapi)
                    {
                        jsonUrl = "https://bmclapi2.bangbang93.com/maven/com/mumfrey/liteloader/versions.json";
                    }
                    else
                    {
                        throw new ArgumentException("未知的下载源类型");
                    }

                    Debug.WriteLine($"请求版本清单: {jsonUrl}");
                    string jsonContent = await client.GetStringAsync(jsonUrl);

                    if (string.IsNullOrEmpty(jsonContent))
                    {
                        return null;
                    }

                    var root = JsonNode.Parse(jsonContent)!.AsObject();

                    if (root["versions"] is not JsonObject versionsObj)
                    {
                        return null;
                    }

                    if (!versionsObj.TryGetPropertyValue(mcVersion, out var mcVersionNode) || mcVersionNode is not JsonObject mcObj)
                    {
                        return null;
                    }

                    JsonObject? liteLoaderVersions = null;
                    foreach (string nodeName in new[] { "snapshots", "artefacts" })
                    {
                        if (!mcObj.TryGetPropertyValue(nodeName, out var node) || node is not JsonObject nodeObj)
                        {
                            continue;
                        }

                        if (nodeObj.TryGetPropertyValue(LITELOADER_GROUP, out var liteNode) && liteNode is JsonObject liteObj)
                        {
                            liteLoaderVersions = liteObj;
                            break;
                        }
                    }

                    if (liteLoaderVersions == null)
                    {
                        return null;
                    }

                    JsonObject? targetVersion = null;
                    foreach (var prop in liteLoaderVersions)
                    {
                        if (prop.Value is not JsonObject versionObj) continue;

                        string? version = versionObj["version"]?.GetValue<string>();
                        if (string.Equals(version, liteVersion, StringComparison.Ordinal))
                        {
                            targetVersion = versionObj;
                            break;
                        }
                    }

                    if (targetVersion == null)
                    {
                        return null;
                    }

                    string? fileName = targetVersion["file"]?.GetValue<string>();
                    if (string.IsNullOrEmpty(fileName))
                    {
                        return null;
                    }

                    string mainUrl = $"{_baseRepoUrl.TrimEnd('/')}/com/mumfrey/liteloader/{liteVersion}/{fileName}";
                    Debug.WriteLine($"主Jar下载地址: {mainUrl}");

                    List<Library> libraries = new List<Library>();
                    if (targetVersion.TryGetPropertyValue("libraries", out var libsNode) && libsNode is JsonArray libsArray)
                    {
                        foreach (var libItem in libsArray)
                        {
                            if (libItem is not JsonObject libObj)
                            {
                                continue;
                            }

                            string? libName = libObj["name"]?.GetValue<string>();
                            if (string.IsNullOrEmpty(libName))
                            {
                                continue;
                            }

                            Artifact? artifact = ParseMavenCoordinate(libName);
                            if (artifact == null)
                            {
                                continue;
                            }

                            string libUrl = libObj["url"]?.GetValue<string>() ?? _baseRepoUrl;
                            if (downloadSource == (int)DownloadSource.Official && string.IsNullOrEmpty(libObj["url"]?.GetValue<string>()))
                            {
                                libUrl = "https://repo.spongepowered.org/maven";
                            }

                            string mavenPath = InstallerBase.MavenToPath(libName);
                            if (string.IsNullOrEmpty(mavenPath))
                            {
                                continue;
                            }

                            libraries.Add(new Library
                            {
                                Artifact = artifact,
                                Url = libUrl,
                                DownloadInfo = new LibraryDownloadInfo
                                {
                                    Path = mavenPath,
                                    Url = $"{libUrl.TrimEnd('/')}/{mavenPath}"
                                }
                            });
                        }
                    }

                    string tweakClass = targetVersion["tweakClass"]?.GetValue<string>() ?? "com.mumfrey.liteloader.launch.LiteLoaderTweaker";

                    var remoteVersion = new LiteLoaderRemoteVersion(
                        gameVersion: mcVersion,
                        selfVersion: liteVersion,
                        urls: new List<string> { mainUrl },
                        tweakClass: tweakClass,
                        libraries: libraries
                    );
                    Debug.WriteLine("远程版本信息解析完成");
                    return remoteVersion;
                }
            }
            catch (Exception ex)
            {
                Debug.WriteLine($"解析远程版本信息失败: {ex.Message}");
                return null;
            }
        }

        private Artifact? ParseMavenCoordinate(string maven)
        {
            if (string.IsNullOrWhiteSpace(maven))
            {
                return null;
            }

            string[] parts = maven.Split(':');
            if (parts.Length < 3)
            {
                return null;
            }

            string group = parts[0].Trim();
            string artifact = parts[1].Trim();
            string version = parts[2].Trim();

            if (string.IsNullOrEmpty(group) || string.IsNullOrEmpty(artifact) || string.IsNullOrEmpty(version))
            {
                return null;
            }

            return new Artifact(group, artifact, version);
        }

        private Version? GetBaseMcVersion(string gameDir, string mcVersion)
        {
            Debug.WriteLine($"查找本地MC基础版本 - 版本: {mcVersion}");
            var localVersionPath = Path.Combine(gameDir, "versions", mcVersion, $"{mcVersion}.json");

            if (!File.Exists(localVersionPath))
            {
                return null;
            }

            try
            {
                string jsonContent = File.ReadAllText(localVersionPath);
                var version = new Version { Id = mcVersion };
                version.SetJson(jsonContent);
                return version;
            }
            catch (IOException)
            {
                return null;
            }
        }

        private Library CreateCoreLibrary(LiteLoaderRemoteVersion remoteVersion)
        {
            string liteVersion = remoteVersion.SelfVersion;
            string mavenCoord = $"com.mumfrey:liteloader:{liteVersion}";
            Debug.WriteLine($"创建LiteLoader核心库 - Maven坐标: {mavenCoord}");

            string mavenPath = InstallerBase.MavenToPath(mavenCoord);
            if (string.IsNullOrEmpty(mavenPath))
            {
                mavenPath = $"com/mumfrey/liteloader/{liteVersion}/liteloader-{liteVersion}.jar";
            }

            string downloadUrl = remoteVersion.Urls.FirstOrDefault() ?? $"{_baseRepoUrl.TrimEnd('/')}/{mavenPath}";

            var coreLibrary = new Library
            {
                Artifact = new Artifact("com.mumfrey", "liteloader", liteVersion),
                Url = _baseRepoUrl,
                DownloadInfo = new LibraryDownloadInfo
                {
                    Path = mavenPath,
                    Url = downloadUrl
                }
            };

            return coreLibrary;
        }

        private List<Library> MergeLibraries(List<Library> baseLibraries, Library coreLibrary)
        {
            if (coreLibrary.Artifact == null)
            {
                return new List<Library>(baseLibraries) { coreLibrary };
            }

            string coreLibCoord = coreLibrary.Artifact.ToString();

            bool coreLibExists = baseLibraries.Any(lib =>
                lib.Artifact != null && lib.Artifact.ToString() == coreLibCoord
            );

            if (coreLibExists)
            {
                return new List<Library>(baseLibraries);
            }
            else
            {
                var merged = new List<Library>(baseLibraries) { coreLibrary };
                return merged;
            }
        }

        private async Task<string> BuildVersionJsonAsync(string versionId, Version baseVersion, LiteLoaderRemoteVersion remoteVersion, List<Library> libraries, string gameDir)
        {
            Debug.WriteLine($"构建版本JSON - 版本ID: {versionId}");
            try
            {
                foreach (var lib in libraries)
                {
                    if (lib.DownloadInfo?.Path == null || lib.DownloadInfo.Url == null || lib.Artifact == null)
                    {
                        continue;
                    }

                    string localPath = Path.Combine(gameDir, "libraries", lib.DownloadInfo.Path);
                    string libName = lib.Artifact.ToString();

                    if (File.Exists(localPath))
                    {
                        continue;
                    }

                    try
                    {
                        await base.DownloadFileAsync(lib.DownloadInfo.Url, localPath);
                    }
                    catch (Exception)
                    {
                        return string.Empty;
                    }
                }

                var libsArray = new JsonArray(libraries.Select(lib =>
                {
                    var entry = new JsonObject
                    {
                        ["name"] = JsonValue.Create(lib.Artifact?.ToString()),
                        ["url"] = JsonValue.Create(lib.Url),
                        ["downloads"] = new JsonObject
                        {
                            ["artifact"] = new JsonObject
                            {
                                ["path"] = JsonValue.Create(lib.DownloadInfo?.Path),
                                ["url"] = JsonValue.Create(lib.DownloadInfo?.Url)
                            }
                        }
                    };
                    return entry;
                }).ToArray());

                var liteJson = new JsonObject
                {
                    ["id"] = JsonValue.Create(versionId),
                    ["inheritsFrom"] = JsonValue.Create(baseVersion.Id),
                    ["type"] = JsonValue.Create("release"),
                    ["arguments"] = new JsonObject
                    {
                        ["game"] = new JsonArray(JsonValue.Create("--tweakClass"), JsonValue.Create(remoteVersion.TweakClass ?? "com.mumfrey.liteloader.launch.LiteLoaderTweaker"))
                    },
                    ["mainClass"] = JsonValue.Create("net.minecraft.launchwrapper.Launch"),
                    ["libraries"] = libsArray,
                    ["logging"] = new JsonObject()
                };

                string liteJsonStr = liteJson.ToJsonString(new JsonSerializerOptions { WriteIndented = true });

                string mergedJson = base.MergeVersionJson(baseVersion.ToJson(), liteJsonStr, versionId);
                if (string.IsNullOrEmpty(mergedJson))
                {
                    return string.Empty;
                }

                return mergedJson;
            }
            catch (Exception ex)
            {
                Debug.WriteLine($"构建版本JSON失败: {ex.Message}");
                return string.Empty;
            }
        }

        private void SaveVersionJson(string versionId, string gameDir, string jsonContent)
        {
            var versionDir = Path.Combine(gameDir, "versions", versionId);
            var jsonPath = Path.Combine(versionDir, $"{versionId}.json");

            if (!Directory.Exists(versionDir))
            {
                Directory.CreateDirectory(versionDir);
            }

            File.WriteAllText(jsonPath, jsonContent);
        }

        #region 数据模型

        public class LiteLoaderRemoteVersion
        {
            public string GameVersion { get; set; }
            public string SelfVersion { get; set; }
            public List<string> Urls { get; set; }
            public string TweakClass { get; set; }
            public List<Library> Libraries { get; set; }

            public LiteLoaderRemoteVersion(string gameVersion, string selfVersion, List<string> urls, string tweakClass, List<Library> libraries)
            {
                GameVersion = gameVersion;
                SelfVersion = selfVersion;
                Urls = urls ?? new List<string>();
                TweakClass = tweakClass;
                Libraries = libraries ?? new List<Library>();
            }
        }

        public class Library
        {
            public Artifact? Artifact { get; set; }
            public string? Url { get; set; }
            public LibraryDownloadInfo? DownloadInfo { get; set; }
        }

        public class Artifact
        {
            public string GroupId { get; set; }
            public string ArtifactId { get; set; }
            public string Version { get; set; }

            public Artifact(string groupId, string artifactId, string version)
            {
                GroupId = groupId;
                ArtifactId = artifactId;
                Version = version;
            }

            public override string ToString() => $"{GroupId}:{ArtifactId}:{Version}";
        }

        public class LibraryDownloadInfo
        {
            public string? Path { get; set; }
            public string? Url { get; set; }
        }

        public class Version
        {
            public string? Id { get; set; }
            private string? _json;

            public void SetJson(string json) => _json = json;
            public string ToJson() => _json ?? "{}";
        }

        public class InstallProgress
        {
            public int Percentage { get; set; }
            public string Message { get; set; } = string.Empty;
            public bool IsCompleted { get; set; } = false;
            public bool IsError { get; set; } = false;
        }

        #endregion
    }
}
