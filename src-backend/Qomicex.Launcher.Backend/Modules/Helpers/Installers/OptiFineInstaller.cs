using Qomicex.Launcher.Backend.Modules.Helpers.Resources;
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Net.Http;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Threading.Tasks;

namespace Qomicex.Launcher.Backend.Modules.Helpers.Installers
{
    public class OptiFineInstaller : InstallerBase, IInstaller
    {
        private string _downloadSource = "https://bmclapi2.bangbang93.com/optifine";
        private string _gameDir;
        private string _gameVersion;

        public OptiFineInstaller(int sourceId, string gameDir, string gameVersion)
        {
            if (sourceId == (int)DownloadSource.Official)
            {
                _downloadSource = "https://optifine.net/download";
            }
            else
            {
                _downloadSource = "https://bmclapi2.bangbang93.com/optifine";
            }
            _gameDir = gameDir;
            _gameVersion = gameVersion;
        }

        public async Task InstallAsync(string versionId, string inheritsFromJson, string? modLoaderVersion, string? installerFilePath, string? javaPath, string? para4)
        {
            if (string.IsNullOrEmpty(modLoaderVersion))
                throw new ArgumentNullException(nameof(modLoaderVersion), "modLoaderVersion不能为空");
            if (string.IsNullOrEmpty(installerFilePath))
                throw new ArgumentNullException(nameof(installerFilePath), "installerFilePath不能为空");
            if (string.IsNullOrEmpty(javaPath))
                throw new ArgumentNullException(nameof(javaPath), "javaPath不能为空");

            var ofInfoParts = modLoaderVersion.Split('-');
            if (ofInfoParts.Length != 2)
            {
                throw new ArgumentException("modLoaderVersion格式错误，需为\"Type-Patch\"（如\"HD_U_G5\"）", nameof(modLoaderVersion));
            }

            OptiFineVersionInfo version = new OptiFineVersionInfo
            {
                McVersion = _gameVersion,
                Type = ofInfoParts[0],
                Patch = ofInfoParts[1],
                FileName = installerFilePath
            };

            await InstallCoreAsync(versionId, version, javaPath, inheritsFromJson);
        }

        private async Task InstallCoreAsync(string versionId, OptiFineVersionInfo version, string javaPath, string? inheritsFromJson)
        {
            Debug.WriteLine($"启动OptiFine核心安装 - Type: {version.Type}, Patch: {version.Patch}");

            var baseVersion = GetBaseMcVersion(_gameDir, _gameVersion);
            if (baseVersion == null)
            {
                throw new Exception($"未找到Minecraft {_gameVersion}的基础版本配置");
            }
            Debug.WriteLine($"成功获取基础版本: {baseVersion.Id}");

            var installerFile = await DownloadInstallerAsync(version);
            if (!installerFile.Exists)
            {
                throw new FileNotFoundException("OptiFine安装包下载失败", installerFile.FullName);
            }
            Debug.WriteLine($"安装包下载成功: {installerFile.FullName}");

            string optiVersionId = versionId;
            string versionDir = Path.Combine(_gameDir, "versions", optiVersionId);
            Debug.WriteLine($"生成版本信息 - ID: {optiVersionId}, 目录: {versionDir}");

            if (!Directory.Exists(versionDir))
            {
                Directory.CreateDirectory(versionDir);
            }

            bool jsonCreated = await CreateVersionJsonAsync(baseVersion, version, optiVersionId, versionDir, inheritsFromJson);
            if (!jsonCreated)
            {
                throw new Exception("版本配置文件创建失败");
            }
            Debug.WriteLine("版本JSON创建成功");

            bool installSuccess = await RunInstallerAsync(installerFile.FullName, javaPath, baseVersion, versionDir, optiVersionId);
            if (!installSuccess)
            {
                throw new Exception("OptiFine安装程序执行失败");
            }
            Debug.WriteLine("OptiFine安装程序执行成功");

            CleanupTempFiles(installerFile.FullName);

            Debug.WriteLine($"OptiFine安装完成 - 版本ID: {optiVersionId}");
        }

