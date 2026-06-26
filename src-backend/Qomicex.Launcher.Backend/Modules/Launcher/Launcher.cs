using System.Text.Json;
using System.Text.Json.Nodes;
using Qomicex.Launcher.Backend.Modules.Helpers;
using Qomicex.Launcher.Backend.Resources;
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Text;
using static Qomicex.Launcher.Backend.DataModules;
using static Qomicex.Launcher.Backend.DataModules.DataDetails;

namespace Qomicex.Launcher.Backend.Modules.Launcher
{
    /// <summary>
    /// Minecraft 启动参数构建器 - 负责构建启动参数
    /// </summary>
    public class Launcher
    {
        public struct LogLevels
        {
            public const string DEBUG = "DEBUG";
            public const string INFO = "INFO";
            public const string WARN = "WARN";
            public const string ERROR = "ERROR";
            public const string FATAL = "FATAL";
        }

        public class LauncherParam : DataDetails.Launcher
        {
            public string GameDir = string.Empty;
            public string LauncherName = string.Empty;
            public new DataDetails.Java Java = new DataDetails.Java();
            public bool FullScreen = false;
            public string Width = "854";
            public string Height = "480";
        }

        /// <summary>
        /// 读取版本JSON文件
        /// </summary>
        public string ReadVersionJson(string version, string gameDir)
        {
            string jsonPath = Path.Combine(gameDir, "versions", version, $"{version}.json");
            if (File.Exists(jsonPath))
            {
                return File.ReadAllText(jsonPath);
            }
            else
            {
                throw new FileNotFoundException($"Version file not found: {jsonPath}");
            }
        }

