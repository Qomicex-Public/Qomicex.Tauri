using Newtonsoft.Json;
using Newtonsoft.Json.Linq;
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Net.Http;
using System.Text;
using System.Threading;
using System.Threading.Tasks;

namespace Qomicex.Core.Modules.Helpers.Installers
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

            // 配置下载源
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
            // para1: modLoaderVersion (LiteLoader版本，如"1.12.2-SNAPSHOT")
            // para2: gameVersion (Minecraft版本)
            // para3, para4: 保留

            if (string.IsNullOrEmpty(modLoaderVersion))
                throw new ArgumentNullException(nameof(modLoaderVersion), "modLoaderVersion不能为空");
            if (string.IsNullOrEmpty(gameVersion))
                throw new ArgumentNullException(nameof(gameVersion), "gameVersion不能为空");

            //string modLoaderVersion = modLoaderVersion;
            string mcVersion = gameVersion;

            Trace.WriteLine($"开始LiteLoader安装 - 目标版本ID: {versionId}, MC版本: {mcVersion}, LiteLoader版本: {modLoaderVersion}");

            bool installResult = await InstallLiteLoaderAsync(versionId, mcVersion, modLoaderVersion);

            if (!installResult)
            {
                throw new Exception($"LiteLoader安装失败 - 版本ID: {versionId}");
            }

            Trace.WriteLine($"LiteLoader安装成功 - 版本ID: {versionId}");
        }

        public async Task<bool> InstallLiteLoaderAsync(string versionId, string mcVersion, string liteVersion, IProgress<InstallProgress>? progress = null, CancellationToken cancellationToken = default)
        {
            Trace.WriteLine($"启动LiteLoader安装流程 - 版本ID: {versionId}, MC版本: {mcVersion}, LiteLoader版本: {liteVersion}");
            progress?.Report(new InstallProgress { Percentage = 0, Message = "开始准备安装Liteloader..." });

            try
            {
                // 输入参数校验
                if (string.IsNullOrEmpty(mcVersion) || string.IsNullOrEmpty(liteVersion))
                {
                    throw new ArgumentException("MC版本和LiteLoader版本不能为空");
                }
                progress?.Report(new InstallProgress { Percentage = 5, Message = "输入验证通过，准备获取版本信息..." });

                // 获取远程版本信息
                progress?.Report(new InstallProgress { Percentage = 10, Message = $"正在获取LiteLoader {liteVersion}（对应MC {mcVersion}）的远程信息..." });

                var remoteVersion = await GetRemoteVersionByVersionsAsync(mcVersion, liteVersion, _sourceId);
                progress?.Report(new InstallProgress { Percentage = 25, Message = "远程版本信息获取完成" });

                if (remoteVersion == null)
                {
                    throw new Exception($"无法获取LiteLoader {liteVersion}（对应MC {mcVersion}）的版本信息");
                }

                // 检查本地MC基础版本
                progress?.Report(new InstallProgress { Percentage = 30, Message = $"正在检查MC {mcVersion}的本地基础版本..." });

                var baseVersion = GetBaseMcVersion(_gameDir, mcVersion);
                if (baseVersion == null)
                {
                    throw new Exception($"未找到MC {mcVersion}的基础版本配置");
                }
                progress?.Report(new InstallProgress { Percentage = 40, Message = "本地MC版本验证通过" });

                // 执行核心安装
                bool success = await InstallLiteLoaderCoreAsync(versionId, _gameDir, baseVersion, remoteVersion, progress, cancellationToken);
                if (!success)
                {
                    throw new Exception("核心安装流程未成功完成");
                }

                // 安装完成
                progress?.Report(new InstallProgress
                {
                    Percentage = 100,
                    Message = $"LiteLoader {liteVersion} 安装完成",
                    IsCompleted = true
                });
                Trace.WriteLine($"LiteLoader安装全流程完成 - 版本ID: {versionId}");
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
                Trace.WriteLine($"LiteLoader安装失败: {ex.Message}");
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
            Trace.WriteLine("进入核心安装流程，开始处理依赖与配置");
            try
            {
                // 1. 创建核心库
                progress?.Report(new InstallProgress { Percentage = 40, Message = "准备核心库信息..." });

                var coreLibrary = CreateCoreLibrary(remoteVersion);
                if (coreLibrary.Artifact == null || coreLibrary.DownloadInfo == null)
                {
                    throw new Exception("核心库信息构建异常");
                }
                Trace.WriteLine($"核心库创建完成 - 坐标: {coreLibrary.Artifact.ToString()}");
                progress?.Report(new InstallProgress { Percentage = 45, Message = "核心库信息准备完成" });

                // 2. 合并库列表（去重）
                var mergedLibraries = MergeLibraries(remoteVersion.Libraries, coreLibrary);
                int totalLibraries = mergedLibraries.Count;
                Trace.WriteLine($"合并后库总数: {totalLibraries}");

                progress?.Report(new InstallProgress
                {
                    Percentage = 50,
                    Message = $"共需下载 {totalLibraries} 个依赖库文件..."
                });

                // 3. 下载库文件
                if (totalLibraries > 0)
                {
                    int downloadedCount = 0;
                    foreach (var lib in mergedLibraries)
                    {
                        cancellationToken.ThrowIfCancellationRequested();

                        // 跳过无效库信息
                        if (lib.DownloadInfo?.Path == null || lib.DownloadInfo.Url == null || lib.Artifact == null)
                        {
                            Trace.WriteLine($"跳过无效库（信息不完整）: {lib.Artifact?.ToString() ?? "未知库"}");
                            continue;
                        }

                        string localPath = Path.Combine(gameDir, "libraries", lib.DownloadInfo.Path);
                        string libName = lib.Artifact.ToString();

                        // 检查文件是否已存在
                        if (File.Exists(localPath))
                        {
                            Trace.WriteLine($"库文件已存在，跳过下载: {libName}");
                            downloadedCount++;
                            continue;
                        }

                        // 创建目标目录
                        string directory = Path.GetDirectoryName(localPath)!;
                        if (!Directory.Exists(directory))
                        {
                            Directory.CreateDirectory(directory);
                        }

                        // 下载文件
                        Trace.WriteLine($"开始下载库文件: {libName}");
                        try
                        {
                            await DownloadFileAsync(lib.DownloadInfo.Url, localPath);
                            Trace.WriteLine($"库文件下载成功: {libName}");
                            downloadedCount++;
                        }
                        catch (Exception e)
                        {
                            throw new Exception($"下载依赖库 {libName} 失败: {e.Message}");
                        }

                        // 更新进度（50%-80% 分配给下载）
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

                // 4. 构建版本JSON
                progress?.Report(new InstallProgress { Percentage = 80, Message = "开始构建版本配置文件..." });

                var versionJson = await BuildVersionJsonAsync(versionId, baseVersion, remoteVersion, mergedLibraries, gameDir);
                if (string.IsNullOrEmpty(versionJson))
                {
                    throw new Exception("构建版本配置失败");
                }
                Trace.WriteLine("版本JSON配置构建完成");
                progress?.Report(new InstallProgress { Percentage = 90, Message = "版本配置文件构建完成" });

                // 5. 保存版本文件
                SaveVersionJson(versionId, gameDir, versionJson);
                Trace.WriteLine($"版本文件保存成功");
                progress?.Report(new InstallProgress { Percentage = 95, Message = "安装完成" });

                Trace.WriteLine("LiteLoader核心安装流程执行成功");
                return true;
            }
            catch (OperationCanceledException)
            {
                Trace.WriteLine("核心安装流程被取消");
                throw;
            }
            catch (Exception ex)
            {
                Trace.WriteLine($"核心安装流程失败: {ex.Message}");
                throw new Exception($"核心安装流程失败: {ex.Message}");
            }
        }

        private async Task<LiteLoaderRemoteVersion?> GetRemoteVersionByVersionsAsync(string mcVersion, string liteVersion, int downloadSource)
        {
            const string LITELOADER_GROUP = "com.mumfrey:liteloader";
            Trace.WriteLine($"获取远程版本信息 - MC: {mcVersion}, LiteLoader: {liteVersion}");

            try
            {
                using (var client = new HttpClient())
                {
                    client.Timeout = TimeSpan.FromSeconds(5);
                    string jsonUrl;

                    // 确定版本清单URL
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

                    // 请求版本清单
                    Trace.WriteLine($"请求版本清单: {jsonUrl}");
                    string jsonContent = await client.GetStringAsync(jsonUrl);

                    if (string.IsNullOrEmpty(jsonContent))
                    {
                        return null;
                    }

                    // 解析JSON
                    JObject root = JObject.Parse(jsonContent);

                    // 1. 检查顶层versions节点
                    if (root["versions"] is not JObject versionsObj)
                    {
                        return null;
                    }

                    // 2. 检查目标MC版本节点
                    if (!versionsObj.TryGetValue(mcVersion, out JToken? mcVersionNode) || mcVersionNode is not JObject mcObj)
                    {
                        return null;
                    }

                    // 3. 查找LiteLoader版本列表（优先snapshots，再artefacts）
                    JObject? liteLoaderVersions = null;
                    foreach (string nodeName in new[] { "snapshots", "artefacts" })
                    {
                        if (!mcObj.TryGetValue(nodeName, out JToken? node) || node is not JObject nodeObj)
                        {
                            continue;
                        }

                        if (nodeObj.TryGetValue(LITELOADER_GROUP, out JToken? liteNode) && liteNode is JObject liteObj)
                        {
                            liteLoaderVersions = liteObj;
                            break;
                        }
                    }

                    if (liteLoaderVersions == null)
                    {
                        return null;
                    }

                    // 4. 匹配目标LiteLoader版本
                    JObject? targetVersion = null;
                    foreach (var prop in liteLoaderVersions.Properties())
                    {
                        if (prop.Value is not JObject versionObj) continue;

                        string? version = versionObj["version"]?.ToString();
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

                    // 5. 解析主文件下载地址
                    string? fileName = targetVersion["file"]?.ToString();
                    if (string.IsNullOrEmpty(fileName))
                    {
                        return null;
                    }

                    string mainUrl = $"{_baseRepoUrl.TrimEnd('/')}/com/mumfrey/liteloader/{liteVersion}/{fileName}";
                    Trace.WriteLine($"主Jar下载地址: {mainUrl}");

                    // 6. 解析依赖库
                    List<Library> libraries = new List<Library>();
                    if (targetVersion.TryGetValue("libraries", out JToken? libsNode) && libsNode is JArray libsArray)
                    {
                        foreach (var libItem in libsArray)
                        {
                            if (libItem is not JObject libObj)
                            {
                                continue;
                            }

                            string? libName = libObj["name"]?.ToString();
                            if (string.IsNullOrEmpty(libName))
                            {
                                continue;
                            }

                            // 解析Maven坐标
                            Artifact? artifact = ParseMavenCoordinate(libName);
                            if (artifact == null)
                            {
                                continue;
                            }

                            // 确定库下载地址
                            string libUrl = libObj["url"]?.ToString() ?? _baseRepoUrl;
                            // 官方源特殊处理：launchwrapper等库需从Sponge仓库下载
                            if (downloadSource == (int)DownloadSource.Official && string.IsNullOrEmpty((string?)libObj["url"]))
                            {
                                libUrl = "https://repo.spongepowered.org/maven";
                            }

                            string mavenPath = base.MavenToPath(libName);
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

                    // 7. 解析TweakClass
                    string tweakClass = targetVersion["tweakClass"]?.ToString() ?? "com.mumfrey.liteloader.launch.LiteLoaderTweaker";

                    // 8. 返回完整版本信息
                    var remoteVersion = new LiteLoaderRemoteVersion(
                        gameVersion: mcVersion,
                        selfVersion: liteVersion,
                        urls: new List<string> { mainUrl },
                        tweakClass: tweakClass,
                        libraries: libraries
                    );
                    Trace.WriteLine("远程版本信息解析完成");
                    return remoteVersion;
                }
            }
            catch (Exception ex)
            {
                Trace.WriteLine($"解析远程版本信息失败: {ex.Message}");
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
            // Maven坐标需满足 group:artifact:version 三部分
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
            Trace.WriteLine($"查找本地MC基础版本 - 版本: {mcVersion}");
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
            Trace.WriteLine($"创建LiteLoader核心库 - Maven坐标: {mavenCoord}");

            string mavenPath = base.MavenToPath(mavenCoord);
            if (string.IsNullOrEmpty(mavenPath))
            {
                mavenPath = $"com/mumfrey/liteloader/{liteVersion}/liteloader-{liteVersion}.jar";
            }

            // 确定核心库下载地址
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

            // 检查基础库中是否已包含核心库（通过Artifact坐标去重）
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
            Trace.WriteLine($"构建版本JSON - 版本ID: {versionId}");
            try
            {
                // 二次检查并下载缺失库
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

                    // 补充下载缺失库
                    try
                    {
                        await base.DownloadFileAsync(lib.DownloadInfo.Url, localPath);
                    }
                    catch (Exception)
                    {
                        return string.Empty;
                    }
                }

                // 构建LiteLoader版本JSON结构
                var liteJson = new JObject
                {
                    ["id"] = versionId,
                    ["inheritsFrom"] = baseVersion.Id,
                    ["type"] = "release",
                    ["arguments"] = new JObject
                    {
                        ["game"] = new JArray("--tweakClass", remoteVersion.TweakClass ?? "com.mumfrey.liteloader.launch.LiteLoaderTweaker")
                    },
                    ["mainClass"] = "net.minecraft.launchwrapper.Launch",
                    ["libraries"] = JArray.FromObject(libraries.Select(lib => new
                    {
                        name = lib.Artifact?.ToString(),
                        url = lib.Url,
                        downloads = new
                        {
                            artifact = new
                            {
                                path = lib.DownloadInfo?.Path,
                                url = lib.DownloadInfo?.Url
                            }
                        }
                    })),
                    ["logging"] = new JObject()
                };

                // 转换为JSON字符串
                string liteJsonStr = liteJson.ToString(Formatting.Indented);

                // 合并基础版本配置
                string mergedJson = base.MergeVersionJson(baseVersion.ToJson(), liteJsonStr, versionId);
                if (string.IsNullOrEmpty(mergedJson))
                {
                    return string.Empty;
                }

                return mergedJson;
            }
            catch (Exception ex)
            {
                Trace.WriteLine($"构建版本JSON失败: {ex.Message}");
                return string.Empty;
            }
        }

        private void SaveVersionJson(string versionId, string gameDir, string jsonContent)
        {
            var versionDir = Path.Combine(gameDir, "versions", versionId);
            var jsonPath = Path.Combine(versionDir, $"{versionId}.json");

            // 创建版本目录
            if (!Directory.Exists(versionDir))
            {
                Directory.CreateDirectory(versionDir);
            }

            // 写入文件
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
