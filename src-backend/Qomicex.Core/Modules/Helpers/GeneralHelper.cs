using Newtonsoft.Json.Linq;
using System;
using System.Collections;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO.Compression;
using System.Runtime.ConstrainedExecution;
using System.Security.Cryptography;
using System.Text;
using static Qomicex.Core.DataModules;
using static System.Runtime.InteropServices.JavaScript.JSType;

namespace Qomicex.Core.Modules.Helpers
{
    public class GeneralHelper
    {
        public List<LoaderInfo> GetModLoaderType(string Version, string GameDir) //添加异步因为Json解析可能会比较耗时
        {
            List<LoaderInfo> types = new List<LoaderInfo>();
            string jsonPath = Path.Combine(GameDir, "versions", Version, $"{Version}.json");
            string jsonContent = string.Empty;

            bool OptiFineFound = false;
            bool LiteLoaderFound = false;
            bool ForgeFound = false;
            bool NeoForgeFound = false;
            bool FabricFound = false;
            bool QuiltFound = false;

            if (File.Exists(jsonPath))
            {
                jsonContent = File.ReadAllText(jsonPath);
            }
            else
            {
                throw new FileNotFoundException($"Version file not found: {jsonPath}");
            }

            JObject data = JObject.Parse(jsonContent);
            if (data == null)
            {
                throw new FileLoadException("Invalid Json file");
            }

            if (!data.TryGetValue("libraries", out var librariesToken) || !(librariesToken is JArray libraries))
            {
                throw new Exception("libraries字段不存在或格式错误");
            }

            //通过libraries字段获取mod加载器类型
            if (data.ContainsKey("libraries"))
            {
                foreach (var library in libraries)
                {
                    var obj = library as JObject;
                    if (obj != null && obj.ContainsKey("name"))
                    {
                        string name = obj["name"]?.ToString().ToLower() ?? string.Empty;
                        if (name != null)
                        {
                            //识别OptiFine
                            if (name.Contains("optifine"))
                            {
                                var nameParts = name.Split(':');
                                if (nameParts.Length == 3)
                                {
                                    if (nameParts[1] == "optifine")
                                    {
                                        OptiFineFound = true;
                                        string ver = string.Empty;
                                        if (nameParts[2].Contains('-'))
                                        {
                                            var verParts = nameParts[2].Split('-');
                                            if (verParts.Length == 2)
                                            {
                                                ver = verParts[1];
                                            }
                                            else
                                                ver = nameParts[2];
                                        }
                                        else
                                            ver = nameParts[2];
                                        types.Add(new LoaderInfo { Type = "OptiFine", Version = ver });
                                    }
                                }
                            }
                            //识别LiteLoader
                            if (name.Contains("liteloader"))
                            {
                                var nameParts = name.Split(':');
                                if (nameParts.Length == 3)
                                {
                                    if (nameParts[1] == "liteloader")
                                    {
                                        LiteLoaderFound = true;
                                        string ver = string.Empty;
                                        if (nameParts[2].Contains('-'))
                                        {
                                            var verParts = nameParts[2].Split('-');
                                            if (verParts.Length == 2)
                                            {
                                                ver = verParts[1];
                                            }
                                            else
                                                ver = nameParts[2];
                                        }
                                        else
                                            ver = nameParts[2];
                                        types.Add(new LoaderInfo { Type = "LiteLoader", Version = ver });
                                    }
                                }
                            }
                            //识别旧版本Forge
                            if (name.Contains("forge"))
                            {
                                var nameParts = name.Split(':');
                                if (nameParts.Length == 3)
                                {
                                    if (nameParts[1] == "forge")
                                    {
                                        ForgeFound = true;
                                        string ver = string.Empty;
                                        if (nameParts[2].Contains('-'))
                                        {
                                            var verParts = nameParts[2].Split('-');
                                            if (verParts.Length == 2)
                                            {
                                                ver = verParts[1];
                                            }
                                            else
                                                ver = nameParts[2];
                                        }
                                        else
                                            ver = nameParts[2];
                                        //types.Add($"Forge {ver}");
                                        types.Add(new LoaderInfo { Type = "Forge", Version = ver });
                                    }
                                }
                            }
                            //识别新版本Forge
                            if (name.Contains("minecraftforge"))
                            {
                                var nameParts = name.Split(':');
                                if (nameParts.Length == 3)
                                {
                                    if (nameParts[1] == "fmlloader")
                                    {
                                        ForgeFound = true;
                                        string ver = string.Empty;
                                        if (nameParts[2].Contains('-'))
                                        {
                                            var verParts = nameParts[2].Split('-');
                                            if (verParts.Length == 2)
                                            {
                                                ver = verParts[1];
                                            }
                                            else
                                                ver = nameParts[2];
                                        }
                                        else
                                            ver = nameParts[2];
                                        //types.Add($"Forge {ver}");
                                        types.Add(new LoaderInfo { Type = "Forge", Version = ver });
                                    }
                                }
                            }
                            //识别Fabric
                            if (name.Contains("fabric"))
                            {
                                var nameParts = name.Split(':');
                                if (nameParts.Length == 3)
                                {
                                    if (nameParts[1] == "fabric" || nameParts[1] == "fabric-loader")
                                    {
                                        FabricFound = true;
                                        /*string ver = string.Empty;
                                        if (nameParts[2].Contains('-'))
                                        {
                                            var verParts = nameParts[2].Split('-');
                                            if (verParts.Length == 2)
                                            {
                                                ver = verParts[1];
                                            }
                                            else
                                                ver = nameParts[2];
                                        }
                                        else
                                            ver = nameParts[2];
                                        types.Add($"Fabric {ver}");*/
                                        //types.Add($"Fabric {nameParts[2]}");
                                        types.Add(new LoaderInfo { Type = "Fabric", Version = nameParts[2] });
                                    }
                                }
                            }
                            //识别Quilt
                            if (name.Contains("quilt"))
                            {
                                var nameParts = name.Split(':');
                                if (nameParts.Length == 3)
                                {
                                    if (nameParts[1] == "quilt" || nameParts[1] == "quilt-loader")
                                    {
                                        QuiltFound = true;
                                        //types.Add($"Quilt {nameParts[2]}");
                                        types.Add(new LoaderInfo { Type = "Quilt", Version = nameParts[2] });
                                    }
                                }
                            }
                        }
                    }
                }
            }

            //虽然还不判断mainClass，但后面要用，所以先获取
            string mainClass = data["mainClass"]?.ToString().ToLower() ?? string.Empty;

            //当Libraries字段中没有找到任何mod加载器时，尝试从arguments参数中获取
            if (data.ContainsKey("arguments"))
            {
                var argData = (JObject)data["arguments"]!;
                if (argData!.ContainsKey("game"))
                {
                    JArray? gameList = argData["game"] as JArray;

                    for (int i = 0; i < gameList!.Count; i++)
                    {
                        var item = gameList[i];
                        if (item.Type == JTokenType.String)
                        {
                            string value = item.ToString();
                            //识别NeoForge
                            if (value == "--fml.neoForgeVersion")
                            {
                                // 获取下一个元素作为版本号
                                if (i + 1 < gameList.Count && gameList[i + 1].Type == JTokenType.String)
                                {
                                    string ver = gameList[i + 1].ToString();
                                    //types.Add($"NeoForge {ver}");
                                    types.Add(new LoaderInfo { Type = "NeoForge", Version = ver });
                                    NeoForgeFound = true;
                                }
                                else
                                {
                                    //types.Add("NeoForge");
                                    types.Add(new LoaderInfo { Type = "NeoForge" });
                                    NeoForgeFound = true;
                                }
                            }
                            if (value == "--fml.forgeVersion")
                            {
                                if (!(NeoForgeFound || ForgeFound) && mainClass == "cpw.mods.bootstraplauncher.bootstraplauncher")
                                {
                                    // 获取下一个元素作为版本号
                                    if (i + 1 < gameList.Count && gameList[i + 1].Type == JTokenType.String)
                                    {
                                        string ver = gameList[i + 1].ToString();
                                        //types.Add($"NeoForge {ver}");
                                        types.Add(new LoaderInfo { Type = "NeoForge", Version = ver });
                                        NeoForgeFound = true;
                                    }
                                    else
                                    {
                                        //types.Add("NeoForge");
                                        types.Add(new LoaderInfo { Type = "NeoForge" });
                                        NeoForgeFound = true;
                                    }
                                }
                            }
                        }
                    }
                }
            }

            // 如果没有找到任何mod加载器类型，则判断MainClass

            if (mainClass == "net.minecraft.client.main.main")
            {
                return new List<LoaderInfo> { new LoaderInfo { Type = "Vanilla" } };
            }
            if (!QuiltFound && mainClass == "org.quiltmc.loader.impl.launch.knot.knotclient")
            {
                QuiltFound = true;
                //types.Add("Quilt");
                types.Add(new LoaderInfo { Type = "Quilt" });
            }
            if (!(NeoForgeFound || ForgeFound) && mainClass == "cpw.mods.bootstraplauncher.bootstraplauncher")
            {
                NeoForgeFound = true;
                //types.Add("NeoForge");
                types.Add(new LoaderInfo { Type = "NeoForge" });
            }
            if (!FabricFound && mainClass == "net.fabricmc.loader.impl.launch.knot.knotclient")
            {
                FabricFound = true;
                //types.Add("Fabric");
                types.Add(new LoaderInfo { Type = "Fabric" });
            }
            if (!ForgeFound && mainClass == "net.minecraftforge.bootstrap.bootstraplauncher")
            {
                ForgeFound = true;
                //types.Add("Forge");
                types.Add(new LoaderInfo { Type = "Forge" });
            }

            if (!(OptiFineFound || ForgeFound || NeoForgeFound || LiteLoaderFound || FabricFound || QuiltFound))
            {
                if (mainClass == "net.minecraft.launchwrapper.Launch")
                {
                    return new List<LoaderInfo> { new LoaderInfo { Type = "Vanilla" } };
                }
            }
            if (types.Count == 0)
            {
                return new List<LoaderInfo> { new LoaderInfo { Type = "Unknown" } };
            }
            return types;
        }

