using System.Reflection;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Text.RegularExpressions;

namespace Qomicex.Launcher.Backend.Services;

public sealed partial class McmodService
{
    // Forward index: normalized English key (slug / parenthesized English) -> (cnName, id).
    private readonly Dictionary<string, (string CnName, int Id)> _forward = [];
    // Reverse index: entries carrying Chinese aliases + an English search term (from slug).
    private readonly List<ReverseEntry> _reverse = [];

    private static readonly JsonSerializerOptions JsonOptions = new() { PropertyNamingPolicy = JsonNamingPolicy.SnakeCaseLower };

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
            var json = TryLoadRuntimeOverride() ?? TryLoadEmbedded();
            if (json == null) return;
            var doc = JsonSerializer.Deserialize<McmodData>(json, JsonOptions);
            if (doc?.Mods == null) return;
            foreach (var entry in doc.Mods)
                IndexEntry(entry);
        }
        catch { /* data unavailable, skip */ }
    }

    private void IndexEntry(McmodEntry entry)
    {
        var cnName = entry.Cn?.Name;
        var slugs = entry.Slug ?? [];

        // Collect every English key that could match a locally-parsed mod display name:
        // the raw slug values plus any English inside parentheses of the Chinese name.
        var englishKeys = new List<string>();
        foreach (var s in slugs)
        {
            AddKey(englishKeys, s.Both);
            AddKey(englishKeys, s.Cf);
            AddKey(englishKeys, s.Mr);
        }
        if (cnName != null)
            foreach (Match m in ParenRegex().Matches(cnName))
                AddKey(englishKeys, m.Groups[1].Value);

        if (!string.IsNullOrEmpty(cnName))
            foreach (var key in englishKeys)
                _forward.TryAdd(key, (cnName, entry.Id));

        // Reverse (Chinese -> slug) index. Needs both a Chinese alias and a usable slug.
        var searchTerm = FirstSlugTerm(slugs);
        if (searchTerm == null) return;

        var aliases = ChineseAliases(cnName);
        if (aliases.Count == 0) return;

        _reverse.Add(new ReverseEntry(aliases, searchTerm, entry.Id));
    }

    private static void AddKey(List<string> keys, string? raw)
    {
        var k = NormalizeEn(raw);
        if (k.Length > 0 && !keys.Contains(k)) keys.Add(k);
    }

    // Split "虚拟人生/凡家物语 (Minecraft Comes Alive)" into ["虚拟人生", "凡家物语"].
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

    // English search term to hand to CurseForge/Modrinth, derived from the first slug.
    private static string? FirstSlugTerm(List<Slug> slugs)
    {
        foreach (var s in slugs)
        {
            var raw = s.Both ?? s.Cf ?? s.Mr;
            if (!string.IsNullOrWhiteSpace(raw)) return raw.Replace('-', ' ').Trim();
        }
        return null;
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

    // Loose normalization: keep only letters/digits, lowercase. So "Industrial Craft 2",
    // "industrial-craft" and "Industrial_Craft2" collapse toward comparable keys.
    private static string NormalizeEn(string? s)
    {
        if (string.IsNullOrEmpty(s)) return "";
        Span<char> buf = s.Length <= 128 ? stackalloc char[s.Length] : new char[s.Length];
        var n = 0;
        foreach (var c in s)
            if (char.IsLetterOrDigit(c)) buf[n++] = char.ToLowerInvariant(c);
        return new string(buf[..n]);
    }

    /// <summary>英文名/slug -> 中文名。</summary>
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

    /// <summary>
    /// 中文关键词 -> 英文搜索词（来自匹配 Mod 的 slug）。
    /// 若关键词不含中文或无匹配，返回 null。用于把中文搜索转发给 CurseForge/Modrinth。
    /// </summary>
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

                // Reject weak overlaps (e.g. a short alias buried in a long query) to
                // avoid false positives for names that are not really in the database.
                if (score < 50) continue;

                // Prefer higher score; tie-break by shorter (more specific) alias, then smaller id.
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

    private sealed class McmodData
    {
        public List<McmodEntry>? Mods { get; set; }
    }

    private sealed class McmodEntry
    {
        public int Id { get; set; }
        public CnInfo? Cn { get; set; }
        public List<Slug>? Slug { get; set; }
    }

    private sealed class CnInfo
    {
        public string? Name { get; set; }
        [JsonPropertyName("can_replace")]
        public bool CanReplace { get; set; }
    }

    private sealed class Slug
    {
        public string? Both { get; set; }
        public string? Cf { get; set; }
        public string? Mr { get; set; }
    }
}
