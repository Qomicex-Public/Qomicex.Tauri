using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Net.Http;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;

namespace Qomicex.Launcher.Backend.Modules.Helpers.Resources
{
    public class LocalResourceHelper
    {
        private static string? SafeGetString(JsonNode? node, string context)
        {
            if (node is JsonValue jv && jv.TryGetValue<string>(out var val))
                return val;
            Console.WriteLine($"[LRH] {context}: expected string, got {node?.GetType().Name ?? "null"} | raw: {node?.ToJsonString() ?? "null"}");
            return null;
        }

        internal static bool CheckRules(JsonObject obj)
        {
            try
            {
                bool isSuitable = false;
                string os = string.Empty;
                string arch = string.Empty;
                bool action = false;

                if (obj.ContainsKey("rules"))
                {
                    var rules = obj["rules"] as JsonArray;

                    foreach (var rule in rules!)
                    {
                        var ruleObj = rule as JsonObject;
                        if (ruleObj == null) continue;
                        string currentArch = RuntimeInformation.OSArchitecture.ToString().ToLower();
                        var actionStr = SafeGetString(ruleObj["action"], "rule.action");
                        action = actionStr == null || actionStr == "allow";
                        if (ruleObj.ContainsKey("os"))
                        {
                            var osObj = ruleObj["os"] as JsonObject;
                            if (osObj != null)
                            {
                                if (osObj.ContainsKey("name"))
                                {
                                    os = SafeGetString(osObj["name"], "rule.os.name") ?? string.Empty;
                                }
                                if (osObj.ContainsKey("arch"))
                                {
                                    arch = SafeGetString(osObj["arch"], "rule.os.arch") ?? string.Empty;
                                }
                            }
                        }
                        if (action && (os.Equals(SystemInfoHelper.OsName, StringComparison.OrdinalIgnoreCase) || string.IsNullOrEmpty(os)) && (arch.Equals(currentArch, StringComparison.OrdinalIgnoreCase) || string.IsNullOrEmpty(arch)))
                        {
                            isSuitable = true;
                        }
                        else if (!action && !os.Equals(SystemInfoHelper.OsName, StringComparison.OrdinalIgnoreCase) && (arch.Equals(currentArch, StringComparison.OrdinalIgnoreCase) || string.IsNullOrEmpty(arch)))
                        {
                            isSuitable = true;
                        }
                    }
                }
                else
                {
                    isSuitable = true;
                }
                return isSuitable;
            }
            catch (Exception ex)
            {
                Console.WriteLine($"[LRH] CheckRules failed: {ex.Message}\nJSON: {obj.ToJsonString()}");
                throw;
            }
        }

        public static List<LibInfo> GetLibraries(string jsonData)
        {
            try
            {
                var libsReturn = new List<LibInfo>();
                var libs = new List<LibInfo>();
                var data = JsonNode.Parse(jsonData)?.AsObject();
                if (data == null)
                {
                    throw new FileLoadException("Invalid Json file");
                }
                // 安全获取libraries数组
                if (!data.TryGetPropertyValue("libraries", out var librariesToken) || !(librariesToken is JsonArray libraries))
                {
                    throw new Exception("libraries字段不存在或格式错误");
                }
                foreach (var item in libraries)
                {
                    var libObj = item as JsonObject;
                    if (libObj == null) continue;
                    if (CheckRules(libObj))
                    {
                        if (libObj.ContainsKey("name"))
                        {
                            var name = SafeGetString(libObj["name"], $"lib.name:{libObj["name"]?.ToJsonString()}") ?? string.Empty;
                        if (!string.IsNullOrEmpty(name))
                        {
                            var isNatives = name.ToLower().Contains("natives");
                            if (CheckNatives(libObj))
                            {
                                var info = new LibInfo();
                                info.IsNativesLib = true;
                                info.IsCpLib = false;
                                info.FullName = GetNativesInfo(libObj, 0);
                                info.Hash = GetNativesInfo(libObj, 1);
                                info.Url = GetNativesInfo(libObj, 2);
                                string[] temp = info.FullName.Split(':');
                                if (temp.Length >= 3)
                                {
                                    info.Name = $"{temp[0]}.{temp[1]}.{temp[3]}";
                                }
                                libs.Add(info);

                            }
                            if (CheckClassPath(libObj))
                            {
                                var info = new LibInfo();
                                info.IsCpLib = true;
                                info.IsNativesLib = false;
                                info.FullName = name;
                                info.Hash = GetClassPathInfo(libObj, 1);
                                info.Url = GetClassPathInfo(libObj, 2);
                                libs.Add(info);
                            }
                        }
                    }
                }
            }
            //筛选版本
            libsReturn = CheckLibsVer(libs);
            return libsReturn;
            }
            catch (Exception ex)
            {
                Console.WriteLine($"[LRH] GetLibraries failed: {ex.Message}\nJSON: {(jsonData.Length > 2000 ? jsonData[..2000] + "..." : jsonData)}");
                throw;
            }
        }