        public string GetVanillaVersion(string Version, string GameDir)
        {
            //从jar读版本
            var version = GameVersion.FromJar(Path.Combine(GameDir, "versions", Version, $"{Version}.jar"));
            if (version != null)
                return version;

            //读json
            string jsonPath = Path.Combine(GameDir, "versions", Version, $"{Version}.json");
            if (!File.Exists(jsonPath))
                return "Unknown";

            var jsonData = File.ReadAllText(jsonPath);
            var jsonObj = JObject.Parse(jsonData);

            // inheritsFrom 递归（Fabric / 旧Forge / OptiFine）
            var inheritsFrom = jsonObj["inheritsFrom"]?.ToString();
            if (!string.IsNullOrEmpty(inheritsFrom))
                return GetVanillaVersion(inheritsFrom, GameDir);

            // --fml.mcVersion（新版Forge 1.13+ 写在 arguments.game 里）
            var gameArgs = jsonObj["arguments"]?["game"] as JArray;
            if (gameArgs != null)
            {
                for (int i = 0; i < gameArgs.Count - 1; i++)
                {
                    if (gameArgs[i]?.ToString() == "--fml.mcVersion")
                    {
                        version = gameArgs[i + 1]?.ToString();
                        if (!string.IsNullOrEmpty(version))
                            return version;
                    }
                }
            }

            // clientVersion（部分旧 patcher）
            version = jsonObj["clientVersion"]?.ToString();
            if (version != null)
                return version;

            return jsonObj["id"]?.ToString() ?? "Unknown";
        }

