using Newtonsoft.Json.Linq;
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Text;

namespace Qomicex.Core.Modules.Helpers.Installers
{
    public class InstallerBase
    {
        public enum InstallType
        {
            Forge,
            Fabric,
            NeoForge,
            Quilt,
            LiteLoader,
            OptiFine,
        }

        internal string MergeJson(string MainVersionJson, string MergedVersionJson)
        {
            try
            {
                JObject MainJson = JObject.Parse(MainVersionJson);
                JObject MergedJson = JObject.Parse(MergedVersionJson);

                MainJson.Merge(MergedJson, new JsonMergeSettings
                {
                    MergeArrayHandling = MergeArrayHandling.Union, // 去重合并数组
                    MergeNullValueHandling = MergeNullValueHandling.Ignore, // 忽略 null
                    PropertyNameComparison = StringComparison.OrdinalIgnoreCase, // 属性名不区分大小写
                });
                return MainJson.ToString();
            }
            catch
            {
                return string.Empty;
            }
        }

        internal void MergeDirectories(string sourceDir, string targetDir)
        {
            // 确保源目录存在
            if (!Directory.Exists(sourceDir)) return;

            // 如果目标目录不存在，先创建
            Directory.CreateDirectory(targetDir);

            // 遍历源目录中的所有文件
            foreach (string file in Directory.GetFiles(sourceDir))
            {
                string fileName = Path.GetFileName(file);
                string destFile = Path.Combine(targetDir, fileName);

                // 将文件复制到目标目录，如果存在就覆盖
                File.Copy(file, destFile, true);
            }

            // 递归处理子目录
            foreach (string directory in Directory.GetDirectories(sourceDir))
            {
                string dirName = Path.GetFileName(directory);
                string targetSubDir = Path.Combine(targetDir, dirName);
                MergeDirectories(directory, targetSubDir);
            }
        }

        internal string MergeVersionJson(string MainVersionJson, string MergedVersionJson, string? DefaultVersionID)
        {
            var mainVersionObj = JObject.Parse(MainVersionJson);

            var JsonData = MergeJson(MainVersionJson, MergedVersionJson);
            var Json = JObject.Parse(JsonData);
            Json["id"] = mainVersionObj["id"];
            Json.Remove("inheritsFrom");
            if (!string.IsNullOrEmpty(DefaultVersionID))
            {
                Json["id"] = DefaultVersionID;
            }
            JsonData = Json.ToString();
            return JsonData;
        }

        /// <summary>
        /// Merges two version JSON files into the main version file, updating the main version's ID and removing
        /// inheritance information.
        /// </summary>
        /// <remarks>If either the main version or the merged version JSON file does not exist, the method
        /// will log an error and return false. The method also handles exceptions that may occur during the file
        /// operations.</remarks>
        /// <param name="MainVersion">The name of the main version to which the merged version will be applied. This version must exist in the
        /// specified game directory.</param>
        /// <param name="MergedVersion">The name of the version to be merged into the main version. This version must also exist in the specified
        /// game directory.</param>
        /// <param name="GameDir">The directory path where the version folders are located. This path must be valid and accessible.</param>
        /// <returns>True if the merge operation is successful; otherwise, false.</returns>
        internal bool MergeVersion(string MainVersion, string MergedVersion, string GameDir)
        {
            try
            {
                string mainVersionDir = Path.Combine(GameDir, "versions", MainVersion);
                string mergedVersionDir = Path.Combine(GameDir, "versions", MergedVersion);
                string mainVersionJsonPath = Path.Combine(mainVersionDir, $"{MainVersion}.json");
                string mergedVersionJsonPath = Path.Combine(mergedVersionDir, $"{MergedVersion}.json");

                if (!File.Exists(mainVersionJsonPath))
                {
                    Trace.WriteLine($"主版本JSON文件不存在：{mainVersionJsonPath}");
                    return false;
                }
                if (!File.Exists(mergedVersionJsonPath))
                {
                    Trace.WriteLine($"待合并版本JSON文件不存在：{mergedVersionJsonPath}");
                    return false;
                }

                string mainJsonContent = File.ReadAllText(mainVersionJsonPath);
                string mergedJsonContent = File.ReadAllText(mergedVersionJsonPath);

                // 合并JSON并修改字段
                string mergedJsonResult = MergeJson(mainJsonContent, mergedJsonContent);
                JObject jsonObj = JObject.Parse(mergedJsonResult);
                jsonObj["id"] = MainVersion;
                jsonObj.Remove("inheritsFrom");
                string finalJsonContent = jsonObj.ToString();

                MergeDirectories(mergedVersionDir, mainVersionDir);

                File.WriteAllText(mainVersionJsonPath, finalJsonContent);

                return true;
            }
            catch (System.Exception ex)
            {
                Trace.WriteLine($"合并版本失败：{ex.Message}\n堆栈信息：{ex.StackTrace}");
                return false;
            }
        }
        internal async Task<bool> DownloadFileAsync(string url, string destinationPath, int maxRedirects = 5)
        {
            // 限制最大重定向次数，防止循环重定向
            if (maxRedirects <= 0)
            {
                throw new Exception($"超过最大重定向次数（{maxRedirects}次），可能存在循环重定向\nURL: {url}");
            }

            var httpClientHandler = new HttpClientHandler
            {
                AllowAutoRedirect = false,
                UseCookies = true,
                AutomaticDecompression = System.Net.DecompressionMethods.GZip | System.Net.DecompressionMethods.Deflate
            };

            using (var client = new HttpClient(httpClientHandler))
            {
                client.Timeout = TimeSpan.FromMinutes(10);
                client.DefaultRequestHeaders.UserAgent.ParseAdd("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Safari/537.36");

                try
                {
                    var response = await client.GetAsync(url, HttpCompletionOption.ResponseHeadersRead);

                    // 处理重定向（301永久重定向、302临时重定向）
                    if (response.StatusCode is System.Net.HttpStatusCode.MovedPermanently
                        or System.Net.HttpStatusCode.Found
                        or System.Net.HttpStatusCode.Redirect
                        or System.Net.HttpStatusCode.SeeOther
                        or System.Net.HttpStatusCode.TemporaryRedirect)
                    {
                        var redirectUrl = response.Headers.Location?.ToString();
                        if (string.IsNullOrEmpty(redirectUrl))
                        {
                            throw new Exception($"重定向失败：服务器未返回Location地址\n原URL: {url}");
                        }

                        // 处理相对路径（将相对地址转换为绝对地址）
                        if (!Uri.IsWellFormedUriString(redirectUrl, UriKind.Absolute))
                        {
                            if (Uri.TryCreate(new Uri(url), redirectUrl, out var absoluteUri))
                            {
                                redirectUrl = absoluteUri.ToString();
                            }
                            else
                            {
                                throw new Exception($"重定向地址无效（相对路径无法转换为绝对路径）\n原URL: {url}\n相对路径: {redirectUrl}");
                            }
                        }

                        Trace.WriteLine($"重定向（剩余次数：{maxRedirects - 1}）：{url} → {redirectUrl}");
                        // 递归调用，重定向次数减1
                        return await DownloadFileAsync(redirectUrl, destinationPath, maxRedirects - 1);
                    }

                    if (!response.IsSuccessStatusCode)
                    {
                        throw new Exception($"下载失败：{response.ReasonPhrase}（状态码：{(int)response.StatusCode}）\nURL: {url}");
                    }

                    var dir = Path.GetDirectoryName(destinationPath);
                    if (!string.IsNullOrEmpty(dir) && !Directory.Exists(dir))
                    {
                        Directory.CreateDirectory(dir);
                    }

                    using (var fileStream = new FileStream(destinationPath, FileMode.Create, FileAccess.Write, FileShare.None))
                    {
                        await response.Content.CopyToAsync(fileStream);
                    }

                    return true;
                }
                catch (Exception ex)
                {
                    throw new Exception($"下载文件失败（URL: {url}）：{ex.Message}");
                }
            }
        }

