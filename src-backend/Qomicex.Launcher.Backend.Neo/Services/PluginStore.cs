using System.Text.Json;
using Qomicex.Launcher.Backend.Neo.Common;
using Qomicex.Launcher.Backend.Neo.JsonContext;
using Qomicex.Launcher.Backend.Neo.Models;

namespace Qomicex.Launcher.Backend.Neo.Services;

public class PluginStore
{
    private readonly string _pluginsDir;
    private List<PluginInfo>? _cache;
    private readonly object _lock = new();

    public PluginStore()
    {
        _pluginsDir = AppPaths.PluginsDir;
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

    public void UninstallPlugin(string id)
    {
        var dir = Path.Combine(_pluginsDir, id);
        if (Directory.Exists(dir))
            Directory.Delete(dir, recursive: true);
        InvalidateCache();
    }

    public void InvalidateCache()
    {
        lock (_lock) { _cache = null; }
    }

    private List<PluginInfo> ScanPlugins()
    {
        var result = new List<PluginInfo>();
        if (!Directory.Exists(_pluginsDir)) return result;

        foreach (var dir in Directory.GetDirectories(_pluginsDir))
        {
            var manifestPath = Path.Combine(dir, "manifest.json");
            if (!File.Exists(manifestPath)) continue;

            try
            {
                var json = File.ReadAllText(manifestPath);
                var manifest = JsonSerializer.Deserialize(json, ApiJsonContext.Default.PluginManifest);
                if (manifest == null) continue;

                result.Add(new PluginInfo
                {
                    Manifest = manifest,
                    Dir = dir,
                    State = "installed",
                    InstalledAt = File.GetCreationTimeUtc(dir).ToString("O")
                });
            }
            catch { }
        }

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
