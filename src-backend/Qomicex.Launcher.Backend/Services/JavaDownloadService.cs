using System.Collections.Concurrent;
using System.IO.Compression;
using System.Text.Json;
using Qomicex.Downloader;
using Qomicex.Launcher.Backend.Common;
using Qomicex.Launcher.Backend.Models;
using SharpCompress.Common;
using SharpCompress.Readers;

namespace Qomicex.Launcher.Backend.Services;

public class JavaDownloadService
{
    private readonly JavaRuntimeStore _javaRuntimeStore;
    private readonly ConcurrentDictionary<string, JavaDownloadTaskState> _tasks = new();

    private sealed class JavaDownloadTaskState
    {
        public string TaskId { get; init; } = string.Empty;
        public string Status { get; set; } = "queued";
        public double Progress { get; set; }
        public double Speed { get; set; }
        public string FileName { get; set; } = string.Empty;
        public string TargetDir { get; set; } = string.Empty;
        public string? Error { get; set; }
        public CancellationTokenSource Cancellation { get; } = new();
    }

    public JavaDownloadService(JavaRuntimeStore javaRuntimeStore)
    {
        _javaRuntimeStore = javaRuntimeStore;
    }

    public Task<JavaDownloadCatalogResponse> GetCatalogAsync()
    {
        var hostPlatform = GetHostPlatform();
        var response = new JavaDownloadCatalogResponse
        {
            Vendors = new List<JavaDownloadVendorInfo>
            {
                new()
                {
                    Id = "temurin",
                    Name = "Temurin",
                    Platforms = new() { hostPlatform },
                    Architectures = new() { "x64", "arm64", "x86" },
                    Versions = new() { 8, 11, 17, 21 },
                },
                new()
                {
                    Id = "zulu",
                    Name = "Zulu",
                    Platforms = new() { hostPlatform },
                    Architectures = new() { "x64", "arm64", "x86" },
                    Versions = new() { 8, 11, 17, 21 },
                },
                new()
                {
                    Id = "microsoft-jdk",
                    Name = "Microsoft JDK",
                    Platforms = new() { hostPlatform },
                    Architectures = new() { "x64", "arm64" },
                    Versions = new() { 11, 17, 21 },
                },
            }
        };

        return Task.FromResult(response);
    }

    public async Task<JavaDownloadStartResponse> StartAsync(JavaDownloadStartRequest request)
    {
        if (!string.Equals(request.Platform, GetHostPlatform(), StringComparison.OrdinalIgnoreCase))
        {
            throw ApiException.BadRequest("首版仅支持下载当前宿主平台的 Java 包", "JAVA_DOWNLOAD_PLATFORM_NOT_SUPPORTED");
        }

        var (url, fileName) = await ResolvePackageAsync(request);
        var taskId = Guid.NewGuid().ToString("N")[..12];
        var targetDir = Path.Combine(GetBaseDir(), request.Vendor, request.Version.ToString(), $"{request.Platform}-{request.Architecture}");
        var state = new JavaDownloadTaskState
        {
            TaskId = taskId,
            Status = "queued",
            FileName = fileName,
            TargetDir = targetDir,
        };
        _tasks[taskId] = state;

        _ = Task.Run(() => RunTaskAsync(state, request, url, fileName));

        return new JavaDownloadStartResponse
        {
            TaskId = taskId,
            Status = state.Status,
            TargetDir = targetDir,
        };
    }

    public JavaDownloadProgressResponse? GetProgress(string taskId)
    {
        if (!_tasks.TryGetValue(taskId, out var state)) return null;
        return new JavaDownloadProgressResponse
        {
            TaskId = state.TaskId,
            Status = state.Status,
            Progress = state.Progress,
            Speed = state.Speed,
            FileName = state.FileName,
            TargetDir = state.TargetDir,
            Error = state.Error,
        };
    }

    public bool Cancel(string taskId)
    {
        if (_tasks.TryGetValue(taskId, out var state))
        {
            state.Cancellation.Cancel();
            state.Status = "cancelled";
            return true;
        }
        return false;
    }

    private static string GetBaseDir()
    {
        var dir = Path.Combine(AppContext.BaseDirectory, "QML", "Runtime", "Java");
        Directory.CreateDirectory(dir);
        return dir;
    }

