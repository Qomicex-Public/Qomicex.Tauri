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
        // 后续任务在此登记各单元的验证方法
        return _failed;
    }
}
