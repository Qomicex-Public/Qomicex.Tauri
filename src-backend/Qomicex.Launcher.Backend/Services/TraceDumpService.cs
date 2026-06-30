using Qomicex.Launcher.Backend.Diagnostics;

namespace Qomicex.Launcher.Backend.Services;

public sealed class TraceDumpService(TraceBufferStore bufferStore)
{
    public string Dump(string reason)
    {
        var logDirectory = Path.Combine(AppPaths.BaseDir, "logs");
        Directory.CreateDirectory(logDirectory);

        var now = DateTime.Now;
        var filePath = Path.Combine(logDirectory, $"backend-trace-{now:yyyyMMdd-HHmmss-fff}-{Guid.NewGuid():N}.log");
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
