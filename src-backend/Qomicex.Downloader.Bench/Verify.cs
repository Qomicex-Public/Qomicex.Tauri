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
        FileWriterCases();
        SourcePoolCases();
        SpeedTrackerCases();
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

    private static void FileWriterCases()
    {
        var tmp = Path.Combine(Path.GetTempPath(), "qdw_" + Guid.NewGuid().ToString("N") + ".bin");
        try
        {
using (var w = new FileWriter(tmp))
        {
            w.Preallocate(8);
            w.WriteAsync(4, new byte[] { 5, 6, 7, 8 }, default).AsTask().GetAwaiter().GetResult();
            w.WriteAsync(0, new byte[] { 1, 2, 3, 4 }, default).AsTask().GetAwaiter().GetResult();
            Assert(!File.Exists(tmp), "final not present before commit");
            w.CommitAtomic();
        }
            var bytes = File.ReadAllBytes(tmp);
            Assert(bytes.Length == 8 && bytes[0] == 1 && bytes[7] == 8, "positional writes land correctly");
        }
        finally { if (File.Exists(tmp)) File.Delete(tmp); }

        // 中止：不留 .qdtmp
        var tmp2 = Path.Combine(Path.GetTempPath(), "qdw_" + Guid.NewGuid().ToString("N") + ".bin");
        var w2 = new FileWriter(tmp2);
        w2.WriteAsync(0, new byte[] { 9 }, default).AsTask().GetAwaiter().GetResult();
        w2.Dispose(); // 未 commit
        Assert(!File.Exists(tmp2) && !File.Exists(tmp2 + ".qdtmp"), "abort leaves no files");

        // 同步定位写（小文件内存落盘路径使用，避免 pooled ValueTask 的 GetResult 崩溃）
        var tmp3 = Path.Combine(Path.GetTempPath(), "qdw_" + Guid.NewGuid().ToString("N") + ".bin");
        try
        {
            using (var w3 = new FileWriter(tmp3))
            {
                var payload = new byte[] { 10, 20, 30, 40 };
                w3.Preallocate(payload.Length);
                w3.Write(0, payload);
                w3.CommitAtomic();
            }
            var b3 = File.ReadAllBytes(tmp3);
            Assert(b3.Length == 4 && b3[0] == 10 && b3[3] == 40, "sync Write lands correctly");
        }
        finally { if (File.Exists(tmp3)) File.Delete(tmp3); }
    }

    private static void SpeedTrackerCases()
    {
        var t = new SpeedTracker();
        t.Sample(0);
        System.Threading.Thread.Sleep(220);
        t.Sample(120_000);
        Assert(t.Current > 0, "speed tracker produces positive speed");

        // 200ms 窗口内的连续采样不应爆表（多线程逐包场景）
        var t2 = new SpeedTracker();
        t2.Sample(0);
        for (int i = 1; i <= 100; i++) t2.Sample(i * 64 * 1024);
        Assert(t2.Current < 500L * 1024 * 1024, "rapid sub-window samples do not explode speed");
    }

    private static void SourcePoolCases()
    {
        var pool = new SourcePool(new[] { "https://a.com/x", "https://bmclapi2.bangbang93.com/x" });
        Assert(pool.HasAvailable(), "pool has available initially");

        var s = pool.Acquire();
        // 致命错误（404）立即禁用
        var disabled = pool.ReportFailure(s!, new Exception("错误码 NotFound (404)"), 4);
        Assert(disabled && s!.IsDisabled, "404 disables source");

        // bmclapi 的 403 不禁用
        var s2 = pool.Acquire();
        var d2 = pool.ReportFailure(s2!, new Exception("错误码 Forbidden (403)"), 4);
        Assert(!d2 && !s2!.IsDisabled, "bmclapi 403 not disabled");

        // 全部禁用后可兜底重试一次
        pool.ReportFailure(s2!, new RangeNotSupportedException("no range"), 4);
        Assert(!pool.HasAvailable(), "all disabled");
        Assert(pool.TryResetForRetry(), "reset re-enables once");
        Assert(!pool.TryResetForRetry(), "reset only once");
    }
}