        /// <summary>
        /// 构建启动参数字符串
        /// </summary>
        public string SelectParam(LauncherParam param, string launcherName)
        {
            Modules.Helpers.GeneralHelper helper = new Modules.Helpers.GeneralHelper();
            List<string> paramList = new List<string>();
            string jsonContent = string.Empty;
            string inheritsFrom = string.Empty;

            jsonContent = ReadVersionJson(param.Version, param.GameDir);

            if (!string.IsNullOrEmpty(jsonContent))
            {
                paramList.Add("-XX:+UseG1GC");
                paramList.Add("-XX:-UseAdaptiveSizePolicy");
                paramList.Add("-XX:-OmitStackTraceInFastThrow");
                paramList.Add("-Dfml.ignoreInvalidMinecraftCertificates=True");
                paramList.Add("-Dfml.ignorePatchDiscrepancies=True");
                paramList.Add("-Dlog4j2.formatMsgNoLookups=true");
                if (!string.IsNullOrEmpty(param.AdditionalParam))
                {
                    paramList.AddRange(param.AdditionalParam.Split(' '));
                }

                if (Environment.OSVersion.Platform == PlatformID.Win32NT)
                {
                    System.Version os_ver = Environment.OSVersion.Version;
                    if (os_ver.Major >= 10)
                    {
                        paramList.Add("-Dos.name=\"Windows 10\"");
                        paramList.Add("-Dos.version=\"10.0\"");
                    }
                }

                paramList.Add($"-Dminecraft.launcher.brand=\"{launcherName}\"");
                paramList.Add("-Dminecraft.launcher.version=23");

                if (JsonNode.Parse(jsonContent) is not JsonObject data)
                    throw new FileLoadException("Invalid Json file");

                if (data.TryGetPropertyValue("inheritsFrom", out JsonNode? inheritsFromToken))
                {
                    inheritsFrom = inheritsFromToken!.GetValue<string>();
                }

                string inheritJsonContent = string.Empty;
                string inheritsFromVer = string.Empty;
                if (inheritsFrom != string.Empty)
                {
                    var versions = helper.SearchVersionsFast(param.GameDir);
                    foreach (var ver in versions)
                    {
                        if (ver == inheritsFrom)
                        {
                            string inheritJsonPath = Path.Combine(param.GameDir, "versions", ver, $"{ver}.json");
                            if (helper.CheckVersionAvailablity(param.GameDir, ver).Code == (int)State.StateCode.Available)
                            {
                                inheritJsonContent = File.ReadAllText(inheritJsonPath);
                                inheritsFromVer = ver;
                            }
                        }
                    }
                }

                List<string> jvmParams = new List<string>();
                jvmParams.AddRange(GetJVMParams(jsonContent));
                if (!string.IsNullOrEmpty(inheritJsonContent))
                {
                    jvmParams.AddRange(GetJVMParams(inheritJsonContent));
                }
                jvmParams.RemoveAll(item => paramList.Contains(item));
                jvmParams.RemoveAll(p => p.StartsWith("-Dos.version="));
                jvmParams.RemoveAll(p => p.StartsWith("-Dos.name="));

                if (param.Java.VersionID >= 18)
                {
                    jvmParams.RemoveAll(p => p.StartsWith("-Dfile.encoding="));
                }
                else if (param.Java.VersionID > 8)
                {
                    jvmParams.RemoveAll(p => p.StartsWith("-Dstdout.encoding="));
                    jvmParams.RemoveAll(p => p.StartsWith("-Dstderr.encoding="));
                }
                paramList.AddRange(jvmParams);

                if (Environment.OSVersion.Platform == PlatformID.Win32NT)
                {
                    if (param.Java.VersionID <= 19)
                    {
                        File.WriteAllBytes(Path.Combine(Path.GetTempPath(), "JavaLaunchWrapper.jar"), Resources.Resources.JavaLaunchWrapper);
                        paramList.Add("-jar");
                        paramList.Add($"\"{Path.Combine(Path.GetTempPath(), "JavaLaunchWrapper.jar")}\"");
                    }
                }

                if (data.ContainsKey("mainClass"))
                {
                    var mainClass = data["mainClass"]!.GetValue<string>();
                    if (!string.IsNullOrEmpty(mainClass))
                    {
                        paramList.Add(mainClass);
                    }
                    else
                    {
                        if (!string.IsNullOrEmpty(inheritJsonContent))
                        {
                            var inheritMainClass = (JsonNode.Parse(inheritJsonContent) as JsonObject)?["mainClass"]?.GetValue<string>() ?? throw new Exception("无法找到MainClass");
                            if (!string.IsNullOrEmpty(inheritMainClass))
                            {
                                paramList.Add(inheritMainClass);
                            }
                            else
                            {
                                throw new Exception("mainClass 字段不存在或格式错误");
                            }
                        }
                        else
                        {
                            throw new Exception("mainClass 字段不存在或格式错误");
                        }
                    }
                }

                paramList.AddRange(GetGameParams(jsonContent));
                if (!string.IsNullOrEmpty(inheritJsonContent))
                {
                    paramList.AddRange(GetGameParams(inheritJsonContent));
                }
                paramList.Add("--width");
                paramList.Add(param.Width);
                paramList.Add("--height");
                paramList.Add(param.Height);

                string assetsIndex = string.Empty;
                string uuid = string.Empty;
                string accessToken = string.Empty;

                if (JsonNode.Parse(jsonContent) is JsonObject parsedJson && parsedJson.ContainsKey("assetIndex"))
                {
                    var assetIndexObj = data["assetIndex"] as JsonObject;
                    assetsIndex = assetIndexObj?["id"]?.GetValue<string>() ?? string.Empty;
                }
                else if (JsonNode.Parse(inheritJsonContent) is JsonObject parsedInheritJson && parsedInheritJson.ContainsKey("assetIndex"))
                {
                    var assetIndexObj = parsedInheritJson["assetIndex"] as JsonObject;
                    assetsIndex = assetIndexObj?["id"]?.GetValue<string>() ?? string.Empty;
                }

                if (param.Account.LoginMethod == "Legacy")
                {
                    uuid = Modules.Helpers.AccountHelper.NameToUuid(param.Account.Name);
                    accessToken = "0";
                }
                else
                {
                    uuid = param.Account.Uuid;
                    accessToken = param.Account.AccessToken;
                }

                List<string> classPathLibraries = new List<string>();
                string classPathLibrariesString = string.Empty;
                if (!string.IsNullOrEmpty(inheritJsonContent))
                    classPathLibraries.AddRange(GetClassPathLibraries(inheritJsonContent, param.GameDir));
                classPathLibraries.AddRange(GetClassPathLibraries(jsonContent, param.GameDir));
                string mainJarPath = Path.Combine(param.GameDir, "versions", param.Version, $"{param.Version}.jar");
                if (!File.Exists(mainJarPath))
                {
                    mainJarPath = Path.Combine(param.GameDir, "versions", inheritsFromVer, $"{inheritsFromVer}.jar");
                }
                classPathLibraries.Add(mainJarPath);
                classPathLibrariesString = string.Join(SystemInfoHelper.Separator, classPathLibraries);

                var gameVersionDir = string.Empty;
                if (param.DevideVersion)
                {
                    gameVersionDir = Path.Combine(param.GameDir, "versions", param.Version);
                }
                else
                {
                    gameVersionDir = param.GameDir;
                }

                if (paramList.Contains("optifine.OptiFineTweaker"))
                {
                    int index = paramList.IndexOf("optifine.OptiFineTweaker");
                    paramList.RemoveAt(index);
                    paramList.RemoveAt(index - 1);
                    paramList.Add("--tweakClass");
                    paramList.Add("optifine.OptiFineTweaker");
                }
                else if (paramList.Contains("optifine.OptiFineForgeTweaker"))
                {
                    int index = paramList.IndexOf("optifine.OptiFineForgeTweaker");
                    paramList.RemoveAt(index);
                    paramList.RemoveAt(index - 1);
                    paramList.Add("--tweakClass");
                    paramList.Add("optifine.OptiFineForgeTweaker");
                }

                string paramString = string.Join(" ", paramList);
                paramString = paramString.Replace("${max_memory}", param.MaxMemory)
                    .Replace("${natives_directory}", GeneralHelper.FormatDirPath(Path.Combine(param.GameDir, "versions", param.Version, $"{param.Version}-natives").TrimEnd(SystemInfoHelper.Separator).ToString()))
                    .Replace("${launcher_name}", $"\"{launcherName}\"")
                    .Replace("${classpath_separator}", SystemInfoHelper.Separator)
                    .Replace("${game_assets}", GeneralHelper.FormatDirPath(Path.Combine(param.GameDir, "assets").TrimEnd(SystemInfoHelper.Separator).ToString()))
                    .Replace("${uuid}", uuid)
                    .Replace("${user_properties}", "{}")
                    .Replace("${version_type}", $"\"{launcherName}\"")
                    .Replace("${user_type}", param.Account.LoginMethod)
                    .Replace("${auth_access_token}", param.Account.AccessToken)
                    .Replace("${assets_index_name}", assetsIndex)
                    .Replace("${assets_root}", GeneralHelper.FormatDirPath(Path.Combine(param.GameDir, "assets")))
                    .Replace("${classpath}", $"\"{classPathLibrariesString}\"")
                    .Replace("${game_directory}", GeneralHelper.FormatDirPath(gameVersionDir.TrimEnd(SystemInfoHelper.Separator).ToString()))
                    .Replace("${version_name}", $"\"{param.Version}\"")
                    .Replace("${auth_uuid}", uuid)
                    .Replace("${auth_player_name}", param.Account.Name)
                    .Replace("${library_directory}", GeneralHelper.FormatDirPath(Path.Combine(param.GameDir, "libraries").TrimEnd(SystemInfoHelper.Separator).ToString()))
                    .Replace("${launcher_version}", "23")
                    .Replace("${authlib_injector_param}", "");
                return paramString;
            }
            else
            {
                throw new Exception("版本Json文件内容为空");
            }
        }