        internal static List<LibInfo> CheckLibsVer(List<LibInfo> libs)
        {
            var groupedLibs = libs
                .GroupBy(lib => lib.Name)
                .Select(group =>
                {
                    LibInfo newest = group.First();
                    foreach (var lib in group.Skip(1))
                    {
                        int cmp = VersionSortInteger(lib.Version, newest.Version);
                        if (cmp > 0)
                        {
                            newest = lib; // 替换为更新版本
                        }
                    }
                    return newest;
                });

            return groupedLibs.ToList();
        }

        private static bool CheckNatives(JsonObject obj)
        {
            if (obj.ContainsKey("natives"))
                return true;
            if (obj.ContainsKey("downloads"))
            {
                if (obj.ContainsKey("classifiers"))
                    return true;
            }
            if (GetNativesInfo(obj, 0).ToLower().Contains("natives"))
                return true;
            return false;
        }

        private static string GetNativesInfo(JsonObject obj, int type = 0)
        {
            string nativesName = string.Empty;

            if (obj.ContainsKey("natives"))
                nativesName = obj["natives"]?[SystemInfoHelper.OsName] is JsonValue jvN && jvN.TryGetValue<string>(out var nv) ? nv : string.Empty;
            if (Environment.Is64BitOperatingSystem)
                nativesName = nativesName.Replace("${arch}", "64");
            else
                nativesName = nativesName.Replace("${arch}", "32");
            if (obj.ContainsKey("downloads"))
            {
                if (obj.ContainsKey("classifiers"))
                {
                    var classifiersObj = obj["downloads"]?["classifiers"] as JsonObject;
                    if (classifiersObj != null && classifiersObj.ContainsKey($"natives-{SystemInfoHelper.OsName}"))
                    {
                        var nativeObj = classifiersObj[nativesName] as JsonObject;
                        if (nativeObj != null)
                        {
                            if (nativeObj.ContainsKey("sha1") && type == 1)
                                return SafeGetString(nativeObj["sha1"], "natives.sha1") ?? string.Empty;
                            if (nativeObj.ContainsKey("url") && type == 2)
                                return SafeGetString(nativeObj["url"], "natives.url") ?? string.Empty;
                        }
                    }
                }
            }
            if (type == 0)
            {
                var name = SafeGetString(obj["name"], "natives.name") ?? string.Empty;
                if (!string.IsNullOrEmpty(nativesName))
                    return $"{name}:{nativesName}";
                return name;
            }
            return string.Empty;
        }

        private static bool CheckClassPath(JsonObject obj)
        {
            if (obj.ContainsKey("downloads"))
            {
                var downloadsObj = obj["downloads"] as JsonObject;
                if (downloadsObj != null && downloadsObj.ContainsKey("artifact"))
                    return true;
            }
            else
            {
                if (!obj.ContainsKey("natives"))
                {
                    return true;
                }
            }
            return false;
        }


