using System.IO.Compression;
using Qomicex.Downloader.Refactor.Configuration;
using Qomicex.Downloader.Refactor.Model;
using Qomicex.Downloader.Refactor.Progress;
using RefDl = Qomicex.Downloader.Refactor.Downloader;
using Qomicex.Launcher.Backend.Neo.Common;
using Qomicex.Launcher.Backend.Neo.Models;

namespace Qomicex.Launcher.Backend.Neo.Services.Connector;

public sealed class EasyTierDownloadStatus
{
    public bool Installed { get; set; }
    public string Status { get; set; } = "idle";
    public double Progress { get; set; }
    public double Speed { get; set; }
    public string? Error { get; set; }
}

public sealed class EasyTierProvider
{
    private const string Version = "v2.6.4";

    private static readonly string[] ProxyPrefixes =
    [
        "",
        "https://edgeone.gh-proxy.org/",
        "https://cdn.gh-proxy.org/",
        "https://hk.gh-proxy.org/",
        "https://v6.gh-proxy.org/",
        "https://ghfast.top/",
    ];

    private readonly ILogger<EasyTierProvider> _logger;
    private readonly object _lock = new();
    private readonly EasyTierDownloadStatus _status = new();
    private Task? _downloadTask;

    public EasyTierProvider(ILogger<EasyTierProvider> logger)
    {
        _logger = logger;
        _status.Installed = File.Exists(GetExecutablePath());
    }

    public static string InstallDir => Path.Combine(AppPaths.BaseDir, "QML", "EasyTier");

    public static string GetExecutablePath()
    {
        var name = OperatingSystem.IsWindows() ? "easytier-core.exe" : "easytier-core";
        return Path.Combine(InstallDir, name);
    }

    public bool IsInstalled => File.Exists(GetExecutablePath());

    public EasyTierDownloadStatus GetStatus()
    {
        lock (_lock)
        {
            _status.Installed = IsInstalled;
            return new EasyTierDownloadStatus
            {
                Installed = _status.Installed,
                Status = _status.Status,
                Progress = _status.Progress,
                Speed = _status.Speed,
                Error = _status.Error,
            };
        }
    }

    public void EnsureDownloadStarted()
    {
        lock (_lock)
        {
            if (IsInstalled)
            {
                _status.Status = "installed";
                return;
            }
            if (_downloadTask is { IsCompleted: false })
                return;

            _status.Status = "downloading";
            _status.Progress = 0;
            _status.Speed = 0;
            _status.Error = null;
            _downloadTask = Task.Run(RunDownloadAsync);
        }
    }

