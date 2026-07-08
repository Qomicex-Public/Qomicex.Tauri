using Newtonsoft.Json;
using Newtonsoft.Json.Linq;
using Qomicex.Core.Modules.Helpers.Resources;
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Net.Http;
using System.Text;
using System.Threading.Tasks;

namespace Qomicex.Core.Modules.Helpers.Installers
{
    public class FabricInstaller : InstallerBase, IInstaller
    {
        private string _downloadSource = "https://meta.fabricmc.net/";
        private string _gameDir = string.Empty;
        public FabricInstaller(int downloadSource, string gameDir)
        {
            if (downloadSource == (int)DownloadSource.Bmclapi)
            {
                _downloadSource = "https://bmclapi2.bangbang93.com/fabric-meta/";
            }
            else
            {
                _downloadSource = "https://meta.fabricmc.net/";
            }
            _gameDir = gameDir;
        }
        /// <summary>
        /// 为指定的游戏版本和整合包标识符安装指定版本的 Fabric 模组加载器。
        /// </summary>
        /// <param name="versionId">要安装 Fabric 的整合包或实例的唯一标识符。不能为空。</param>
        /// <param name="inheritsFromJson">继承自版本的JSON内容。可为空，为空时尝试从游戏目录读取。</param>
        /// <param name="fabricVersion">要安装的 Fabric 模组加载器版本。必须是有效的 Fabric 版本字符串。</param>
        /// <param name="gameVersion">Fabric 应安装的游戏版本。必须是受支持的游戏版本。</param>
        /// <param name="installerFilePath">Fabric 安装无需填写此参数，可传入 <see langword="null"/>。</param>
        /// <param name="javaPath">Fabric 安装无需填写此参数，可传入 <see langword="null"/>。</param>
        public async Task InstallAsync(string versionId, string inheritsFromJson, string? fabricVersion, string? gameVersion, string? para3, string? para4)
        {
            if (fabricVersion == null) throw new ArgumentNullException(nameof(fabricVersion));
            if (gameVersion == null) throw new ArgumentNullException(nameof(gameVersion));
            await InstallFabricAsync(versionId, fabricVersion, gameVersion, inheritsFromJson);
        }

        /// <summary>
        /// 异步安装 Fabric Loader
        /// </summary>
        /// <param name="versionId">生成的版本ID</param>
        /// <param name="fabricVersion">欲安装的Fabric版本</param>
        /// <param name="gameVersion">原版游戏版本</param>
        /// <param name="inheritsFromJson">继承自版本的JSON内容，可为空</param>
        /// <returns>是否成功</returns>
        public async Task<bool> InstallFabricAsync(string versionId, string fabricVersion, string gameVersion, string? inheritsFromJson = null)
        {
            try
            {
                var jsonData = await BuildJson(versionId, fabricVersion, gameVersion, _gameDir);
                if (string.IsNullOrEmpty(jsonData))
                {
                    throw new Exception("构建JSON数据失败");
                }
                var versionDir = $"{_gameDir}/versions/{versionId}";
                if (!Directory.Exists(versionDir))
                {
                    Directory.CreateDirectory(versionDir);
                }
                if (!string.IsNullOrEmpty(inheritsFromJson))
                {
                    jsonData = MergeVersionJson(inheritsFromJson, jsonData, versionId);
                }
                else if (File.Exists(Path.Combine(_gameDir, "versions", gameVersion, $"{gameVersion}.json")))
                {
                    var mainVersionJson = await File.ReadAllTextAsync(Path.Combine(_gameDir, "versions", gameVersion, $"{gameVersion}.json"));
                    jsonData = MergeVersionJson(mainVersionJson, jsonData, versionId);
                }
                else
                {
                    throw new Exception("主版本JSON文件不存在");
                }
                await File.WriteAllTextAsync(Path.Combine(_gameDir, "versions", versionId, $"{versionId}.json"), jsonData);
                return true;
            }
            catch (Exception ex)
            {
                throw new Exception($"安装Fabric失败: {ex.Message}");
            }
        }


        private async Task<string> BuildJson(string versionId, string fabricVersion, string gameVersion, string gameDir)
        {
            try
            {
                using HttpClient client = new HttpClient();

                var result = await client.GetAsync($"{_downloadSource}v2/versions/loader/{gameVersion}/{fabricVersion}/profile/json");
                var metaStr = string.Empty;
                if (result.IsSuccessStatusCode)
                {
                    metaStr = await result.Content.ReadAsStringAsync();
                }
                else
                {
                    throw new Exception("获取Launcher Meta失败");
                }
                var meta = JObject.Parse(metaStr);


                // 下载 libraries
                var libs = meta["libraries"] as JArray;
                if (libs != null)
                {
                    foreach (var lib in libs)
                    {
                        Trace.WriteLine($"下载库文件:{lib["name"]}");
                        var urlDomain = _downloadSource;
                        if (!string.IsNullOrEmpty(lib["url"]?.ToString()!))
                        {
                            urlDomain = lib["url"]?.ToString()!;
                        }
                        try { await DownloadFileAsync($"{urlDomain}{MavenToPath(lib["name"]?.ToString()!)}", $"{gameDir}/libraries/{MavenToPath(lib["name"]?.ToString()!)}"); }
                        catch (Exception ex)
                        {
                            throw new Exception($"下载库文件失败: {lib["name"]}\n{ex.Message}");
                        }
                    }
                }

                meta["id"] = versionId;

                return meta.ToString(Formatting.Indented);
            }
            catch (Exception ex)
            {
                throw new Exception($"构建JSON数据失败: {ex.Message}");
            }

        }

        public async Task<List<LocalResourceHelper.MissFileData>> GetMissFabricLibraries(string fabricVersion, string gameVersion, string gameDir)
        {
            var missFiles = new List<LocalResourceHelper.MissFileData>();

            try
            {
                using HttpClient client = new HttpClient();

                var result = await client.GetAsync($"{_downloadSource}v2/versions/loader/{gameVersion}/{fabricVersion}/profile/json");
                var metaStr = string.Empty;
                if (result.IsSuccessStatusCode)
                {
                    metaStr = await result.Content.ReadAsStringAsync();
                }
                else
                {
                    throw new Exception("获取Launcher Meta失败");
                }
                var meta = JObject.Parse(metaStr);

                var libs = meta["libraries"] as JArray;
                if (libs != null)
                {
                    foreach (var lib in libs)
                    {
                        Trace.WriteLine($"下载库文件:{lib["name"]}");
                        var urlDomain = _downloadSource;
                        if (!string.IsNullOrEmpty(lib["url"]?.ToString()!))
                        {
                            urlDomain = lib["url"]?.ToString()!;
                        }
                        missFiles.Add(new LocalResourceHelper.MissFileData
                        {
                            Name = lib["name"]?.ToString()!,
                            Path = $"{gameDir}/libraries/{MavenToPath(lib["name"]?.ToString()!)}",
                            Url = $"{urlDomain}{MavenToPath(lib["name"]?.ToString()!)}",
                            Sha1 = lib["sha1"]?.ToString()!
                        });
                    }
                }
                return missFiles;
            }
            catch (Exception ex)
            {
                throw new Exception($"获取缺失Fabric库文件失败: {ex.Message}");
            }
            
        }

        public class Library
        {
            public string? Name { get; set; }
            public string? Url { get; set; }

            // 可选字段（根据 Fabric metadata）
            public string? Sha1 { get; set; }
            public string? Sha256 { get; set; }
            public string? Sha512 { get; set; }
            public string? Md5 { get; set; }
            public long? Size { get; set; }
        }
    }
}