        private static string GetClassPathInfo(JsonObject obj, int type = 0)
        {
            if (obj.ContainsKey("downloads"))
            {
                var downloadsObj = obj["downloads"] as JsonObject;
                if (downloadsObj != null && downloadsObj.ContainsKey("artifact"))
                {
                    var artifactObj = downloadsObj["artifact"] as JsonObject;
                    if (artifactObj != null)
                    {
                        if (artifactObj.ContainsKey("sha1") && type == 1)
                            return SafeGetString(artifactObj["sha1"], "classpath.sha1") ?? string.Empty;
                        if (artifactObj.ContainsKey("url") && type == 2)
                            return SafeGetString(artifactObj["url"], "classpath.url") ?? string.Empty;
                    }
                }
            }
            else if (type == 2 && obj.ContainsKey("url"))
            {
                // Fabric/Quilt style: top-level "url" is the maven repo base, combine with path
                var baseUrl = SafeGetString(obj["url"], "classpath.baseUrl") ?? string.Empty;
                if (!string.IsNullOrEmpty(baseUrl))
                {
                    var name = SafeGetString(obj["name"], "classpath.name.forUrl") ?? string.Empty;
                    if (!string.IsNullOrEmpty(name))
                    {
                        var mavenPath = MavenToPath(name);
                        if (!string.IsNullOrEmpty(mavenPath))
                            return $"{baseUrl.TrimEnd('/')}/{mavenPath}";
                    }
                }
            }
            if (type == 0)
                return SafeGetString(obj["name"], "classpath.name") ?? string.Empty;
            return string.Empty;
        }

        private static int VersionSortInteger(string left, string right)
        {
            left = left.ToLowerInvariant();
            right = right.ToLowerInvariant();

            var leftParts = Regex.Matches(left, "[a-z]+|[0-9]+").Select(m => m.Value).ToList();
            var rightParts = Regex.Matches(right, "[a-z]+|[0-9]+").Select(m => m.Value).ToList();

            for (int i = 0; ; i++)
            {
                if (i >= leftParts.Count && i >= rightParts.Count)
                {
                    return string.Compare(left, right, StringComparison.Ordinal);
                }

                string lVal = i < leftParts.Count ? leftParts[i] : "-1";
                string rVal = i < rightParts.Count ? rightParts[i] : "-1";

                if (lVal == rVal) continue;

                lVal = ConvertSpecialLabel(lVal);
                rVal = ConvertSpecialLabel(rVal);

                if (!int.TryParse(lVal, out int lNum) || !int.TryParse(rVal, out int rNum))
                {
                    return string.Compare(lVal, rVal, StringComparison.Ordinal);
                }

                if (lNum > rNum) return 1;
                if (lNum < rNum) return -1;
            }
        }

        private static string ConvertSpecialLabel(string label)
        {
            return label switch
            {
                "pre" or "snapshot" => "-3",
                "rc" => "-2",
                "experimental" => "-4",
                _ => label
            };
        }

        public class LibInfo
        {
            private string _fullName = string.Empty;
            private string _name = string.Empty;
            private string _path = string.Empty;
            private string _version = string.Empty;
            public bool IsNativesLib = false; // 是否为Natives文件
            public bool IsCpLib = false; // 是否为CpLib文件
            public string FullName
            {
                get { return _fullName; }
                set
                {
                    _fullName = value ?? string.Empty;
                    if (string.IsNullOrEmpty(_fullName)) return;

                    IsNativesLib = _fullName.ToLower().Contains("natives");
                    string[] temp = _fullName.Split(':');
                    if (temp.Length >= 3)
                    {
                        _version = temp[2];
                        _name = $"{temp[0]}.{temp[1]}";

                        _path = MavenToPath(_fullName);
                        if (temp.Length >= 4)
                        {
                            //有的natives文件并没有natives或classifiers键,但会在版本号后加上{natives-arch},可以使用关键字判断
                            if (temp[3].ToLower().Contains("natives"))
                            {
                                IsNativesLib = true;
                                _name += $".{temp[3]}"; //如果是Natives文件，则在名称后加上-natives
                                IsCpLib = false;
                            }
                        }
                    }
                }
            }
            public string Name
            {
                get { return _name; }
                set { _name = value ?? string.Empty; }
            }
            public string Path
            {
                get { return _path; }
                set { _path = value ?? string.Empty; }
            }
            public string Version
            {
                get { return _version; }
            }
            public string Hash = string.Empty;
            public string Url = string.Empty;
            public bool NameExists(string Name)
            {
                if (string.IsNullOrEmpty(Name)) return false;
                if (Name.Equals(_name, StringComparison.OrdinalIgnoreCase) || Name.Equals(_fullName, StringComparison.OrdinalIgnoreCase))
                {
                    return true;
                }
                return false;
            }
            public bool PathExists(string Path)
            {
                if (string.IsNullOrEmpty(Path)) return false;
                if (Path.Equals(_path, StringComparison.OrdinalIgnoreCase))
                {
                    return true;
                }
                return false;
            }
        }