    private async Task RunDownloadAsync()
    {
        var tmpDir = Path.Combine(InstallDir, ".tmp");
        try
        {
            Directory.CreateDirectory(InstallDir);
            Directory.CreateDirectory(tmpDir);

            var assetName = $"easytier-{GetOsToken()}-{GetArchToken()}-{Version}.zip";
            var githubUrl = $"https://github.com/EasyTier/EasyTier/releases/download/{Version}/{assetName}";
            var archivePath = Path.Combine(tmpDir, assetName);

            lock (_lock) _status.Status = "resolving";
            var prefix = await PickFastestPrefixAsync();
            var url = prefix + githubUrl;

            _logger.LogInformation("下载 EasyTier (镜像前缀='{Prefix}'): {Url}", prefix, url);

            lock (_lock) _status.Status = "downloading";
            var fileProgress = new Progress<FileProgressInfo>(fp =>
            {
                lock (_lock)
                {
                    _status.Progress = fp.ProgressPercent;
                    _status.Speed = fp.SpeedBytesPerSec;
                }
            });
            using var downloader = new RefDl(builder => builder
                .WithMaxConcurrency(1)
                .WithRetry(3, TimeSpan.FromSeconds(1))
                .WithProgress(null, fileProgress, null));
            var task = new DownloadTask { Url = url, SavePath = archivePath };
            await downloader.DownloadAsync(task, CancellationToken.None);

            lock (_lock) _status.Status = "extracting";

            var extractDir = Path.Combine(tmpDir, "extract");
            if (Directory.Exists(extractDir)) Directory.Delete(extractDir, recursive: true);
            Directory.CreateDirectory(extractDir);
            ZipFile.ExtractToDirectory(archivePath, extractDir, overwriteFiles: true);

            var coreName = OperatingSystem.IsWindows() ? "easytier-core.exe" : "easytier-core";
            var cliName = OperatingSystem.IsWindows() ? "easytier-cli.exe" : "easytier-cli";
            var coreSource = Directory.GetFiles(extractDir, coreName, SearchOption.AllDirectories).FirstOrDefault()
                ?? throw new InvalidOperationException("解压后未找到 easytier-core");
            var sourceDir = Path.GetDirectoryName(coreSource)!;

            foreach (var file in Directory.GetFiles(sourceDir))
            {
                var dest = Path.Combine(InstallDir, Path.GetFileName(file));
                File.Copy(file, dest, overwrite: true);
            }

            SetExecutable(Path.Combine(InstallDir, coreName));
            var cliDest = Path.Combine(InstallDir, cliName);
            if (File.Exists(cliDest)) SetExecutable(cliDest);

            lock (_lock)
            {
                _status.Status = "installed";
                _status.Installed = true;
                _status.Progress = 100;
                _status.Speed = 0;
            }
            _logger.LogInformation("EasyTier 安装完成: {Path}", GetExecutablePath());
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "EasyTier 下载失败");
            lock (_lock)
            {
                _status.Status = "failed";
                _status.Error = ex.Message;
            }
        }
        finally
        {
            try { if (Directory.Exists(tmpDir)) Directory.Delete(tmpDir, recursive: true); } catch { }
        }
    }

    private async Task<string> PickFastestPrefixAsync()
    {
        var githubUrl = $"https://github.com/EasyTier/EasyTier/releases/download/{Version}/easytier-{GetOsToken()}-{GetArchToken()}-{Version}.zip";

        async Task<(string prefix, long ms)> ProbeAsync(string prefix)
        {
            using var http = new HttpClient { Timeout = TimeSpan.FromSeconds(5) };
            var sw = System.Diagnostics.Stopwatch.StartNew();
            try
            {
                using var req = new HttpRequestMessage(HttpMethod.Get, prefix + githubUrl);
                req.Headers.Range = new System.Net.Http.Headers.RangeHeaderValue(0, 0);
                using var resp = await http.SendAsync(req, HttpCompletionOption.ResponseHeadersRead);
                sw.Stop();
                if (!resp.IsSuccessStatusCode) return (prefix, long.MaxValue);
                return (prefix, sw.ElapsedMilliseconds);
            }
            catch
            {
                return (prefix, long.MaxValue);
            }
        }

        var results = await Task.WhenAll(ProxyPrefixes.Select(ProbeAsync));
        var best = results.OrderBy(r => r.ms).First();
        if (best.ms == long.MaxValue)
        {
            _logger.LogWarning("所有 EasyTier 镜像测速失败，回退直连 GitHub");
            return "";
        }
        _logger.LogInformation("EasyTier 最快镜像前缀='{Prefix}' ({Ms}ms)", best.prefix, best.ms);
        return best.prefix;
    }

    private static void SetExecutable(string path)
    {
        if (OperatingSystem.IsWindows()) return;
        try
        {
            File.SetUnixFileMode(path,
                UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute |
                UnixFileMode.GroupRead | UnixFileMode.GroupExecute |
                UnixFileMode.OtherRead | UnixFileMode.OtherExecute);
        }
        catch { }
    }

    private static string GetOsToken()
    {
        if (OperatingSystem.IsWindows()) return "windows";
        if (OperatingSystem.IsMacOS()) return "macos";
        if (OperatingSystem.IsLinux()) return "linux";
        throw ApiException.BadRequest("当前平台不支持 EasyTier 自动下载");
    }

    private static string GetArchToken() =>
        System.Runtime.InteropServices.RuntimeInformation.OSArchitecture switch
        {
            System.Runtime.InteropServices.Architecture.X64 => "x86_64",
            System.Runtime.InteropServices.Architecture.Arm64 => "aarch64",
            System.Runtime.InteropServices.Architecture.X86 when OperatingSystem.IsWindows() => "i686",
            _ => throw ApiException.BadRequest("当前 CPU 架构不支持 EasyTier 自动下载"),
        };
}