        public static string FormatDirPath(string path)
        {
            if (path.Contains(' '))
                return $"\"{path}\"";
            else
                return path;
        }
        public static List<string> ExtractFolderFromZip(string zipPath, string targetFolderInZip, string outputDirectory)
        {
            List<string> extractedFiles = new List<string>();

            using (ZipArchive archive = ZipFile.OpenRead(zipPath))
            {
                foreach (ZipArchiveEntry entry in archive.Entries)
                {
                    // 标准化路径分隔符
                    string entryPath = entry.FullName.Replace('\\', '/');

                    // 判断是否在目标文件夹下
                    if (entryPath.StartsWith(targetFolderInZip + "/") && !string.IsNullOrEmpty(entry.Name))
                    {
                        string relativePath = entryPath.Substring(targetFolderInZip.Length + 1);
                        string destinationPath = Path.Combine(outputDirectory, relativePath);

                        Directory.CreateDirectory(Path.GetDirectoryName(destinationPath)!);
                        entry.ExtractToFile(destinationPath, overwrite: true);

                        extractedFiles.Add(destinationPath);
                    }
                }
            }

            return extractedFiles;
        }

        public State CheckVersionAvailablity(string GameDir, string Version)
        {
            State state = new State();
            string jsonContent = string.Empty;
            string jsonPath = Path.Combine(GameDir, "versions", Version, $"{Version}.json");

            if (File.Exists(jsonPath))
            {
                jsonContent = File.ReadAllText(jsonPath);
            }
            else
            {
                state.Name = "Error";
                state.Describe = "Version file not found";
                state.Code = 1;
                return state;
            }

            // 检查 JSON 内容是否为空
            if (string.IsNullOrWhiteSpace(jsonContent))
            {
                state.Name = "Error";
                state.Describe = "Version JSON file is empty";
                state.Code = 1;
                return state;
            }

            try
            {
                JObject data = JObject.Parse(jsonContent);
                if (data == null)
                {
                    state.Name = "Error";
                    state.Describe = "Invalid JSON format";
                    state.Code = 1;
                    return state;
                }

                string id = data["id"]?.ToString().ToLower() ?? string.Empty;
                if (id != Version.ToLower())
                {
                    state.Name = "Warning";
                    state.Describe = "Version ID does not match the directory name";
                    state.Code = 2;
                }
            }
            catch (Exception ex)
            {
                state.Name = "Error";
                state.Describe = $"JSON parse error: {ex.Message}";
                state.Code = 1;
            }

            return state;
        }

