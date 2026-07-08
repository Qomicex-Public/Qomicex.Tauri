using Newtonsoft.Json.Linq;
using Qomicex.Core.Modules.Helpers.Resources;
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Text;

namespace Qomicex.Core.Modules.Helpers.Installers
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
            await InstallAsyncTask(versionId, inheritsFromJson, javaPath, neoForgeInstallerPath, para3, para4);
        }

        public async Task InstallAsyncTask(string versionId, string inheritsFromJson, string? javaPath, string? neoForgeInstallerPath, string? para3, string? para4)
        {
            if (string.IsNullOrEmpty(javaPath))
                throw new ArgumentNullException(nameof(javaPath));
            if (string.IsNullOrEmpty(neoForgeInstallerPath))
                throw new ArgumentNullException(nameof(neoForgeInstallerPath));

            _installerPath = neoForgeInstallerPath;
            _mainJarPath = Path.Combine("versions", this.gameVersion, $"{this.gameVersion}.jar");
            await InstallNeoForge(versionId, inheritsFromJson, javaPath, neoForgeInstallerPath);
            return;
        }

        private async Task InstallNeoForge(string versionId, string inheritsFromJson, string javaPath, string neoForgeInstallerPath)
        {
            List<string> backFiles = new List<string>();
            List<string> backDirs = new List<string>();
            string jsonData;
            string installProfileData;
            byte[] clientLzma;
            try
            {
                jsonData = Encoding.UTF8.GetString(GeneralHelper.ReadSpecifyFileFromZip(neoForgeInstallerPath, "version.json"));
                installProfileData = Encoding.UTF8.GetString(GeneralHelper.ReadSpecifyFileFromZip(neoForgeInstallerPath, "install_profile.json"));
                clientLzma = GeneralHelper.ReadSpecifyFileFromZip(neoForgeInstallerPath, "data/client.lzma");
            }
            catch (Exception ex)
            {
                throw new Exception("读取NeoForge安装器内容失败，请检查安装器文件是否正确", ex);
            }

            var installProfileJson = JObject.Parse(installProfileData!);
            string profileName = installProfileJson["profile"]?.ToString().ToLower() ?? string.Empty;
            if (profileName != "neoforge" && !(gameVersion == "1.20.1" && profileName == "forge"))
            {
                throw new Exception("安装器版本不正确，请检查安装器文件是否正确");
            }

            // 修改 version.json
            var versionData = JObject.Parse(jsonData!);
            versionData["id"] = versionId;
            versionData["inheritsFrom"] = this.gameVersion;
            jsonData = versionData.ToString();

            // 合并版本 JSON
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

            // 写出版本 JSON
            var versionDir = Path.Combine(this.gameDir, "versions", versionId);
            if (!Directory.Exists(versionDir))
            {
                Directory.CreateDirectory(versionDir);
                backDirs.Add(versionDir);
            }
            string targetJsonPath = Path.Combine(versionDir, $"{versionId}.json");
            try
            {
                File.WriteAllText(targetJsonPath, jsonData);
            }
            catch (Exception ex)
            {
                BackInstall(backFiles, backDirs);
                throw new Exception($"写出NeoForge版本Json失败: {ex.Message}", ex);
            }
            backFiles.Add(targetJsonPath);

            // 写出 client.lzma
            var lzmaDir = Path.Combine(this.gameDir, "libraries", "net", "neoforged", "neoforge", versionId);
            if (!Directory.Exists(lzmaDir))
            {
                Directory.CreateDirectory(lzmaDir);
                backDirs.Add(lzmaDir);
            }
            string clientLzmaPath = Path.Combine(lzmaDir, "client.lzma");
            try
            {
                File.WriteAllBytes(clientLzmaPath, clientLzma);
            }
            catch (Exception ex)
            {
                BackInstall(backFiles, backDirs);
                throw new Exception($"写出NeoForge LZMA失败: {ex.Message}", ex);
            }
            backFiles.Add(clientLzmaPath);

            // 更新 BINPATCH
            installProfileJson["data"]!["BINPATCH"]!["client"] = $"\"{clientLzmaPath}\"";

            // 下载缺失库
            var libs = GetMissNeoForgeLibraries(neoForgeInstallerPath, versionId);
            foreach (var lib in libs)
            {
                try
                {
                    await DownloadFileAsync(lib.Url, lib.Path);
                }
                catch (Exception ex)
                {
                    BackInstall(backFiles, backDirs);
                    throw new Exception($"下载NeoForge缺失库失败: {lib.Path}\n{ex.Message}", ex);
                }
            }

            // 执行 processors
            var processors = installProfileJson["processors"] as JArray;
            if (processors != null && processors.Count > 0)
            {
                foreach (var processor in processors)
                {
                    var processorObject = (JObject)processor;
                    if (!ShouldRunProcessor(processorObject, "client"))
                    {
                        continue;
                    }

                    try
                    {
                        await RunProcessor(installProfileJson, processorObject, versionId, this.gameDir, javaPath);
                    }
                    catch (Exception ex)
                    {
                        BackInstall(backFiles, backDirs);
                        throw new Exception($"处理NeoForge处理器失败: {processorObject["jar"]}\n{ex.Message}", ex);
                    }
                }
            }


        }

        /// <summary>
        /// 获取缺失的 NeoForge 库文件列表
        /// </summary>
        /// <param name="neoForgeInstallerPath">NeoForge 安装器路径</param>
        /// <param name="versionId">版本ID</param>
        /// <returns>缺失库文件列表</returns>
        public List<LocalResourceHelper.MissFileData> GetMissNeoForgeLibraries(string neoForgeInstallerPath, string versionId)
        {
            // 读取安装器内容
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

            // 获取缺失 libs
            var libs = LocalResourceHelper.GetLibraries(installProfileData!);
            libs.AddRange(LocalResourceHelper.GetLibraries(versionData!));
            foreach (var coordinate in ExtractMavenCoordinatesFromProcessors(JObject.Parse(installProfileData!)))
            {
                libs.Add(new LocalResourceHelper.LibInfo { FullName = coordinate });
            }
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

        private void BackInstall(List<string> files, List<string> dirs)
        {
            int deletedFileCount = 0;
            int deletedDirCount = 0;

            for (int i = files.Count - 1; i >= 0; i--)
            {
                string file = files[i];
                try
                {
                    if (File.Exists(file))
                    {
                        File.Delete(file);
                        Trace.WriteLine($"回滚删除文件: {file}");
                        deletedFileCount++;
                    }
                }
                catch (Exception e)
                {
                    Trace.WriteLine($"回滚删除文件失败: {file}, 原因: {e.Message}");
                }
            }

            var dirList = new List<string>();
            foreach (var dir in dirs)
            {
                if (!dirList.Contains(dir))
                    dirList.Add(dir);
            }

            dirList.Sort((a, b) => b.Length.CompareTo(a.Length));

            foreach (var dir in dirList)
            {
                try
                {
                    if (Directory.Exists(dir) && !Directory.EnumerateFileSystemEntries(dir).Any())
                    {
                        Directory.Delete(dir, false);
                        Trace.WriteLine($"回滚删除目录: {dir}");
                        deletedDirCount++;
                    }
                }
                catch (Exception e)
                {
                    Trace.WriteLine($"回滚删除目录失败: {dir}, 原因: {e.Message}");
                }
            }

            Trace.WriteLine($"回滚操作完成 - 成功删除 {deletedFileCount}/{files.Count} 个文件，{deletedDirCount}/{dirs.Count} 个目录");
        }

    }
}