    private static async Task<(string url, string fileName)> ResolvePackageAsync(JavaDownloadStartRequest request)
    {
        using var http = new HttpClient();

        if (request.Vendor == "temurin")
        {
            var imageType = request.Version == 8 ? "jre" : "jdk";
            var api = $"https://api.adoptium.net/v3/assets/latest/{request.Version}/hotspot?release_type=ga&os={MapTemurinPlatform(request.Platform)}&architecture={MapTemurinArchitecture(request.Architecture)}&image_type={imageType}";
            var json = await http.GetStringAsync(api);
            using var doc = JsonDocument.Parse(json);
            var item = doc.RootElement.EnumerateArray().FirstOrDefault();
            if (item.ValueKind == JsonValueKind.Undefined)
            {
                throw ApiException.NotFound("未找到可用的 Java 下载包", "JAVA_DOWNLOAD_PACKAGE_NOT_FOUND");
            }

            var pkg = item.GetProperty("binary").GetProperty("package");
            return (pkg.GetProperty("link").GetString() ?? string.Empty, pkg.GetProperty("name").GetString() ?? string.Empty);
        }

        if (request.Vendor == "zulu")
        {
            var ext = request.Platform == "windows" ? "zip" : "tar.gz";
            var api = $"https://api.azul.com/metadata/v1/zulu/packages?java_version={request.Version}&os={MapZuluPlatform(request.Platform)}&arch={MapZuluArchitecture(request.Architecture)}&archive_type={ext}&java_package_type=jdk&latest=true";
            var json = await http.GetStringAsync(api);
            using var doc = JsonDocument.Parse(json);
            var item = doc.RootElement
                .EnumerateArray()
                .FirstOrDefault(entry => IsPlainZuluPackage(entry));
            if (item.ValueKind == JsonValueKind.Undefined)
            {
                throw ApiException.NotFound("未找到可用的 Java 下载包", "JAVA_DOWNLOAD_PACKAGE_NOT_FOUND");
            }

            return (item.GetProperty("download_url").GetString() ?? string.Empty, item.GetProperty("name").GetString() ?? string.Empty);
        }

        if (request.Vendor == "microsoft-jdk")
        {
            var api = "https://aka.ms/download-jdk/microsoft-jdk.json";
            var json = await http.GetStringAsync(api);
            using var doc = JsonDocument.Parse(json);
            if (!doc.RootElement.TryGetProperty("releases", out var releases)
                || releases.ValueKind != JsonValueKind.Array)
            {
                throw ApiException.NotFound("未找到可用的 Java 下载包", "JAVA_DOWNLOAD_PACKAGE_NOT_FOUND");
            }

            foreach (var release in releases.EnumerateArray())
            {
                if (!release.TryGetProperty("version", out var versionElement)
                    || versionElement.ValueKind != JsonValueKind.Number
                    || !versionElement.TryGetInt32(out var version)
                    || version != request.Version)
                {
                    continue;
                }

                if (!release.TryGetProperty("files", out var files)
                    || files.ValueKind != JsonValueKind.Array)
                {
                    continue;
                }

                foreach (var file in files.EnumerateArray())
                {
                    if (!file.TryGetProperty("platform", out var platformElement)
                        || !file.TryGetProperty("arch", out var archElement)
                        || !file.TryGetProperty("fileName", out var fileNameElement)
                        || !file.TryGetProperty("url", out var urlElement))
                    {
                        continue;
                    }

                    var platform = platformElement.GetString();
                    var architecture = archElement.GetString();
                    var fileName = fileNameElement.GetString();
                    var url = urlElement.GetString();

                    if (string.IsNullOrWhiteSpace(platform)
                        || string.IsNullOrWhiteSpace(architecture)
                        || string.IsNullOrWhiteSpace(fileName)
                        || string.IsNullOrWhiteSpace(url))
                    {
                        continue;
                    }

                    if (platform == MapMicrosoftPlatform(request.Platform)
                        && architecture == MapMicrosoftArchitecture(request.Architecture)
                        && (fileName.EndsWith(".zip", StringComparison.OrdinalIgnoreCase)
                            || fileName.EndsWith(".tar.gz", StringComparison.OrdinalIgnoreCase)))
                    {
                        return (url, fileName);
                    }
                }
            }

            throw ApiException.NotFound("未找到可用的 Java 下载包", "JAVA_DOWNLOAD_PACKAGE_NOT_FOUND");
        }

        throw ApiException.NotFound("未找到可用的 Java 下载包", "JAVA_DOWNLOAD_PACKAGE_NOT_FOUND");
    }

    private async Task RunTaskAsync(JavaDownloadTaskState state, JavaDownloadStartRequest request, string url, string fileName)
    {
        try
        {
            state.Status = "downloading";
            var tmpDir = Path.Combine(GetBaseDir(), ".tmp", state.TaskId);
            Directory.CreateDirectory(tmpDir);
            var archivePath = Path.Combine(tmpDir, fileName);

            using var manager = new DownloadManager(intervalMs: 500);
            var tid = manager.CreateTask(maxConcurrentFiles: 1, maxRetries: 3, ignoreRangeProbe200Ok: true);
            manager.AddFileToTask(tid, url, archivePath);
            manager.OnTaskProgressUpdated += (_, info) =>
            {
                state.Progress = info.Progress;
                state.Speed = info.Speed;
            };
            await manager.StartTaskAsync(tid, state.Cancellation.Token);

            state.Status = "extracting";
            var extractedRoot = await ExtractAsync(state, archivePath, request);

            state.Status = "registering";
            var javaExe = FindJavaExecutable(extractedRoot) ?? throw ApiException.NotFound("解压后未找到 Java 可执行文件", "JAVA_DOWNLOAD_REGISTER_FAILED");
            await _javaRuntimeStore.AddCustomAsync(javaExe);

            state.Progress = 100;
            state.Speed = 0;
            state.Status = "completed";
        }
        catch (OperationCanceledException)
        {
            state.Status = "cancelled";
        }
        catch (ApiException ex)
        {
            state.Status = "failed";
            state.Error = ex.Message;
        }
        catch (Exception ex)
        {
            state.Status = "failed";
            state.Error = ex.Message;
        }
    }

