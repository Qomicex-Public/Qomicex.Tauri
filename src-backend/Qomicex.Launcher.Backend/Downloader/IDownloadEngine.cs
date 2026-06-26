using System;
using System.Collections.Generic;
using System.Text;
using System.Threading;
using System.Threading.Tasks;

namespace Qomicex.Launcher.Backend.Downloader
{
    public interface IDownloadEngine
    {
        Task DownloadFileAsync(
            string url,
            string outputPath,
            IProgress<Core.FileProgress>? progress,
            CancellationToken cancellationToken,
            string? userAgent = null);

        void Pause();

        void Resume();

        void Cancel();

        void UpdateProgress();
    }
}