        private List<string> GetClassPathLibraries(string jsonStr, string gameDir)
        {
            var list = new List<string>();
            var libs = Modules.Helpers.Resources.LocalResourceHelper.GetLibraries(jsonStr);
            var OfJar = new List<string>();
            foreach (var lib in libs)
            {
                if (lib.IsCpLib)
                {
                    if (lib.Name.ToLower().Contains("optifine"))
                    {
                        OfJar.Add(Path.Combine(gameDir, "libraries", lib.Path));
                        continue;
                    }
                    list.Add(Path.Combine(gameDir, "libraries", lib.Path));
                }
            }
            if (OfJar.Count != 0)
            {
                list.AddRange(OfJar);
            }
            return list;
        }

        private List<string> GetJVMParams(string jsonData)
        {
            var paramList = new List<string>();
            if (JsonNode.Parse(jsonData) is not JsonObject datas)
                throw new FileLoadException("Invalid Json file");

            if (datas.ContainsKey("arguments"))
            {
                var data = (JsonObject)datas["arguments"]!;
                if (data.ContainsKey("jvm"))
                {
                    JsonArray? jvmList = data["jvm"]! as JsonArray;
                    foreach (var item in jvmList!)
                    {
                        string value = string.Empty;
                        bool rulesSuitable = false;

                        if (item is JsonObject obj)
                        {
                            rulesSuitable = Helpers.Resources.LocalResourceHelper.CheckRules(obj!);

                            if (obj!.ContainsKey("value"))
                            {
                                var valToken = obj["value"];

                                if (valToken is JsonValue val && val.TryGetValue<string>(out var strVal))
                                {
                                    value = strVal;
                                }
                                else if (valToken is JsonArray arr)
                                {
                                    foreach (var subVal in arr)
                                    {
                                        if (subVal is JsonValue sv && sv.TryGetValue<string>(out var s))
                                            value += $"{s} ";
                                    }
                                }
                            }
                        }
                        else if (item is JsonValue jv && jv.TryGetValue<string>(out var s))
                        {
                            rulesSuitable = true;
                            value = s;
                        }

                        if (rulesSuitable)
                        {
                            paramList.Add(value.TrimEnd(' '));
                        }
                    }
                }
                else
                {
                    paramList.Add("-Djava.library.path=${natives_directory}");
                    paramList.Add("-cp");
                    paramList.Add("${classpath}");
                    paramList.Add("${authlib_injector_param}");
                    paramList.Add("-Xmn256m");
                    paramList.Add("-Xmx${max_memory}m");
                }
            }
            else
            {
                paramList.Add("-Djava.library.path=${natives_directory}");
                paramList.Add("-cp");
                paramList.Add("${classpath}");
                paramList.Add("${authlib_injector_param}");
                paramList.Add("-Xmn256m");
                paramList.Add("-Xmx${max_memory}m");
            }
            return paramList;
        }