    private static async Task<string> ExtractAsync(JavaDownloadTaskState state, string archivePath, JavaDownloadStartRequest request)
    {
        Directory.CreateDirectory(state.TargetDir);
        if (archivePath.EndsWith(".zip", StringComparison.OrdinalIgnoreCase))
        {
            ZipFile.ExtractToDirectory(archivePath, state.TargetDir, overwriteFiles: true);
            await Task.CompletedTask;
            return state.TargetDir;
        }

        if (archivePath.EndsWith(".tar.gz", StringComparison.OrdinalIgnoreCase))
        {
            using var stream = File.OpenRead(archivePath);
            using var reader = ReaderFactory.Open(stream);
            while (reader.MoveToNextEntry())
            {
                if (reader.Entry.IsDirectory)
                {
                    continue;
                }

                reader.WriteEntryToDirectory(state.TargetDir, new ExtractionOptions
                {
                    ExtractFullPath = true,
                    Overwrite = true,
                });
            }

            await Task.CompletedTask;
            return state.TargetDir;
        }

        throw ApiException.BadRequest("当前仅支持 zip / tar.gz 自动解压", "JAVA_DOWNLOAD_EXTRACT_FAILED");
    }

    private static string? FindJavaExecutable(string rootDir)
    {
        var javaName = OperatingSystem.IsWindows() ? "java.exe" : "java";
        var candidates = Directory.GetFiles(rootDir, javaName, SearchOption.AllDirectories);
        return candidates.FirstOrDefault(path => path.Contains($"{Path.DirectorySeparatorChar}bin{Path.DirectorySeparatorChar}", StringComparison.OrdinalIgnoreCase));
    }

    private static string GetHostPlatform()
    {
        if (OperatingSystem.IsWindows()) return "windows";
        if (OperatingSystem.IsLinux()) return "linux";
        if (OperatingSystem.IsMacOS()) return "macos";
        throw ApiException.BadRequest("当前宿主平台不支持 Java 下载", "JAVA_DOWNLOAD_PLATFORM_INVALID");
    }

    private static bool IsPlainZuluPackage(JsonElement entry)
    {
        var name = entry.GetProperty("name").GetString() ?? string.Empty;
        return !name.Contains("-fx-", StringComparison.OrdinalIgnoreCase)
            && !name.Contains("-crac-", StringComparison.OrdinalIgnoreCase);
    }

    private static string MapTemurinPlatform(string platform) => platform switch
    {
        "macos" => "mac",
        "windows" or "linux" => platform,
        _ => throw ApiException.BadRequest("不支持的操作系统平台", "JAVA_DOWNLOAD_PLATFORM_INVALID"),
    };

    private static string MapTemurinArchitecture(string architecture) => architecture switch
    {
        "x64" => "x64",
        "arm64" => "aarch64",
        "x86" => "x32",
        _ => throw ApiException.BadRequest("不支持的 CPU 架构", "JAVA_DOWNLOAD_ARCH_INVALID"),
    };

    private static string MapZuluPlatform(string platform) => platform switch
    {
        "macos" => "macos",
        "windows" or "linux" => platform,
        _ => throw ApiException.BadRequest("不支持的操作系统平台", "JAVA_DOWNLOAD_PLATFORM_INVALID"),
    };

    private static string MapZuluArchitecture(string architecture) => architecture switch
    {
        "x64" => "x64",
        "arm64" => "arm",
        "x86" => "i686",
        _ => throw ApiException.BadRequest("不支持的 CPU 架构", "JAVA_DOWNLOAD_ARCH_INVALID"),
    };

    private static string MapMicrosoftPlatform(string platform) => platform switch
    {
        "macos" => "macOS",
        "windows" => "windows",
        "linux" => "linux",
        _ => throw ApiException.BadRequest("不支持的操作系统平台", "JAVA_DOWNLOAD_PLATFORM_INVALID"),
    };

    private static string MapMicrosoftArchitecture(string architecture) => architecture switch
    {
        "x64" => "x64",
        "arm64" => "aarch64",
        _ => throw ApiException.BadRequest("不支持的 CPU 架构", "JAVA_DOWNLOAD_ARCH_INVALID"),
    };

}