        public async Task<List<OptiFineVersionInfo>> GetAvailableVersionsAsync()
        {
            Debug.WriteLine("开始获取OptiFine可用版本列表");

            try
            {
                using (var client = new HttpClient())
                {
                    client.Timeout = TimeSpan.FromSeconds(5);
                    string url = $"{_downloadSource}/{_gameVersion}";
                    string json = await client.GetStringAsync(url);

                    if (string.IsNullOrEmpty(json))
                    {
                        return new List<OptiFineVersionInfo>();
                    }

                    List<OptiFineVersionInfo>? versions = JsonSerializer.Deserialize<List<OptiFineVersionInfo>>(json);

                    if (versions != null && versions.Count > 0)
                    {
                        versions.Sort((a, b) => string.Compare(b.Patch, a.Patch, StringComparison.Ordinal));
                    }

                    Debug.WriteLine($"成功获取 {versions?.Count ?? 0} 个可用OptiFine版本");
                    return versions ?? new List<OptiFineVersionInfo>();
                }
            }
            catch (Exception ex)
            {
                Debug.WriteLine($"获取OptiFine版本列表失败: {ex.Message}");
                throw new Exception("获取OptiFine版本列表失败", ex);
            }
        }

        private async Task<FileInfo> DownloadInstallerAsync(OptiFineVersionInfo version)
        {
            if (!string.IsNullOrEmpty(version.FileName) && File.Exists(version.FileName))
            {
                Debug.WriteLine($"使用本地安装器文件: {version.FileName}");
                return new FileInfo(version.FileName);
            }

            string url = $"{_downloadSource}/{_gameVersion}/{version.Type}/{version.Patch}";
            string fileName = $"{_gameVersion}_{version.Type}_{version.Patch}.jar";
            string savePath = Path.Combine(_gameDir, "temp", fileName);

            Debug.WriteLine($"下载安装包 - URL: {url}, 保存路径: {savePath}");

            string tempDir = Path.GetDirectoryName(savePath)!;
            if (!Directory.Exists(tempDir))
            {
                Directory.CreateDirectory(tempDir);
            }

            if (File.Exists(savePath))
            {
                Debug.WriteLine("安装包已存在，跳过下载");
                return new FileInfo(savePath);
            }

            await DownloadFileAsync(url, savePath);
            Debug.WriteLine("安装包下载完成");
            return new FileInfo(savePath);
        }

        private async Task<bool> CreateVersionJsonAsync(Version baseVersion, OptiFineVersionInfo optiVersion, string versionId, string versionDir, string? inheritsFromJson)
        {
            try
            {
                var baseJson = JsonNode.Parse(baseVersion.ToJson())!.AsObject();

                var newJson = new JsonObject
                {
                    ["id"] = JsonValue.Create(versionId),
                    ["inheritsFrom"] = JsonValue.Create(_gameVersion),
                    ["type"] = JsonValue.Create("release"),
                    ["time"] = JsonValue.Create(DateTime.UtcNow.ToString("yyyy-MM-dd'T'HH:mm:ssZ")),
                    ["releaseTime"] = JsonValue.Create(DateTime.UtcNow.ToString("yyyy-MM-dd'T'HH:mm:ssZ")),
                    ["mainClass"] = JsonValue.Create("net.minecraft.launchwrapper.Launch"),
                    ["minecraftArguments"] = JsonValue.Create("--tweakClass optifine.OptiFineTweaker"),
                    ["libraries"] = new JsonArray()
                };

                if (baseJson["libraries"] is JsonArray baseLibraries)
                {
                    foreach (var lib in baseLibraries)
                    {
                        ((JsonArray)newJson["libraries"]!).Add(lib?.DeepClone());
                    }
                }

                var optiLib = JsonSerializer.SerializeToNode(new
                {
                    name = $"optifine:OptiFine:{_gameVersion}_{optiVersion.Type}_{optiVersion.Patch}"
                })!.AsObject();
                ((JsonArray)newJson["libraries"]!).Add(optiLib);

                var launchWrapperLib = JsonSerializer.SerializeToNode(new
                {
                    name = "net.minecraft:launchwrapper:1.12"
                })!.AsObject();
                ((JsonArray)newJson["libraries"]!).Add(launchWrapperLib);

                if (!string.IsNullOrEmpty(inheritsFromJson))
                {
                    var merged = MergeVersionJson(inheritsFromJson, newJson.ToJsonString(), versionId);
                    newJson = JsonNode.Parse(merged)!.AsObject();
                }

                string jsonPath = Path.Combine(versionDir, $"{versionId}.json");
                await File.WriteAllTextAsync(jsonPath, newJson.ToJsonString(new JsonSerializerOptions { WriteIndented = true }));

                string sourceJar = Path.Combine(_gameDir, "versions", _gameVersion, $"{_gameVersion}.jar");
                string targetJar = Path.Combine(versionDir, $"{versionId}.jar");

                if (!File.Exists(sourceJar))
                {
                    throw new FileNotFoundException("基础Minecraft客户端JAR文件不存在", sourceJar);
                }

                File.Copy(sourceJar, targetJar, true);

                return true;
            }
            catch (Exception ex)
            {
                Debug.WriteLine($"创建版本JSON失败: {ex.Message}");
                return false;
            }
        }