        private static string RemoveOptionalSuffix(string input)
        {
            int atIndex = input.IndexOf('@');
            return atIndex >= 0 ? input.Substring(0, atIndex) : input;
        }

        public static string MavenToPath(string maven)
        {
            // 防御性检查：坐标为空直接返回
            if (string.IsNullOrWhiteSpace(maven))
            {
                Debug.WriteLine("Maven坐标为空，无法转换路径");
                return string.Empty;
            }

            // 分割坐标（支持格式：group:artifact:version[:classifier[:type]]）
            string[] parts = maven.Split(':');

            // 最少需要3个部分（group:artifact:version）
            if (parts.Length < 3)
            {
                Debug.WriteLine($"无效的Maven坐标格式：{maven}，至少需要3个部分（group:artifact:version）");
                return string.Empty;
            }

            // 提取基础部分（确保不越界）
            string group = RemoveOptionalSuffix(parts[0].Trim());
            string artifact = RemoveOptionalSuffix(parts[1].Trim());
            string version = parts[2].Trim();

            // 处理可选的classifier（第4部分）和 type（第5部分，通常为 jar）
            string classifier = parts.Length >= 4 ? parts[3].Trim() : string.Empty;
            string type = parts.Length >= 5 ? parts[4].Trim() : "jar"; // 默认类型为 jar
            if (version.Contains("@"))
            {
                type = version.Split('@')[1].Trim(); // 如果版本中包含@，则取@后面的部分作为类型
                version = version.Split('@')[0].Trim(); // 去掉@及其后面的部分
            }

            // 验证基础部分有效性
            if (string.IsNullOrEmpty(group) || string.IsNullOrEmpty(artifact) || string.IsNullOrEmpty(version))
            {
                Debug.WriteLine($"Maven坐标包含空值：{maven}");
                return string.Empty;
            }

            // 转换 group为路径（com.mumfrey → com/mumfrey）
            string groupPath = group.Replace('.', '/');

            // 构建文件名（artifact-version[-classifier].type）
            string fileName = $"{artifact}-{version}";
            if (!string.IsNullOrEmpty(classifier))
                fileName += $"-{classifier}";
            fileName += $".{type}";

            // 组合完整路径
            return $"{groupPath}/{artifact}/{version}/{fileName}";
        }

        private DownloadSource _downloadSource = new DownloadSource();
        private int DownloadSourceId = 0;

        public enum DownloadSources
        {
            Mojang, BMCLAPI
        }

        public class DownloadSource
        {
            public string librariesSource = "https://libraries.minecraft.net/";
            public string mainJarSource = string.Empty;
            public string assetsIndexSource = string.Empty;
            public string assetsSource = "http://resources.download.minecraft.net/";
        }

        public class MissFileData
        {
            public string Name = string.Empty;
            public string Path = string.Empty;
            public string Url = string.Empty;
            public string Sha1 = string.Empty;
        }

        public void SetDownloadSource(int source)
        {
            DownloadSourceId = source;
            if (source == (int)DownloadSources.Mojang)
            {
                _downloadSource = new DownloadSource();
            }
            else if (source == (int)DownloadSources.BMCLAPI)
            {
                _downloadSource = new DownloadSource
                {
                    librariesSource = "https://bmclapi2.bangbang93.com/maven/",
                    mainJarSource = "https://bmclapi2.bangbang93.com/",
                    assetsIndexSource = "https://bmclapi2.bangbang93.com/",
                    assetsSource = "https://bmclapi2.bangbang93.com/assets/"
                };
            }

        }

