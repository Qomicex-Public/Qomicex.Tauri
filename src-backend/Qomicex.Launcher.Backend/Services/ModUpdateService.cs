using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.Json.Serialization;
using System.Text.RegularExpressions;
using Qomicex.Launcher.Backend.Common;

namespace Qomicex.Launcher.Backend.Services;

public sealed class ModUpdateService
{
    private readonly IHttpClientFactory _httpClientFactory;

    public ModUpdateService(IHttpClientFactory httpClientFactory)
    {
        _httpClientFactory = httpClientFactory;
    }

    public async Task<List<ModUpdateEntry>> CheckUpdates(List<ModUpdateCheckItem> items, string? gameVersion, string? loader)
    {
        var result = new List<ModUpdateEntry>();
        foreach (var item in items)
        {
            if (string.IsNullOrEmpty(item.ProjectId)) continue;
            var latest = item.Source switch
            {
                "modrinth" => await GetLatestModrinthVersion(item.ProjectId, gameVersion, loader),
                "curseforge" => await GetLatestCurseForgeVersion(item.ProjectId, gameVersion),
                _ => null,
            };
            if (latest == null) continue;
            if (SameVersion(latest.VersionNumber, item.CurrentVersion)) continue;
            result.Add(new ModUpdateEntry
            {
                FileName = item.FileName,
                Name = item.Name,
                CurrentVersion = item.CurrentVersion,
                LatestVersion = latest.VersionNumber,
                ProjectId = item.ProjectId,
                Source = item.Source,
                DownloadUrl = latest.DownloadUrl,
                NewFileName = latest.FileName,
            });
        }
        return result;
    }

    // ponytail: heuristic — compare extracted numeric version parts
    // strips loader prefixes (fabric-, forge-) and MC version numbers
    // so e.g. "2.31" ≈ "26.2-2.31-fabric", "0.9.1+mc26.2" ≈ "mc26.2-0.9.1-fabric"
    private static bool SameVersion(string a, string b)
    {
        if (a == b) return true;
        var numsA = Regex.Matches(a, @"\d+(\.\d+)+").Cast<Match>().Select(m => m.Value).ToList();
        var numsB = Regex.Matches(b, @"\d+(\.\d+)+").Cast<Match>().Select(m => m.Value).ToList();
        return numsA.Intersect(numsB).Any();
    }

    private async Task<LatestVersionInfo?> GetLatestModrinthVersion(string projectId, string? gameVersion, string? loader)
    {
        try
        {
            var client = _httpClientFactory.CreateClient("Modrinth");
            var versions = await client.GetFromJsonAsync<List<ModrinthVersionJson>>(
                ModApiMirror.MirrorModrinth($"https://api.modrinth.com/v2/project/{Uri.EscapeDataString(projectId)}/version"));
            if (versions == null || versions.Count == 0) return null;

            var best = versions
                .Where(v => (gameVersion == null || v.GameVersions?.Contains(gameVersion) == true)
                         && (loader == null || v.Loaders == null || v.Loaders.Count == 0 || v.Loaders.Contains(loader)))
                .MaxBy(v => v.DatePublished);
            best ??= versions.MaxBy(v => v.DatePublished);
            if (best == null) return null;

            var primaryFile = best.Files?.FirstOrDefault(f => f.Url != null);
            if (primaryFile == null) return null;

            return new LatestVersionInfo
            {
                VersionNumber = best.VersionNumber ?? "",
                DownloadUrl = primaryFile.Url!,
                FileName = primaryFile.Filename ?? Path.GetFileName(primaryFile.Url) ?? "unknown",
            };
        }
        catch
        {
            return null;
        }
    }

    // ponytail: CF version matching via gameVersion only (no loader filter)
    private async Task<LatestVersionInfo?> GetLatestCurseForgeVersion(string projectId, string? gameVersion)
    {
        try
        {
            var client = _httpClientFactory.CreateClient("CurseForge");
            var query = $"/v1/mods/{Uri.EscapeDataString(projectId)}/files?pageSize=50";
            if (!string.IsNullOrWhiteSpace(gameVersion))
                query += $"&gameVersion={Uri.EscapeDataString(gameVersion)}";

            var req = new HttpRequestMessage(HttpMethod.Get, ModApiMirror.MirrorCurseForge(query));
            var resp = await client.SendAsync(req);
            resp.EnsureSuccessStatusCode();
            var json = await resp.Content.ReadFromJsonAsync<JsonObject>();
            var data = json?["data"]?.AsArray();
            if (data == null || data.Count == 0) return null;

            var latestFile = data
                .Select(f => ParseCfFile(f))
                .Where(f => f != null)
                .MaxBy(f => f!.DatePublished);
            if (latestFile == null) return null;

            return new LatestVersionInfo
            {
                VersionNumber = latestFile.VersionNumber,
                DownloadUrl = latestFile.DownloadUrl,
                FileName = latestFile.FileName,
            };
        }
        catch
        {
            return null;
        }
    }

    private static CfFileInfo? ParseCfFile(JsonNode? node)
    {
        if (node == null) return null;
        try
        {
            var versionNumber = node["displayName"]?.GetValue<string>() ?? "";
            var datePublished = DateTime.MinValue;
            if (DateTime.TryParse(node["fileDate"]?.GetValue<string>(), out var dt)) datePublished = dt;
            var downloadUrl = node["downloadUrl"]?.GetValue<string>() ?? "";
            var fileName = node["fileName"]?.GetValue<string>() ?? "";
            return new CfFileInfo
            {
                VersionNumber = versionNumber,
                DatePublished = datePublished,
                DownloadUrl = downloadUrl,
                FileName = fileName,
            };
        }
        catch { return null; }
    }

    private sealed record CfFileInfo
    {
        public string VersionNumber { get; set; } = "";
        public DateTime DatePublished { get; set; }
        public string DownloadUrl { get; set; } = "";
        public string FileName { get; set; } = "";
    }

    private sealed class ModrinthVersionJson
    {
        [JsonPropertyName("id")] public string? Id { get; set; }
        [JsonPropertyName("version_number")] public string? VersionNumber { get; set; }
        [JsonPropertyName("game_versions")] public List<string>? GameVersions { get; set; }
        [JsonPropertyName("loaders")] public List<string>? Loaders { get; set; }
        [JsonPropertyName("files")] public List<ModrinthFileJson>? Files { get; set; }
        [JsonPropertyName("date_published")] public DateTime DatePublished { get; set; }
    }

    private sealed class ModrinthFileJson
    {
        [JsonPropertyName("url")] public string? Url { get; set; }
        [JsonPropertyName("filename")] public string? Filename { get; set; }
    }
}

public sealed class ModUpdateCheckItem
{
    public string FileName { get; set; } = "";
    public string Name { get; set; } = "";
    public string CurrentVersion { get; set; } = "";
    public string ProjectId { get; set; } = "";
    public string Source { get; set; } = "";
}

public sealed class ModUpdateEntry
{
    public string FileName { get; set; } = "";
    public string Name { get; set; } = "";
    public string CurrentVersion { get; set; } = "";
    public string LatestVersion { get; set; } = "";
    public string ProjectId { get; set; } = "";
    public string Source { get; set; } = "";
    public string DownloadUrl { get; set; } = "";
    public string NewFileName { get; set; } = "";
}

public sealed class BatchUpdateRequest
{
    public List<ModUpdateEntry> Updates { get; set; } = [];
}

public sealed class LatestVersionInfo
{
    public string VersionNumber { get; set; } = "";
    public string DownloadUrl { get; set; } = "";
    public string FileName { get; set; } = "";
}
