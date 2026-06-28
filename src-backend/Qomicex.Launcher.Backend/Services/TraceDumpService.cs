using Qomicex.Launcher.Backend.Diagnostics;

namespace Qomicex.Launcher.Backend.Services;

public sealed class TraceDumpService(TraceBufferStore bufferStore)
{
    public string Dump(string reason)
    {
        var logDirectory = Path.Combine(AppContext.BaseDirectory, "logs");
        Directory.CreateDirectory(logDirectory);

        var filePath = Path.Combine(logDirectory, $"backend-trace-{DateTime.Now:yyyyMMdd-HHmmss}.log");
        var lines = new List<string>
        {
            $"Reason: {reason}",
            $"Timestamp: {DateTime.Now:yyyy-MM-dd HH:mm:ss.fff}",
            string.Empty,
        };

        lines.AddRange(bufferStore.Snapshot());
        File.WriteAllLines(filePath, lines);
        return filePath;
    }
}
