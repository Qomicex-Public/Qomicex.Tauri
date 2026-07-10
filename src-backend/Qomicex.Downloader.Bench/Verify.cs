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
        SegmentChainCases();
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

    private static void SegmentChainCases()
    {
        // 空链首段
        var c1 = new SegmentChain(500_000);
        var s1 = c1.ClaimNext();
        Assert(s1 != null && s1.Start == 0, "chain first segment at 0");

        // 分裂最大段：End=499999, Undone=500000, newStart=499999-200000=299999
        var s2 = c1.ClaimNext();
        Assert(s2 != null && s2.Start == 299_999, "chain split at 60% point");
        Assert(c1.End(s1!) == 299_998, "head end shrinks after split");

        // 太小不分裂：单段剩余 < 256KB
        var c2 = new SegmentChain(100 * 1024);
        var a = c2.ClaimNext();          // head @0
        var b = c2.ClaimNext();          // undone 100K < 256K → null
        Assert(a != null && b == null, "no split under threshold");

        // 断点续传：取消一段后重新领取，从断点继续
        var c3 = new SegmentChain(1_000_000);
        var h = c3.ClaimNext()!;
        h.Downloaded = 100_000;
        h.Canceled = true;
        var resumed = c3.ClaimNext();
        Assert(resumed == h && resumed!.Start == 100_000 && resumed.Downloaded == 0, "resume from break point");
    }
}