        private async Task<string> GetInheritsFrom(string ver, string gameDir)
        {
            string inheritsFrom = string.Empty;
            string JsonContent = await File.ReadAllTextAsync(Path.Combine(gameDir, "versions", ver, $"{ver}.json"));
            var data = JsonNode.Parse(JsonContent)?.AsObject();
            if (data == null)
            {
                throw new FileLoadException("Invalid Json file");
            }
            if (data.ContainsKey("inheritsFrom"))
            {
                inheritsFrom = SafeGetString(data["inheritsFrom"], "inheritsFrom") ?? string.Empty;
            }
            return inheritsFrom;
        }

        public async Task<List<MissFileData>> GetMissLibrariesAsync(string version, string gameDir)
        {
            List<MissFileData> missFiles = new List<MissFileData>();
            var jsonPath = Path.Combine(gameDir, "versions", version, $"{version}.json");
            Debug.WriteLine($"[Scan] GetMissLibrariesAsync 读取 {jsonPath}");
            string JsonContent = await File.ReadAllTextAsync(jsonPath);
            var lib = GetLibraries(JsonContent);
            Debug.WriteLine($"[Scan] GetLibraries 返回 {lib?.Count ?? 0} 个库");
            //inheritsFrom版本处理
            if (string.IsNullOrEmpty(await GetInheritsFrom(version, gameDir)))
            {
                //如果没有继承版本，则直接使用当前版本的库
                if (lib == null || lib.Count == 0)
                {
                    throw new Exception("未找到任何库文件");
                }
            }
            else
            {
                //如果有继承版本，则获取继承版本的库
                string inheritsFrom = await GetInheritsFrom(version, gameDir);
                string inheritsJsonContent = await File.ReadAllTextAsync($"{Path.Combine(gameDir, "versions", inheritsFrom, $"{inheritsFrom}.json")}");
                var inheritsLib = GetLibraries(inheritsJsonContent);
                if (inheritsLib != null && inheritsLib.Count > 0)
                {
                    lib.AddRange(inheritsLib);
                }
            }

            foreach (var item in lib)
            {
                string path = item.Path;
                if (!string.IsNullOrEmpty(item.Hash))
                {
                    if (GeneralHelper.VerifyFileSha1(Path.Combine(gameDir, "libraries", path), item.Hash))
                    {
                        continue; //如果文件存在且 sha1校验通过则跳过
                    }
                    else
                    {
                        MissFileData missFile = new MissFileData();
                        missFile.Name = item.Name;
                        missFile.Path = Path.Combine(gameDir, "libraries", path);
                        if (!string.IsNullOrEmpty(item.Url))
                            missFile.Url = item.Url.Replace("https://libraries.minecraft.net/", _downloadSource.librariesSource);
                        else
                            missFile.Url = $"{_downloadSource.librariesSource}{path}";
                        missFile.Sha1 = item.Hash;
                        missFiles.Add(missFile);
                    }
                }
                else if (!string.IsNullOrEmpty(path))
                {
                    if (File.Exists(Path.Combine(gameDir, "libraries", path)))
                    {
                        continue; //如果文件存在则跳过
                    }
                    else
                    {
                        MissFileData missFile = new MissFileData();
                        missFile.Name = item.Name;
                        missFile.Path = Path.Combine(gameDir, "libraries", path);
                        if (!string.IsNullOrEmpty(item.Url))
                            missFile.Url = item.Url;
                        else
                            missFile.Url = $"{_downloadSource.librariesSource}{path}";
                        missFile.Sha1 = item.Hash;
                        missFiles.Add(missFile);
                    }
                }
                else
                {
                    throw new Exception("库文件路径或哈希值不能为空");
                }
            }
            return missFiles;
        }

