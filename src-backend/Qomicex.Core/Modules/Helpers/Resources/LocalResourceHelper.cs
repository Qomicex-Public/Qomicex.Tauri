using Newtonsoft.Json.Linq;
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;

namespace Qomicex.Core.Modules.Helpers.Resources
{
    public class LocalResourceHelper
    {
        internal static bool CheckRules(JObject obj)
        {
            bool isSuitable = false;
            string os = string.Empty;
            string arch = string.Empty;
            bool action = false;
            //DataModules.SystemInfo sysInfo = Modules.Helpers.GeneralHelper.GetSystemInfo();

            if (obj.ContainsKey("rules"))//判断是否适用
            {
                JArray? rules = (JArray?)obj["rules"];

                foreach (var rule in rules!)
                {
                    var ruleObj = (JObject)rule;
                    string currentArch = RuntimeInformation.OSArchitecture.ToString().ToLower();
                    if (ruleObj["action"]!.ToString() == "allow" || ruleObj["action"] is null) { action = true; } else { action = false; }
                    if (ruleObj.ContainsKey("os"))
                    {
                        var osObj = (JObject?)ruleObj["os"];
                        if (osObj!.ContainsKey("name"))
                        {
                            os = osObj["name"]!.ToString();
                        }
                        if (osObj.ContainsKey("arch"))
                        {
                            arch = osObj["arch"]!.ToString();
                        }
                    }
                    if (action && (os.Equals(SystemInfoHelper.OsName, StringComparison.OrdinalIgnoreCase) || string.IsNullOrEmpty(os)) && (arch.Equals(currentArch, StringComparison.OrdinalIgnoreCase) || string.IsNullOrEmpty(arch)))
                    {
                        isSuitable = true;
                    }
                    else if (!action && (os.Equals(SystemInfoHelper.OsName, StringComparison.OrdinalIgnoreCase) || string.IsNullOrEmpty(os)) && (arch.Equals(currentArch, StringComparison.OrdinalIgnoreCase) || string.IsNullOrEmpty(arch)))
                    {
                        isSuitable = false;
                    }
                }
            }
            else
            {
                isSuitable = true;
            }
            return isSuitable;
        }

