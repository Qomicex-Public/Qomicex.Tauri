using Newtonsoft.Json.Linq;
using System;
using System.Buffers.Text;
using System.Collections.Generic;
using System.Diagnostics;
using System.Text.RegularExpressions;
using System.Text;

namespace Qomicex.Core.Modules.Helpers.Installers
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
        public string ResolveUrl(string originalUrl)
        {
            var mapping = SourceMappings.FirstOrDefault(m => m.Original == originalUrl);
            return mapping.Default ?? originalUrl;
        }


        internal async Task RunProcessor(JObject ipObj, JObject processor, string versionId, string gameDir, string javaPath)
        {
            if (processor == null)
            {
                //Processor对象为空，跳过执行
                return;
            }
            string separator = OperatingSystem.IsWindows() ? ";" : ":";

            string processorJar = processor["jar"]?.ToString() ?? "未知Jar";

            //检查构造是否已完成
            Trace.WriteLine("检查Processor输出文件是否已存在且校验通过");
            var outputPaths = ReplaceOutputs(ipObj, processor, gameDir);
            foreach (var output in outputPaths)
            {
                string filePath = ResolveProcessorOutputPath(output.Key);
                string fileSha1 = output.Value.Trim('\'');

                Trace.WriteLine($"校验文件: {filePath}，预期SHA1: {fileSha1}");
                if (File.Exists(filePath))
                {
                    Trace.WriteLine("文件已存在，开始SHA1校验");
                    var result = GeneralHelper.VerifyFileSha1(filePath, fileSha1);
                    if (result)
                    {
                        Trace.WriteLine("文件校验通过，跳过Processor执行");
                        return;
                    }
                    Trace.WriteLine("文件校验失败，需要重新执行Processor");
                }
                else
                {
                    Trace.WriteLine("文件不存在，需要执行Processor生成");
                }
            }

            //处理Processor依赖Jar
            Trace.WriteLine("处理Processor依赖Jar文件");
            var jar = processor["jar"]?.ToString();
            if (string.IsNullOrEmpty(jar))
            {
                throw new Exception("Processor Jar路径未定义");
            }

            var jarParts = jar.Split(':');
            if (jarParts.Length < 3)
            {
                throw new Exception($"Processor Jar格式错误: {jar}");
            }

            string jarPath = ResolveLibraryPath(gameDir, jar);
            Trace.WriteLine($"Processor依赖Jar路径: {jarPath}");

            if (!File.Exists(jarPath))
            {
                Trace.WriteLine("依赖Jar不存在，尝试下载");
                string downloadUrl = $"{BaseUrl}/{jarParts[0].Replace(".", "/")}/{jarParts[1]}/{jarParts[2]}/{jarParts[1]}-{jarParts[2]}.jar";
                try
                {
                    await DownloadFileAsync(downloadUrl, jarPath);
                    Trace.WriteLine($"依赖Jar下载成功: {jarPath}");
                }
                catch (Exception ex)
                {
                    throw new Exception($"下载缺失的库文件失败: {jarPath}\n{ex.Message}");
                }
            }

            //构造classpath
            Trace.WriteLine("构造Processor执行的classpath");
            string cps = string.Empty;
            var classpathArr = processor["classpath"] as JArray;
            if (classpathArr == null || classpathArr.Count == 0)
            {
                Trace.WriteLine("Processor的classpath为空");
            }
            else
            {
                foreach (var cp in classpathArr)
                {
                    string cpStr = cp.ToString();
                    var cpParts = cpStr.Split(':');
                    if (cpParts.Length < 3)
                    {
                        throw new Exception($"Classpath格式错误: {cpStr}");
                    }

                    string cpJarPath = ResolveLibraryPath(gameDir, cpStr);
                    Trace.WriteLine($"处理classpath依赖: {cpJarPath}");

                    if (!File.Exists(cpJarPath))
                    {
                        Trace.WriteLine("classpath依赖不存在，尝试下载");
                        string downloadUrl = $"{BaseUrl}/{cpParts[0].Replace(".", "/")}/{cpParts[1]}/{cpParts[2]}/{cpParts[1]}-{cpParts[2]}.jar";
                        try
                        {
                            await DownloadFileAsync(downloadUrl, cpJarPath);
                            Trace.WriteLine($"classpath依赖下载成功: {cpJarPath}");
                        }
                        catch (Exception ex)
                        {
                            throw new Exception($"下载缺失的库文件失败: {cpJarPath}\n{ex.Message}");
                        }
                    }
                    cps += $"{cpJarPath}{separator}";
                }
                cps = cps.TrimEnd(';', ':');
                Trace.WriteLine($"构造完成的classpath: {cps}");
            }

            //构造arguments
            Trace.WriteLine("构造Processor执行参数");
            string args = string.Empty;
            var argsArr = processor["args"] as JArray;
            if (argsArr != null && argsArr.Count > 0)
            {
                foreach (var arg in argsArr)
                {
                    args += $"{arg} ";
                }
                args = args.TrimEnd(' ');
                Trace.WriteLine($"替换前的参数: {args}");
                args = ReplaceArguments(ipObj, args);
                Trace.WriteLine($"替换后的参数: {args}");
            }
            else
            {
                Trace.WriteLine("Processor的args为空");
            }

            //获取主类并执行
            Trace.WriteLine($"获取Jar主类: {jarPath}");
            var mainClass = GetJarMainClass(jarPath);
            if (string.IsNullOrEmpty(mainClass))
            {
                throw new Exception($"无法获取Jar主类: {jarPath}");
            }
            Trace.WriteLine($"Jar主类: {mainClass}");

            string command = $"-cp \"{cps}{separator}{jarPath}\" {mainClass} {args}";
            Trace.WriteLine($"执行Processor命令: {javaPath} {command}");
            var (exitCode, procOutput) = RunInstallProcess(command, javaPath);
            if (exitCode != 0)
            {
                Trace.WriteLine($"Processor输出: {procOutput}");
                throw new Exception($"Processor执行失败 (exit={exitCode})，命令: {javaPath} {command}\n输出: {procOutput}");
            }

            //校验输出文件
            Trace.WriteLine("Processor执行完成，校验输出文件");
            outputPaths = ReplaceOutputs(ipObj, processor, gameDir);
            foreach (var output in outputPaths)
            {
                string filePath = ResolveProcessorOutputPath(output.Key);
                string fileSha1 = output.Value.Trim('\'');

                Trace.WriteLine($"校验文件: {filePath}，预期SHA1: {fileSha1}");
                if (!File.Exists(filePath))
                {
                    throw new Exception($"Processor执行失败: 输出文件不存在 - {filePath}");
                }

                var result = GeneralHelper.VerifyFileSha1(filePath, fileSha1);
                if (!result)
                {
                    throw new Exception($"输出文件SHA1不匹配: {filePath}");
                }
                Trace.WriteLine("输出文件校验通过");
            }

            Trace.WriteLine($"Processor {processorJar} 执行成功");
        }

        internal string ResolveLibraryPath(string gameDir, string mavenCoordinate)
        {
            var relativePath = MavenToPath(mavenCoordinate);
            if (string.IsNullOrWhiteSpace(relativePath))
            {
                throw new Exception($"无效的Maven坐标: {mavenCoordinate}");
            }

            var normalizedRelativePath = relativePath.Replace('/', Path.DirectorySeparatorChar);
            return Path.Combine(gameDir, "libraries", normalizedRelativePath);
        }

        internal string ResolveProcessorOutputPath(string outputKey)
        {
            if (string.IsNullOrWhiteSpace(outputKey))
            {
                return string.Empty;
            }

            if (Path.IsPathRooted(outputKey))
            {
                if (!outputKey.StartsWith(this.gameDir, StringComparison.OrdinalIgnoreCase))
                {
                    throw new Exception($"Forge处理器输出路径越界: {outputKey} 不在游戏目录 {this.gameDir} 内");
                }
                return outputKey;
            }

            var rawKey = outputKey.TrimEnd(']').TrimStart('[');
            var libMavenPath = MavenToPath(rawKey);
            if (string.IsNullOrWhiteSpace(libMavenPath))
            {
                return outputKey;
            }

            return Path.Combine(this.gameDir, "libraries", libMavenPath.Replace('/', Path.DirectorySeparatorChar));
        }

        internal Dictionary<string, string> ReplaceOutputs(JObject ipObj, JObject processor, string gameDir)
        {
            Trace.WriteLine("解析并替换Processor输出文件路径");
            var outputs = new Dictionary<string, string>();

            if (processor["outputs"] == null)
            {
                Trace.WriteLine("Processor的outputs节点为空，返回空字典");
                return outputs;
            }
            foreach (var output in processor["outputs"]!)
            {
                var prop = (JProperty)output;
                string key = prop.Name;
                string value = prop.Value!.ToString();
                Trace.WriteLine($"原始输出配置: {key}={value}");

                string replacedStr = ReplaceArguments(ipObj, $"{key}={value}");
                var splitArr = replacedStr.Split('=');
                if (splitArr.Length != 2)
                {
                    Trace.WriteLine($"替换后的输出格式错误: {replacedStr}，跳过该配置");
                    continue;
                }

                outputs[splitArr[0]] = splitArr[1];
                Trace.WriteLine($"替换后输出配置: {splitArr[0]}={splitArr[1]}");
            }
            Trace.WriteLine($"解析完成 {outputs.Count} 个输出配置");
            return outputs;
        }

        internal string ReplaceArguments(JObject ipObj, string args)
        {
            Trace.WriteLine($"替换前的参数: {args}");

            //替换data节点中的变量
            if (ipObj["data"] != null)
            {
                var dataObj = (JObject)ipObj["data"]!;
                foreach (var prop in dataObj)
                {
                    var name = prop.Key;
                    var value = prop.Value?["client"]?.ToString();
                    if (!string.IsNullOrEmpty(value))
                    {
                        string placeholder = $"{{{name}}}";
                        if (args.Contains(placeholder))
                        {
                            var normalizedValue = NormalizeProcessorValue(value);
                            args = args.Replace(placeholder, normalizedValue);
                            Trace.WriteLine($"替换变量 {placeholder} -> {normalizedValue}");
                        }
                    }
                }
            }
            else
            {
                Trace.WriteLine("ipObj的data节点为空，跳过data变量替换");
            }

            //替换固定变量
            var replacements = new Dictionary<string, string>
    {
        { "{MINECRAFT_VERSION}", this.gameVersion },
        { "{MINECRAFT_JAR}", Path.IsPathRooted(_mainJarPath) ? _mainJarPath : Path.Combine(this.gameDir, _mainJarPath) },
        { "{ROOT}", this.gameDir },
        { "{LIBRARY_DIR}", $"{this.gameDir}/libraries" },
        { "{INSTALLER}", _installerPath },
        { "{SIDE}", "client" }
    };

            foreach (var kvp in replacements)
            {
                if (args.Contains(kvp.Key))
                {
                    args = args.Replace(kvp.Key, kvp.Value);
                    Trace.WriteLine($"替换固定变量 {kvp.Key} -> {kvp.Value}");
                }
            }

            args = ReplaceInlineMavenCoordinates(args);

            Trace.WriteLine($"替换后的参数: {args}");
            return args;
        }

        internal string NormalizeProcessorValue(string value)
        {
            if (string.IsNullOrWhiteSpace(value))
            {
                return value;
            }

            if (value.StartsWith('[') && value.EndsWith(']'))
            {
                var mavenCoordinate = value[1..^1];
                return ResolveLibraryPath(this.gameDir, mavenCoordinate);
            }

            return value.Trim('\'');
        }

        internal string ReplaceInlineMavenCoordinates(string value)
        {
            if (string.IsNullOrWhiteSpace(value))
            {
                return value;
            }

            var result = value;
            var matches = System.Text.RegularExpressions.Regex.Matches(value, "\\[(.+?)\\]");
            foreach (System.Text.RegularExpressions.Match match in matches)
            {
                if (!match.Success)
                {
                    continue;
                }

                var replacement = ResolveLibraryPath(this.gameDir, match.Groups[1].Value);
                result = result.Replace(match.Value, replacement, StringComparison.Ordinal);
            }

            return result;
        }

        internal List<string> ExtractMavenCoordinatesFromProcessors(JObject installProfileJson)
        {
            var coordinates = new List<string>();
            var processors = installProfileJson["processors"] as JArray;
            if (processors == null)
            {
                return coordinates;
            }

            foreach (var processor in processors.OfType<JObject>())
            {
                var args = processor["args"] as JArray;
                if (args == null)
                {
                    continue;
                }

                foreach (var arg in args)
                {
                    var text = arg?.ToString();
                    if (string.IsNullOrWhiteSpace(text))
                    {
                        continue;
                    }

                    var matches = Regex.Matches(text, "\\[(.+?)\\]");
                    foreach (Match match in matches)
                    {
                        if (match.Success)
                        {
                            coordinates.Add(match.Groups[1].Value);
                        }
                    }
                }
            }

            return coordinates;
        }

        internal bool ShouldRunProcessor(JObject processor, string side)
        {
            var sides = processor["sides"] as JArray;
            if (sides == null || sides.Count == 0)
            {
                return true;
            }

            return sides
                .Select(token => token?.ToString())
                .Any(value => string.Equals(value, side, StringComparison.OrdinalIgnoreCase));
        }
    }
}