        public async Task<MissFileData?> GetMissMainJarAsync(string version, string gameDir)
        {
            MissFileData missMainJar = new MissFileData();
            string JsonContent = await File.ReadAllTextAsync(Path.Combine(gameDir, "versions", version, $"{version}.json"));
            var data = JsonNode.Parse(JsonContent)?.AsObject();
            if (data == null)
            {
                throw new FileLoadException("Invalid Json file");
            }

            string sha1 = (data["downloads"] as JsonObject)?["client"]?["sha1"]?.GetValue<string>() ?? string.Empty;
            if (!string.IsNullOrEmpty(sha1))
            {
                if (!GeneralHelper.VerifyFileSha1(Path.Combine(gameDir, "versions", version, $"{version}.jar"), sha1))
                {
                    missMainJar.Name = $"{version}.jar";
                    missMainJar.Path = Path.Combine(gameDir, "versions", version, $"{version}.jar");
                    missMainJar.Url = (data["downloads"] as JsonObject)?["client"]?["url"]?.GetValue<string>() ?? string.Empty;
                    if (DownloadSourceId == (int)DownloadSources.BMCLAPI)
                    {
                        missMainJar.Url = missMainJar.Url.Replace("https://piston-meta.mojang.com/", _downloadSource.mainJarSource)
                            .Replace("https://launchermeta.mojang.com/", _downloadSource.mainJarSource)
                            .Replace("https://launcher.mojang.com/", _downloadSource.mainJarSource)
                            .Replace("https://piston-data.mojang.com/", _downloadSource.mainJarSource);
                    }
                    missMainJar.Sha1 = sha1;
                }
            }
            else if (!string.IsNullOrEmpty(await GetInheritsFrom(version, gameDir)))
            {
                //有继承版本但当前版本无 sha1，跳过当前版本的主 Jar，由继承版本处理
                return null;
            }
            else
            {
                //如果有继承版本，则获取继承版本的主Jar
                string inheritsFrom = await GetInheritsFrom(version, gameDir);
                string inheritsJsonContent = await File.ReadAllTextAsync(Path.Combine(gameDir, "versions", inheritsFrom, $"{inheritsFrom}.json"));
                var inheritsData = JsonNode.Parse(inheritsJsonContent)?.AsObject();
                if (inheritsData == null)
                {
                    throw new FileLoadException("Invalid Json file");
                }
                string inheritsSha1 = (inheritsData["downloads"] as JsonObject)?["client"]?["sha1"]?.GetValue<string>() ?? string.Empty;
                if (!string.IsNullOrEmpty(inheritsSha1))
                {
                    if (!GeneralHelper.VerifyFileSha1(Path.Combine(gameDir, "versions", inheritsFrom, $"{inheritsFrom}.jar"), inheritsSha1))
                    {
                        missMainJar.Name = $"{inheritsFrom}.jar";
                        missMainJar.Path = Path.Combine(gameDir, "versions", inheritsFrom, $"{inheritsFrom}.jar");
                        missMainJar.Url = (inheritsData["downloads"] as JsonObject)?["client"]?["url"]?.GetValue<string>() ?? string.Empty;
                        if (DownloadSourceId == (int)DownloadSources.BMCLAPI)
                        {
                            missMainJar.Url = missMainJar.Url.Replace("https://piston-meta.mojang.com/", _downloadSource.mainJarSource)
                                                        .Replace("https://launchermeta.mojang.com/", _downloadSource.mainJarSource)
                                                        .Replace("https://launcher.mojang.com/", _downloadSource.mainJarSource)
                                                        .Replace("https://piston-data.mojang.com/", _downloadSource.mainJarSource);
                        }
                        missMainJar.Sha1 = inheritsSha1;
                    }
                }
            }
            return missMainJar;
        }

