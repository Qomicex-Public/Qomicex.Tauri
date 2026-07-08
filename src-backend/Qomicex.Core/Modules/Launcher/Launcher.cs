using Newtonsoft.Json.Linq;
using Qomicex.Core.Modules.Helpers;
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Text;
using static Qomicex.Core.DataModules;
using static Qomicex.Core.DataModules.DataDetails;

namespace Qomicex.Core.Modules.Launcher
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

            // 读取Json文件
            jsonContent = ReadVersionJson(param.Version, param.GameDir);

            // 处理Json
            if (!string.IsNullOrEmpty(jsonContent))
            {
                // 设置初始参数
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

                // Windows适配
                if (OperatingSystem.IsWindows())
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

                // 解析Json
                JObject data = JObject.Parse(jsonContent);
                if (data == null)
                {
                    throw new FileLoadException("Invalid Json file");
                }

                if (data.TryGetValue("inheritsFrom", out JToken? inheritsFromToken))
                {
                    inheritsFrom = inheritsFromToken.ToString();
                }

                string inheritJsonContent = string.Empty;
                string inheritsFromVer = string.Empty;
                if (inheritsFrom != string.Empty)
                {
                    // 如果有继承的版本，则获取继承版本的Json内容
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
                    // 如果有继承版本，则获取继承版本的JVM参数
                    jvmParams.AddRange(GetJVMParams(inheritJsonContent));
                }
                jvmParams.RemoveAll(item => paramList.Contains(item));// 去除重复的JVM参数
                jvmParams.RemoveAll(p => p.StartsWith("-Dos.version="));
                jvmParams.RemoveAll(p => p.StartsWith("-Dos.name="));

                // 处理Java编码
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

                // 拼接 mainClass
                if (data.ContainsKey("mainClass"))
                {
                    var mainClass = data["mainClass"]!.ToString();
                    if (!string.IsNullOrEmpty(mainClass))
                    {
                        paramList.Add(mainClass);
                    }
                    else
                    {
                        if (!string.IsNullOrEmpty(inheritJsonContent))
                        {
                            // 如果有继承版本，则获取继承版本的mainClass
                            var inheritMainClass = JObject.Parse(inheritJsonContent)["mainClass"]?.ToString() ?? throw new Exception("无法找到MainClass");
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

                // 获取Game参数
                paramList.AddRange(GetGameParams(jsonContent));
                if (!string.IsNullOrEmpty(inheritJsonContent))
                {
                    // 如果有继承版本，则获取继承版本的Game参数
                    paramList.AddRange(GetGameParams(inheritJsonContent));
                }
                paramList.Add("--width");
                paramList.Add(param.Width);
                paramList.Add("--height");
                paramList.Add(param.Height);

                // 获取其他参数
                string assetsIndex = string.Empty;
                string uuid = string.Empty;
                string accessToken = string.Empty;

                // 获取 assetIndex
                if (JObject.Parse(jsonContent).ContainsKey("assetIndex"))
                {
                    var assetIndexObj = data["assetIndex"] as JObject;
                    assetsIndex = assetIndexObj?["id"]?.ToString() ?? string.Empty;
                }
                else if (JObject.Parse(inheritJsonContent).ContainsKey("assetIndex"))
                {
                    var assetIndexObj = JObject.Parse(inheritJsonContent)["assetIndex"] as JObject;
                    assetsIndex = assetIndexObj?["id"]?.ToString() ?? string.Empty;
                }

                // 处理账户
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

                // 获取ClassPathLibraries
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

                // 处理版本隔离路径
                var gameVersionDir = string.Empty;
                if (param.DevideVersion)
                {
                    gameVersionDir = Path.Combine(param.GameDir, "versions", param.Version);
                }
                else
                {
                    gameVersionDir = param.GameDir;
                }

                // 处理OptiFine与Forge兼容
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

                // 替换参数
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
                    .Replace("${authlib_injector_param}", param.AdditionalParam);
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
            //optifine Jar缓存
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
                //如果有OptiFine Jar，则添加到ClassPath末尾(OptiFine的Jar必须在末尾，否则会导致无法启动)
                list.AddRange(OfJar);
            }
            return list;
        }

        private List<string> GetJVMParams(string jsonData)
        {
            var paramList = new List<string>();
            JObject datas = JObject.Parse(jsonData);
            if (datas == null)
            {
                throw new FileLoadException("Invalid Json file");
            }

            //获取jvm参数
            if (datas.ContainsKey("arguments"))
            {
                //arguments存在
                var data = (JObject)datas["arguments"]!;
                if (data.ContainsKey("jvm"))
                {
                    //jvm存在
                    JArray? jvmList = data["jvm"]! as JArray;
                    foreach (var item in jvmList!)
                    {
                        //检查参数
                        string value = string.Empty;
                        bool rulesSuitable = false;

                        if (item.Type == JTokenType.Object) // 处理对象项
                        {
                            // 解析 "rules"
                            var obj = (JObject?)item;
                            rulesSuitable = Helpers.Resources.LocalResourceHelper.CheckRules(obj!);

                            // 解析 "value"
                            if (obj!.ContainsKey("value"))
                            {
                                var valToken = obj["value"];

                                if (valToken!.Type == JTokenType.String)
                                {
                                    value = valToken.ToString();
                                }
                                else if (valToken.Type == JTokenType.Array)
                                {
                                    foreach (var subVal in valToken)
                                    {
                                        value += $"{subVal.ToString()} ";
                                    }
                                }
                            }
                        }
                        else if (item.Type == JTokenType.String) // 处理独立字符串项
                        {
                            rulesSuitable = true;
                            value = item.ToString();
                        }

                        // 如果满足条件，则添加到参数字符串
                        if (rulesSuitable)
                        {
                            if(value.Contains(" "))
                                value = $"\"{value}\"";
                            paramList.Add(value.TrimEnd(' '));
                        }
                    }
                }
                else
                {
                    //适配老版本Modloader Json (例如LiteLoader)
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
                //适配老版本Json
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
            JObject datas = JObject.Parse(jsonData);
            if (datas == null)
            {
                throw new FileLoadException("Invalid Json file");
            }

            //获取game参数
            if (datas.ContainsKey("arguments"))
            {
                var data = (JObject)datas["arguments"]!;
                if (data!.ContainsKey("game"))
                {
                    JArray? gameList = data["game"] as JArray;
                    foreach (var item in gameList!)
                    {
                        //检查参数
                        if (item.Type == JTokenType.String) // 处理独立字符串项
                        {
                            list.Add(item.ToString());
                        }
                    }
                }
            }
            //适配老版本及混合Json
            if (datas.ContainsKey("minecraftArguments"))
            {
                list.AddRange(datas["minecraftArguments"]!.ToString().Split(' '));
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
                var json = JObject.Parse(jsonContent);

                // 创建Natives目录
                string versionName = Path.GetFileName(versionPath);
                string nativesDir = Path.Combine(versionPath, $"{versionName}-natives");
                Directory.CreateDirectory(nativesDir);

                // 收集所有需要解压的natives库
                var allNatives = new List<Helpers.Resources.LocalResourceHelper.LibInfo>();

                var libs = Helpers.Resources.LocalResourceHelper.GetLibraries(jsonContent);
                allNatives.AddRange(libs.Where(lib => lib.IsNativesLib));

                if (json.ContainsKey("inheritsFrom"))
                {
                    string inheritsFrom = string.Empty;
                    if (json.TryGetValue("inheritsFrom", out JToken? inheritsFromToken))
                    {
                        inheritsFrom = inheritsFromToken.ToString();
                    }

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
                                    string inheritJsonContent = File.ReadAllText(inheritJsonPath);
                                    var inheritLibs = Helpers.Resources.LocalResourceHelper.GetLibraries(inheritJsonContent);
                                    allNatives.AddRange(inheritLibs.Where(lib => lib.IsNativesLib));
                                }
                            }
                        }
                    }
                }

                if (allNatives.Count == 0)
                {
                    Trace.WriteLine("没有需要解压的Natives文件");
                    return true;
                }

                // 逐个解压natives JAR到natives目录（保留JAR内部目录结构）
                foreach (var native in allNatives)
                {
                    string zipFilePath = Path.Combine(minecraftPath, "libraries", native.Path);
                    if (System.IO.File.Exists(zipFilePath))
                    {
                        Helpers.GeneralHelper.Unzip(zipFilePath, nativesDir);
                        Trace.WriteLine($"已解压Natives: {native.FullName}");
                    }
                    else
                    {
                        Trace.WriteLine($"Natives文件不存在: {zipFilePath}");
                    }
                }

                // 同时解压到版本JSON中 java.library.path 指定的子目录（如果有）
                string javaLibDir = ParseJavaLibraryPath(json, nativesDir);
                if (!string.IsNullOrEmpty(javaLibDir) && javaLibDir != nativesDir)
                {
                    Directory.CreateDirectory(javaLibDir);
                    foreach (var native in allNatives)
                    {
                        string zipFilePath = Path.Combine(minecraftPath, "libraries", native.Path);
                        if (System.IO.File.Exists(zipFilePath))
                        {
                            Helpers.GeneralHelper.Unzip(zipFilePath, javaLibDir);
                        }
                    }
                    // 扁平化 java.library.path 子目录中的原生库文件
                    string keepExt = OperatingSystem.IsWindows() ? ".dll" : OperatingSystem.IsMacOS() ? ".dylib" : ".so";
                    FlattenNatives(javaLibDir, keepExt);
                    Trace.WriteLine($"已解压Natives到java.library.path子目录: {javaLibDir}");
                }

                return true;
            }
            catch (Exception ex)
            {
                Trace.WriteLine($"解压Natives失败：{ex.Message}");
                return false;
            }
        }

        /// <summary>
        /// 从版本JSON的JVM参数中解析 java.library.path 的实际路径
        /// </summary>
        private static string ParseJavaLibraryPath(JObject json, string nativesDir)
        {
            try
            {
                if (json.TryGetValue("arguments", out JToken? argsToken) && argsToken is JObject argsObj
                    && argsObj.TryGetValue("jvm", out JToken? jvmToken) && jvmToken is JArray jvmArray)
                {
                    foreach (var item in jvmArray)
                    {
                        string value = string.Empty;
                        if (item.Type == JTokenType.Object && item is JObject obj)
                        {
                            if (obj.TryGetValue("value", out JToken? valToken))
                            {
                                if (valToken.Type == JTokenType.String)
                                    value = valToken.ToString();
                                else if (valToken.Type == JTokenType.Array)
                                {
                                    foreach (var sub in valToken)
                                        value += sub.ToString() + " ";
                                }
                            }
                        }
                        else if (item.Type == JTokenType.String)
                        {
                            value = item.ToString();
                        }

                        if (value.Contains("java.library.path", StringComparison.OrdinalIgnoreCase))
                        {
                            int eqIdx = value.IndexOf('=');
                            if (eqIdx >= 0)
                            {
                                string libPath = value.Substring(eqIdx + 1).Trim();
                                libPath = libPath.Replace("${natives_directory}", nativesDir);
                                if (!string.IsNullOrEmpty(libPath) && libPath != nativesDir)
                                    return libPath;
                            }
                        }
                    }
                }
            }
            catch { }
            return nativesDir;
        }

        /// <summary>
        /// 将嵌套目录中的原生库文件（.so/.dll/.dylib）扁平化到其所在子目录的根
        /// </summary>
        private static void FlattenNatives(string dir, string keepExt)
        {
            if (!Directory.Exists(dir))
                return;

            // 递归遍历所有子目录
            foreach (string subDir in Directory.GetDirectories(dir))
            {
                FlattenNatives(subDir, keepExt);
            }

            // 将当前目录子目录中的原生库文件移动到当前目录
            foreach (string subDir in Directory.GetDirectories(dir))
            {
                foreach (string filePath in Directory.GetFiles(subDir))
                {
                    string ext = Path.GetExtension(filePath);
                    if (string.Equals(ext, keepExt, StringComparison.OrdinalIgnoreCase))
                    {
                        string destPath = Path.Combine(dir, Path.GetFileName(filePath));
                        if (!System.IO.File.Exists(destPath))
                        {
                            File.Move(filePath, destPath);
                        }
                    }
                }
                // 如果子目录为空则删除
                if (Directory.GetFileSystemEntries(subDir).Length == 0)
                {
                    try { Directory.Delete(subDir); } catch { }
                }
            }
        }
    }
}
