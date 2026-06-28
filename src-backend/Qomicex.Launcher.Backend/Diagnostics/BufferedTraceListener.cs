using System.Diagnostics;

namespace Qomicex.Launcher.Backend.Diagnostics;

public sealed class BufferedTraceListener(TraceBufferStore store) : TraceListener
{
    private string? Category => Attributes?["Category"];

    public override void Write(string? message)
    {
        if (!string.IsNullOrEmpty(message))
        {
            store.Add(Format(message));
        }
    }

    public override void WriteLine(string? message)
    {
        if (!string.IsNullOrEmpty(message))
        {
            store.Add(Format(message));
        }
    }

    private string Format(string message)
    {
        var category = string.IsNullOrWhiteSpace(Category) ? string.Empty : $" [{Category}]";
        return $"{DateTime.Now:yyyy-MM-dd HH:mm:ss.fff}{category} {message}";
    }
}
