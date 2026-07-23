using System.Reflection;
using System.Text.Json;
using System.Text.RegularExpressions;
using Qomicex.Launcher.Backend.Neo.Common;

namespace Qomicex.Launcher.Backend.Neo.Services;

public sealed partial class McmodService
{
    private readonly Dictionary<string, (string CnName, int Id)> _forward = [];
    private readonly List<ReverseEntry> _reverse = [];

    [GeneratedRegex(@"\(([^)]*)\)")]
    private static partial Regex ParenRegex();
    [GeneratedRegex(@"\s*\([^)]*\)")]
    private static partial Regex StripParenRegex();
    [GeneratedRegex(@"[\u4e00-\u9fff]")]
    private static partial Regex ChineseRegex();

    public McmodService()
    {
        try
        {
            var jsonBytes = TryLoadRuntimeOverride() ?? TryLoadEmbedded();
            if (jsonBytes == null) return;
            using var doc = JsonDocument.Parse(jsonBytes);
            if (!doc.RootElement.TryGetProperty("mods", out var modsEl) || modsEl.ValueKind != JsonValueKind.Array)
                return;

            foreach (var modEl in modsEl.EnumerateArray())
                IndexEntry(modEl);
        }
        catch { }
    }

    private void IndexEntry(JsonElement entry)
    {
        var id = entry.TryGetProperty("id", out var idEl) && idEl.TryGetInt32(out var i) ? i : 0;

        string? cnName = null;
        if (entry.TryGetProperty("cn", out var cnEl))
            cnName = cnEl.TryGetProperty("name", out var nEl) ? nEl.GetString() : null;

        var slugs = new List<string>();
        if (entry.TryGetProperty("slug", out var slugArr) && slugArr.ValueKind == JsonValueKind.Array)
        {
            foreach (var s in slugArr.EnumerateArray())
            {
                if (s.TryGetProperty("both", out var b)) AddSlug(slugs, b);
                if (s.TryGetProperty("cf", out var cf)) AddSlug(slugs, cf);
                if (s.TryGetProperty("mr", out var mr)) AddSlug(slugs, mr);
            }
        }

        var englishKeys = new List<string>();
        foreach (var s in slugs)
            AddKey(englishKeys, s);
        if (cnName != null)
            foreach (Match m in ParenRegex().Matches(cnName))
                AddKey(englishKeys, m.Groups[1].Value);

        if (!string.IsNullOrEmpty(cnName))
            foreach (var key in englishKeys)
                _forward.TryAdd(key, (cnName, id));

        var searchTerm = FirstSlugTerm(slugs);
        if (searchTerm == null) return;

        var aliases = ChineseAliases(cnName);
        if (aliases.Count == 0) return;

        _reverse.Add(new ReverseEntry(aliases, searchTerm, id));
    }

    private static void AddSlug(List<string> slugs, JsonElement el)
    {
        var val = el.GetString();
        if (!string.IsNullOrWhiteSpace(val)) slugs.Add(val);
    }

    private static void AddKey(List<string> keys, string? raw)
    {
        var k = NormalizeEn(raw);
        if (k.Length > 0 && !keys.Contains(k)) keys.Add(k);
    }

    private static List<string> ChineseAliases(string? cnName)
    {
        var result = new List<string>();
        if (string.IsNullOrEmpty(cnName)) return result;
        var stripped = StripParenRegex().Replace(cnName, "");
        foreach (var part in stripped.Split('/'))
        {
            var alias = part.Trim();
            if (alias.Length > 0 && ChineseRegex().IsMatch(alias)) result.Add(alias);
        }
        return result;
    }

    private static string? FirstSlugTerm(List<string> slugs)
    {
        if (slugs.Count == 0) return null;
        return slugs[0].Replace('-', ' ').Trim();
    }

    private static byte[]? TryLoadRuntimeOverride()
    {
        var path = Path.Combine(AppPaths.BaseDir, "QML", "mcmod_data.json");
        return File.Exists(path) ? File.ReadAllBytes(path) : null;
    }

    private static byte[]? TryLoadEmbedded()
    {
        using var stream = Assembly.GetExecutingAssembly().GetManifestResourceStream("Qomicex.Launcher.Backend.Neo.Resources.mcmod_data.json");
        if (stream == null) return null;
        using var ms = new MemoryStream();
        stream.CopyTo(ms);
        return ms.ToArray();
    }

    private static string NormalizeEn(string? s)
    {
        if (string.IsNullOrEmpty(s)) return "";
        Span<char> buf = s.Length <= 128 ? stackalloc char[s.Length] : new char[s.Length];
        var n = 0;
        foreach (var c in s)
            if (char.IsLetterOrDigit(c)) buf[n++] = char.ToLowerInvariant(c);
        return new string(buf[..n]);
    }

    public string? Lookup(string enName)
    {
        var key = NormalizeEn(enName);
        if (key.Length == 0) return null;
        return _forward.TryGetValue(key, out var e) ? e.CnName : null;
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
            var key = NormalizeEn(name);
            if (key.Length > 0 && _forward.TryGetValue(key, out var e))
                result[name] = (e.CnName, e.Id);
            else
                result[name] = (null, null);
        }
        return result;
    }

    public string? ResolveChineseSearch(string? keyword)
    {
        if (string.IsNullOrWhiteSpace(keyword) || !ChineseRegex().IsMatch(keyword)) return null;
        var query = new string(keyword.Where(c => !char.IsWhiteSpace(c)).ToArray());
        if (query.Length == 0) return null;

        ReverseEntry? best = null;
        var bestScore = 0;
        var bestAliasLen = int.MaxValue;

        foreach (var entry in _reverse)
        {
            foreach (var alias in entry.Aliases)
            {
                int score;
                if (alias == query) score = 1000;
                else if (alias.Contains(query) || query.Contains(alias))
                    score = Math.Min(alias.Length, query.Length) * 100 / Math.Max(alias.Length, query.Length);
                else continue;

                if (score < 50) continue;

                if (score > bestScore ||
                    (score == bestScore && alias.Length < bestAliasLen) ||
                    (score == bestScore && alias.Length == bestAliasLen && best != null && entry.Id < best.Id))
                {
                    best = entry;
                    bestScore = score;
                    bestAliasLen = alias.Length;
                }
            }
        }

        return best?.SearchTerm;
    }

    private sealed record ReverseEntry(List<string> Aliases, string SearchTerm, int Id);
}