        internal string MavenToPath(string maven)
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
            string group = parts[0].Trim();
            string artifact = parts[1].Trim();
            string version = parts[2].Trim();

            // 处理可选的classifier和type，兼容 classifier@type 与 classifier:type 两种格式
            // 最后一部分的 @ 表示扩展名（HMCL同样处理：检查最后一个部分）
            string classifier = string.Empty;
            string type = "jar";

            // 3部分坐标时，version可能带@extension（如 group:artifact:version@zip）
            if (parts.Length < 4 && version.Contains('@', StringComparison.Ordinal))
            {
                var verParts = version.Split('@', 2);
                version = verParts[0].Trim();
                type = verParts.Length > 1 && !string.IsNullOrWhiteSpace(verParts[1])
                    ? verParts[1].Trim()
                    : "jar";
            }

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

        internal string GetJarMainClass(string jarPath)
        {
            var manifestBytes = GeneralHelper.ReadSpecifyFileFromZip(jarPath, "META-INF/MANIFEST.MF");
            var mf = Encoding.UTF8.GetString(manifestBytes);
            if (string.IsNullOrEmpty(mf))
            {
                return string.Empty;
            }
            var lines = mf.Split(new[] { '\r', '\n' }, StringSplitOptions.RemoveEmptyEntries);
            foreach (var line in lines)
            {
                if (line.StartsWith("Main-Class: ", StringComparison.OrdinalIgnoreCase))
                {
                    return line.Substring("Main-Class: ".Length).Trim();
                }
            }
            return string.Empty;
        }

        internal (int exitCode, string output) RunInstallProcess(string arguments, string program)
        {
            using var process = new Process();

            bool isWindows = OperatingSystem.IsWindows();

            if (program == null)
            {
                program = isWindows ? "cmd.exe" : (File.Exists("/bin/bash") ? "/bin/bash" : "/bin/sh");
            }

            process.StartInfo.FileName = program;

            if (isWindows)
            {
                process.StartInfo.Arguments = program == "cmd.exe" ? $"/c {arguments}" : arguments;
            }
            else
            {
                process.StartInfo.Arguments = program == "/bin/bash" ? $"-c \"{arguments}\"" : arguments;
            }

            process.StartInfo.UseShellExecute = false;
            process.StartInfo.RedirectStandardOutput = true;
            process.StartInfo.RedirectStandardError = true;
            process.StartInfo.CreateNoWindow = true;

            process.Start();
            string stdout = process.StandardOutput.ReadToEnd();
            string stderr = process.StandardError.ReadToEnd();
            process.WaitForExit();

            return (process.ExitCode, (stdout + "\n" + stderr).Trim());
        }


        public enum DownloadSource
        {
            Official = 0, // 官方源
            Bmclapi = 1 // BMCLAPI 源
        }
        internal struct SourcesList
        {
            public string Original;
            public string Default;
        }
    }
}
