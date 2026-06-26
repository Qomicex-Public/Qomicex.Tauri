using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Net.Http;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Threading.Tasks;

namespace Qomicex.Launcher.Backend.Modules.Helpers.Installers
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

        public async Task InstallAsync(string versionId, string inheritsFromJson, string? fabricVersion, string? gameVersion, string? para3, string? para4)
        {
            if (fabricVersion == null) throw new ArgumentNullException(nameof(fabricVersion));
            if (gameVersion == null) throw new ArgumentNullException(nameof(gameVersion));
            await InstallFabricAsync(versionId, fabricVersion, gameVersion, inheritsFromJson);
        }

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
                else if (File.Exists($"{_gameDir}/versions/{gameVersion}/{gameVersion}.json"))
                {
                    var mainVersionJson = await File.ReadAllTextAsync($"{_gameDir}/versions/{gameVersion}/{gameVersion}.json");
                    jsonData = MergeVersionJson(mainVersionJson, jsonData, versionId);
                }
                else
                {
                    throw new Exception("主版本JSON文件不存在");
                }
                await File.WriteAllTextAsync($"{_gameDir}/versions/{versionId}/{versionId}.json", jsonData);
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
                var meta = JsonNode.Parse(metaStr)!.AsObject();


                var libs = meta["libraries"] as JsonArray;
                if (libs != null)
                {
                    foreach (var lib in libs)
                    {
                        Debug.WriteLine($"下载库文件:{lib!["name"]}");
                        var urlDomain = _downloadSource;
                        if (!string.IsNullOrEmpty(lib!["url"]?.GetValue<string>()))
                        {
                            urlDomain = lib["url"]?.GetValue<string>()!;
                        }
                        try { await DownloadFileAsync($"{urlDomain}{MavenToPath(lib!["name"]?.GetValue<string>()!)}", $"{gameDir}/libraries/{MavenToPath(lib["name"]?.GetValue<string>()!)}"); }
                        catch (Exception ex)
                        {
                            throw new Exception($"下载库文件失败: {lib["name"]}\n{ex.Message}");
                        }
                    }
                }

                meta["id"] = JsonValue.Create(versionId);

                return meta.ToJsonString(new JsonSerializerOptions { WriteIndented = true });
            }
            catch (Exception ex)
            {
                throw new Exception($"构建JSON数据失败: {ex.Message}");
            }

        }


        public class Library
        {
            public string? Name { get; set; }
            public string? Url { get; set; }

            public string? Sha1 { get; set; }
            public string? Sha256 { get; set; }
            public string? Sha512 { get; set; }
            public string? Md5 { get; set; }
            public long? Size { get; set; }
        }
    }
}