        public async Task<List<MissFileData>> GetMissAssetsAsync(string version, string gameDir)
        {
            List<MissFileData> missFiles = new List<MissFileData>();
            string JsonContent = await File.ReadAllTextAsync(Path.Combine(gameDir, "versions", version, $"{version}.json"));
            var data = JsonNode.Parse(JsonContent)?.AsObject();
            if (data == null)
            {
                throw new FileLoadException("Invalid Json file");
            }

            if (data.ContainsKey("assetIndex"))
            {
                var assetIndexObj = data["assetIndex"] as JsonObject;
                string assetsIndexPath = string.Empty;
                //检查 assetIndex
                if (assetIndexObj != null && assetIndexObj.ContainsKey("id"))
                {
                    string assetId = assetIndexObj["id"]!.GetValue<string>();
                    string sha1 = assetIndexObj["sha1"]!.GetValue<string>();
                    string url = assetIndexObj["url"]!.GetValue<string>();
                    if (DownloadSourceId == (int)DownloadSources.BMCLAPI)
                    {
                        url = url.Replace("https://piston-meta.mojang.com/", _downloadSource.assetsIndexSource)
                            .Replace("https://launchermeta.mojang.com/", _downloadSource.assetsIndexSource)
                            .Replace("https://launcher.mojang.com/", _downloadSource.assetsIndexSource)
                            .Replace("http://", "https://");
                    }

                    assetsIndexPath = Path.Combine(gameDir, "assets", "indexes", $"{assetId}.json");
                    if (!File.Exists(assetsIndexPath) || !GeneralHelper.VerifyFileSha1(assetsIndexPath, sha1))
                    {
                        using (HttpClient http = new HttpClient())
                        {
                            http.BaseAddress = new Uri(url);
                            var response = await http.GetAsync(url);
                            if (response.IsSuccessStatusCode)
                            {
                                var content = await response.Content.ReadAsStringAsync();
                                if (!Directory.Exists(Path.GetDirectoryName(assetsIndexPath)))
                                    Directory.CreateDirectory(Path.GetDirectoryName(assetsIndexPath)!);
                                await File.WriteAllTextAsync(assetsIndexPath, content);
                            }
                            else
                            {
                                throw new Exception($"下载资源索引失败: {response.ReasonPhrase}");

                            }
                        }
                    }
                }
                //检查 assets
                if (File.Exists(assetsIndexPath))
                {
                    string assetsJsonContent = await File.ReadAllTextAsync(assetsIndexPath);
                    var assetsData = JsonNode.Parse(assetsJsonContent)?.AsObject();
                    if (assetsData != null && assetsData.ContainsKey("objects"))
                    {
                        var assetObj = assetsData["objects"] as JsonObject;
                        if (assetObj != null)
                        {
                            foreach (var item in assetObj)
                            {
                                string assetName = item.Key;
                                var assetDetails = item.Value as JsonObject;
                                if (assetDetails == null) continue;
                                string assetHash = assetDetails["hash"]!.GetValue<string>();
                                string assetUrl = $"{_downloadSource.assetsSource}{assetHash.Substring(0, 2)}/{assetHash}";
                                string assetPath = Path.Combine(gameDir, "assets", "objects", assetHash.Substring(0, 2), assetHash);
                                if (!File.Exists(assetPath) || !GeneralHelper.VerifyFileSha1(assetPath, assetHash))
                                {
                                    MissFileData missFile = new MissFileData
                                    {
                                        Name = assetHash,
                                        Path = assetPath,
                                        Url = assetUrl.Replace("http://", "https://"),
                                        Sha1 = assetHash
                                    };
                                    missFiles.Add(missFile);
                                }
                            }
                        }
                    }
                }
            }
            if (!string.IsNullOrEmpty(await GetInheritsFrom(version, gameDir)))
            {
                var inheritsFromVer = await GetInheritsFrom(version, gameDir);
                JsonContent = await File.ReadAllTextAsync(Path.Combine(gameDir, "versions", inheritsFromVer, $"{inheritsFromVer}.json"));
                data = JsonNode.Parse(JsonContent)?.AsObject();
                if (data == null)
                {
                    throw new FileLoadException("Invalid Json file");
                }

                if (data.ContainsKey("assetIndex"))
                {
                    var assetIndexObj = data["assetIndex"] as JsonObject;
                    string assetsIndexPath = string.Empty;
                    //检查 assetIndex
                    if (assetIndexObj != null && assetIndexObj.ContainsKey("id"))
                    {
                        string assetId = assetIndexObj["id"]!.GetValue<string>();
                        string sha1 = assetIndexObj["sha1"]!.GetValue<string>();
                        string url = assetIndexObj["url"]!.GetValue<string>();
                        if (DownloadSourceId == (int)DownloadSources.BMCLAPI)
                        {
                            url = url.Replace("https://piston-meta.mojang.com/", _downloadSource.assetsIndexSource)
                                .Replace("https://launchermeta.mojang.com/", _downloadSource.assetsIndexSource)
                                .Replace("https://launcher.mojang.com/", _downloadSource.assetsIndexSource)
                                .Replace("http://", "https://");
                        }

                        assetsIndexPath = Path.Combine(gameDir, "assets", "indexes", $"{assetId}.json");
                        if (!File.Exists(assetsIndexPath) || !GeneralHelper.VerifyFileSha1(assetsIndexPath, sha1))
                        {
                            using (HttpClient http = new HttpClient())
                            {
                                http.BaseAddress = new Uri(url);
                                var response = await http.GetAsync(url);
                                if (response.IsSuccessStatusCode)
                                {
                                    var content = await response.Content.ReadAsStringAsync();
                                    if (!Directory.Exists(Path.GetDirectoryName(assetsIndexPath)))
                                        Directory.CreateDirectory(Path.GetDirectoryName(assetsIndexPath)!);
                                    await File.WriteAllTextAsync(assetsIndexPath, content);
                                }
                                else
                                {
                                    throw new Exception($"下载资源索引失败: {response.ReasonPhrase}");

                                }
                            }
                        }
                    }
                    //检查 assets
                    if (File.Exists(assetsIndexPath))
                    {
                        string assetsJsonContent = await File.ReadAllTextAsync(assetsIndexPath);
                        var assetsData = JsonNode.Parse(assetsJsonContent)?.AsObject();
                        if (assetsData != null && assetsData.ContainsKey("objects"))
                        {
                            var assetObj = assetsData["objects"] as JsonObject;
                            if (assetObj != null)
                            {
                                foreach (var item in assetObj)
                                {
                                    string assetName = item.Key;
                                    var assetDetails = item.Value as JsonObject;
                                    if (assetDetails == null) continue;
                                    string assetHash = assetDetails["hash"]!.GetValue<string>();
                                    string assetUrl = $"{_downloadSource.assetsSource}{assetHash.Substring(0, 2)}/{assetHash}";
                                    string assetPath = Path.Combine(gameDir, "assets", "objects", assetHash.Substring(0, 2), assetHash);
                                    if (!File.Exists(assetPath) || !GeneralHelper.VerifyFileSha1(assetPath, assetHash))
                                    {
                                        MissFileData missFile = new MissFileData
                                        {
                                            Name = assetHash,
                                            Path = assetPath,
                                            Url = assetUrl.Replace("http://", "https://"),
                                            Sha1 = assetHash
                                        };
                                        missFiles.Add(missFile);
                                    }
                                }
                            }
                        }
                    }
                }
            }
            return missFiles;
        }

