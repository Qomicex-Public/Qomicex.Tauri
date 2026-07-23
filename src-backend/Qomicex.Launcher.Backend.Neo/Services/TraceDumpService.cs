using Qomicex.Launcher.Backend.Neo.Common;
using Qomicex.Launcher.Backend.Neo.Diagnostics;

namespace Qomicex.Launcher.Backend.Neo.Services;

public sealed class TraceDumpService(TraceBufferStore bufferStore)
{
    public string Dump(string reason)
    {
        var logDir = Path.Combine(AppPaths.BaseDir, "logs");
        Directory.CreateDirectory(logDir);
        var now = DateTime.Now;
        var filePath = Path.Combine(logDir, $"backend-trace-{now:yyyyMMdd-HHmmss-fff}-{Guid.NewGuid():N}.log");
        var lines = new List<string>
        {
            $"Reason: {reason}",
            $"Timestamp: {now:yyyy-MM-dd HH:mm:ss.fff}",
            string.Empty,
        };
        lines.AddRange(bufferStore.Snapshot());
        File.WriteAllLines(filePath, lines);
        return filePath;
    }
}
