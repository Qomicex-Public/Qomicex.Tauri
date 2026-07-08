using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;

namespace Qomicex.Core.Modules.Helpers.Resources.Expansion.Local
{
    public class Screenshots: LocalResourceBase
    {
        private readonly string _gameDirectory;
        private readonly string _version;
        private readonly bool _versionSegmented;
        private readonly string _apiKey;

        public Screenshots(string gameDirectory, string version, bool versionSegmented, string apiKey)
        {
            _gameDirectory = gameDirectory;
            _version = version;
            _versionSegmented = versionSegmented;
            _apiKey = apiKey;
        }

        private List<string> GetScreenshotFiles()
        {
            string screenshotDirectory = _versionSegmented
                ? Path.Combine(_gameDirectory, "versions", _version, "screenshots")
                : Path.Combine(_gameDirectory, "screenshots");

            if (!Directory.Exists(screenshotDirectory))
                return new List<string>();

            return Directory.GetFiles(screenshotDirectory, "*.png").ToList();
        }

        public List<ScreenshotInfo> GetScreenshotList()
        {
            var files = GetScreenshotFiles();
            var screenshotInfos = new List<ScreenshotInfo>();

            foreach (var file in files)
            {
                var fileInfo = new FileInfo(file);

                screenshotInfos.Add(new ScreenshotInfo
                {
                    FilePath = file,
                    FileName = fileInfo.Name,
                    CreatedAt = fileInfo.CreationTime,
                    FileSize = fileInfo.Length
                });
            }

            return screenshotInfos;
        }

        public class ScreenshotInfo
        {
            public string FilePath { get; set; }
            public string FileName { get; set; }
            public DateTime CreatedAt { get; set; }
            public long FileSize { get; set; }
        }
    }
}
