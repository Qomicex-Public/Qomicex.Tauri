using System.Diagnostics;
using Qomicex.Downloader.Refactor.Progress;
using DlLogLevel = Qomicex.Downloader.Refactor.Progress.LogLevel;

namespace Qomicex.Launcher.Backend.Neo.Common;

public static class DownloaderTrace
{
    public static IProgress<DownloadLogEntry> CreateLogProgress()
    {
        return new Progress<DownloadLogEntry>(entry =>
        {
            var level = entry.Level switch
            {
                DlLogLevel.Error => "ERROR",
                DlLogLevel.Warning => "WARN",
                DlLogLevel.Retry => "RETRY",
                _ => "INFO"
            };
            var detail = entry.Detail is not null ? $" | {entry.Detail}" : "";
            Trace.WriteLine($"[Downloader][{level}] [{entry.TaskId[..Math.Min(8, entry.TaskId.Length)]}] {entry.Message}{detail}");
        });
    }
}
