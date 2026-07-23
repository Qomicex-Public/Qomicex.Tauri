using System.Text.Json;
using Qomicex.Core.AOT.Core;
using Qomicex.Core.AOT.Public.Models;
using Qomicex.Launcher.Backend.Neo.JsonContext;
using Qomicex.Launcher.Backend.Neo.Models;

namespace Qomicex.Launcher.Backend.Neo.Services;

public sealed class JavaRuntimeStore
{
    private readonly DefaultGameCore _core;
    private readonly string _filePath;
    private readonly SemaphoreSlim _mutex = new(1, 1);

    private static readonly StringComparer PathComparer = OperatingSystem.IsWindows()
        ? StringComparer.OrdinalIgnoreCase
        : StringComparer.Ordinal;

    public JavaRuntimeStore(DefaultGameCore core)
    {
        _core = core;
        var dataDir = GetBaseDir();
        Directory.CreateDirectory(dataDir);
        _filePath = Path.Combine(dataDir, "java-runtimes.json");
    }

    public async Task<List<JavaResult>> GetCustomAsync()
    {
        var entries = await LoadEntriesAsync();
        var results = new List<JavaResult>();

        foreach (var entry in entries)
        {
            var runtime = await ValidatePathAsync(entry.Path);
            if (runtime != null)
                results.Add(runtime with { DiscoveredBy = "Custom" });
        }

        return results;
    }

    public async Task<JavaResult> AddCustomAsync(string path)
    {
        var normalizedPath = Path.GetFullPath(path.Trim());
        var runtime = await ValidatePathAsync(normalizedPath)
            ?? throw ApiException.NotFound("无法识别该路径下的 Java 运行时", "JAVA_RUNTIME_NOT_FOUND");

        await _mutex.WaitAsync();
        try
        {
            var entries = await LoadEntriesUnsafeAsync();
            if (!entries.Any(e => PathComparer.Equals(e.Path, normalizedPath)))
            {
                entries.Add(new StoredJavaRuntime(normalizedPath));
                await SaveEntriesUnsafeAsync(entries);
            }
        }
        finally
        {
            _mutex.Release();
        }

        return runtime with { DiscoveredBy = "Custom" };
    }

    public async Task RemoveCustomAsync(string path)
    {
        var normalizedPath = Path.GetFullPath(path.Trim());

        await _mutex.WaitAsync();
        try
        {
            var entries = await LoadEntriesUnsafeAsync();
            if (entries.RemoveAll(e => PathComparer.Equals(e.Path, normalizedPath)) > 0)
                await SaveEntriesUnsafeAsync(entries);
        }
        finally
        {
            _mutex.Release();
        }
    }

    public async Task<List<JavaResult>> GetMergedAsync(JavaSearchMode mode)
    {
        var options = new JavaSearchOptions(
            CustomExcludePaths: [],
            CustomRootPath: null,
            GameDir: null,
            Mode: mode,
            IncludeJRE: true,
            IncludeJDK: true,
            MaxDepth: 5,
            MaxResults: 100,
            ScanHiddenFolders: false,
            IncludeNetworkDrives: false
        );

        var scanned = await _core.JavaProvider.Search(options);
        var merged = new Dictionary<string, JavaResult>(PathComparer);

        foreach (var r in scanned)
            merged[Path.GetFullPath(r.Path)] = r;

        foreach (var r in await ScanJavaDownloadDirAsync())
            merged.TryAdd(Path.GetFullPath(r.Path), r);

        foreach (var r in await GetCustomAsync())
            merged[Path.GetFullPath(r.Path)] = r;

        return merged.Values.ToList();
    }

    internal async Task<List<JavaResult>> ScanJavaDownloadDirAsync()
    {
        var dir = Path.Combine(GetBaseDir(), "Runtime", "Java");
        if (!Directory.Exists(dir)) return [];

        var javaName = OperatingSystem.IsWindows() ? "java.exe" : "java";
        var results = new List<JavaResult>();
        var seen = new HashSet<string>(PathComparer);
        var searchRoot = new JavaSearchOptions(
            CustomExcludePaths: [],
            CustomRootPath: dir,
            GameDir: null,
            Mode: JavaSearchMode.Custom,
            IncludeJRE: true,
            IncludeJDK: true,
            MaxDepth: 5,
            MaxResults: 50,
            ScanHiddenFolders: true,
            IncludeNetworkDrives: false
        );

        try
        {
            foreach (var javaPath in Directory.GetFiles(dir, javaName, SearchOption.AllDirectories))
            {
                var javaHome = Path.GetDirectoryName(Path.GetDirectoryName(javaPath));
                if (string.IsNullOrEmpty(javaHome)) continue;

                var found = await _core.JavaProvider.Search(searchRoot with { CustomRootPath = javaHome });
                foreach (var r in found)
                {
                    if (seen.Add(r.Path))
                        results.Add(r with { DiscoveredBy = "DownloadDir" });
                }
            }
        }
        catch { }

        return results;
    }

    private async Task<JavaResult?> ValidatePathAsync(string javaPath)
    {
        var javaHome = Path.GetDirectoryName(Path.GetDirectoryName(javaPath));
        if (string.IsNullOrEmpty(javaHome)) return null;

        var options = new JavaSearchOptions(
            CustomExcludePaths: [],
            CustomRootPath: javaHome,
            GameDir: null,
            Mode: JavaSearchMode.Custom,
            IncludeJRE: true,
            IncludeJDK: true,
            MaxDepth: 2,
            MaxResults: 20,
            ScanHiddenFolders: true,
            IncludeNetworkDrives: false
        );

        var results = await _core.JavaProvider.Search(options);
        return results.FirstOrDefault(r => PathComparer.Equals(Path.GetFullPath(r.Path), Path.GetFullPath(javaPath)));
    }

    private async Task<List<StoredJavaRuntime>> LoadEntriesAsync()
    {
        await _mutex.WaitAsync();
        try { return await LoadEntriesUnsafeAsync(); }
        finally { _mutex.Release(); }
    }

    private async Task<List<StoredJavaRuntime>> LoadEntriesUnsafeAsync()
    {
        if (!File.Exists(_filePath)) return [];
        var json = await File.ReadAllTextAsync(_filePath);
        var entries = JsonSerializer.Deserialize(json, ApiJsonContext.Default.ListStoredJavaRuntime) ?? [];
        return entries
            .Where(e => !string.IsNullOrWhiteSpace(e.Path))
            .Select(e => new StoredJavaRuntime(Path.GetFullPath(e.Path.Trim())))
            .DistinctBy(e => e.Path, PathComparer)
            .ToList();
    }

    private async Task SaveEntriesUnsafeAsync(List<StoredJavaRuntime> entries)
    {
        var json = JsonSerializer.Serialize(entries, ApiJsonContext.Default.ListStoredJavaRuntime);
        await File.WriteAllTextAsync(_filePath, json);
    }

    private static string GetBaseDir()
    {
        var root = Environment.GetEnvironmentVariable("QOMICEX_HOME")
            ?? Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "qomicex-launcher");
        return Path.Combine(root, "QML");
    }

}

public sealed record StoredJavaRuntime(string Path);
