using System.Diagnostics;

namespace Qomicex.Launcher.Backend.Diagnostics;

public sealed class BufferedTraceListener(TraceBufferStore store) : TraceListener
{
    private readonly object _gate = new();
    private string _pendingLine = string.Empty;

    private string? Category => Attributes?["Category"];

    public override void Write(string? message)
    {
        if (string.IsNullOrEmpty(message))
        {
            return;
        }

        lock (_gate)
        {
            _pendingLine += message;
        }
    }

    public override void WriteLine(string? message)
    {
        string entry;

        lock (_gate)
        {
            _pendingLine += message ?? string.Empty;
            entry = _pendingLine;
            _pendingLine = string.Empty;
        }

        store.Add(Format(entry));
    }

    private string Format(string message)
    {
        var category = string.IsNullOrWhiteSpace(Category) ? string.Empty : $" [{Category}]";
        return $"{DateTime.Now:yyyy-MM-dd HH:mm:ss.fff}{category} {message}";
    }
}
