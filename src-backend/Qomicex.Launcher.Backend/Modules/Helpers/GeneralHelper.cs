using System.Text.Json;
using System;
using System.Collections;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO.Compression;
using System.Runtime.ConstrainedExecution;
using System.Security.Cryptography;
using System.Text;
using static Qomicex.Launcher.Backend.DataModules;

namespace Qomicex.Launcher.Backend.Modules.Helpers
{
    public class GeneralHelper
    {
        public List<LoaderInfo> GetModLoaderType(string Version, string GameDir)
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

            using JsonDocument doc = JsonDocument.Parse(jsonContent);
            JsonElement data = doc.RootElement;

            if (!data.TryGetProperty("libraries", out var librariesProp) || librariesProp.ValueKind != JsonValueKind.Array)
            {
                throw new Exception("libraries字段不存在或格式错误");
            }

            foreach (var library in librariesProp.EnumerateArray())
            {
                if (library.TryGetProperty("name", out var nameProp))
                {
                    string name = nameProp.GetString()?.ToLower() ?? string.Empty;
                    if (name != null)
                    {
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
                                    types.Add(new LoaderInfo { Type = "Forge", Version = ver });
                                }
                            }
                        }
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
                                    types.Add(new LoaderInfo { Type = "Forge", Version = ver });
                                }
                            }
                        }
                        if (name.Contains("fabric"))
                        {
                            var nameParts = name.Split(':');
                            if (nameParts.Length == 3)
                            {
                                if (nameParts[1] == "fabric" || nameParts[1] == "fabric-loader")
                                {
                                    FabricFound = true;
                                    types.Add(new LoaderInfo { Type = "Fabric", Version = nameParts[2] });
                                }
                            }
                        }
                        if (name.Contains("quilt"))
                        {
                            var nameParts = name.Split(':');
                            if (nameParts.Length == 3)
                            {
                                if (nameParts[1] == "quilt" || nameParts[1] == "quilt-loader")
                                {
                                    QuiltFound = true;
                                    types.Add(new LoaderInfo { Type = "Quilt", Version = nameParts[2] });
                                }
                            }
                        }
                    }
                }
            }

            string mainClass = data.TryGetProperty("mainClass", out var mc) ? mc.GetString()?.ToLower() ?? string.Empty : string.Empty;

            if (data.TryGetProperty("arguments", out var argData) && argData.TryGetProperty("game", out var gameProp) && gameProp.ValueKind == JsonValueKind.Array)
            {
                var gameList = new List<JsonElement>();
                foreach (var item in gameProp.EnumerateArray())
                    gameList.Add(item);

                for (int i = 0; i < gameList.Count; i++)
                {
                    var item = gameList[i];
                    if (item.ValueKind == JsonValueKind.String)
                    {
                        string value = item.GetString()!;
                        if (value == "--fml.neoForgeVersion")
                        {
                            if (i + 1 < gameList.Count && gameList[i + 1].ValueKind == JsonValueKind.String)
                            {
                                string ver = gameList[i + 1].GetString()!;
                                types.Add(new LoaderInfo { Type = "NeoForge", Version = ver });
                                NeoForgeFound = true;
                            }
                            else
                            {
                                types.Add(new LoaderInfo { Type = "NeoForge" });
                                NeoForgeFound = true;
                            }
                        }
                        if (value == "--fml.forgeVersion")
                        {
                            if (!(NeoForgeFound || ForgeFound) && mainClass == "cpw.mods.bootstraplauncher.bootstraplauncher")
                            {
                                if (i + 1 < gameList.Count && gameList[i + 1].ValueKind == JsonValueKind.String)
                                {
                                    string ver = gameList[i + 1].GetString()!;
                                    types.Add(new LoaderInfo { Type = "NeoForge", Version = ver });
                                    NeoForgeFound = true;
                                }
                                else
                                {
                                    types.Add(new LoaderInfo { Type = "NeoForge" });
                                    NeoForgeFound = true;
                                }
                            }
                        }
                    }
                }
            }

            if (mainClass == "net.minecraft.client.main.main")
            {
                return new List<LoaderInfo> { new LoaderInfo { Type = "Vanilla" } };
            }
            if (!QuiltFound && mainClass == "org.quiltmc.loader.impl.launch.knot.knotclient")
            {
                QuiltFound = true;
                types.Add(new LoaderInfo { Type = "Quilt" });
            }
            if (!(NeoForgeFound || ForgeFound) && mainClass == "cpw.mods.bootstraplauncher.bootstraplauncher")
            {
                NeoForgeFound = true;
                types.Add(new LoaderInfo { Type = "NeoForge" });
            }
            if (!FabricFound && mainClass == "net.fabricmc.loader.impl.launch.knot.knotclient")
            {
                FabricFound = true;
                types.Add(new LoaderInfo { Type = "Fabric" });
            }
            if (!ForgeFound && mainClass == "net.minecraftforge.bootstrap.bootstraplauncher")
            {
                ForgeFound = true;
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
                    string entryPath = entry.FullName.Replace('\\', '/');

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

            if (string.IsNullOrWhiteSpace(jsonContent))
            {
                state.Name = "Error";
                state.Describe = "Version JSON file is empty";
                state.Code = 1;
                return state;
            }

            try
            {
                using JsonDocument doc = JsonDocument.Parse(jsonContent);
                var data = doc.RootElement;

                string id = data.TryGetProperty("id", out var idProp) ? idProp.GetString()?.ToLower() ?? string.Empty : string.Empty;
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
        public static byte[] ReadSpecifyFileFromZip(string path, string fileName)
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
            using JsonDocument doc = JsonDocument.Parse(jsonContent);
            var data = doc.RootElement;
            if (!data.TryGetProperty("javaVersion", out _))
            {
                if (data.TryGetProperty("inheritsFrom", out var inheritsProp))
                {
                    return GetMinecraftRequireJavaVersion(inheritsProp.GetString()!, gameDir);
                }
                throw new Exception("Java version information not found in the version file.");
            }
            return (data.TryGetProperty("javaVersion", out var jv) && jv.TryGetProperty("majorVersion", out var mv)) ? mv.GetString() ?? "Unknown" : "Unknown";
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

                    string jsonPath = Path.Combine(dir, $"{dirName}.json");
                    if (!File.Exists(jsonPath))
                    {
                        Debug.WriteLine($"[SearchVersions] Skipping invalid version directory (no JSON): {dirName}");
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
                return false;

            Directory.CreateDirectory(targetDir);

            try
            {
                ZipFile.ExtractToDirectory(zipFilePath, targetDir, overwriteFiles: true);
                return true;
            }
            catch (Exception ex)
            {
                Debug.WriteLine($"解压失败：{ex.Message}");
                return false;
            }
        }
        public static bool DeleteExcept(string folderPath, string keepSuffix)
        {
            if (!Directory.Exists(folderPath))
                return false;

            foreach (string itemPath in Directory.GetFileSystemEntries(folderPath))
            {
                if (Directory.Exists(itemPath))
                {
                    DeleteExcept(itemPath, keepSuffix);
                    if (Directory.GetFileSystemEntries(itemPath).Length == 0)
                        Directory.Delete(itemPath);
                }
                else
                {
                    if (!Path.GetExtension(itemPath).Equals(keepSuffix, StringComparison.OrdinalIgnoreCase))
                        File.Delete(itemPath);
                }
            }
            return true;
        }
    }
}
