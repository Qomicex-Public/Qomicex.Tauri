using System.Text.Json;
using Qomicex.Core.Modules.Helpers;
using Qomicex.Launcher.Backend.Common;

namespace Qomicex.Launcher.Backend.Services;

public sealed class JavaRuntimeStore
{
    private readonly string _filePath;
    private readonly SemaphoreSlim _mutex = new(1, 1);

    private static readonly StringComparer PathComparer = OperatingSystem.IsWindows()
        ? StringComparer.OrdinalIgnoreCase
        : StringComparer.Ordinal;

    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        WriteIndented = true,
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
    };

    public JavaRuntimeStore()
    {
        var dataDir = Path.Combine(AppPaths.BaseDir, "QML");
        Directory.CreateDirectory(dataDir);
        _filePath = Path.Combine(dataDir, "java-runtimes.json");
    }

    public async Task<List<JavaHelper.JavaInfoExtended>> GetCustomAsync()
    {
        var entries = await LoadEntriesAsync();
        var runtimes = new List<JavaHelper.JavaInfoExtended>();

        foreach (var entry in entries)
        {
            var runtime = ValidatePath(entry.Path);
            if (runtime != null)
            {
                runtime.DiscoveredBy = "Custom";
                runtimes.Add(runtime);
            }
        }

        return runtimes;
    }

    public async Task<JavaHelper.JavaInfoExtended> AddCustomAsync(string path)
    {
        var normalizedPath = NormalizePath(path);
        var runtime = ValidatePath(normalizedPath);
        if (runtime == null)
        {
            throw ApiException.NotFound("无法识别该路径下的 Java 运行时", "JAVA_RUNTIME_NOT_FOUND");
        }

        runtime.DiscoveredBy = "Custom";

        await _mutex.WaitAsync();
        try
        {
            var entries = await LoadEntriesUnsafeAsync();
            if (!entries.Any(entry => PathComparer.Equals(entry.Path, normalizedPath)))
            {
                entries.Add(new StoredJavaRuntime(normalizedPath));
                await SaveEntriesUnsafeAsync(entries);
            }
        }
        finally
        {
            _mutex.Release();
        }

        return runtime;
    }

    public async Task RemoveCustomAsync(string path)
    {
        var normalizedPath = NormalizePath(path);

        await _mutex.WaitAsync();
        try
        {
            var entries = await LoadEntriesUnsafeAsync();
            if (entries.RemoveAll(entry => PathComparer.Equals(entry.Path, normalizedPath)) > 0)
            {
                await SaveEntriesUnsafeAsync(entries);
            }
        }
        finally
        {
            _mutex.Release();
        }
    }

    public async Task<List<JavaHelper.JavaInfoExtended>> GetMergedAsync(JavaHelper.JavaSearchMode mode)
    {
        var scanned = JavaHelper.SearchJava(new JavaHelper.JavaSearchOptions { Mode = mode });
        var merged = new Dictionary<string, JavaHelper.JavaInfoExtended>(PathComparer);

        foreach (var runtime in scanned)
        {
            merged[NormalizePath(runtime.Path)] = runtime;
        }

        foreach (var runtime in await GetCustomAsync())
        {
            merged[NormalizePath(runtime.Path)] = runtime;
        }

        return merged.Values.ToList();
    }

    private async Task<List<StoredJavaRuntime>> LoadEntriesAsync()
    {
        await _mutex.WaitAsync();
        try
        {
            return await LoadEntriesUnsafeAsync();
        }
        finally
        {
            _mutex.Release();
        }
    }

    private async Task<List<StoredJavaRuntime>> LoadEntriesUnsafeAsync()
    {
        if (!File.Exists(_filePath))
        {
            return [];
        }

        var json = await File.ReadAllTextAsync(_filePath);
        var entries = JsonSerializer.Deserialize<List<StoredJavaRuntime>>(json, JsonOptions) ?? [];

        return entries
            .Where(entry => !string.IsNullOrWhiteSpace(entry.Path))
            .Select(entry => new StoredJavaRuntime(NormalizePath(entry.Path)))
            .DistinctBy(entry => entry.Path, PathComparer)
            .ToList();
    }

    private async Task SaveEntriesUnsafeAsync(List<StoredJavaRuntime> entries)
    {
        var json = JsonSerializer.Serialize(entries, JsonOptions);
        await File.WriteAllTextAsync(_filePath, json);
    }

    private static string NormalizePath(string path)
    {
        if (string.IsNullOrWhiteSpace(path))
        {
            throw ApiException.BadRequest("Java 路径不能为空", "JAVA_RUNTIME_PATH_REQUIRED");
        }

        return Path.GetFullPath(path.Trim());
    }

    private static JavaHelper.JavaInfoExtended? ValidatePath(string javaPath)
    {
        var javaHome = Path.GetDirectoryName(Path.GetDirectoryName(javaPath));
        if (string.IsNullOrEmpty(javaHome))
        {
            return null;
        }

        var runtimes = JavaHelper.SearchJava(new JavaHelper.JavaSearchOptions
        {
            Mode = JavaHelper.JavaSearchMode.Custom,
            CustomRootPath = javaHome,
            MaxDepth = 2,
            MaxResults = 20,
            ScanHiddenFolders = true,
        });

        return runtimes.FirstOrDefault(runtime => PathComparer.Equals(NormalizePath(runtime.Path), javaPath));
    }

    private sealed record StoredJavaRuntime(string Path);
}
