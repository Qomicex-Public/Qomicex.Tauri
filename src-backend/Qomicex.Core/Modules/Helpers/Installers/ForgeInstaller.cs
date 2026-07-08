using Newtonsoft.Json.Linq;
using Qomicex.Core.Modules.Helpers.Resources;
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Text;
using static Qomicex.Core.Modules.Helpers.Installers.InstallerBase;

namespace Qomicex.Core.Modules.Helpers.Installers
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
            await InstallAsyncTask(versionId, inheritsFromJson, javaPath, forgeInstallerPath, para3, para4);
        }

        public async Task InstallAsyncTask(string versionId, string inheritsFromJson, string? javaPath, string? forgeInstallerPath, string? para3, string? para4)
        {
            if (string.IsNullOrEmpty(javaPath))
                throw new ArgumentNullException(nameof(javaPath));
            if (string.IsNullOrEmpty(forgeInstallerPath))
                throw new ArgumentNullException(nameof(forgeInstallerPath));

            _installerPath = forgeInstallerPath;
            _mainJarPath = Path.Combine("versions", this.gameVersion, $"{this.gameVersion}.jar");
            if (IsLegacyForgeInstaller(forgeInstallerPath))
                await InstallLegacyForge(versionId, inheritsFromJson, javaPath, forgeInstallerPath);
            else
                await InstallForge(versionId, inheritsFromJson, javaPath, forgeInstallerPath);
            return;
        }

        private async Task InstallForge(string versionId, string inheritsFromJson, string javaPath, string forgeInstallerPath)
        {
            //初始化回滚列表
            List<string> backFiles = new List<string>();
            List<string> backDirs = new List<string>();

            //读取Forge安装器内容
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

            var installProfileJson = JObject.Parse(installProfileData!);

            //处理Json
            try
            {
                //检查安装器 - 新格式(spec)不检查profile字段；旧格式需要校验
                bool isSpecFormat = installProfileJson.ContainsKey("spec");
                if (!isSpecFormat)
                {
                    string profileName = installProfileJson["profile"]?.ToString() ?? string.Empty;
                    if (profileName != "forge")
                    {
                        throw new Exception("安装器版本不正确，请检查安装器文件是否正确");
                    }
                }

                var forgeVersion = installProfileJson["version"]?.ToString().Split("-")[2];

                //生成版本Json
                var versionData = JObject.Parse(jsonData!);
                versionData["id"] = versionId;
                versionData["inheritsFrom"] = this.gameVersion;
                jsonData = versionData.ToString();

                //合并版本Json
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
                        Trace.WriteLine("依赖版本JSON不存在，直接写出版本文件");
                    }
                }


                //写出版本Json
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

            //写出客户端LZMA
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
                //写入client.lzma文件: {clientLzmaPath}
                File.WriteAllBytes(clientLzmaPath, clientLzma);
            }
            catch (Exception ex)
            {
                BackInstall(backFiles, backDirs);
                throw new Exception($"写出LZMA失败: {ex.Message}");
            }

            //更新install_profile.json中的BINPATCH路径
            string binPatchPath = $"\"{Path.Combine(this.gameDir, "libraries", "net", "minecraftforge", "forge", $"{this.gameVersion}-{versionId}", "client.lzma")}\"";
            Trace.WriteLine($"更新install_profile.json的BINPATCH路径为: {binPatchPath}");
            installProfileJson["data"]!["BINPATCH"]!["client"] = binPatchPath;

            //解压Forge Jar
            //提取并写入Forge主Jar文件（新格式spec 2中path可能为null，由后续library下载补全）
            var pathToken = installProfileJson["path"];
            if (pathToken != null && !string.IsNullOrWhiteSpace(pathToken.ToString()))
            {
                var jarMavenPath = MavenToPath(pathToken.ToString());
                if (!string.IsNullOrWhiteSpace(jarMavenPath))
                {
                    var forgeJar = GeneralHelper.ReadSpecifyFileFromZip(forgeInstallerPath, $@"maven/{jarMavenPath}");
                    if (forgeJar.Length > 0)
                    {
                        var jarFullPath = Path.Combine(this.gameDir, "libraries", jarMavenPath);
                        var jarDir = Path.GetDirectoryName(jarFullPath);

                        if (!Directory.Exists(jarDir))
                        {
                            Directory.CreateDirectory(jarDir!);
                            backDirs.Add(jarDir!);
                        }

                        backFiles.Add(jarFullPath);
                        File.WriteAllBytes(jarFullPath, forgeJar);
                    }
                    else
                    {
                        Trace.WriteLine($"Forge主JAR在installer的maven/{jarMavenPath}不存在，跳过提取");
                    }
                }
            }
            else
            {
                Trace.WriteLine("Forge安装器path字段为空，跳过主JAR提取（新格式常见，库文件将通过下载补全）");
            }

            //新格式：从installer的maven/目录提取processor相关JAR
            foreach (var coord in ExtractMavenCoordinatesFromProcessors(installProfileJson))
            {
                var mavenPath = MavenToPath(coord);
                if (string.IsNullOrWhiteSpace(mavenPath)) continue;

                var destPath = Path.Combine(this.gameDir, "libraries", mavenPath);
                if (File.Exists(destPath)) continue;

                byte[] bytes;
                try
                {
                    bytes = GeneralHelper.ReadSpecifyFileFromZip(forgeInstallerPath, $@"maven/{mavenPath}");
                }
                catch (FileNotFoundException)
                {
                    Trace.WriteLine($"坐标 {coord} 不在安装器maven目录中，尝试从网络下载");
                    var downloadUrl = $"{BaseUrl}/{mavenPath}";
                    try
                    {
                        var destDir2 = Path.GetDirectoryName(destPath);
                        if (!Directory.Exists(destDir2))
                            Directory.CreateDirectory(destDir2!);
                        await DownloadFileAsync(downloadUrl, destPath);
                        Trace.WriteLine($"数据依赖下载成功: {coord}");
                    }
                    catch (Exception e)
                    {
                        BackInstall(backFiles, backDirs);
                        throw new Exception($"下载数据依赖失败: {coord}\n{e.Message}");
                    }
                    continue;
                }
                if (bytes.Length > 0)
                {
                    var destDir = Path.GetDirectoryName(destPath);
                    if (!Directory.Exists(destDir))
                    {
                        Directory.CreateDirectory(destDir!);
                    }
                    File.WriteAllBytes(destPath, bytes);
                    Trace.WriteLine($"从installer提取了processor依赖: {coord}");
                }
            }

            //下载缺失lib
            var libs = GetMissForgeLibraries(forgeInstallerPath, versionId);
            Trace.WriteLine($"发现 {libs.Count} 个缺失的库文件");
            foreach (var lib in libs)
            {
                Trace.WriteLine($"下载库文件: {lib.Name} -> {lib.Path}");
                try
                {
                    await DownloadFileAsync(lib.Url, lib.Path);
                    Trace.WriteLine($"库文件 {lib.Name} 下载成功");
                }
                catch (Exception e)
                {
                    Trace.WriteLine($"下载库文件失败，触发回滚: {e.Message}");
                    BackInstall(backFiles, backDirs);
                    throw new Exception($"下载缺失的库文件失败: {lib.Path}\n{e.Message}");
                }
            }

            //Processor后处理
            var processors = installProfileJson["processors"] as JArray;
            if (processors != null && processors.Count > 0)
            {
                Trace.WriteLine($"开始执行Processor后处理，共 {processors.Count} 个处理器");
                foreach (var processor in processors)
                {
                    var processorObj = (JObject)processor;
                    string processorJar = processorObj["jar"]?.ToString() ?? "未知";
                    Trace.WriteLine($"处理Processor: {processorJar}");

                    if (!ShouldRunProcessor(processorObj, "client"))
                    {
                        Trace.WriteLine("该Processor不适用于当前side=client，跳过执行");
                        continue;
                    }

                    try
                    {
                        await RunProcessor(installProfileJson, processorObj, versionId, this.gameDir, javaPath);
                        Trace.WriteLine($"Processor {processorJar} 执行成功");
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
                Trace.WriteLine("未找到processors节点，跳过Processor后处理");
            }

            Trace.WriteLine($"高版本Forge安装成功 - 版本ID: {versionId}");
        }
        private async Task InstallLegacyForge(string versionId, string inheritsFromJson, string javaPath, string forgeInstallerPath)
        {
            //初始化回滚列表
            List<string> backFiles = new List<string>();
            List<string> backDirs = new List<string>();

            //读取Forge安装器内容
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

            var installProfileJson = JObject.Parse(installProfileData!);

            //处理Json
            try
            {
                //检查安装器
                string profileName = installProfileJson["profile"]?.ToString() ?? string.Empty;
                if (profileName != "forge")
                {
                    throw new Exception("安装器版本不正确，请检查安装器文件是否正确");
                }

                var forgeVersion = installProfileJson["version"]?.ToString().Split("-")[2];

                //生成版本Json
                var versionData = JObject.Parse(jsonData!);
                versionData["id"] = versionId;
                versionData["inheritsFrom"] = this.gameVersion;
                jsonData = versionData.ToString();

                //合并版本Json
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
                        Trace.WriteLine("依赖版本JSON不存在，直接写出版本文件");
                    }
                }


                //写出版本Json
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

            //解压Forge Jar
            //提取并写入Forge主Jar文件（旧格式：path在install.path；通过filePath定位installer ZIP中的文件）
            var installSection = installProfileJson["install"] as JObject;
            var jarMavenPath = MavenToPath(installProfileJson["path"]?.ToString()!);
            if (string.IsNullOrWhiteSpace(jarMavenPath))
                jarMavenPath = MavenToPath(installSection?["path"]?.ToString()!);
            var filePath = installSection?["filePath"]?.ToString()
                ?? jarMavenPath.Split('/').LastOrDefault() ?? string.Empty;

            if (!string.IsNullOrWhiteSpace(jarMavenPath) && !string.IsNullOrWhiteSpace(filePath))
            {
                var forgeJar = GeneralHelper.ReadSpecifyFileFromZip(forgeInstallerPath, filePath);
                if (forgeJar.Length > 0)
                {
                    var jarFullPath = Path.Combine(this.gameDir, "libraries", jarMavenPath);
                    var jarDir = Path.GetDirectoryName(jarFullPath);

                    if (!Directory.Exists(jarDir))
                    {
                        Directory.CreateDirectory(jarDir!);
                        backDirs.Add(jarDir!);
                    }

                    backFiles.Add(jarFullPath);
                    File.WriteAllBytes(jarFullPath, forgeJar);
                }
            }

            //下载缺失lib
            var libs = GetMissForgeLibraries(forgeInstallerPath, versionId);
            Trace.WriteLine($"发现 {libs.Count} 个缺失的库文件");
            foreach (var lib in libs)
            {
                Trace.WriteLine($"下载库文件: {lib.Name} -> {lib.Path}");
                try
                {
                    await DownloadFileAsync(lib.Url, lib.Path);
                    Trace.WriteLine($"库文件 {lib.Name} 下载成功");
                }
                catch (Exception e)
                {
                    Trace.WriteLine($"下载库文件失败，触发回滚: {e.Message}");
                    BackInstall(backFiles, backDirs);
                    throw new Exception($"下载缺失的库文件失败: {lib.Path}\n{e.Message}");
                }
            }
            Trace.WriteLine($"旧版本Forge安装成功 - 版本ID: {versionId}");
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
                var installProfileJson = JObject.Parse(installProfileData!);

                // spec 2 必须有 "spec" 字段
                if (installProfileJson.ContainsKey("spec"))
                {
                    return false;
                }

                // spec 1 必须有 "install" 和 "versionInfo"（旧格式特征）
                if (installProfileJson.ContainsKey("install") && installProfileJson.ContainsKey("versionInfo"))
                {
                    return true;
                }

                // 进一步判断：data/client.lzma 只在新版（spec 2）中存在
                try
                {
                    var lzma = GeneralHelper.ReadSpecifyFileFromZip(forgeInstallerPath, "data/client.lzma");
                    if (lzma.Length > 0)
                        return false; // 有 client.lzma → spec 2
                }
                catch (FileNotFoundException)
                {
                    // 无 client.lzma → 旧版
                }

                // 最终 fallback：检查 install 节点中 path 字段（spec 1 指向 JAR 文件，spec 2 可能缺失）
                var installPath = installProfileJson["install"]?["path"]?.ToString();
                if (!string.IsNullOrEmpty(installPath))
                    return true;

                // 假旧版（最保守策略）
                return true;
            }
            catch (Exception e)
            {
                throw new Exception("获取安装器标识失败", e);
            }
        }

        private void BackInstall(List<string> files, List<string> dirs)
        {
            //删除文件,回滚安装
            int deletedFileCount = 0;
            foreach (var file in files)
            {
                if (File.Exists(file))
                {
                    try
                    {
                        File.Delete(file);
                        Trace.WriteLine($"回滚删除文件: {file}");
                        deletedFileCount++;
                    }
                    catch (Exception e)
                    {
                        Trace.WriteLine($"回滚删除文件失败: {file}, 原因: {e.Message}");
                    }
                }
                else
                {
                    Trace.WriteLine($"回滚文件不存在，跳过: {file}");
                }
            }

            //删除目录
            int deletedDirCount = 0;
            foreach (var dir in dirs)
            {
                if (Directory.Exists(dir))
                {
                    try
                    {
                        Directory.Delete(dir, true);
                        Trace.WriteLine($"回滚删除目录: {dir}");
                        deletedDirCount++;
                    }
                    catch (Exception e)
                    {
                        Trace.WriteLine($"回滚删除目录失败: {dir}, 原因: {e.Message}");
                    }
                }
                else
                {
                    Trace.WriteLine($"回滚目录不存在，跳过: {dir}");
                }
            }

            Trace.WriteLine($"回滚操作完成 - 成功删除 {deletedFileCount}/{files.Count} 个文件，{deletedDirCount}/{dirs.Count} 个目录");
        }

        /// <summary>
        /// 获取缺失的 Forge 库文件列表
        /// </summary>
        /// <param name="forgeInstallerPath">Forge安装器路径</param>
        /// <param name="versionId">版本ID</param>
        /// <returns></returns>
        /// <exception cref="Exception"></exception>
        public List<LocalResourceHelper.MissFileData> GetMissForgeLibraries(string forgeInstallerPath, string versionId)
        {
            //读取Forge安装器内容
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


            //获取缺失 libs
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
