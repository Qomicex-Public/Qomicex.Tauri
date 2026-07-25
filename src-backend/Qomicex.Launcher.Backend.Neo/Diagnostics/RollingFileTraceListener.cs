using System.Diagnostics;
using Qomicex.Launcher.Backend.Neo.Common;

namespace Qomicex.Launcher.Backend.Neo.Diagnostics;

public sealed class RollingFileTraceListener : TraceListener
{
    private readonly string _logDir;
    private readonly object _lock = new();
    private string? _currentDate;
    private StreamWriter? _writer;

    public RollingFileTraceListener()
    {
        _logDir = Path.Combine(AppPaths.BaseDir, "logs");
        Directory.CreateDirectory(_logDir);
    }

    public override void Write(string? message)
    {
        WriteLine(message);
    }

    public override void WriteLine(string? message)
    {
        if (string.IsNullOrEmpty(message)) return;
        lock (_lock)
        {
            var date = DateTime.Now.ToString("yyyy-MM-dd");
            if (_currentDate != date)
            {
                _writer?.Dispose();
                _writer = null;
                _currentDate = date;
                var path = Path.Combine(_logDir, $"backend-{date}.log");
                var fs = new FileStream(path, FileMode.Append, FileAccess.Write, FileShare.ReadWrite);
                _writer = new StreamWriter(fs) { AutoFlush = true };
            }
            _writer?.WriteLine(message);
        }
    }

    protected override void Dispose(bool disposing)
    {
        if (disposing)
        {
            lock (_lock)
            {
                _writer?.Dispose();
                _writer = null;
            }
        }
        base.Dispose(disposing);
    }
}
