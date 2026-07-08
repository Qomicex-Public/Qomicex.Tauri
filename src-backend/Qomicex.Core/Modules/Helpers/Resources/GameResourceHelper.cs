using Newtonsoft.Json.Linq;
using System;
using System.Collections.Generic;
using System.Diagnostics;

namespace Qomicex.Core.Modules.Helpers.Resources
{
    public class GameResourceHelper
    {
        private static readonly HttpClient _httpClient = new HttpClient();
        private const string OfficialBaseUrl = "https://launchermeta.mojang.com";
        private const string BmclapiBaseUrl = "https://bmclapi2.bangbang93.com";

        public GameResourceHelper()
        {
        }

        public async Task<List<VersionInfo>> GetMinecraftListAsync(int source = 1)
        {
            dynamic? manifest = await GetMinecraftVersionManifest(source);
            return ParseVersionList(manifest);
        }

        public async Task<dynamic?> GetMinecraftVersionManifest(int DownloadScore = 1)
        {
            var baseUrl = DownloadScore == 1 ? OfficialBaseUrl : BmclapiBaseUrl;
            var manifestUrl = $"{baseUrl}/mc/game/version_manifest.json";
            try
            {
                var json = await _httpClient.GetStringAsync(manifestUrl);
                return JObject.Parse(json);
            }
            catch (Exception ex)
            {
                Trace.WriteLine($"获取版本列表失败: {ex.Message}");
                return null;
            }

        }

        public List<VersionInfo> ParseVersionList(dynamic versionManifest)
        {
            if (versionManifest == null)
                return new List<VersionInfo>();

            var versions = new List<VersionInfo>();

            foreach (var version in versionManifest.versions)
            {
                versions.Add(new VersionInfo
                {
                    Id = version.id.ToString(),
                    Type = version.type.ToString(),
                    ReleaseTime = DateTime.Parse(version.releaseTime.ToString()),
                    Url = version.url.ToString()
                });
            }

            return versions;
        }
        public class VersionInfo
        {
            public string? Id { get; set; }
            public string? Type { get; set; }
            public DateTime ReleaseTime { get; set; }
            public string? Url { get; set; }
        }
    }
}
