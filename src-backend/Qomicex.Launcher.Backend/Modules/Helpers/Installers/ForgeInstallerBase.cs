using System;
using System.Buffers.Text;
using System.Collections.Generic;
using System.Diagnostics;
using System.Linq;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace Qomicex.Launcher.Backend.Modules.Helpers.Installers
{
    public class ForgeInstallerBase : InstallerBase
    {
        internal string BaseUrl = string.Empty;
        internal List<SourcesList> SourceMappings = new List<SourcesList>();
        public int SourceId;
        internal string gameDir = string.Empty;
        internal string gameVersion = string.Empty;
        internal string _installerPath = string.Empty;
        internal string _mainJarPath = string.Empty;

        internal static string? SafeGetString(JsonNode? node)
        {
            if (node is JsonValue jv && jv.TryGetValue<string>(out var val))
                return val;
            return null;
        }
        public string ResolveUrl(string originalUrl)
        {
            var mapping = SourceMappings.FirstOrDefault(m => m.Original == originalUrl);
            return mapping.Default ?? originalUrl;
        }


        internal async Task RunProcessor(JsonObject ipObj, JsonObject processor, string versionId, string gameDir, string javaPath)
        {
            if (processor == null)
            {
                return;
            }

            // Check sides filter — skip processors not targeting client
            if (processor["sides"] is JsonArray sidesArr && sidesArr.Count > 0)
            {
                bool sideMatch = false;
                foreach (var side in sidesArr)
                {
                    if (string.Equals(SafeGetString(side), "client", StringComparison.OrdinalIgnoreCase))
                    {
                        sideMatch = true;
                        break;
                    }
                }
                if (!sideMatch)
                {
                    Debug.WriteLine("Processor的sides配置不包含client，跳过");
                    return;
                }
            }

            string separator = OperatingSystem.IsWindows() ? ";" : ":";

            string processorJar = SafeGetString(processor["jar"]) ?? "未知Jar";

            Debug.WriteLine("检查Processor输出文件是否已存在且校验通过");
            var outputPaths = ReplaceOutputs(ipObj, processor, gameDir);
            foreach (var output in outputPaths)
            {
                string rawKey = output.Key.TrimEnd(']').TrimStart('[');
                string libMavenPath = MavenToPath(rawKey);
                string filePath = Path.Combine(this.gameDir, "libraries", libMavenPath);
                filePath = filePath.Substring(0, filePath.Length - 4);
                filePath = filePath.Contains("@") ? filePath.Replace("@", ".") : $"{filePath}.jar";
                string fileSha1 = output.Value.Trim('\'');

                Debug.WriteLine($"校验文件: {filePath}，预期SHA1: {fileSha1}");
                if (File.Exists(filePath))
                {
                    Debug.WriteLine("文件已存在，开始SHA1校验");
                    var result = GeneralHelper.VerifyFileSha1(filePath, fileSha1);
                    if (result)
                    {
                        Debug.WriteLine("文件校验通过，跳过Processor执行");
                        return;
                    }
                    Debug.WriteLine("文件校验失败，需要重新执行Processor");
                }
                else
                {
                    Debug.WriteLine("文件不存在，需要执行Processor生成");
                }
            }

            Debug.WriteLine("处理Processor依赖Jar文件");
            var jar = SafeGetString(processor["jar"]);
            if (string.IsNullOrEmpty(jar))
            {
                throw new Exception("Processor Jar路径未定义");
            }

            string jarMavenPath = MavenToPath(jar);
            if (string.IsNullOrEmpty(jarMavenPath))
            {
                throw new Exception($"Processor Jar格式错误: {jar}");
            }
            string jarPath = Path.GetFullPath(Path.Combine(gameDir, "libraries", jarMavenPath));
            Debug.WriteLine($"Processor依赖Jar路径: {jarPath}");

            if (!File.Exists(jarPath))
            {
                Debug.WriteLine("依赖Jar不存在，尝试下载");
                string downloadUrl = $"{BaseUrl}/{jarMavenPath.Replace('\\', '/')}";
                try
                {
                    await DownloadFileAsync(downloadUrl, jarPath);
                    Debug.WriteLine($"依赖Jar下载成功: {jarPath}");
                }
                catch (Exception ex)
                {
                    throw new Exception($"下载缺失的库文件失败: {jarPath}\n{ex.Message}");
                }
            }

            Debug.WriteLine("构造Processor执行的classpath");
            var classpathSet = new HashSet<string>();

            static void AddLibrariesFromJson(JsonNode? json, string gameDir, HashSet<string> set)
            {
                if (json?["libraries"] is JsonArray arr)
                    foreach (var lib in arr)
                    {
                        var name = SafeGetString(lib?["name"]);
                        if (string.IsNullOrEmpty(name)) continue;
                        var mavenPath = MavenToPath(name);
                        if (string.IsNullOrEmpty(mavenPath)) continue;
                        var jarPath = Path.GetFullPath(Path.Combine(gameDir, "libraries", mavenPath));
                        if (File.Exists(jarPath))
                            set.Add(jarPath);
                    }
            }

            AddLibrariesFromJson(ipObj, gameDir, classpathSet);

            // Libraries from version.json inside installer (loader-specific)
            if (!string.IsNullOrEmpty(_installerPath))
            {
                try
                {
                    var versionRaw = Encoding.UTF8.GetString(
                        GeneralHelper.ReadSpecifyFileFromZip(_installerPath, "version.json"));
                    AddLibrariesFromJson(JsonNode.Parse(versionRaw), gameDir, classpathSet);
                }
                catch { }
            }

            // Libraries from vanilla version.json (already downloaded, includes Gson etc.)
            var vanillaJsonPath = Path.Combine(this.gameDir, "versions", this.gameVersion, $"{this.gameVersion}.json");
            if (File.Exists(vanillaJsonPath))
            {
                try
                {
                    var vanillaRaw = File.ReadAllText(vanillaJsonPath);
                    AddLibrariesFromJson(JsonNode.Parse(vanillaRaw), gameDir, classpathSet);
                }
                catch { }
            }

            // Add processor classpath entries
            if (processor["classpath"] is JsonArray classpathArr)
            {
                foreach (var cp in classpathArr)
                {
                    string cpStr = SafeGetString(cp!) ?? string.Empty;
                    string cpMavenPath = MavenToPath(cpStr);
                    if (string.IsNullOrEmpty(cpMavenPath)) throw new Exception($"Classpath格式错误: {cpStr}");

                    string cpJarPath = Path.GetFullPath(Path.Combine(gameDir, "libraries", cpMavenPath));
                    Debug.WriteLine($"处理classpath依赖: {cpJarPath}");

                    if (!File.Exists(cpJarPath))
                    {
                        Debug.WriteLine("classpath依赖不存在，尝试下载");
                        string downloadUrl = $"{BaseUrl}/{cpMavenPath.Replace('\\', '/')}";
                        await DownloadFileAsync(downloadUrl, cpJarPath);
                    }
                    classpathSet.Add(cpJarPath);
                }
            }

            string cps = string.Join(separator, classpathSet);
            Debug.WriteLine($"构造完成的classpath: {cps}");

            Debug.WriteLine("构造Processor执行参数");
            string args = string.Empty;
            var argsArr = processor["args"] as JsonArray;
            if (argsArr != null && argsArr.Count > 0)
            {
                foreach (var arg in argsArr)
                {
                    args += $"{SafeGetString(arg!) ?? ""} ";
                }
                args = args.TrimEnd(' ');
                Debug.WriteLine($"替换前的参数: {args}");
                args = ReplaceArguments(ipObj, args);
                Debug.WriteLine($"替换后的参数: {args}");
            }
            else
            {
                Debug.WriteLine("Processor的args为空");
            }

            Debug.WriteLine($"获取Jar主类: {jarPath}");
            var mainClass = GetJarMainClass(jarPath);
            if (string.IsNullOrEmpty(mainClass))
            {
                throw new Exception($"无法获取Jar主类: {jarPath}");
            }
            Debug.WriteLine($"Jar主类: {mainClass}");

            string command = $"-cp \"{cps}{separator}{jarPath}\" {mainClass} {args}";
            Debug.WriteLine($"执行Processor命令: {javaPath} {command}");
            if (RunInstallProcess(command, javaPath) != 0)
            {
                throw new Exception($"Processor执行失败，命令: {javaPath} {command}");
            }

            Debug.WriteLine("Processor执行完成，校验输出文件");
            outputPaths = ReplaceOutputs(ipObj, processor, gameDir);
            foreach (var output in outputPaths)
            {
                string rawKey = output.Key.TrimEnd(']').TrimStart('[');
                string libMavenPath = MavenToPath(rawKey);
                string filePath = Path.Combine(this.gameDir, "libraries", libMavenPath);
                filePath = filePath.Substring(0, filePath.Length - 4);
                filePath = filePath.Contains("@") ? filePath.Replace("@", ".") : $"{filePath}.jar";
                string fileSha1 = output.Value.Trim('\'');

                Debug.WriteLine($"校验文件: {filePath}，预期SHA1: {fileSha1}");
                if (!File.Exists(filePath))
                {
                    throw new Exception($"Processor执行失败: 输出文件不存在 - {filePath}");
                }

                var result = GeneralHelper.VerifyFileSha1(filePath, fileSha1);
                if (!result)
                {
                    throw new Exception($"输出文件SHA1不匹配: {filePath}");
                }
                Debug.WriteLine("输出文件校验通过");
            }

            Debug.WriteLine($"Processor {processorJar} 执行成功");
        }

        internal Dictionary<string, string> ReplaceOutputs(JsonObject ipObj, JsonObject processor, string gameDir)
        {
            Debug.WriteLine("解析并替换Processor输出文件路径");
            var outputs = new Dictionary<string, string>();

            if (processor["outputs"] == null)
            {
                Debug.WriteLine("Processor的outputs节点为空，返回空字典");
                return outputs;
            }
            var outputsObj = processor["outputs"]!.AsObject();
            foreach (var output in outputsObj)
            {
                string key = output.Key;
                string value = SafeGetString(output.Value) ?? string.Empty;
                Debug.WriteLine($"原始输出配置: {key}={value}");

                string replacedStr = ReplaceArguments(ipObj, $"{key}={value}");
                var splitArr = replacedStr.Split('=');
                if (splitArr.Length != 2)
                {
                    Debug.WriteLine($"替换后的输出格式错误: {replacedStr}，跳过该配置");
                    continue;
                }

                outputs[splitArr[0]] = splitArr[1];
                Debug.WriteLine($"替换后输出配置: {splitArr[0]}={splitArr[1]}");
            }
            Debug.WriteLine($"解析完成 {outputs.Count} 个输出配置");
            return outputs;
        }

        internal string ReplaceArguments(JsonObject ipObj, string args)
        {
            Debug.WriteLine($"替换前的参数: {args}");

            if (ipObj["data"] != null)
            {
                var dataObj = ipObj["data"]!.AsObject();
                foreach (var prop in dataObj)
                {
                    var name = prop.Key;
                    var value = SafeGetString(prop.Value?["client"]);
                    if (!string.IsNullOrEmpty(value))
                    {
                        // Resolve [maven:coord@type] to local library path
                        if (value.StartsWith('[') && value.EndsWith(']'))
                        {
                            var mavenPath = MavenToPath(value.TrimStart('[').TrimEnd(']'));
                            if (!string.IsNullOrEmpty(mavenPath))
                            {
                                var resolved = Path.GetFullPath(Path.Combine(this.gameDir, "libraries", mavenPath));
                                Debug.WriteLine($"解析Maven坐标 {value} -> {resolved}");
                                value = resolved;
                            }
                        }

                        string placeholder = $"{{{name}}}";
                        if (args.Contains(placeholder))
                        {
                            args = args.Replace(placeholder, value);
                            Debug.WriteLine($"替换变量 {placeholder} -> {value}");
                        }
                    }
                }
            }
            else
            {
                Debug.WriteLine("ipObj的data节点为空，跳过data变量替换");
            }

            var replacements = new Dictionary<string, string>
    {
        { "{MINECRAFT_VERSION}", this.gameVersion },
        { "{MINECRAFT_JAR}", _mainJarPath },
        { "{ROOT}", this.gameDir },
        { "{LIBRARY_DIR}", Path.Combine(this.gameDir, "libraries") },
        { "{INSTALLER}", _installerPath },
        { "{SIDE}", "client" }
    };

            foreach (var kvp in replacements)
            {
                if (args.Contains(kvp.Key))
                {
                    args = args.Replace(kvp.Key, kvp.Value);
                    Debug.WriteLine($"替换固定变量 {kvp.Key} -> {kvp.Value}");
                }
            }

            // Resolve any remaining [maven:coord@type] literals not from data variables
            args = System.Text.RegularExpressions.Regex.Replace(args, @"\[([^\]]+)\]",
                match =>
                {
                    var coord = match.Groups[1].Value;
                    var libPath = MavenToPath(coord);
                    if (!string.IsNullOrEmpty(libPath))
                    {
                        var resolved = Path.GetFullPath(Path.Combine(this.gameDir, "libraries", libPath));
                        Debug.WriteLine($"解析硬编码Maven坐标 {match.Value} -> {resolved}");
                        return resolved;
                    }
                    return match.Value;
                });

            Debug.WriteLine($"替换后的参数: {args}");
            return args;
        }
    }
}
