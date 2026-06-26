using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Linq;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace Qomicex.Launcher.Backend.Modules.Helpers.Installers
{
    public class InstallerBase
    {
        private static readonly HttpClient _sharedClient = new HttpClient(new HttpClientHandler
        {
            AllowAutoRedirect = true,
            UseCookies = true,
            AutomaticDecompression = System.Net.DecompressionMethods.GZip | System.Net.DecompressionMethods.Deflate
        })
        {
            Timeout = TimeSpan.FromMinutes(10),
            DefaultRequestHeaders = { { "User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Safari/537.36" } }
        };
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
                var mainObj = JsonNode.Parse(MainVersionJson)!.AsObject();
                var mergedObj = JsonNode.Parse(MergedVersionJson)!.AsObject();

                MergeJsonObjects(mainObj, mergedObj);

                return mainObj.ToJsonString();
            }
            catch
            {
                return string.Empty;
            }
        }

        internal static void MergeJsonObjects(JsonObject target, JsonObject source)
        {
            foreach (var kvp in source)
            {
                if (kvp.Value == null)
                    continue;

                if (kvp.Value is JsonObject sourceObj && target.TryGetPropertyValue(kvp.Key, out var targetVal) && targetVal is JsonObject targetObj)
                {
                    MergeJsonObjects(targetObj, sourceObj);
                }
                else if (kvp.Value is JsonArray sourceArr && target.TryGetPropertyValue(kvp.Key, out var targetArrVal) && targetArrVal is JsonArray targetArr)
                {
                    foreach (var item in sourceArr)
                    {
                        if (!targetArr.Any(x => JsonNode.DeepEquals(x, item)))
                        {
                            targetArr.Add(item?.DeepClone());
                        }
                    }
                }
                else
                {
                    target[kvp.Key] = kvp.Value?.DeepClone();
                }
            }
        }

        internal void MergeDirectories(string sourceDir, string targetDir)
        {
            if (!Directory.Exists(sourceDir)) return;

            Directory.CreateDirectory(targetDir);

            foreach (string file in Directory.GetFiles(sourceDir))
            {
                string fileName = Path.GetFileName(file);
                string destFile = Path.Combine(targetDir, fileName);

                File.Copy(file, destFile, true);
            }

            foreach (string directory in Directory.GetDirectories(sourceDir))
            {
                string dirName = Path.GetFileName(directory);
                string targetSubDir = Path.Combine(targetDir, dirName);
                MergeDirectories(directory, targetSubDir);
            }
        }

        internal string MergeVersionJson(string MainVersionJson, string MergedVersionJson, string? DefaultVersionID)
        {
            var mainVersionObj = JsonNode.Parse(MainVersionJson)!.AsObject();

            var JsonData = MergeJson(MainVersionJson, MergedVersionJson);
            var Json = JsonNode.Parse(JsonData)!.AsObject();
            Json["id"] = mainVersionObj["id"]?.DeepClone();
            Json.Remove("inheritsFrom");
            if (!string.IsNullOrEmpty(DefaultVersionID))
            {
                Json["id"] = JsonValue.Create(DefaultVersionID);
            }
            JsonData = Json.ToJsonString();
            return JsonData;
        }

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
                    Debug.WriteLine($"主版本JSON文件不存在：{mainVersionJsonPath}");
                    return false;
                }
                if (!File.Exists(mergedVersionJsonPath))
                {
                    Debug.WriteLine($"待合并版本JSON文件不存在：{mergedVersionJsonPath}");
                    return false;
                }

                string mainJsonContent = File.ReadAllText(mainVersionJsonPath);
                string mergedJsonContent = File.ReadAllText(mergedVersionJsonPath);

                string mergedJsonResult = MergeJson(mainJsonContent, mergedJsonContent);
                var jsonObj = JsonNode.Parse(mergedJsonResult)!.AsObject();
                jsonObj["id"] = JsonValue.Create(MainVersion);
                jsonObj.Remove("inheritsFrom");
                string finalJsonContent = jsonObj.ToJsonString();

                MergeDirectories(mergedVersionDir, mainVersionDir);

                File.WriteAllText(mainVersionJsonPath, finalJsonContent);

                return true;
            }
            catch (System.Exception ex)
            {
                Debug.WriteLine($"合并版本失败：{ex.Message}\n堆栈信息：{ex.StackTrace}");
                return false;
            }
        }
        internal async Task<bool> DownloadFileAsync(string url, string destinationPath)
        {
            try
            {
                var response = await _sharedClient.GetAsync(url, HttpCompletionOption.ResponseHeadersRead);

                for (int hop = 0; hop < 5 && (int)response.StatusCode is >= 300 and < 400; hop++)
                {
                    var location = response.Headers.Location;
                    if (location == null) break;
                    response.Dispose();
                    if (!location.IsAbsoluteUri)
                        location = new Uri(new Uri(url), location);
                    url = location.ToString();
                    response = await _sharedClient.GetAsync(url, HttpCompletionOption.ResponseHeadersRead);
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
            catch (Exception ex) when (ex is not Exception { Message: var m } || !m.StartsWith("下载失败"))
            {
                throw new Exception($"下载文件失败（URL: {url}）：{ex.Message}");
            }
        }

        internal static string MavenToPath(string maven)
        {
            if (string.IsNullOrWhiteSpace(maven))
            {
                Debug.WriteLine("Maven坐标为空，无法转换路径");
                return string.Empty;
            }

            string[] parts = maven.Split(':');

            if (parts.Length < 3)
            {
                Debug.WriteLine($"无效的Maven坐标格式：{maven}，至少需要3个部分（group:artifact:version）");
                return string.Empty;
            }

            string group = parts[0].Trim();
            string artifact = parts[1].Trim();
            string version = parts[2].Trim();

            string classifier = parts.Length >= 4 ? parts[3].Trim() : string.Empty;
            string type = parts.Length >= 5 ? parts[4].Trim() : "jar";

            if (!string.IsNullOrEmpty(classifier) && classifier.Contains('@'))
            {
                var atParts = classifier.Split('@', 2);
                classifier = atParts[0];
                if (atParts.Length > 1 && !string.IsNullOrWhiteSpace(atParts[1]))
                    type = atParts[1].Trim();
            }

            if (string.IsNullOrEmpty(group) || string.IsNullOrEmpty(artifact) || string.IsNullOrEmpty(version))
            {
                Debug.WriteLine($"Maven坐标包含空值：{maven}");
                return string.Empty;
            }

            string groupPath = group.Replace('.', '/');

            string fileName = $"{artifact}-{version}";
            if (!string.IsNullOrEmpty(classifier))
                fileName += $"-{classifier}";
            fileName += $".{type}";

            return $"{groupPath}/{artifact}/{version}/{fileName}";
        }

        internal string GetJarMainClass(string jarPath)
        {
            var raw = GeneralHelper.ReadSpecifyFileFromZip(jarPath, "META-INF/MANIFEST.MF");
            if (raw == null || raw.Length == 0)
                return string.Empty;
            var mf = Encoding.UTF8.GetString(raw);
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

        internal int RunInstallProcess(string arguments, string program)
        {
            using var process = new Process();

            bool isWindows = OperatingSystem.IsWindows();
            bool isLinux = OperatingSystem.IsLinux();
            bool isMacOS = OperatingSystem.IsMacOS();

            if (program == null)
            {
                program = isWindows ? "cmd.exe" : "/bin/bash";
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

            if (process.ExitCode != 0)
            {
                Debug.WriteLine($"[RunInstallProcess] 退出码: {process.ExitCode}\nstdout: {stdout}\nstderr: {stderr}");
            }

            return process.ExitCode;
        }


        public enum DownloadSource
        {
            Official = 0,
            Bmclapi = 1
        }
        internal struct SourcesList
        {
            public string Original;
            public string Default;
        }
    }
}
