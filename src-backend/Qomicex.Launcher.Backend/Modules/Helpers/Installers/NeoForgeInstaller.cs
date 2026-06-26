using Qomicex.Launcher.Backend.Modules.Helpers.Resources;
using System;
using System.Collections.Generic;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Threading.Tasks;

namespace Qomicex.Launcher.Backend.Modules.Helpers.Installers
{
    public class NeoForgeInstaller : ForgeInstallerBase, IInstaller
    {
        public NeoForgeInstaller(int sourceId, string gameDir, string gameVersion)
        {
            SourceId = sourceId;
            SourceMappings = new List<SourcesList>();
            if (sourceId == (int)DownloadSource.Bmclapi)
            {
                BaseUrl = "https://bmclapi2.bangbang93.com/maven";
                SourceMappings = new List<SourcesList>
                {
                    new SourcesList
                    {
                        Original = "https://maven.neoforged.net/releases/net/neoforged/forge",
                        Default = $"{BaseUrl}/net/neoforged/forge"
                    },
                    new SourcesList
                    {
                        Original = "https://maven.neoforged.net/releases/net/neoforged/neoforge",
                        Default = $"{BaseUrl}/net/neoforged/neoforge"
                    }
                };
            }
            else
            {
                BaseUrl = "https://maven.neoforged.net/releases";
            }
            this.gameDir = gameDir;
            this.gameVersion = gameVersion;
        }

        public async Task InstallAsync(string versionId, string inheritsFromJson, string? javaPath, string? neoForgeInstallerPath, string? para3, string? para4)
        {
            if (string.IsNullOrEmpty(javaPath))
                throw new ArgumentNullException(nameof(javaPath));
            if (string.IsNullOrEmpty(neoForgeInstallerPath))
                throw new ArgumentNullException(nameof(neoForgeInstallerPath));

            _installerPath = neoForgeInstallerPath;
            _mainJarPath = Path.Combine(this.gameDir, "versions", this.gameVersion, $"{this.gameVersion}.jar");
            await InstallNeoForge(versionId, inheritsFromJson, javaPath, neoForgeInstallerPath);
        }
        private async Task InstallNeoForge(string versionId, string inheritsFromJson, string javaPath, string neoForgeInstallerPath)
        {
            List<string> backFiles = new List<string>();
            List<string> backDirs = new List<string>();
            var jsonData = Encoding.UTF8.GetString(GeneralHelper.ReadSpecifyFileFromZip(neoForgeInstallerPath, "version.json"));
            var installProfileData = Encoding.UTF8.GetString(GeneralHelper.ReadSpecifyFileFromZip(neoForgeInstallerPath, "install_profile.json"));
            var clientLzma = GeneralHelper.ReadSpecifyFileFromZip(neoForgeInstallerPath, "data/client.lzma");
            var installProfileJson = JsonNode.Parse(installProfileData!)!.AsObject();
            string profileName = SafeGetString(installProfileJson["profile"]) ?? string.Empty;
            if (!string.Equals(profileName, "neoforge", StringComparison.OrdinalIgnoreCase)
                && !(gameVersion == "1.20.1" && string.Equals(profileName, "forge", StringComparison.OrdinalIgnoreCase)))
            {
                throw new Exception("安装器版本不正确，请检查安装器文件是否正确");
            }

            var versionData = JsonNode.Parse(jsonData!)!.AsObject();
            versionData["id"] = JsonValue.Create(versionId);
            versionData["inheritsFrom"] = JsonValue.Create(this.gameVersion);
            jsonData = versionData.ToJsonString();

            if (!string.IsNullOrEmpty(inheritsFromJson))
            {
                jsonData = MergeVersionJson(inheritsFromJson, jsonData, versionId);
            }
            else
            {
                string jsonPath = Path.Combine(this.gameDir, "versions", this.gameVersion, $"{this.gameVersion}.json");
                if (File.Exists(jsonPath))
                {
                    string inheritsFromVerData = File.ReadAllText(jsonPath);
                    jsonData = MergeVersionJson(inheritsFromVerData, jsonData, versionId);
                }
            }

            var versionDir = Path.Combine(this.gameDir, "versions", versionId);
            if (!Directory.Exists(versionDir))
            {
                Directory.CreateDirectory(versionDir);
                backDirs.Add(versionDir);
            }
            string targetJsonPath = Path.Combine(versionDir, $"{versionId}.json");
            File.WriteAllText(targetJsonPath, jsonData);
            backFiles.Add(targetJsonPath);

            var lzmaDir = Path.Combine(this.gameDir, "libraries", "net", "neoforged", "neoforge", $"{this.gameVersion}-{versionId}");
            if (!Directory.Exists(lzmaDir))
            {
                Directory.CreateDirectory(lzmaDir);
                backDirs.Add(lzmaDir);
            }
            string clientLzmaPath = Path.Combine(lzmaDir, "client.lzma");
            File.WriteAllBytes(clientLzmaPath, clientLzma);
            backFiles.Add(clientLzmaPath);

            installProfileJson["data"]!["BINPATCH"]!["client"] = JsonValue.Create($"\"{clientLzmaPath}\"");

            var libs = GetMissNeoForgeLibraries(neoForgeInstallerPath, versionId);
            foreach (var lib in libs)
            {
                await DownloadFileAsync(lib.Url, lib.Path);
            }

            var processors = installProfileJson["processors"] as JsonArray;
            if (processors != null && processors.Count > 0)
            {
                foreach (var processor in processors)
                {
                    await RunProcessor(installProfileJson, (JsonObject)processor!, versionId, this.gameDir, javaPath);
                }
            }


        }

        public List<LocalResourceHelper.MissFileData> GetMissNeoForgeLibraries(string neoForgeInstallerPath, string versionId)
        {
            var versionData = string.Empty;
            var installProfileData = string.Empty;
            try
            {
                versionData = Encoding.UTF8.GetString(GeneralHelper.ReadSpecifyFileFromZip(neoForgeInstallerPath, "version.json"));
                installProfileData = Encoding.UTF8.GetString(GeneralHelper.ReadSpecifyFileFromZip(neoForgeInstallerPath, "install_profile.json"));
            }
            catch
            {
                throw new Exception("读取NeoForge安装器内容失败，请检查安装器文件是否正确");
            }

            var libs = LocalResourceHelper.GetLibraries(installProfileData!);
            libs.AddRange(LocalResourceHelper.GetLibraries(versionData!));
            libs = LocalResourceHelper.CheckLibsVer(libs);

            var missFiles = new List<LocalResourceHelper.MissFileData>();
            foreach (var lib in libs)
            {
                var libPath = Path.Combine(this.gameDir, "libraries", lib.Path);
                if (!File.Exists(libPath))
                {
                    var url = string.Empty;
                    if (!string.IsNullOrEmpty(lib.Url))
                    {
                        if (SourceId != 0)
                            url = ResolveUrl(lib.Url);
                        else
                            url = lib.Url;
                    }
                    else
                    {
                        url = $"{BaseUrl}/{lib.Path}";
                    }

                    missFiles.Add(new LocalResourceHelper.MissFileData
                    {
                        Name = $"{lib.Name}-{lib.Version}.jar",
                        Path = libPath,
                        Url = url,
                        Sha1 = lib.Hash
                    });
                }
            }
            return missFiles;
        }

    }
}
