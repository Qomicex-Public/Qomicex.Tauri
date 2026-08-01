namespace Qomicex.Launcher.Backend.Neo.Services;

public static class PluginVersion
{
    /// <summary>判断 installed 是否满足 range（如 ">=1.2.0"、">=1"、"=1.0.1"、"1.0.1"、">=1.0 <2.0" 等）。</summary>
    public static bool Satisfies(string installed, string? range)
    {
        if (string.IsNullOrWhiteSpace(range)) return true;

        var parts = range.Split(' ', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
        foreach (var part in parts)
        {
            if (!SatisfiesSingle(installed, part)) return false;
        }
        return true;
    }

    private static bool SatisfiesSingle(string installed, string constraint)
    {
        if (constraint.StartsWith(">=")) return CompareVersions(installed, constraint[2..].Trim()) >= 0;
        if (constraint.StartsWith("<=")) return CompareVersions(installed, constraint[2..].Trim()) <= 0;
        if (constraint.StartsWith('>')) return CompareVersions(installed, constraint[1..].Trim()) > 0;
        if (constraint.StartsWith('<')) return CompareVersions(installed, constraint[1..].Trim()) < 0;
        if (constraint.StartsWith('=')) return CompareVersions(installed, constraint[1..].Trim()) == 0;
        return CompareVersions(installed, constraint) == 0;
    }

    /// <summary>逐段数值比较语义化版本；无法解析时回退字符串比较。</summary>
    public static int CompareVersions(string a, string b)
    {
        var pa = Parse(a);
        var pb = Parse(b);
        var len = Math.Max(pa.Length, pb.Length);
        for (var i = 0; i < len; i++)
        {
            var va = i < pa.Length ? pa[i] : 0;
            var vb = i < pb.Length ? pb[i] : 0;
            if (va != vb) return va < vb ? -1 : 1;
        }
        return 0;
    }

    private static int[] Parse(string version)
    {
        var cleaned = version.Trim().Split('-')[0].Split('+')[0];
        var segs = cleaned.Split('.');
        var nums = new List<int>();
        foreach (var s in segs)
        {
            if (int.TryParse(s, out var n)) nums.Add(n);
            else break;
        }
        return nums.Count > 0 ? nums.ToArray() : [0];
    }
}
