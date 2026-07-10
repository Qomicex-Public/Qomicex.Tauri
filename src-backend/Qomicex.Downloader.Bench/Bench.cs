using System.Diagnostics;
using Qomicex.Downloader;

namespace Qomicex.Downloader.Bench;

public static class Bench
{
    public static async Task<int> RunAsync(string[] urls)
    {
        if (urls.Length == 0)
        {
            Console.WriteLine("usage: bench <url> [url...]");
            return 2;
        }
        foreach (var url in urls)
        {
            Console.WriteLine($"\n=== {url} ===");
            await Measure("NEW", url, new Core(threadCount: 8, mirrorRuleSets: new[] { MirrorRuleSets.Bmclapi }));
            await Measure("OLD", url, new LegacyCore(threadCount: 8));
        }
        return 0;
    }

    private static async Task Measure(string label, string url, IDownloadEngine engine)
    {
        var dir = Path.Combine(Path.GetTempPath(), "qdbench");
        Directory.CreateDirectory(dir);
        var outPath = Path.Combine(dir, label + "_" + Guid.NewGuid().ToString("N") + ".bin");

        long min = long.MaxValue, max = 0, samples = 0, sumSpeed = 0;
        var progress = new Progress<DownloadProgress>(p =>
        {
            if (p.Speed <= 0) return;
            samples++; sumSpeed += (long)p.Speed;
            if (p.Speed < min) min = (long)p.Speed;
            if (p.Speed > max) max = (long)p.Speed;
        });

        var sw = Stopwatch.StartNew();
        string result;
        try
        {
            await engine.DownloadFileAsync(url, outPath, progress, default, "QomicexBench/1.0");
            sw.Stop();
            long size = new FileInfo(outPath).Length;
            result = $"OK  size={Fmt(size)}  time={sw.ElapsedMilliseconds}ms  avg={Fmt(size * 1000 / Math.Max(sw.ElapsedMilliseconds,1))}/s  min={Fmt(min==long.MaxValue?0:min)}/s  max={Fmt(max)}/s";
        }
        catch (Exception ex)
        {
            sw.Stop();
            result = $"FAIL  {ex.Message}";
        }
        finally { try { File.Delete(outPath); } catch { } }

        Console.WriteLine($"[{label}] {result}");
    }

    private static string Fmt(long b)
        => b >= 1_048_576 ? $"{b / 1_048_576.0:0.0}MB" : b >= 1024 ? $"{b / 1024.0:0.0}KB" : $"{b}B";
}
