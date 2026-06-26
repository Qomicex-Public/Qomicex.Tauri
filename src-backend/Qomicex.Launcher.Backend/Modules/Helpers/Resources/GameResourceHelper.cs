using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Net.Http;
using System.Text.Json.Nodes;
using System.Threading.Tasks;

namespace Qomicex.Launcher.Backend.Modules.Helpers.Resources
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
            var manifest = await GetMinecraftVersionManifest(source);
            return ParseVersionList(manifest);
        }

        public async Task<JsonObject?> GetMinecraftVersionManifest(int DownloadScore = 1)
        {
            var baseUrl = DownloadScore == 1 ? OfficialBaseUrl : BmclapiBaseUrl;
            var manifestUrl = $"{baseUrl}/mc/game/version_manifest.json";
            try
            {
                var json = await _httpClient.GetStringAsync(manifestUrl);
                return JsonNode.Parse(json)?.AsObject();
            }
            catch (Exception ex)
            {
                Debug.WriteLine($"获取版本列表失败: {ex.Message}");
                return null;
            }

        }

        string LogPath => Path.Combine(Path.GetTempPath(), "qomicex-debug.log");
        void Log(string msg) { try { File.AppendAllText(LogPath, $"[{DateTime.Now:HH:mm:ss}] {msg}\n"); } catch { } }

        public List<VersionInfo> ParseVersionList(JsonObject? versionManifest)
        {
            Log("ParseVersionList called, manifest=" + (versionManifest == null ? "null" : "ok"));
            try
            {
                if (versionManifest == null)
                    return new List<VersionInfo>();

                var versions = new List<VersionInfo>();
                var arr = versionManifest["versions"]?.AsArray();
                if (arr == null)
                    return versions;

                foreach (var version in arr.OfType<JsonObject>())
                {
                    versions.Add(new VersionInfo
                    {
                        Id = SafeGetString(version["id"], "version.id") ?? string.Empty,
                        Type = SafeGetString(version["type"], "version.type") ?? string.Empty,
                        ReleaseTime = DateTime.Parse(SafeGetString(version["releaseTime"], "version.releaseTime") ?? string.Empty),
                        Url = SafeGetString(version["url"], "version.url") ?? string.Empty
                    });
                }

                return versions;
            }
            catch (Exception ex)
            {
                Log($"ParseVersionList failed: {ex}");
                Console.WriteLine($"[GRH] ParseVersionList failed: {ex.Message}");
                Console.WriteLine($"[GRH] Manifest: {versionManifest?.ToJsonString()?[..2000]}");
                throw;
            }
        }

        private static string? SafeGetString(JsonNode? node, string context)
        {
            if (node is JsonValue jv && jv.TryGetValue<string>(out var val))
                return val;
            var msg = $"[GRH] {context}: expected string, got {node?.GetType().Name ?? "null"} | raw: {node?.ToJsonString() ?? "null"}";
            try { File.AppendAllText(Path.Combine(Path.GetTempPath(), "qomicex-debug.log"), $"[{DateTime.Now:HH:mm:ss}] {msg}\n"); } catch { }
            Console.WriteLine(msg);
            return null;
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