        public async Task<List<MissFileData>> GetAllMissFilesAsync(string version, string gameDir)
        {
            List<MissFileData> missFiles = new List<MissFileData>();

            Debug.WriteLine($"[Scan] 开始扫描 {version} 在 {gameDir}");

            try
            {
                var libFiles = await GetMissLibrariesAsync(version, gameDir);
                Debug.WriteLine($"[Scan] GetMissLibrariesAsync 返回 {libFiles?.Count ?? 0} 个文件");
                if (libFiles != null && libFiles.Count > 0)
                    missFiles.AddRange(libFiles);
            }
            catch (Exception ex)
            {
                Debug.WriteLine($"[Scan] GetMissLibrariesAsync 异常: {ex.Message}");
            }

            try
            {
                var assetsFiles = await GetMissAssetsAsync(version, gameDir);
                Debug.WriteLine($"[Scan] GetMissAssetsAsync 返回 {assetsFiles?.Count ?? 0} 个文件");
                if (assetsFiles != null && assetsFiles.Count > 0)
                    missFiles.AddRange(assetsFiles);
            }
            catch (Exception ex)
            {
                Debug.WriteLine($"[Scan] GetMissAssetsAsync 异常: {ex.Message}");
            }

            try
            {
                var mainJar = await GetMissMainJarAsync(version, gameDir);
                if (mainJar != null)
                {
                    Debug.WriteLine($"[Scan] GetMissMainJarAsync 返回: {mainJar.Name}");
                    missFiles.Add(mainJar);
                }
                else
                {
                    Debug.WriteLine($"[Scan] GetMissMainJarAsync 返回 null (jar 已存在)");
                }
            }
            catch (Exception ex)
            {
                Debug.WriteLine($"[Scan] GetMissMainJarAsync 异常: {ex.Message}");
            }

            Debug.WriteLine($"[Scan] 总计 {missFiles.Count} 个缺失文件");
            return missFiles;
        }
    }
}
