using Microsoft.Win32;
using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using System.Runtime.Versioning;
using System.Threading.Tasks;
using static Qomicex.Core.DataModules;

namespace Qomicex.Core.Modules.Helpers
{
    public static class JavaHelper
    {
        #region 枚举和配置
        public enum JavaSearchMode { Quick, Deep, Custom }

        public enum JavaState
        {
            Valid,
            InvalidPath,
            MissingReleaseFile,
            CorruptedReleaseFile,
            UnknownError
        }

        public class JavaSearchOptions
        {
            public JavaSearchMode Mode { get; set; } = JavaSearchMode.Quick;
            public string? GameDir { get; set; }
            public bool IncludeJRE { get; set; } = true;
            public bool IncludeJDK { get; set; } = true;
            public int MaxDepth { get; set; } = 5;
            public int MaxResults { get; set; } = 100;
            public bool ScanHiddenFolders { get; set; } = false;
            public bool IncludeNetworkDrives { get; set; } = false;
            public string? CustomRootPath { get; set; }
            public List<string> CustomExcludePaths { get; set; } = new();
        }

        public class JavaInfoExtended : DataDetails.Java
        {
            public JavaState State { get; set; } = JavaState.UnknownError;
            public string StateMessage { get; set; } = string.Empty;
            public string DiscoveredBy { get; set; } = string.Empty;
        }

        public static readonly JavaSearchOptions QuickOptions = new()
        {
            Mode = JavaSearchMode.Quick,
            MaxDepth = 3,
            MaxResults = 100,
            ScanHiddenFolders = false,
            IncludeNetworkDrives = false
        };

        public static readonly JavaSearchOptions DeepOptions = new()
        {
            Mode = JavaSearchMode.Deep,
            MaxDepth = 5,
            MaxResults = 100,
            ScanHiddenFolders = false,
            IncludeNetworkDrives = false
        };
        #endregion

        #region 排除列表和路径常量
        private static readonly HashSet<string> ExcludedPaths = new(StringComparer.OrdinalIgnoreCase)
        {
            "Windows", "ProgramData", "$Recycle.Bin", "System32", "SysWOW64",
            "WinSxS", "node_modules", ".git", ".svn", ".hg", "target", "build",
            "dist", ".gradle", ".m2", ".nuget", ".vscode", ".idea", "__pycache__",
            ".venv", "venv", "env", ".tox", ".pytest_cache", ".cargo", ".rustup",
            ".npm", ".yarn", ".pnpm-store", ".next", ".nuxt", "out", ".output",
            ".parcel-cache", ".webpack", ".cache", ".angular", ".svelte-kit",
            ".nyc_output", ".coverage", ".sonarqube", ".scannerwork", ".vs",
            ".vscode-test", "obj",
            "Steam", "Epic Games", "Origin", "EA Games", "Battle.net",
            "Ubisoft Game Launcher", "GOG Galaxy",
            "Temp", "tmp", "temp", "Downloads", "Prefetch", "Recent",
            "Cookies", "History", "INetCache",
            "Docker", "containerd"
        };