        private List<string> GetGameParams(string jsonData)
        {
            var list = new List<string>();
            if (JsonNode.Parse(jsonData) is not JsonObject datas)
                throw new FileLoadException("Invalid Json file");

            if (datas.ContainsKey("arguments"))
            {
                var data = (JsonObject)datas["arguments"]!;
                if (data!.ContainsKey("game"))
                {
                    JsonArray? gameList = data["game"] as JsonArray;
                    foreach (var item in gameList!)
                    {
                        if (item is JsonValue jv && jv.TryGetValue<string>(out var s))
                        {
                            list.Add(s);
                        }
                    }
                }
            }
            if (datas.ContainsKey("minecraftArguments"))
            {
                list.AddRange(datas["minecraftArguments"]!.GetValue<string>().Split(' '));
            }
            return list;
        }

        /// <summary>
        /// 解压Natives库
        /// </summary>
        public bool UnzipNatives(string jsonPath, string minecraftPath, string versionPath)
        {
            try
            {
                string jsonContent = File.ReadAllText(jsonPath);
                var libs = Helpers.Resources.LocalResourceHelper.GetLibraries(jsonContent);
                List<Helpers.Resources.LocalResourceHelper.LibInfo> validNatives = libs.Where(lib => lib.IsNativesLib).ToList();

                if (JsonNode.Parse(jsonContent) is not JsonObject json)
                    throw new FileLoadException("Invalid Json file");

                if (json.ContainsKey("inheritsFrom"))
                {
                    string inheritsFrom = string.Empty;
                    if (json.TryGetPropertyValue("inheritsFrom", out JsonNode? inheritsFromToken))
                    {
                        inheritsFrom = inheritsFromToken!.GetValue<string>();
                    }

                    string inheritJsonContent = string.Empty;
                    string inheritsFromVer = string.Empty;
                    if (inheritsFrom != string.Empty)
                    {
                        Modules.Helpers.GeneralHelper helper = new Modules.Helpers.GeneralHelper();
                        var versions = helper.SearchVersionsFast(minecraftPath);
                        foreach (var ver in versions)
                        {
                            if (ver == inheritsFrom)
                            {
                                string inheritJsonPath = Path.Combine(minecraftPath, "versions", ver, $"{ver}.json");
                                if (helper.CheckVersionAvailablity(minecraftPath, ver).Code == (int)State.StateCode.Available)
                                {
                                    inheritJsonContent = File.ReadAllText(inheritJsonPath);
                                    inheritsFromVer = ver;
                                }
                            }
                        }
                    }

                    libs = Helpers.Resources.LocalResourceHelper.GetLibraries(inheritJsonContent);
                    validNatives.AddRange(libs.Where(lib => lib.IsNativesLib).ToList());
                }

                if (validNatives.Count == 0)
                {
                    Debug.WriteLine("没有需要解压的Natives文件");
                    return true;
                }

                string versionName = Path.GetFileName(versionPath);
                string nativesDir = Path.Combine(versionPath, $"{versionName}-natives");
                Directory.CreateDirectory(nativesDir);

                foreach (var native in validNatives)
                {
                    string[] parts = native.FullName!.Split(':');
                    if (parts.Length < 3)
                    {
                        Debug.WriteLine($"无效的库格式: {native.FullName}");
                        continue;
                    }

                    string zipFilePath = Path.Combine(minecraftPath, "libraries", native.Path);

                    if (!Helpers.GeneralHelper.Unzip(zipFilePath, nativesDir))
                    {
                        Debug.WriteLine($"解压失败：{zipFilePath}");
                        return false;
                    }
                }
                Helpers.GeneralHelper.DeleteExcept(nativesDir, ".dll");
                return true;
            }
            catch (Exception ex)
            {
                Debug.WriteLine($"解压Natives失败：{ex.Message}");
                return false;
            }
        }
    }
}