        public static List<LibInfo> GetLibraries(string jsonData)
        {
            var libsReturn = new List<LibInfo>();
            var libs = new List<LibInfo>();
            JObject data = JObject.Parse(jsonData);
            if (data == null)
            {
                throw new FileLoadException("Invalid Json file");
            }
            // 安全获取libraries数组
            if (!data.TryGetValue("libraries", out var librariesToken) || !(librariesToken is JArray libraries))
            {
                throw new Exception("libraries字段不存在或格式错误");
            }
            foreach (var item in libraries)
            {
                var libObj = (JObject)item;
                if (CheckRules(libObj))
                {
                    if (libObj.ContainsKey("optional") && (bool)libObj["optional"]!)
                        continue;
                    if (libObj.ContainsKey("name"))
                    {
                        var name = libObj["name"]!.ToString();
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

        internal static List<LibInfo> CheckLibsVer(List<LibInfo> libs)
        {
            var groupedLibs = libs
                .GroupBy(lib => lib.Name)
                .Select(group =>
                {
                    LibInfo newest = group.First();
                    foreach (var lib in group.Skip(1))
                    {
                        //int cmp = CompareVersionsExtended(lib.Version, newest.Version);
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

        private static bool CheckNatives(JObject obj)
        {
            if (obj.ContainsKey("natives"))
                return true;
            if (obj.ContainsKey("downloads") && ((JObject?)obj["downloads"])!.ContainsKey("classifiers"))
                return true;
            if (GetNativesInfo(obj, 0).ToLower().Contains("natives"))
                return true;
            return false;
        }

        private static string GetNativesInfo(JObject obj, int type = 0)
        {
            string nativesName = string.Empty;

            if (obj.ContainsKey("natives"))
            {
                var natives = (JObject?)obj["natives"];
                if (natives != null && natives.ContainsKey(SystemInfoHelper.OsName))
                {
                    nativesName = natives[SystemInfoHelper.OsName]!.ToString();
                }
            }
            if (Environment.Is64BitOperatingSystem)
                nativesName = nativesName.Replace("${arch}", "64");
            else
                nativesName = nativesName.Replace("${arch}", "32");
            if (obj.ContainsKey("downloads") && obj["downloads"] is JObject downloadsObj && downloadsObj.ContainsKey("classifiers"))
            {
                var classifiersObj = (JObject?)downloadsObj["classifiers"];
                if (classifiersObj != null && classifiersObj.ContainsKey(nativesName) && classifiersObj[nativesName] is JObject nativeEntry)
                {
                    if (type == 1 && nativeEntry.ContainsKey("sha1"))
                        return nativeEntry["sha1"]!.ToString();
                    if (type == 2 && nativeEntry.ContainsKey("url"))
                        return nativeEntry["url"]!.ToString();
                }
            }
            if (type == 0)
                if (!string.IsNullOrEmpty(nativesName))
                    return $"{obj["name"]!.ToString()}:{nativesName}";
                else
                    return obj["name"]!.ToString();
            return string.Empty;
        }

        private static bool CheckClassPath(JObject obj)
        {
            if (obj.ContainsKey("downloads"))
            {
                var downloadsObj = obj["downloads"] as JObject;
                if (downloadsObj!.ContainsKey("artifact"))
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


        private static string GetClassPathInfo(JObject obj, int type = 0)
        {
            if (obj.ContainsKey("downloads"))
            {
                var downloadsObj = obj["downloads"] as JObject;
                if (downloadsObj != null && downloadsObj.ContainsKey("artifact"))
                {
                    var artifactObj = downloadsObj["artifact"] as JObject;
                    if (artifactObj != null)
                    {
                        if (artifactObj.ContainsKey("sha1") && type == 1)
                            return artifactObj["sha1"]!.ToString();
                        if (artifactObj!.ContainsKey("url") && type == 2)
                            return artifactObj!["url"]!.ToString();
                    }
                }
            }
            if (type == 0)
                return obj["name"]!.ToString();
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
                Trace.WriteLine("Maven坐标为空，无法转换路径");
                return string.Empty;
            }

            // 分割坐标（支持格式：group:artifact:version[:classifier[:type]]）
            string[] parts = maven.Split(':');

            // 最少需要3个部分（group:artifact:version）
            if (parts.Length < 3)
            {
                Trace.WriteLine($"无效的Maven坐标格式：{maven}，至少需要3个部分（group:artifact:version）");
                return string.Empty;
            }

            // 提取基础部分（确保不越界）
            string group = RemoveOptionalSuffix(parts[0].Trim());
            string artifact = RemoveOptionalSuffix(parts[1].Trim());
            string version = parts[2].Trim();

            // 处理可选的classifier和type，兼容 classifier@type 与 classifier:type 两种格式
            string classifier = string.Empty;
            string type = "jar";
            if (parts.Length >= 4)
            {
                var classifierPart = parts[3].Trim();
                if (classifierPart.Contains('@', StringComparison.Ordinal))
                {
                    var classifierParts = classifierPart.Split('@', 2);
                    classifier = classifierParts[0].Trim();
                    type = classifierParts.Length > 1 && !string.IsNullOrWhiteSpace(classifierParts[1])
                        ? classifierParts[1].Trim()
                        : "jar";
                }
                else
                {
                    classifier = classifierPart;
                    if (parts.Length >= 5 && !string.IsNullOrWhiteSpace(parts[4]))
                    {
                        type = parts[4].Trim();
                    }
                }
            }

            // 验证基础部分有效性
            if (string.IsNullOrEmpty(group) || string.IsNullOrEmpty(artifact) || string.IsNullOrEmpty(version))
            {
                Trace.WriteLine($"Maven坐标包含空值：{maven}");
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
            public string assetsSource = "https://resources.download.minecraft.net/";
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
            string JsonContent = await File.ReadAllTextAsync(Path.Combine(gameDir, "versions", ver, $"{ver}.json"));//$"{gameDir}/versions/{ver}/{ver}.json"
            JObject data = JObject.Parse(JsonContent);
            if (data == null)
            {
                throw new FileLoadException("Invalid Json file");
            }
            if (data.ContainsKey("inheritsFrom"))
            {
                inheritsFrom = data["inheritsFrom"]!.ToString();
            }
            return inheritsFrom;
        }

        public async Task<List<MissFileData>> GetMissLibrariesAsync(string version, string gameDir)
        {
            List<MissFileData> missFiles = new List<MissFileData>();
            string JsonContent = await File.ReadAllTextAsync(Path.Combine(gameDir, "versions", version, $"{version}.json")); //$"{gameDir}/versions/{version}/{version}.json"
            var lib = GetLibraries(JsonContent);
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
                    if (GeneralHelper.VerifyFileSha1(Path.Combine(gameDir, "libraries", path), item.Hash))//$"{gameDir}/libraries/{path}"
                    {
                        continue; //如果文件存在且 sha1校验通过则跳过
                    }
                    else
                    {
                        MissFileData missFile = new MissFileData();
                        missFile.Name = item.Name;
                        missFile.Path = Path.Combine(gameDir, "libraries", path); //$"{gameDir}/libraries/{path}"
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
            var missMainJar = await GetMissMainJarAsync(version, gameDir)!;
            if (!string.IsNullOrEmpty(missMainJar!.Path))
            {
                missFiles.Add(missMainJar);
            }
            return missFiles;
        }

        public async Task<List<MissFileData>> GetMissLibrariesFromJsonAsync(string JsonContent, string versionId, string gameDir)
        {
            List<MissFileData> missFiles = new List<MissFileData>();
            var lib = GetLibraries(JsonContent);

            //如果没有继承版本，则直接使用当前版本的库
            if (lib == null || lib.Count == 0)
            {
                throw new Exception("未找到任何库文件");
            }

            foreach (var item in lib)
            {
                string path = item.Path;
                if (!string.IsNullOrEmpty(item.Hash))
                {
                    if (GeneralHelper.VerifyFileSha1(Path.Combine(gameDir, "libraries", path), item.Hash))//$"{gameDir}/libraries/{path}"
                    {
                        continue; //如果文件存在且 sha1校验通过则跳过
                    }
                    else
                    {
                        MissFileData missFile = new MissFileData();
                        missFile.Name = item.Name;
                        missFile.Path = Path.Combine(gameDir, "libraries", path); //$"{gameDir}/libraries/{path}"
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
            var missMainJar = await GetMissMainJarFromJsonAsync(JsonContent, versionId, gameDir);
            if (missMainJar != null && !string.IsNullOrEmpty(missMainJar.Path))
            {
                missFiles.Add(missMainJar);
            }
            return missFiles;
        }

        public async Task<MissFileData?> GetMissMainJarFromJsonAsync(string jsonContent, string versionId, string gameDir)
        { 
            MissFileData missMainJar = new MissFileData();
            JObject data = JObject.Parse(jsonContent);
            if (data == null)
            {
                throw new FileLoadException("Invalid Json file");
            }

            string sha1 = data["downloads"]?["client"]?["sha1"]?.ToString() ?? string.Empty;
            if (!string.IsNullOrEmpty(sha1))
            {
                if (File.Exists(Path.Combine(gameDir, "versions", versionId, $"{versionId}.jar")) && GeneralHelper.VerifyFileSha1(Path.Combine(gameDir, "versions", versionId, $"{versionId}.jar"), sha1))
                {
                    return null; //如果文件存在且 sha1校验通过则返回null
                }
                else
                {
                    missMainJar.Name = $"{versionId}.jar";
                    missMainJar.Path = Path.Combine(gameDir, "versions", versionId, $"{versionId}.jar");
                    missMainJar.Url = data["downloads"]?["client"]?["url"]?.ToString() ?? string.Empty;
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
            return missMainJar;
        }

        public async Task<MissFileData?> GetMissMainJarAsync(string version, string gameDir)
        {
            MissFileData missMainJar = new MissFileData();
            string JsonContent = await File.ReadAllTextAsync(Path.Combine(gameDir, "versions", version, $"{version}.json")); //$"{gameDir}/versions/{version}/{version}.json"
            JObject data = JObject.Parse(JsonContent);
            if (data == null)
            {
                throw new FileLoadException("Invalid Json file");
            }

            string sha1 = data["downloads"]?["client"]?["sha1"]?.ToString() ?? string.Empty;
            if (!string.IsNullOrEmpty(sha1))
            {
                if (!GeneralHelper.VerifyFileSha1(Path.Combine(gameDir, "versions", version, $"{version}.jar"), sha1)) //$"{gameDir}/versions/{version}/{version}.jar"
                {
                    missMainJar.Name = $"{version}.jar";
                    missMainJar.Path = Path.Combine(gameDir, "versions", version, $"{version}.jar");
                    missMainJar.Url = data["downloads"]?["client"]?["url"]?.ToString() ?? string.Empty;
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
                //如果没有继承版本，则直接使用当前版本的主Jar
                if (File.Exists(Path.Combine(gameDir, "versions", version, $"{version}.jar")) && GeneralHelper.VerifyFileSha1(Path.Combine(gameDir, "versions", version, $"{version}.jar"), sha1))
                {
                    return null; //如果文件存在且 sha1校验通过则返回null
                }
                else
                {
                    missMainJar.Name = $"{version}.jar";
                    missMainJar.Path = Path.Combine(gameDir, "versions", version, $"{version}.jar");
                    missMainJar.Url = data["downloads"]?["client"]?["url"]?.ToString() ?? string.Empty;
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
            else
            {
                //如果有继承版本，则获取继承版本的主Jar
                string inheritsFrom = await GetInheritsFrom(version, gameDir);
                string inheritsJsonContent = await File.ReadAllTextAsync(Path.Combine(gameDir, "versions", inheritsFrom, $"{inheritsFrom}.json"));
                JObject inheritsData = JObject.Parse(inheritsJsonContent);
                if (inheritsData == null)
                {
                    throw new FileLoadException("Invalid Json file");
                }
                string inheritsSha1 = inheritsData["downloads"]?["client"]?["sha1"]?.ToString() ?? string.Empty;
                if (!string.IsNullOrEmpty(inheritsSha1))
                {
                    if (!GeneralHelper.VerifyFileSha1(Path.Combine(gameDir, "versions", inheritsFrom, $"{inheritsFrom}.jar"), inheritsSha1)) //$"{gameDir}/versions/{inheritsFrom}/{inheritsFrom}.jar"
                    {
                        missMainJar.Name = $"{inheritsFrom}.jar";
                        missMainJar.Path = Path.Combine(gameDir, "versions", inheritsFrom, $"{inheritsFrom}.jar");
                        missMainJar.Url = inheritsData["downloads"]?["client"]?["url"]?.ToString() ?? string.Empty;
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
            string JsonContent = await File.ReadAllTextAsync(Path.Combine(gameDir, "versions", version, $"{version}.json"));//$"{gameDir}/versions/{version}/{version}.json"
            JObject data = JObject.Parse(JsonContent);
            if (data == null)
            {
                throw new FileLoadException("Invalid Json file");
            }

            if (data.ContainsKey("assetIndex"))
            {
                var assetIndexObj = (JObject)data["assetIndex"]!;
                string assetsIndexPath = string.Empty;
                //检查 assetIndex
                if (assetIndexObj.ContainsKey("id"))
                {
                    string assetId = assetIndexObj["id"]!.ToString();
                    string sha1 = assetIndexObj["sha1"]!.ToString();
                    string url = assetIndexObj["url"]!.ToString();
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
                    JObject assetsData = JObject.Parse(assetsJsonContent);
                    if (assetsData.ContainsKey("objects"))
                    {
                        JObject assetObj = (JObject)assetsData["objects"]!;
                        foreach (var item in assetObj)
                        {
                            string assetName = item.Key;
                            JObject assetDetails = (JObject)item.Value!;
                            string assetHash = assetDetails["hash"]!.ToString();
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
            if (!string.IsNullOrEmpty(await GetInheritsFrom(version, gameDir)))
            {
                var inheritsFromVer = await GetInheritsFrom(version, gameDir);
                JsonContent = await File.ReadAllTextAsync(Path.Combine(gameDir, "versions", inheritsFromVer, $"{inheritsFromVer}.json"));//$"{gameDir}/versions/{inheritsFromVer}/{inheritsFromVer}.json"
                data = JObject.Parse(JsonContent);
                if (data == null)
                {
                    throw new FileLoadException("Invalid Json file");
                }

                if (data.ContainsKey("assetIndex"))
                {
                    var assetIndexObj = (JObject)data["assetIndex"]!;
                    string assetsIndexPath = string.Empty;
                    //检查 assetIndex
                    if (assetIndexObj.ContainsKey("id"))
                    {
                        string assetId = assetIndexObj["id"]!.ToString();
                        string sha1 = assetIndexObj["sha1"]!.ToString();
                        string url = assetIndexObj["url"]!.ToString();
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
                        JObject assetsData = JObject.Parse(assetsJsonContent);
                        if (assetsData.ContainsKey("objects"))
                        {
                            JObject assetObj = (JObject)assetsData["objects"]!;
                            foreach (var item in assetObj)
                            {
                                string assetName = item.Key;
                                JObject assetDetails = (JObject)item.Value!;
                                string assetHash = assetDetails["hash"]!.ToString();
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
            return missFiles;
        }

        public async Task<List<MissFileData>> GetMissAssetsFromJsonAsync(string jsonContent, string versionId, string gameDir)
        {
            List<MissFileData> missFiles = new List<MissFileData>();
            JObject data = JObject.Parse(jsonContent);
            if (data == null)
            {
                throw new FileLoadException("Invalid Json file");
            }

            if (data.ContainsKey("assetIndex"))
            {
                var assetIndexObj = (JObject)data["assetIndex"]!;
                string assetsIndexPath = string.Empty;
                //检查 assetIndex
                if (assetIndexObj.ContainsKey("id"))
                {
                    string assetId = assetIndexObj["id"]!.ToString();
                    string sha1 = assetIndexObj["sha1"]!.ToString();
                    string url = assetIndexObj["url"]!.ToString();
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
                    JObject assetsData = JObject.Parse(assetsJsonContent);
                    if (assetsData.ContainsKey("objects"))
                    {
                        JObject assetObj = (JObject)assetsData["objects"]!;
                        foreach (var item in assetObj)
                        {
                            string assetName = item.Key;
                            JObject assetDetails = (JObject)item.Value!;
                            string assetHash = assetDetails["hash"]!.ToString();
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
            return missFiles;
        }

        public async Task<List<MissFileData>> GetAllMissFilesAsync(string version, string gameDir)
        {
            List<MissFileData> missFiles = new List<MissFileData>();
            var libFiles = await GetMissLibrariesAsync(version, gameDir);
            if (libFiles != null && libFiles.Count > 0)
            {
                missFiles.AddRange(libFiles);
            }

            var assetsFiles = await GetMissAssetsAsync(version, gameDir);
            if (assetsFiles != null && assetsFiles.Count > 0)
            {
                missFiles.AddRange(assetsFiles);
            }
            return missFiles;
        }

        /// <summary>
        /// 获取Json中所有缺失文件列表
        /// </summary>
        /// <param name="jsonContent"></param>
        /// <param name="versionId"></param>
        /// <param name="gameDir"></param>
        /// <returns></returns>
        public async Task<List<MissFileData>> GetAllMissFilesFromJsonAsync(string jsonContent, string versionId, string gameDir)
        {
            List<MissFileData> missFiles = new List<MissFileData>();
            var libFiles = await GetMissLibrariesFromJsonAsync(jsonContent, versionId, gameDir);
            if (libFiles != null && libFiles.Count > 0)
            {
                missFiles.AddRange(libFiles);
            }

            var assetsFiles = await GetMissAssetsFromJsonAsync(jsonContent,versionId, gameDir);
            if (assetsFiles != null && assetsFiles.Count > 0)
            {
                missFiles.AddRange(assetsFiles);
            }
            return missFiles;
        }
    }
}