        private static List<string> HighPriorityPaths => _highPriorityPaths.Value;
        private static readonly Lazy<List<string>> _highPriorityPaths = new(() =>
        {
            var pf = Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles);
            var pf86 = Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86);
            var localAppData = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
            var userProfile = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
            var commonAppData = Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData);
            var systemDrive = Path.GetPathRoot(Environment.GetFolderPath(Environment.SpecialFolder.System)) ?? @"C:\";
            return new List<string>
            {
                Path.Combine(pf, "Java"),
                Path.Combine(pf, "Eclipse Adoptium"),
                Path.Combine(pf, "Eclipse Foundation"),
                Path.Combine(pf, "Amazon Corretto"),
                Path.Combine(pf, "Microsoft", "jdk"),
                Path.Combine(pf, "BellSoft"),
                Path.Combine(pf, "Semeru"),
                Path.Combine(pf, "Zulu"),
                Path.Combine(pf, "SapMachine"),
                Path.Combine(pf, "RedHat"),
                Path.Combine(pf, "ojdkbuild"),
                Path.Combine(pf, "GraalVM"),
                Path.Combine(pf, "Liberica"),
                Path.Combine(pf, "Temurin"),
                Path.Combine(pf86, "Java"),
                Path.Combine(pf86, "Eclipse Adoptium"),
                Path.Combine(localAppData, "JetBrains"),
                Path.Combine(pf, "JetBrains"),
                Path.Combine(pf, "Android"),
                Path.Combine(systemDrive, "Android"),
                Path.Combine(userProfile, ".jdks"),
                Path.Combine(localAppData, "Programs", "Java"),
                Path.Combine(userProfile, "scoop", "apps"),
                Path.Combine(systemDrive, "tools", "java"),
                Path.Combine(commonAppData, "chocolatey", "lib")
            };
        });

        private static readonly List<string> LinuxPaths = new()
        {
            "/usr/lib/jvm",
            "/usr/java",
            "/opt/java",
            "/usr/local/java",
            "/snap",
            "/var/snap",
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".sdkman/candidates/java"),
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".jabba/jdk"),
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".asdf/installs/java"),
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".jenv/versions"),
            "/usr/lib64/jvm",
            "/usr/local/lib/jvm",
            "/opt/jdk",
            "/opt/jre",
            "/usr/local/jdk",
            "/usr/local/jre"
        };

        private static readonly List<string> MacOSPaths = new()
        {
            "/Library/Java/JavaVirtualMachines",
            "/System/Library/Java/JavaVirtualMachines",
            "/opt/homebrew/opt",
            "/usr/local/opt",
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".sdkman/candidates/java"),
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".jabba/jdk"),
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".asdf/installs/java"),
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".jenv/versions"),
            "/usr/local/Cellar/openjdk",
            "/opt/local/Library/Java",
            "/usr/libexec/java_home"
        };
        #endregion

        #region 主入口函数
        public static List<JavaInfoExtended> SearchJava(JavaSearchOptions? options = null)
        {
            options ??= QuickOptions;

            if (options.Mode == JavaSearchMode.Custom && string.IsNullOrEmpty(options.CustomRootPath))
            {
                throw new ArgumentException("Custom模式必须提供CustomRootPath");
            }

            return options.Mode switch
            {
                JavaSearchMode.Quick => SearchQuick(options),
                JavaSearchMode.Deep => SearchDeep(options),
                JavaSearchMode.Custom => SearchCustom(options),
                _ => throw new ArgumentOutOfRangeException()
            };
        }
        #endregion

        #region 搜索实现
        private static List<JavaInfoExtended> SearchQuick(JavaSearchOptions options)
        {
            var results = new ConcurrentBag<JavaInfoExtended>();
            var discoveredPaths = new ConcurrentDictionary<string, bool>();

            SearchEnvironmentVariables(results, discoveredPaths, options);

            if (RuntimeInformation.IsOSPlatform(OSPlatform.Windows))
                SearchRegistry(results, discoveredPaths, options);

            SearchHighPriorityPaths(results, discoveredPaths, options);

            if (!string.IsNullOrEmpty(options.GameDir))
                SearchMinecraftRuntime(options.GameDir, results, discoveredPaths, options);

            SearchPathEnvironment(results, discoveredPaths, options);

            return ProcessResults(results, options);
        }

        private static List<JavaInfoExtended> SearchDeep(JavaSearchOptions options)
        {
            var results = new ConcurrentBag<JavaInfoExtended>();
            var discoveredPaths = new ConcurrentDictionary<string, bool>();

            var quickResults = SearchQuick(options);
            foreach (var java in quickResults)
            {
                discoveredPaths[Path.GetFullPath(java.Path)] = true;
                results.Add(java);
            }

            var drives = GetValidDrives(options.IncludeNetworkDrives);
            Parallel.ForEach(drives, new ParallelOptions { MaxDegreeOfParallelism = 4 }, drive =>
            {
                try
                {
                    BreadthFirstSearch(drive, results, discoveredPaths, options, ExcludedPaths);
                }
                catch (Exception ex)
                {
                    Trace.WriteLine($"扫描驱动器 {drive} 失败: {ex.Message}");
                }
            });

            return ProcessResults(results, options);
        }

        private static List<JavaInfoExtended> SearchCustom(JavaSearchOptions options)
        {
            if (!Directory.Exists(options.CustomRootPath))
                return new List<JavaInfoExtended>();

            var excludes = new HashSet<string>(ExcludedPaths, StringComparer.OrdinalIgnoreCase);
            foreach (var path in options.CustomExcludePaths)
                excludes.Add(path);

            var results = new ConcurrentBag<JavaInfoExtended>();
            var discoveredPaths = new ConcurrentDictionary<string, bool>();

            BreadthFirstSearch(options.CustomRootPath!, results, discoveredPaths, options, excludes);

            return ProcessResults(results, options);
        }
        #endregion

        #region 辅助方法
        private static List<JavaInfoExtended> ProcessResults(
            ConcurrentBag<JavaInfoExtended> results,
            JavaSearchOptions options)
        {
            return results
                .OrderBy(j => j.State != JavaState.Valid)
                .ThenByDescending(j => j.VersionID)
                .Take(options.MaxResults)
                .ToList();
        }

        private static void BreadthFirstSearch(
            string rootPath,
            ConcurrentBag<JavaInfoExtended> results,
            ConcurrentDictionary<string, bool> discoveredPaths,
            JavaSearchOptions options,
            HashSet<string> excludes)
        {
            var queue = new Queue<(string Path, int Depth)>();
            queue.Enqueue((rootPath, 0));

            while (queue.Count > 0 && results.Count < options.MaxResults)
            {
                var (currentPath, depth) = queue.Dequeue();

                if (depth > options.MaxDepth) continue;

                try
                {
                    var javaPath = GetJavaExecutablePath(currentPath);
                    if (!string.IsNullOrEmpty(javaPath))
                    {
                        AddJavaIfValid(javaPath, results, discoveredPaths, options, $"BFS:{rootPath}");
                        continue;
                    }

                    foreach (var subDir in Directory.GetDirectories(currentPath))
                    {
                        var dirName = Path.GetFileName(subDir);

                        if (ShouldExclude(subDir, dirName, excludes))
                            continue;

                        if (!options.ScanHiddenFolders)
                        {
                            var attr = File.GetAttributes(subDir);
                            if ((attr & FileAttributes.Hidden) == FileAttributes.Hidden)
                                continue;
                        }

                        queue.Enqueue((subDir, depth + 1));
                    }
                }
                catch (UnauthorizedAccessException)
                {
                }
                catch (Exception ex)
                {
                    Trace.WriteLine($"BFS 扫描 {currentPath} 失败: {ex.Message}");
                }
            }
        }

        private static bool ShouldExclude(string fullPath, string dirName, HashSet<string> excludes)
        {
            if (excludes.Contains(dirName))
                return true;

            foreach (var exclude in excludes)
            {
                if (fullPath.IndexOf(exclude, StringComparison.OrdinalIgnoreCase) >= 0)
                    return true;
            }

            if (OperatingSystem.IsWindows() && fullPath.StartsWith("\\\\"))
                return true;

            if (dirName.StartsWith(".") &&
                !dirName.Equals(".jdks", StringComparison.OrdinalIgnoreCase) &&
                !dirName.Equals(".sdkman", StringComparison.OrdinalIgnoreCase) &&
                !dirName.Equals(".jenv", StringComparison.OrdinalIgnoreCase) &&
                !dirName.Equals(".jabba", StringComparison.OrdinalIgnoreCase) &&
                !dirName.Equals(".asdf", StringComparison.OrdinalIgnoreCase))
            {
                return true;
            }

            return false;
        }

        private static void SearchEnvironmentVariables(
            ConcurrentBag<JavaInfoExtended> results,
            ConcurrentDictionary<string, bool> discoveredPaths,
            JavaSearchOptions options)
        {
            var envVars = new[] { "JAVA_HOME", "JDK_HOME", "JRE_HOME" };
            foreach (var envVar in envVars)
            {
                var path = Environment.GetEnvironmentVariable(envVar);
                if (!string.IsNullOrEmpty(path) && Directory.Exists(path))
                {
                    var javaPath = GetJavaExecutablePath(path);
                    if (!string.IsNullOrEmpty(javaPath))
                        AddJavaIfValid(javaPath, results, discoveredPaths, options, envVar);
                }
            }
        }

        [SupportedOSPlatform("windows")]
        private static void SearchRegistry(
            ConcurrentBag<JavaInfoExtended> results,
            ConcurrentDictionary<string, bool> discoveredPaths,
            JavaSearchOptions options)
        {
            var registryKeys = new[]
            {
                @"SOFTWARE\JavaSoft\Java Runtime Environment",
                @"SOFTWARE\JavaSoft\Java Development Kit",
                @"SOFTWARE\JavaSoft\JDK",
                @"SOFTWARE\WOW6432Node\JavaSoft\Java Runtime Environment",
                @"SOFTWARE\WOW6432Node\JavaSoft\Java Development Kit",
                @"SOFTWARE\WOW6432Node\JavaSoft\JDK",
                @"SOFTWARE\Eclipse Adoptium\JDK",
                @"SOFTWARE\Eclipse Adoptium\JRE",
                @"SOFTWARE\Microsoft\JDK",
                @"SOFTWARE\Amazon\Corretto",
                @"SOFTWARE\BellSoft\Liberica",
                @"SOFTWARE\Azul Systems\Zulu",
                @"SOFTWARE\AdoptOpenJDK\JDK",
                @"SOFTWARE\AdoptOpenJDK\JRE",
                @"SOFTWARE\Semeru\JDK",
                @"SOFTWARE\Semeru\JRE"
            };

            foreach (var keyPath in registryKeys)
            {
                try
                {
                    using var key = Registry.LocalMachine.OpenSubKey(keyPath);
                    if (key == null) continue;

                    foreach (var subKeyName in key.GetSubKeyNames())
                    {
                        using var subKey = key.OpenSubKey(subKeyName);
                        if (subKey == null) continue;

                        var javaHome = subKey.GetValue("JavaHome")?.ToString();
                        if (!string.IsNullOrEmpty(javaHome) && Directory.Exists(javaHome))
                        {
                            var javaPath = GetJavaExecutablePath(javaHome);
                            if (!string.IsNullOrEmpty(javaPath))
                                AddJavaIfValid(javaPath, results, discoveredPaths, options, $"Registry:{keyPath}");
                        }
                    }
                }
                catch (Exception ex)
                {
                    Trace.WriteLine($"读取注册表 {keyPath} 失败: {ex.Message}");
                }
            }
        }

        private static void SearchHighPriorityPaths(
            ConcurrentBag<JavaInfoExtended> results,
            ConcurrentDictionary<string, bool> discoveredPaths,
            JavaSearchOptions options)
        {
            List<string> pathsToSearch;

            if (RuntimeInformation.IsOSPlatform(OSPlatform.Windows))
                pathsToSearch = HighPriorityPaths;
            else if (RuntimeInformation.IsOSPlatform(OSPlatform.Linux))
                pathsToSearch = LinuxPaths;
            else if (RuntimeInformation.IsOSPlatform(OSPlatform.OSX))
                pathsToSearch = MacOSPaths;
            else
                return;

            Parallel.ForEach(pathsToSearch, new ParallelOptions { MaxDegreeOfParallelism = 4 }, basePath =>
            {
                if (!Directory.Exists(basePath)) return;

                try
                {
                    foreach (var dir in Directory.GetDirectories(basePath))
                    {
                        var javaPath = GetJavaExecutablePath(dir);
                        if (!string.IsNullOrEmpty(javaPath))
                            AddJavaIfValid(javaPath, results, discoveredPaths, options, $"HighPriority:{basePath}");
                    }
                }
                catch (Exception ex)
                {
                    Trace.WriteLine($"扫描高优先级路径 {basePath} 失败: {ex.Message}");
                }
            });
        }

        private static void SearchMinecraftRuntime(
            string gameDir,
            ConcurrentBag<JavaInfoExtended> results,
            ConcurrentDictionary<string, bool> discoveredPaths,
            JavaSearchOptions options)
        {
            var runtimePath = Path.Combine(gameDir, "runtime");
            if (!Directory.Exists(runtimePath)) return;

            try
            {
                Parallel.ForEach(Directory.GetDirectories(runtimePath), new ParallelOptions { MaxDegreeOfParallelism = 4 }, platformDir =>
                {
                    try
                    {
                        foreach (var versionDir in Directory.GetDirectories(platformDir))
                        {
                            var javaPath = GetJavaExecutablePath(versionDir);
                            if (!string.IsNullOrEmpty(javaPath))
                                AddJavaIfValid(javaPath, results, discoveredPaths, options, "MinecraftRuntime");
                        }
                    }
                    catch (Exception ex)
                    {
                        Trace.WriteLine($"扫描 Minecraft runtime {platformDir} 失败: {ex.Message}");
                    }
                });
            }
            catch (Exception ex)
            {
                Trace.WriteLine($"扫描 Minecraft runtime 失败: {ex.Message}");
            }
        }

        private static void SearchPathEnvironment(
            ConcurrentBag<JavaInfoExtended> results,
            ConcurrentDictionary<string, bool> discoveredPaths,
            JavaSearchOptions options)
        {
            var pathVar = Environment.GetEnvironmentVariable("PATH");
            if (string.IsNullOrEmpty(pathVar)) return;

            var paths = pathVar.Split(Path.PathSeparator);

            Parallel.ForEach(paths, new ParallelOptions { MaxDegreeOfParallelism = 4 }, pathEntry =>
            {
                try
                {
                    if (string.IsNullOrWhiteSpace(pathEntry) || !Directory.Exists(pathEntry))
                        return;

                    var fullPath = Path.GetFullPath(pathEntry);
                    var javaName = RuntimeInformation.IsOSPlatform(OSPlatform.Windows) ? "java.exe" : "java";
                    var javaPath = Path.Combine(fullPath, javaName);

                    if (File.Exists(javaPath))
                    {
                        AddJavaIfValid(javaPath, results, discoveredPaths, options, "PATH");
                    }
                    else if (fullPath.EndsWith("bin", StringComparison.OrdinalIgnoreCase))
                    {
                        var parentDir = Directory.GetParent(fullPath)?.FullName;
                        if (!string.IsNullOrEmpty(parentDir))
                        {
                            var parentJavaPath = Path.Combine(fullPath, javaName);
                            if (File.Exists(parentJavaPath))
                                AddJavaIfValid(parentJavaPath, results, discoveredPaths, options, "PATH");
                        }
                    }
                }
                catch (Exception ex)
                {
                    Trace.WriteLine($"扫描 PATH 条目 {pathEntry} 失败: {ex.Message}");
                }
            });
        }

        private static void AddJavaIfValid(
            string javaPath,
            ConcurrentBag<JavaInfoExtended> results,
            ConcurrentDictionary<string, bool> discoveredPaths,
            JavaSearchOptions options,
            string discoveredBy)
        {
            try
            {
                var normalizedPath = Path.GetFullPath(javaPath);

                if (discoveredPaths.ContainsKey(normalizedPath))
                    return;

                discoveredPaths[normalizedPath] = true;

                var javaInfo = GetJavaInfo(normalizedPath, discoveredBy);
                if (javaInfo == null) return;

                if (!options.IncludeJRE && javaInfo.Type?.ToLower().Contains("jre") == true)
                    return;
                if (!options.IncludeJDK && javaInfo.Type?.ToLower().Contains("jdk") == true)
                    return;

                results.Add(javaInfo);
            }
            catch (Exception ex)
            {
                Trace.WriteLine($"添加 Java {javaPath} 失败: {ex.Message}");
            }
        }

        private static JavaInfoExtended? GetJavaInfo(string javaPath, string discoveredBy)
        {
            var javaInfo = new JavaInfoExtended
            {
                Path = javaPath,
                DiscoveredBy = discoveredBy
            };

            if (!File.Exists(javaPath))
            {
                javaInfo.State = JavaState.InvalidPath;
                javaInfo.StateMessage = "Java 可执行文件不存在";
                return javaInfo;
            }

            var javaHome = Path.GetDirectoryName(Path.GetDirectoryName(javaPath));
            if (string.IsNullOrEmpty(javaHome))
            {
                javaInfo.State = JavaState.InvalidPath;
                javaInfo.StateMessage = "无法确定 JAVA_HOME";
                return javaInfo;
            }

            var releaseFile = Path.Combine(javaHome, "release");
            if (!File.Exists(releaseFile))
            {
                javaInfo.State = JavaState.MissingReleaseFile;
                javaInfo.StateMessage = "未找到 release 文件，可能不是标准的 Java 安装";
                TryGetVersionFromCommand(javaInfo);
                return javaInfo;
            }

            try
            {
                var lines = File.ReadAllLines(releaseFile);
                foreach (var line in lines)
                {
                    if (line.StartsWith("JAVA_VERSION="))
                    {
                        javaInfo.Version = line.Split('=')[1].Trim('"');
                        javaInfo.VersionID = GeneralHelper.GetNormalizedMajorVersion(javaInfo.Version);
                        javaInfo.Name = $"Java {javaInfo.Version}";
                    }
                    else if (line.StartsWith("JAVA_RUNTIME_NAME="))
                    {
                        var runtimeName = line.Split('=')[1].Trim('"');
                        if (runtimeName.Contains("JDK"))
                            javaInfo.Type = "JDK";
                        else if (runtimeName.Contains("JRE"))
                            javaInfo.Type = "JRE";
                    }
                    else if (line.StartsWith("OS_ARCH="))
                    {
                        javaInfo.Arch = line.Split('=')[1].Trim('"');
                    }
                    else if (line.StartsWith("IMPLEMENTOR="))
                    {
                        var implementor = line.Split('=')[1].Trim('"');
                        if (!string.IsNullOrEmpty(implementor) && implementor != "Oracle Corporation")
                            javaInfo.Name = $"{implementor} {javaInfo.Name}";
                    }
                }

                if (string.IsNullOrEmpty(javaInfo.Type))
                {
                    if (Directory.Exists(Path.Combine(javaHome, "jre")) ||
                        Directory.Exists(Path.Combine(javaHome, "include")))
                        javaInfo.Type = "JDK";
                    else
                        javaInfo.Type = "JRE";
                }

                javaInfo.State = JavaState.Valid;
                javaInfo.StateMessage = "有效";
            }
            catch (Exception ex)
            {
                javaInfo.State = JavaState.CorruptedReleaseFile;
                javaInfo.StateMessage = $"release 文件损坏: {ex.Message}";
                TryGetVersionFromCommand(javaInfo);
            }

            return javaInfo;
        }

        private static void TryGetVersionFromCommand(JavaInfoExtended javaInfo)
        {
            try
            {
                using var process = new Process
                {
                    StartInfo = new ProcessStartInfo
                    {
                        FileName = javaInfo.Path,
                        Arguments = "-version",
                        UseShellExecute = false,
                        RedirectStandardError = true,
                        RedirectStandardOutput = true,
                        CreateNoWindow = true
                    }
                };

                process.Start();
                var output = process.StandardError.ReadToEnd();
                process.WaitForExit(5000);

                if (!string.IsNullOrEmpty(output))
                {
                    var lines = output.Split('\n');
                    foreach (var line in lines)
                    {
                        if (line.Contains("version"))
                        {
                            var match = System.Text.RegularExpressions.Regex.Match(line, @"""(\d+(:?\.\d+)*)""");
                            if (match.Success)
                            {
                                javaInfo.Version = match.Groups[1].Value;
                                javaInfo.VersionID = GeneralHelper.GetNormalizedMajorVersion(javaInfo.Version);
                                javaInfo.Name = $"Java {javaInfo.Version} (未验证)";
                                break;
                            }
                        }
                    }
                }
            }
            catch (Exception ex)
            {
                Trace.WriteLine($"通过命令获取 Java 版本失败: {ex.Message}");
            }
        }

        private static string? GetJavaExecutablePath(string javaHome)
        {
            var binDir = Path.Combine(javaHome, "bin");
            if (!Directory.Exists(binDir))
                return null;

            var javaName = RuntimeInformation.IsOSPlatform(OSPlatform.Windows) ? "java.exe" : "java";
            var javaPath = Path.Combine(binDir, javaName);

            return File.Exists(javaPath) ? javaPath : null;
        }

        private static List<string> GetValidDrives(bool includeNetworkDrives)
        {
            var drives = new List<string>();

            if (RuntimeInformation.IsOSPlatform(OSPlatform.Windows))
            {
                foreach (var drive in DriveInfo.GetDrives())
                {
                    if (!drive.IsReady) continue;
                    if (!includeNetworkDrives && drive.DriveType == DriveType.Network) continue;
                    if (drive.DriveType == DriveType.CDRom || drive.DriveType == DriveType.Removable) continue;

                    drives.Add(drive.RootDirectory.FullName);
                }
            }
            else if (RuntimeInformation.IsOSPlatform(OSPlatform.Linux) ||
                     RuntimeInformation.IsOSPlatform(OSPlatform.OSX))
            {
                drives.Add("/");
                drives.Add("/home");
                drives.Add("/opt");
                drives.Add("/usr");
            }

            return drives;
        }

        public static bool CheckJavaCompatibility(JavaInfoExtended java, string minecraftVersion, string gameDir)
        {
            if (java.State != JavaState.Valid)
                return false;

            try
            {
                var requiredVersion = GeneralHelper.GetMinecraftRequireJavaVersion(minecraftVersion, gameDir);
                if (requiredVersion == "Unknown")
                    return true;

                if (int.TryParse(requiredVersion, out int required) && java.VersionID >= required)
                    return true;

                return false;
            }
            catch
            {
                return true;
            }
        }

        public static List<JavaInfoExtended> GetRecommendedJava(
            List<JavaInfoExtended> javaList,
            string minecraftVersion,
            string gameDir)
        {
            return javaList
                .Where(j => j.State == JavaState.Valid)
                .OrderByDescending(j => CheckJavaCompatibility(j, minecraftVersion, gameDir))
                .ThenBy(j => j.VersionID)
                .ToList();
        }
        #endregion
    }
}
