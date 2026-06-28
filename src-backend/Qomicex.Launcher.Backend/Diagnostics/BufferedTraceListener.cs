using System.Diagnostics;
using System.Threading;

namespace Qomicex.Launcher.Backend.Diagnostics;

public sealed class BufferedTraceListener(TraceBufferStore store) : TraceListener
{
    private readonly ThreadLocal<string> _pendingLine = new(() => string.Empty);

    private string? Category => Attributes?["Category"];

    public override void Write(string? message)
    {
        if (string.IsNullOrEmpty(message))
        {
            return;
        }

        _pendingLine.Value += message;
    }

    public override void WriteLine(string? message)
    {
        var entry = _pendingLine.Value + (message ?? string.Empty);
        _pendingLine.Value = string.Empty;

        store.Add(Format(entry));
    }

    public override void Flush()
    {
        var entry = _pendingLine.Value;
        if (string.IsNullOrEmpty(entry))
        {
            return;
        }

        _pendingLine.Value = string.Empty;
        store.Add(Format(entry));
    }

    private string Format(string message)
    {
        var category = string.IsNullOrWhiteSpace(Category) ? string.Empty : $" [{Category}]";
        return $"{DateTime.Now:yyyy-MM-dd HH:mm:ss.fff}{category} {message}";
    }
}