        private async Task<bool> RunInstallerAsync(string installerPath, string javaPath, Version baseVersion, string versionDir, string versionId)
        {
            string clientJarPath = Path.Combine(_gameDir, "versions", _gameVersion, $"{_gameVersion}.jar");
            string outputJarPath = Path.Combine(versionDir, $"{versionId}.jar");
            string libPath = Path.Combine(_gameDir, "libraries", "optifine", "OptiFine",
                $"{_gameVersion}_{versionId.Split('_')[1]}_{versionId.Split('_')[2]}",
                $"OptiFine-{_gameVersion}_{versionId.Split('_')[1]}_{versionId.Split('_')[2]}.jar");

            Debug.WriteLine($"准备安装程序参数 - 客户端Jar: {clientJarPath}, 输出Jar: {outputJarPath}, 库路径: {libPath}");

            string libDir = Path.GetDirectoryName(libPath)!;
            if (!Directory.Exists(libDir))
            {
                Directory.CreateDirectory(libDir);
            }

            string arguments = $"-cp \"{installerPath}\" optifine.Patcher \"{clientJarPath}\" \"{installerPath}\" \"{libPath}\"";
            Debug.WriteLine($"执行安装命令: {javaPath} {arguments}");

            using (var process = new Process())
            {
                process.StartInfo = new ProcessStartInfo(javaPath)
                {
                    Arguments = arguments,
                    WorkingDirectory = _gameDir,
                    UseShellExecute = false,
                    RedirectStandardOutput = true,
                    RedirectStandardError = true,
                    CreateNoWindow = true
                };

                process.OutputDataReceived += (sender, e) =>
                {
                    if (!string.IsNullOrEmpty(e.Data))
                    {
                        Debug.WriteLine($"OptiFine安装输出: {e.Data}");
                    }
                };

                process.ErrorDataReceived += (sender, e) =>
                {
                    if (!string.IsNullOrEmpty(e.Data))
                    {
                        Debug.WriteLine($"OptiFine安装错误: {e.Data}");
                    }
                };

                process.Start();
                process.BeginOutputReadLine();
                process.BeginErrorReadLine();
                await process.WaitForExitAsync();

                return process.ExitCode == 0;
            }
        }

        private void CleanupTempFiles(string installerPath)
        {
            try
            {
                if (File.Exists(installerPath))
                {
                    File.Delete(installerPath);
                    Debug.WriteLine($"临时文件清理成功: {installerPath}");
                }
            }
            catch (Exception ex)
            {
                Debug.WriteLine($"清理临时文件失败: {ex.Message}");
            }
        }

        private Version? GetBaseMcVersion(string gameDir, string mcVersion)
        {
            var localVersionPath = Path.Combine(gameDir, "versions", mcVersion, $"{mcVersion}.json");
            Debug.WriteLine($"查找基础版本配置: {localVersionPath}");

            if (!File.Exists(localVersionPath))
            {
                Debug.WriteLine("基础版本配置文件不存在");
                return null;
            }

            try
            {
                string jsonContent = File.ReadAllText(localVersionPath);
                var version = new Version { Id = mcVersion };
                version.SetJson(jsonContent);
                return version;
            }
            catch (IOException ex)
            {
                Debug.WriteLine($"读取基础版本配置失败: {ex.Message}");
                return null;
            }
        }

        #region 数据模型

        public class OptiFineVersionInfo
        {
            public string? Type { get; set; }
            public string? Patch { get; set; }
            public string? FileName { get; set; }
            public string? McVersion { get; set; }
        }

        public class Version
        {
            public string? Id { get; set; }
            private string? _json;

            public void SetJson(string json) => _json = json;
            public string ToJson() => _json ?? "{}";
        }

        #endregion
    }
}
