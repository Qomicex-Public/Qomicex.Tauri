namespace Qomicex.Downloader.Bench;

public static class Verify
{
    private static int _failed;

    public static void Assert(bool cond, string name)
    {
        if (cond) { Console.WriteLine($"[PASS] {name}"); }
        else { _failed++; Console.WriteLine($"[FAIL] {name}"); }
    }

    public static int RunAll()
    {
        _failed = 0;
        SourceExpanderCases();
        return _failed;
    }

    private static void SourceExpanderCases()
    {
        var exp = new SourceExpander(new[] { MirrorRuleSets.Bmclapi }, preferMirror: true);

        var r1 = exp.Expand("https://libraries.minecraft.net/foo/bar.jar");
        Assert(r1[0] == "https://bmclapi2.bangbang93.com/maven/foo/bar.jar", "expand libraries→bmclapi first");
        Assert(r1.Contains("https://libraries.minecraft.net/foo/bar.jar"), "expand keeps official");

        var r2 = exp.Expand("https://bmclapi2.bangbang93.com/maven/net/neoforged/neoforge/x.jar");
        Assert(r2[0].StartsWith("https://bmclapi2.bangbang93.com/maven/net/neoforged/neoforge/"), "reverse keeps mirror first");
        Assert(r2.Any(u => u.StartsWith("https://maven.neoforged.net/releases/net/neoforged/neoforge/")), "reverse adds neoforge official candidate");

        var r3 = exp.Expand("https://example.com/a.bin");
        Assert(r3.Count == 1 && r3[0] == "https://example.com/a.bin", "unknown url stays single");

        var r4 = exp.Expand("https://meta.fabricmc.net/v2/versions");
        Assert(r4.Distinct(StringComparer.OrdinalIgnoreCase).Count() == r4.Count, "expand dedups");
    }
}
