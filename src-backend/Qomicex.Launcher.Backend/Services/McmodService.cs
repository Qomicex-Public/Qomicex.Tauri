using System.Reflection;
using System.Text.Json;

namespace Qomicex.Launcher.Backend.Services;

public sealed class McmodService
{
    private readonly Dictionary<string, (string CnName, int? Id)> _map;
    private static readonly JsonSerializerOptions JsonOptions = new() { PropertyNamingPolicy = JsonNamingPolicy.SnakeCaseLower };

    public McmodService()
    {
        _map = [];

        try
        {
            var json = TryLoadRuntimeOverride() ?? TryLoadEmbedded();
            if (json == null) return;
            var doc = JsonSerializer.Deserialize<McmodData>(json, JsonOptions);
            if (doc?.Mods == null) return;
            foreach (var entry in doc.Mods)
            {
                var key = Normalize(entry.EnName ?? "");
                if (key.Length > 0 && !_map.ContainsKey(key))
                    _map[key] = (entry.CnName ?? entry.EnName ?? "", entry.Id);
            }
        }
        catch { /* data unavailable, skip */ }
    }

    private static byte[]? TryLoadRuntimeOverride()
    {
        var path = Path.Combine(AppPaths.BaseDir, "QML", "mcmod_data.json");
        return File.Exists(path) ? File.ReadAllBytes(path) : null;
    }

    private static byte[]? TryLoadEmbedded()
    {
        using var stream = Assembly.GetExecutingAssembly().GetManifestResourceStream("Qomicex.Launcher.Backend.Resources.mcmod_data.json");
        if (stream == null) return null;
        using var ms = new MemoryStream();
        stream.CopyTo(ms);
        return ms.ToArray();
    }

    private static string Normalize(string s) => (s ?? "").Trim().ToLowerInvariant();

    public string? Lookup(string enName)
    {
        var key = Normalize(enName);
        if (key.Length == 0) return null;

        if (_map.TryGetValue(key, out var entry)) return entry.CnName;

        foreach (var (k, v) in _map)
            if (k.Contains(key) || key.Contains(k))
                return v.CnName;

        var words = key.Split(' ', StringSplitOptions.RemoveEmptyEntries);
        foreach (var (k, v) in _map)
            foreach (var w in words)
                if (w.Length > 2 && k.Contains(w))
                    return v.CnName;

        return null;
    }

    public Dictionary<string, string?> BatchLookup(List<string> names)
    {
        var result = new Dictionary<string, string?>(names.Count);
        foreach (var name in names)
            result[name] = Lookup(name);
        return result;
    }

    public Dictionary<string, (string? CnName, int? Id)> BatchLookupWithIds(List<string> names)
    {
        var result = new Dictionary<string, (string? CnName, int? Id)>(names.Count);
        foreach (var name in names)
        {
            if (name == null) continue;
            var key = Normalize(name);
            if (key.Length > 0 && _map.TryGetValue(key, out var entry))
                result[name] = (entry.CnName, entry.Id);
            else
                result[name] = (null, null);
        }
        return result;
    }

    private sealed class McmodData
    {
        public List<McmodEntry>? Mods { get; set; }
    }

    private sealed class McmodEntry
    {
        public int? Id { get; set; }
        public string? EnName { get; set; }
        public string? CnName { get; set; }
    }
}