        public static bool VerifyFileSha1(string filePath, string expectedHash)
        {
            if (!File.Exists(filePath)) { return false; }
            using (FileStream stream = File.OpenRead(filePath))
            using (SHA1 sha1 = SHA1.Create())
            {
                byte[] hashBytes = sha1.ComputeHash(stream);
                string actualHash = BitConverter.ToString(hashBytes).Replace("-", "").ToLower();
                return actualHash.Trim().Equals(expectedHash.Trim(), StringComparison.OrdinalIgnoreCase);
            }
        }

        public List<string> SearchVersionsFast(string GameDir)
        {
            List<string> versions = new List<string>();
            string versionsPath = Path.Combine(GameDir, "versions");
            if (Directory.Exists(versionsPath))
            {
                var dirs = Directory.GetDirectories(versionsPath);
                foreach (var dir in dirs)
                {
                    string dirName = Path.GetFileName(dir);
                    if (File.Exists(Path.Combine(GameDir, "versions", dirName, $"{dirName}.json")))
                    {
                        versions.Add(dirName);
                    }
                }
            }
            return versions;
        }


        public static string GetJavaVersion(string javaPath)
        {
            if (string.IsNullOrEmpty(javaPath) || !File.Exists(javaPath))
                return "Java路径无效或文件不存在";
            string javaHome = Path.GetDirectoryName(Path.GetDirectoryName(javaPath))!;
            string releaseFile = Path.Combine(javaHome, "release");
            if (!File.Exists(releaseFile)) return "未找到 release 文件";

            var lines = File.ReadAllLines(releaseFile);
            foreach (var line in lines)
            {
                if (line.StartsWith("JAVA_VERSION="))
                {
                    return line.Split('=')[1].Trim('"');
                }
            }
            return "未找到版本信息";
        }

        public static int GetNormalizedMajorVersion(string version)
        {
            if (string.IsNullOrWhiteSpace(version)) return -1;

            var parts = version.Split('.');
            if (parts[0] == "1" && parts.Length > 1 && int.TryParse(parts[1], out int legacyMajor))
                return legacyMajor;

            if (int.TryParse(parts[0], out int major))
                return major;

            return -1;
        }
        public static byte[] ReadSpecifyFileFromZip(string path, string fileName) //优化资源未正确释放,潜在的内存问题
        {
            if (string.IsNullOrEmpty(path))
                throw new ArgumentNullException(nameof(path));
            if (string.IsNullOrEmpty(fileName))
                throw new ArgumentNullException(nameof(fileName));

            using (var fileStream = File.OpenRead(path))
            using (var archive = new ZipArchive(fileStream, ZipArchiveMode.Read))
            {
                var verEntry = archive.Entries.FirstOrDefault(e =>
                    e.FullName.Equals(fileName, StringComparison.OrdinalIgnoreCase));

                if (verEntry == null)
                {
                    throw new FileNotFoundException($"未找到指定文件 {fileName}", fileName);
                }

                using (var entryStream = verEntry.Open())
                using (var memoryStream = new MemoryStream())
                {
                    entryStream.CopyTo(memoryStream);
                    return memoryStream.ToArray();
                }
            }
        }

