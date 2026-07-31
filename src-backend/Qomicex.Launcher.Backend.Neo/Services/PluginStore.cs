using System.Text.Json;
using Qomicex.Launcher.Backend.Neo.Common;
using Qomicex.Launcher.Backend.Neo.JsonContext;
using Qomicex.Launcher.Backend.Neo.Models;

namespace Qomicex.Launcher.Backend.Neo.Services;

public class PluginStore
{
    private readonly string _pluginsDir;
    private readonly string _statesFile;
    private List<PluginInfo>? _cache;
    private Dictionary<string, string>? _statesCache;
    private readonly object _lock = new();

    public PluginStore()
    {
        _pluginsDir = AppPaths.PluginsDir;
        _statesFile = Path.Combine(AppPaths.BaseDir, "plugin-states.json");
        Directory.CreateDirectory(_pluginsDir);
    }

    public List<PluginInfo> ListPlugins()
    {
        lock (_lock)
        {
            if (_cache != null) return _cache;
            return ScanPlugins();
        }
    }

    public PluginInfo? GetPlugin(string id)
    {
        return ListPlugins().FirstOrDefault(p => p.Manifest.Id == id);
    }

    public PluginInfo? InstallPlugin(string sourceDir)
    {
        var manifestPath = Path.Combine(sourceDir, "manifest.json");
        if (!File.Exists(manifestPath)) return null;

        var json = File.ReadAllText(manifestPath);
        var manifest = JsonSerializer.Deserialize(json, ApiJsonContext.Default.PluginManifest);
        if (manifest == null) return null;

        var targetDir = Path.Combine(_pluginsDir, manifest.Id);
        if (Directory.Exists(targetDir))
            Directory.Delete(targetDir, recursive: true);

        CopyDirectory(sourceDir, targetDir);

        InvalidateCache();
        return new PluginInfo
        {
            Manifest = manifest,
            Dir = targetDir,
            State = "installed",
            InstalledAt = DateTime.UtcNow.ToString("O")
        };
    }

    public void SetPluginState(string id, string state)
    {
        lock (_lock)
        {
            _statesCache ??= LoadStates();
            _statesCache[id] = state;
            File.WriteAllText(_statesFile, JsonSerializer.Serialize(_statesCache, ApiJsonContext.Default.DictionaryStringString));
            _cache = null;
        }
    }

    public void UninstallPlugin(string id)
    {
        var dir = Path.Combine(_pluginsDir, id);
        if (Directory.Exists(dir))
            Directory.Delete(dir, recursive: true);
        lock (_lock)
        {
            _statesCache ??= LoadStates();
            _statesCache.Remove(id);
            File.WriteAllText(_statesFile, JsonSerializer.Serialize(_statesCache, ApiJsonContext.Default.DictionaryStringString));
        }
        InvalidateCache();
    }

    private Dictionary<string, string> LoadStates()
    {
        if (!File.Exists(_statesFile)) return [];
        try
        {
            var json = File.ReadAllText(_statesFile);
            return JsonSerializer.Deserialize(json, ApiJsonContext.Default.DictionaryStringString) ?? [];
        }
        catch { return []; }
    }

    public void InvalidateCache()
    {
        lock (_lock) { _cache = null; }
    }

    private List<PluginInfo> ScanPlugins()
    {
        var result = new List<PluginInfo>();
        if (!Directory.Exists(_pluginsDir)) return result;

        var states = LoadStates();

        foreach (var dir in Directory.GetDirectories(_pluginsDir))
        {
            var manifestPath = Path.Combine(dir, "manifest.json");
            if (!File.Exists(manifestPath)) continue;

            try
            {
                var json = File.ReadAllText(manifestPath);
                var manifest = JsonSerializer.Deserialize(json, ApiJsonContext.Default.PluginManifest);
                if (manifest == null) continue;

                var id = manifest.Id;
                states.TryGetValue(id, out var saved);
                result.Add(new PluginInfo
                {
                    Manifest = manifest,
                    Dir = dir,
                    State = saved ?? "installed",
                    InstalledAt = File.GetCreationTimeUtc(dir).ToString("O")
                });
            }
            catch { }
        }

        _statesCache = states;
        _cache = result;
        return result;
    }

    private static void CopyDirectory(string source, string target)
    {
        Directory.CreateDirectory(target);
        foreach (var file in Directory.GetFiles(source))
            File.Copy(file, Path.Combine(target, Path.GetFileName(file)), overwrite: true);
        foreach (var dir in Directory.GetDirectories(source))
            CopyDirectory(dir, Path.Combine(target, Path.GetFileName(dir)));
    }
}
