using Qomicex.Launcher.Backend.Modules.Helpers.Resources;
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Threading.Tasks;
using static Qomicex.Launcher.Backend.Modules.Helpers.Installers.InstallerBase;

namespace Qomicex.Launcher.Backend.Modules.Helpers.Installers
{
    public class ForgeInstaller : ForgeInstallerBase, IInstaller
    {
        public ForgeInstaller(int sourceId, string gameDir, string gameVersion)
        {
            SourceId = sourceId;
            SourceMappings = new List<SourcesList>();
            if (sourceId == (int)DownloadSource.Bmclapi)
            {
                BaseUrl = "https://bmclapi2.bangbang93.com/maven";
                SourceMappings = new List<SourcesList>
                {
                    new SourcesList { Original = "https://maven.minecraftforge.net", Default = BaseUrl },
                    new SourcesList { Original = "https://files.minecraftforge.net/maven", Default = BaseUrl },
                    new SourcesList { Original = "https://libraries.minecraft.net", Default = BaseUrl }
                };
            }
            else
            {
                BaseUrl = "https://maven.minecraftforge.net";
            }
            this.gameDir = gameDir;
            this.gameVersion = gameVersion;
        }
        public async Task InstallAsync(string versionId, string inheritsFromJson, string? javaPath, string? forgeInstallerPath, string? para3, string? para4)
        {
            if (string.IsNullOrEmpty(javaPath))
                throw new ArgumentNullException(nameof(javaPath));
            if (string.IsNullOrEmpty(forgeInstallerPath))
                throw new ArgumentNullException(nameof(forgeInstallerPath));

            _installerPath = forgeInstallerPath;
            _mainJarPath = Path.Combine(this.gameDir, "versions", this.gameVersion, $"{this.gameVersion}.jar");
            if (IsLegacyForgeInstaller(forgeInstallerPath))
                await InstallLegacyForge(versionId, inheritsFromJson, javaPath, forgeInstallerPath);
            else
                await InstallForge(versionId, inheritsFromJson, javaPath, forgeInstallerPath);
        }

