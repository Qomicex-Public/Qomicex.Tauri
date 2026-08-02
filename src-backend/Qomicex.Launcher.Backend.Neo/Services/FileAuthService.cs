using System.Text.Json;
using Qomicex.Launcher.Backend.Neo.Common;
using Qomicex.Launcher.Backend.Neo.JsonContext;

namespace Qomicex.Launcher.Backend.Neo.Services;

/// <summary>
/// 插件文件访问授权服务。
/// 按 {插件id: [已授权路径前缀]} 持久化到 {BaseDir}/plugin-fs-auth.json，
/// 路径统一规范化并校验防目录穿越。
/// </summary>
public class FileAuthService
{
    private readonly string _authFile;
    private readonly object _lock = new();
    private Dictionary<string, List<string>>? _cache;

    public FileAuthService()
    {
        _authFile = Path.Combine(AppPaths.BaseDir, "plugin-fs-auth.json");
    }

    /// <summary>规范化绝对路径：展开相对路径、去除 .. 与多余分隔符。返回 null 表示非法路径。</summary>
    public static string? NormalizePath(string path)
    {
        if (string.IsNullOrWhiteSpace(path)) return null;
        string full;
        try
        {
            full = Path.GetFullPath(path);
        }
        catch
        {
            return null;
        }
        return full;
    }

    /// <summary>判断 grantedPath 是否覆盖 targetPath（前缀目录匹配）。</summary>
    private static bool Covers(string targetPath, string grantedPath)
    {
        var t = targetPath.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
        var g = grantedPath.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
        if (string.Equals(t, g, StringComparison.OrdinalIgnoreCase)) return true;
        return t.StartsWith(g + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase)
            || t.StartsWith(g + Path.AltDirectorySeparatorChar, StringComparison.OrdinalIgnoreCase);
    }

    /// <summary>查询插件对路径的授权状态。返回 null 表示未授权；否则返回匹配的授权前缀。</summary>
    public string? FindGrant(string pluginId, string path)
    {
        var normalized = NormalizePath(path);
        if (normalized == null) return null;
        lock (_lock)
        {
            _cache ??= Load();
            if (!_cache.TryGetValue(pluginId, out var grants)) return null;
            foreach (var g in grants)
            {
                var gn = NormalizePath(g);
                if (gn != null && Covers(normalized, gn)) return g;
            }
        }
        return null;
    }

    /// <summary>为插件授权路径前缀。</summary>
    public void Grant(string pluginId, string path)
    {
        var normalized = NormalizePath(path);
        if (normalized == null) return;
        lock (_lock)
        {
            _cache ??= Load();
            if (!_cache.TryGetValue(pluginId, out var grants))
            {
                grants = [];
                _cache[pluginId] = grants;
            }
            if (!grants.Any(g => string.Equals(NormalizePath(g), normalized, StringComparison.OrdinalIgnoreCase)))
                grants.Add(normalized);
            Save();
        }
    }

    /// <summary>撤销插件对路径前缀的授权。</summary>
    public void Revoke(string pluginId, string path)
    {
        var normalized = NormalizePath(path);
        if (normalized == null) return;
        lock (_lock)
        {
            _cache ??= Load();
            if (!_cache.TryGetValue(pluginId, out var grants)) return;
            grants.RemoveAll(g => string.Equals(NormalizePath(g), normalized, StringComparison.OrdinalIgnoreCase));
            if (grants.Count == 0) _cache.Remove(pluginId);
            Save();
        }
    }

    private Dictionary<string, List<string>> Load()
    {
        if (!File.Exists(_authFile)) return [];
        try
        {
            var json = File.ReadAllText(_authFile);
            return JsonSerializer.Deserialize(json, ApiJsonContext.Default.DictionaryStringListString) ?? [];
        }
        catch { return []; }
    }

    private void Save()
    {
        try
        {
            File.WriteAllText(_authFile, JsonSerializer.Serialize(_cache, ApiJsonContext.Default.DictionaryStringListString));
        }
        catch { }
    }
}