        public static string GetMinecraftRequireJavaVersion(string version, string gameDir)
        {
            if (string.IsNullOrEmpty(version) || string.IsNullOrEmpty(gameDir))
                throw new ArgumentNullException("Version or GameDir cannot be null or empty.");
            string jsonPath = Path.Combine(gameDir, "versions", version, $"{version}.json");
            if (!File.Exists(jsonPath))
                throw new FileNotFoundException($"Version file not found: {jsonPath}");
            string jsonContent = File.ReadAllText(jsonPath);
            JObject data = JObject.Parse(jsonContent);
            if (data == null || !data.ContainsKey("javaVersion"))
            {
                if (data!.ContainsKey("inheritsFrom"))
                {
                    return GetMinecraftRequireJavaVersion(data["inheritsFrom"]!.ToString(), gameDir);
                }
                throw new Exception("Java version information not found in the version file.");
            }
            return data["javaVersion"]?["majorVersion"]?.ToString() ?? "Unknown";
        }
        public List<DataDetails.Version> SearchVersions(string GameDir)
        {
            List<DataDetails.Version> versions = new List<DataDetails.Version>();
            string versionsPath = Path.Combine(GameDir, "versions");
            if (Directory.Exists(versionsPath))
            {
                var dirs = Directory.GetDirectories(versionsPath);
                foreach (var dir in dirs)
                {
                    string dirName = Path.GetFileName(dir);

                    // 检查版本 JSON 文件是否存在
                    string jsonPath = Path.Combine(dir, $"{dirName}.json");
                    if (!File.Exists(jsonPath))
                    {
                        Trace.WriteLine($"[SearchVersions] Skipping invalid version directory (no JSON): {dirName}");
                        continue;
                    }

                    DataDetails.Version temp = new DataDetails.Version(GameDir);
                    temp.Name = dirName;
                    versions.Add(temp);
                }
            }
            return versions;
        }
        public static bool Unzip(string zipFilePath, string targetDir)
        {
            if (!File.Exists(zipFilePath))
                return false; // 压缩包不存在

            // 确保目标目录存在
            Directory.CreateDirectory(targetDir);

            try
            {
                // 解压所有文件
                ZipFile.ExtractToDirectory(zipFilePath, targetDir, overwriteFiles: true);
                return true;
            }
            catch (Exception ex)
            {
                Trace.WriteLine($"解压失败：{ex.Message}");
                return false;
            }
        }
        /// <summary>
        /// 删除指定目录中除特定后缀外的所有文件（注意：操作有风险，需确保路径正确）
        /// </summary>
        /// <param name="folderPath"></param>
        /// <param name="keepSuffix"></param>
        /// <returns></returns>
        public static bool DeleteExcept(string folderPath, string keepSuffix)
        {
            if (!Directory.Exists(folderPath))
                return false;

            // 遍历目录中的所有文件和子目录
            foreach (string itemPath in Directory.GetFileSystemEntries(folderPath))
            {
                if (Directory.Exists(itemPath))
                {
                    // 递归清理子目录
                    DeleteExcept(itemPath, keepSuffix);
                    // 若子目录为空则删除
                    if (Directory.GetFileSystemEntries(itemPath).Length == 0)
                        Directory.Delete(itemPath);
                }
                else
                {
                    // 若文件后缀不是需要保留的，则删除
                    if (!Path.GetExtension(itemPath).Equals(keepSuffix, StringComparison.OrdinalIgnoreCase))
                        File.Delete(itemPath);
                }
            }
            return true;
        }
    }
}