        private async Task InstallForge(string versionId, string inheritsFromJson, string javaPath, string forgeInstallerPath)
        {
            List<string> backFiles = new List<string>();
            List<string> backDirs = new List<string>();

            var jsonData = string.Empty;
            var installProfileData = string.Empty;
            byte[] clientLzma;
            try
            {
                jsonData = Encoding.UTF8.GetString(GeneralHelper.ReadSpecifyFileFromZip(forgeInstallerPath, "version.json"));
                installProfileData = Encoding.UTF8.GetString(GeneralHelper.ReadSpecifyFileFromZip(forgeInstallerPath, "install_profile.json"));
                clientLzma = GeneralHelper.ReadSpecifyFileFromZip(forgeInstallerPath, "data/client.lzma");

                if (string.IsNullOrEmpty(jsonData))
                    throw new FileLoadException("提取的version.json内容为空");
                if (string.IsNullOrEmpty(installProfileData))
                    throw new FileLoadException("提取的install_profile.json内容为空");
                if (clientLzma.Length == 0)
                    throw new FileLoadException("提取的client.lzma文件大小为0");
            }
            catch (Exception e)
            {
                throw new Exception("读取Forge安装器内容失败，请检查安装器文件是否正确", e);
            }

            var installProfileJson = JsonNode.Parse(installProfileData!)!.AsObject();

            try
            {
                string profileName = SafeGetString(installProfileJson["profile"]) ?? string.Empty;
                if (profileName != "forge")
                {
                    throw new Exception("安装器版本不正确，请检查安装器文件是否正确");
                }

                var forgeVersion = SafeGetString(installProfileJson["version"])?.Split("-")[2];

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
                    else
                    {
                        Debug.WriteLine("依赖版本JSON不存在，直接写出版本文件");
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
            }
            catch (Exception e)
            {
                throw new Exception("生成版本Json失败", e);
            }

            var lzmaDir = Path.Combine(this.gameDir, "libraries", "net", "minecraftforge", "forge", $"{this.gameVersion}-{versionId}");
            if (!Directory.Exists(lzmaDir))
            {
                Directory.CreateDirectory(lzmaDir);
                backDirs.Add(lzmaDir);
            }

            string clientLzmaPath = Path.Combine(lzmaDir, "client.lzma");
            backFiles.Add(clientLzmaPath);
            try
            {
                File.WriteAllBytes(clientLzmaPath, clientLzma);
            }
            catch (Exception ex)
            {
                BackInstall(backFiles, backDirs);
                throw new Exception($"写出LZMA失败: {ex.Message}");
            }

            string binPatchPath = $"\"{Path.Combine(this.gameDir, "libraries", "net", "minecraftforge", "forge", $"{this.gameVersion}-{versionId}", "client.lzma")}\"";
            Debug.WriteLine($"更新install_profile.json的BINPATCH路径为: {binPatchPath}");
            installProfileJson["data"]!["BINPATCH"]!["client"] = JsonValue.Create(binPatchPath);

            var jarMavenPath = MavenToPath(SafeGetString(installProfileJson["path"])!);
            var forgeJar = GeneralHelper.ReadSpecifyFileFromZip(forgeInstallerPath, $@"maven/{jarMavenPath}");
            var jarFullPath = Path.Combine(this.gameDir, "libraries", jarMavenPath);
            var jarDir = Path.GetDirectoryName(jarFullPath);

            if (!Directory.Exists(jarDir))
            {
                Directory.CreateDirectory(jarDir!);
                backDirs.Add(jarDir!);
            }

            backFiles.Add(jarFullPath);
            File.WriteAllBytes(jarFullPath, forgeJar);

            // ponytail: lib downloads handled externally by InstallTask Stage 7 (DownloadManager).
            // Here we only need to ensure processor-required libs exist.
            // Download them inline since processors will fail without them.
            var libs = GetMissForgeLibraries(forgeInstallerPath, versionId);
            Debug.WriteLine($"发现 {libs.Count} 个缺失的库文件");
            foreach (var lib in libs)
            {
                Debug.WriteLine($"下载库文件: {lib.Name} -> {lib.Path}");
                try
                {
                    await DownloadFileAsync(lib.Url, lib.Path);
                    Debug.WriteLine($"库文件 {lib.Name} 下载成功");
                }
                catch (Exception e)
                {
                    Debug.WriteLine($"下载库文件失败，触发回滚: {e.Message}");
                    BackInstall(backFiles, backDirs);
                    throw new Exception($"下载缺失的库文件失败: {lib.Path}\n{e.Message}");
                }
            }

            var processors = installProfileJson["processors"] as JsonArray;
            if (processors != null && processors.Count > 0)
            {
                Debug.WriteLine($"开始执行Processor后处理，共 {processors.Count} 个处理器");
                foreach (var processor in processors)
                {
                    var processorObj = (JsonObject)processor!;
                    string processorJar = SafeGetString(processorObj["jar"]) ?? "未知";
                    Debug.WriteLine($"处理Processor: {processorJar}");

                    if (processorObj["sides"] is JsonArray sidesArr && !sidesArr.Any(s => SafeGetString(s) == "client"))
                    {
                        Debug.WriteLine("该Processor为服务端专用，跳过执行");
                        continue;
                    }

                    try
                    {
                        await RunProcessor(installProfileJson, processorObj, versionId, this.gameDir, javaPath);
                        Debug.WriteLine($"Processor {processorJar} 执行成功");
                    }
                    catch (Exception ex)
                    {
                        BackInstall(backFiles, backDirs);
                        throw new Exception($"处理器执行失败: {processorJar}\n{ex.Message}");
                    }
                }
            }
            else
            {
                Debug.WriteLine("未找到processors节点，跳过Processor后处理");
            }

            Debug.WriteLine($"高版本Forge安装成功 - 版本ID: {versionId}");
        }
        private async Task InstallLegacyForge(string versionId, string inheritsFromJson, string javaPath, string forgeInstallerPath)
        {
            List<string> backFiles = new List<string>();
            List<string> backDirs = new List<string>();

            var jsonData = string.Empty;
            var installProfileData = string.Empty;
            try
            {
                jsonData = Encoding.UTF8.GetString(GeneralHelper.ReadSpecifyFileFromZip(forgeInstallerPath, "version.json"));
                installProfileData = Encoding.UTF8.GetString(GeneralHelper.ReadSpecifyFileFromZip(forgeInstallerPath, "install_profile.json"));

                if (string.IsNullOrEmpty(jsonData))
                    throw new FileLoadException("提取的version.json内容为空");
                if (string.IsNullOrEmpty(installProfileData))
                    throw new FileLoadException("提取的install_profile.json内容为空");
            }
            catch (Exception e)
            {
                throw new Exception("读取Forge安装器内容失败，请检查安装器文件是否正确", e);
            }

            var installProfileJson = JsonNode.Parse(installProfileData!)!.AsObject();

            try
            {
                string profileName = SafeGetString(installProfileJson["profile"]) ?? string.Empty;
                if (profileName != "forge")
                {
                    throw new Exception("安装器版本不正确，请检查安装器文件是否正确");
                }

                var forgeVersion = SafeGetString(installProfileJson["version"])?.Split("-")[2];

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
                    else
                    {
                        Debug.WriteLine("依赖版本JSON不存在，直接写出版本文件");
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
            }
            catch (Exception e)
            {
                throw new Exception("生成版本Json失败", e);
            }

            var jarMavenPath = MavenToPath(SafeGetString(installProfileJson["path"])!);
            var forgeJar = GeneralHelper.ReadSpecifyFileFromZip(forgeInstallerPath, $@"maven/{jarMavenPath}");
            var jarFullPath = Path.Combine(this.gameDir, "libraries", jarMavenPath);
            var jarDir = Path.GetDirectoryName(jarFullPath);

            if (!Directory.Exists(jarDir))
            {
                Directory.CreateDirectory(jarDir!);
                backDirs.Add(jarDir!);
            }

            backFiles.Add(jarFullPath);
            File.WriteAllBytes(jarFullPath, forgeJar);

            // ponytail: lib downloads moved to InstallTask Stage 7 (DownloadManager with progress)
            Debug.WriteLine($"旧版本Forge安装成功 - 版本ID: {versionId}");
        }
        public bool IsLegacyForgeInstaller(string forgeInstallerPath)
        {
            var installProfileData = string.Empty;
            try
            {
                installProfileData = Encoding.UTF8.GetString(GeneralHelper.ReadSpecifyFileFromZip(forgeInstallerPath, "install_profile.json"));
                if (string.IsNullOrEmpty(installProfileData))
                {
                    throw new Exception("install_profile.json内容为空");
                }
            }
            catch (Exception e)
            {
                throw new Exception("读取Forge安装器内容失败，请检查安装器文件是否正确", e);
            }

            try
            {
                var installProfileJson = JsonNode.Parse(installProfileData!)!.AsObject();
                string profileName = SafeGetString(installProfileJson["profile"]) ?? string.Empty;

                if (profileName != "forge")
                {
                    throw new Exception("安装器版本不正确，请检查安装器文件是否正确");
                }

                bool hasProcessors = installProfileJson.ContainsKey("processors") && installProfileJson["processors"]?.AsArray().Count > 0;
                return !hasProcessors;
            }
            catch (Exception e)
            {
                throw new Exception("获取安装器标识失败", e);
            }
        }

        private void BackInstall(List<string> files, List<string> dirs)
        {
            int deletedFileCount = 0;
            foreach (var file in files)
            {
                if (File.Exists(file))
                {
                    try
                    {
                        File.Delete(file);
                        Debug.WriteLine($"回滚删除文件: {file}");
                        deletedFileCount++;
                    }
                    catch (Exception e)
                    {
                        Debug.WriteLine($"回滚删除文件失败: {file}, 原因: {e.Message}");
                    }
                }
                else
                {
                    Debug.WriteLine($"回滚文件不存在，跳过: {file}");
                }
            }

            int deletedDirCount = 0;
            foreach (var dir in dirs)
            {
                if (Directory.Exists(dir))
                {
                    try
                    {
                        Directory.Delete(dir, true);
                        Debug.WriteLine($"回滚删除目录: {dir}");
                        deletedDirCount++;
                    }
                    catch (Exception e)
                    {
                        Debug.WriteLine($"回滚删除目录失败: {dir}, 原因: {e.Message}");
                    }
                }
                else
                {
                    Debug.WriteLine($"回滚目录不存在，跳过: {dir}");
                }
            }

            Debug.WriteLine($"回滚操作完成 - 成功删除 {deletedFileCount}/{files.Count} 个文件，{deletedDirCount}/{dirs.Count} 个目录");
        }

        public List<LocalResourceHelper.MissFileData> GetMissForgeLibraries(string forgeInstallerPath, string versionId)
        {
            var versionData = string.Empty;
            var installProfileData = string.Empty;
            try
            {
                versionData = Encoding.UTF8.GetString(GeneralHelper.ReadSpecifyFileFromZip(forgeInstallerPath, "version.json"));
                installProfileData = Encoding.UTF8.GetString(GeneralHelper.ReadSpecifyFileFromZip(forgeInstallerPath, "install_profile.json"));
            }
            catch
            {
                throw new Exception("读取Forge安装器内容失败，请检查安装器文件是否正确");
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
                        if (SourceId != 0)
                            url = ResolveUrl(lib.Url);
                        else url = lib.Url;
                    else
                        url = $"{BaseUrl}/{lib.Path}";

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
