using System.Collections.Concurrent;
using System.Formats.Tar;
using System.IO.Compression;
using Qomicex.Core.AOT.Core;
using Qomicex.Core.AOT.Public.Models;
using Qomicex.Launcher.Backend.Neo.Models;

namespace Qomicex.Launcher.Backend.Neo.Services;

public sealed class JavaDownloadService
{
    private readonly DefaultGameCore _core;
    private readonly HttpClient _httpClient;
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
        public CancellationTokenSource Cancellation { get; set; } = new();
        public JavaDownloadStartRequest? PendingRequest { get; set; }
        public string DownloadUrl { get; set; } = string.Empty;
        public DateTime LastSample { get; set; }
        public long LastBytes { get; set; }
        public bool Paused { get; set; }
    }

    public JavaDownloadService(DefaultGameCore core, HttpClient httpClient, JavaRuntimeStore javaRuntimeStore)
    {
        _core = core;
        _httpClient = httpClient;
        _javaRuntimeStore = javaRuntimeStore;
    }

    public Task<JavaDownloadCatalogResponse> GetCatalogAsync()
    {
        var hostPlatform = GetHostPlatform();
        return Task.FromResult(new JavaDownloadCatalogResponse(
        [
            new("temurin", "Temurin", [hostPlatform], ["x64", "arm64", "x86"], [8, 11, 17, 21, 25], IsRecommended: true),
            new("zulu", "Zulu", [hostPlatform], ["x64", "arm64", "x86"], [8, 11, 17, 21, 25]),
        ]));
    }

    public async Task<JavaDownloadStartResponse> StartAsync(JavaDownloadStartRequest request)
    {
        if (!string.Equals(request.Platform, GetHostPlatform(), StringComparison.OrdinalIgnoreCase))
            throw ApiException.BadRequest("首版仅支持下载当前宿主平台的 Java 包", "JAVA_DOWNLOAD_PLATFORM_NOT_SUPPORTED");

        var (url, fileName) = await ResolvePackageAsync(request);

        var taskId = Guid.NewGuid().ToString("N")[..12];
        var targetDir = Path.Combine(GetBaseDir(), request.Vendor, request.Version.ToString(), $"{request.Platform}-{request.Architecture}");
        var state = new JavaDownloadTaskState
        {
            TaskId = taskId,
            Status = "queued",
            TargetDir = targetDir,
            DownloadUrl = url,
            FileName = fileName,
        };
        _tasks[taskId] = state;

        _ = Task.Run(() => RunTaskAsync(state, request));

        return new JavaDownloadStartResponse(taskId, state.Status, targetDir);
    }

    public JavaDownloadProgressResponse? GetProgress(string taskId)
    {
        if (!_tasks.TryGetValue(taskId, out var state)) return null;
        return new JavaDownloadProgressResponse(
            state.TaskId, state.Status, state.Progress, state.Speed,
            state.FileName, state.TargetDir, state.Error);
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

    public bool Pause(string taskId)
    {
        if (_tasks.TryGetValue(taskId, out var state) && state.Status == "downloading")
        {
            state.Paused = true;
            state.Status = "paused";
            return true;
        }
        return false;
    }

    public bool Resume(string taskId)
    {
        if (_tasks.TryGetValue(taskId, out var state) && state.Status == "paused")
        {
            state.Paused = false;
            state.Status = "downloading";
            return true;
        }
        return false;
    }

    public List<JavaDownloadProgressResponse> GetAllActiveStates()
    {
        return _tasks.Values
            .Where(t => t.Status is "queued" or "resolving" or "downloading" or "paused" or "extracting" or "registering")
            .Select(t => new JavaDownloadProgressResponse(
                t.TaskId, t.Status, t.Progress, t.Speed,
                t.FileName, t.TargetDir, t.Error))
            .ToList();
    }

    private static string GetBaseDir()
    {
        var root = Environment.GetEnvironmentVariable("QOMICEX_HOME")
            ?? Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "qomicex-launcher");
        var dir = Path.Combine(root, "QML", "Runtime", "Java");
        Directory.CreateDirectory(dir);
        return dir;
    }

    private async Task<(string url, string fileName)> ResolvePackageAsync(JavaDownloadStartRequest request)
    {
        var (source, platform, arch, packageType) = request.Vendor switch
        {
            "temurin" => (JavaDownloadSource.Adoptium, MapPlatform(request.Platform), MapArchitecture(request.Architecture), JavaPackageType.JDK),
            "zulu" => (JavaDownloadSource.Zulu, MapPlatform(request.Platform), MapArchitecture(request.Architecture), JavaPackageType.JDK),
            _ => throw ApiException.NotFound("未找到可用的 Java 下载包", "JAVA_DOWNLOAD_PACKAGE_NOT_FOUND"),
        };

        var packages = await _core.JavaProvider.GetPackages(request.Version, platform, arch, packageType, source);
        var pkg = packages.FirstOrDefault()
            ?? throw ApiException.NotFound("未找到可用的 Java 下载包", "JAVA_DOWNLOAD_PACKAGE_NOT_FOUND");

        return (pkg.DownloadUrl, pkg.FileName);
    }

    private async Task RunTaskAsync(JavaDownloadTaskState state, JavaDownloadStartRequest request)
    {
        state.PendingRequest = request;
        string? tmpDir = null;
        try
        {
            state.Status = "downloading";
            tmpDir = Path.Combine(GetBaseDir(), ".tmp", state.TaskId);
            Directory.CreateDirectory(tmpDir);
            var archivePath = Path.Combine(tmpDir, state.FileName);

            using var response = await _httpClient.GetAsync(state.DownloadUrl, HttpCompletionOption.ResponseHeadersRead, state.Cancellation.Token);
            response.EnsureSuccessStatusCode();

            var totalBytes = response.Content.Headers.ContentLength ?? -1;
            using var contentStream = await response.Content.ReadAsStreamAsync(state.Cancellation.Token);
            using var fileStream = File.Create(archivePath);

            var buffer = new byte[81920];
            long bytesRead = 0;
            state.LastSample = DateTime.UtcNow;
            state.LastBytes = 0;

            int read;
            while ((read = await contentStream.ReadAsync(buffer, state.Cancellation.Token)) > 0)
            {
                while (state.Paused)
                {
                    await Task.Delay(200, state.Cancellation.Token);
                    state.LastSample = DateTime.UtcNow;
                    state.LastBytes = bytesRead;
                }

                await fileStream.WriteAsync(buffer.AsMemory(0, read), state.Cancellation.Token);
                bytesRead += read;

                var now = DateTime.UtcNow;
                var elapsed = (now - state.LastSample).TotalSeconds;
                if (elapsed >= 0.5)
                {
                    state.Progress = totalBytes > 0 ? (double)bytesRead / totalBytes * 80 : 0;
                    state.Speed = (bytesRead - state.LastBytes) / elapsed;
                    state.LastSample = now;
                    state.LastBytes = bytesRead;
                }
            }

            state.Progress = 85;
            state.Status = "extracting";

            var extractDir = Path.Combine(tmpDir, "extracted");
            Directory.CreateDirectory(extractDir);

            if (state.FileName.EndsWith(".zip", StringComparison.OrdinalIgnoreCase))
            {
                ZipFile.ExtractToDirectory(archivePath, extractDir, overwriteFiles: true);
            }
            else if (state.FileName.EndsWith(".tar.gz", StringComparison.OrdinalIgnoreCase))
            {
                await using var gzStream = File.OpenRead(archivePath);
                await using var decompressed = new GZipStream(gzStream, CompressionMode.Decompress);
                await TarFile.ExtractToDirectoryAsync(decompressed, extractDir, overwriteFiles: true);
            }

            var jdkDir = FindJdkDir(extractDir)
                ?? throw new InvalidOperationException("解压后未找到 jdk 目录");

            if (Directory.Exists(state.TargetDir))
                Directory.Delete(state.TargetDir, recursive: true);
            Directory.CreateDirectory(Path.GetDirectoryName(state.TargetDir)!);
            Directory.Move(jdkDir, state.TargetDir);

            state.Progress = 95;
            state.Status = "registering";

            var javaExe = OperatingSystem.IsWindows() ? "java.exe" : "java";
            var javaPath = Path.Combine(state.TargetDir, "bin", javaExe);
            if (File.Exists(javaPath))
                await _javaRuntimeStore.AddCustomAsync(javaPath);

            state.Progress = 100;
            state.Status = "completed";
        }
        catch (OperationCanceledException)
        {
            state.Status = "cancelled";
        }
        catch (Exception ex)
        {
            state.Status = "failed";
            state.Error = ex.Message;
        }
        finally
        {
            state.PendingRequest = null;
            if (tmpDir != null && Directory.Exists(tmpDir))
                Directory.Delete(tmpDir, recursive: true);
        }
    }

    private static string? FindJdkDir(string extractDir)
    {
        var top = Directory.GetDirectories(extractDir).FirstOrDefault();
        if (top != null && Directory.Exists(Path.Combine(top, "bin")))
            return top;

        foreach (var dir in Directory.GetDirectories(extractDir))
        {
            if (Directory.Exists(Path.Combine(dir, "bin")))
                return dir;
        }
        return null;
    }

    private static string GetHostPlatform()
    {
        if (OperatingSystem.IsWindows()) return "windows";
        if (OperatingSystem.IsLinux()) return "linux";
        if (OperatingSystem.IsMacOS()) return "macos";
        throw ApiException.BadRequest("当前宿主平台不支持 Java 下载", "JAVA_DOWNLOAD_PLATFORM_INVALID");
    }

    private static JavaPlatform MapPlatform(string platform) => platform switch
    {
        "windows" => JavaPlatform.Windows,
        "linux" => JavaPlatform.Linux,
        "macos" => JavaPlatform.MacOS,
        _ => throw ApiException.BadRequest("不支持的操作系统平台", "JAVA_DOWNLOAD_PLATFORM_INVALID"),
    };

    private static JavaArchitecture MapArchitecture(string architecture) => architecture switch
    {
        "x64" => JavaArchitecture.X64,
        "arm64" => JavaArchitecture.Arm64,
        _ => throw ApiException.BadRequest("不支持的 CPU 架构", "JAVA_DOWNLOAD_ARCH_INVALID"),
    };
}

// DTOs
public sealed record JavaDownloadVendorInfo(
    string Id, string Name, List<string> Platforms, List<string> Architectures, List<int> Versions,
    bool IsRecommended = false
);

public sealed record JavaDownloadCatalogResponse(List<JavaDownloadVendorInfo> Vendors);

public sealed record JavaDownloadStartRequest(
    string Vendor, int Version, string Platform, string Architecture
);

public sealed record JavaDownloadStartResponse(
    string TaskId, string Status, string TargetDir
);

public sealed record JavaDownloadProgressResponse(
    string TaskId, string Status, double Progress, double Speed,
    string FileName, string TargetDir, string? Error
);
