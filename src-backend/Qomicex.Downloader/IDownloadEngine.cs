namespace Qomicex.Downloader
{
    public sealed class DownloadProgress
    {
        public double Progress { get; set; }
        public long DownloadedBytes { get; set; }
        public long TotalBytes { get; set; }
        public double Speed { get; set; }
        public bool IsCompleted { get; set; }
    }

    public interface IDownloadEngine
    {
        /// <summary>
        /// 异步下载文件
        /// </summary>
        Task DownloadFileAsync(
            string url,
            string outputPath,
            IProgress<DownloadProgress>? progress,
            CancellationToken cancellationToken,
            string? userAgent = null);

        /// <summary>
        /// 暂停下载
        /// </summary>
        void Pause();

        /// <summary>
        /// 恢复下载
        /// </summary>
        void Resume();

        /// <summary>
        /// 取消下载
        /// </summary>
        void Cancel();

        /// <summary>
        /// 手动触发进度更新（当 AutoUpdate=false 时）
        /// </summary>
        void UpdateProgress();
    }
}
