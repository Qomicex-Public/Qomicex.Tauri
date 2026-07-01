using System.Text.Json;
using System.Text.Json.Nodes;
using System.Diagnostics;
using Microsoft.AspNetCore.Mvc;

namespace Qomicex.Launcher.Backend.Controllers;

[ApiController]
[Route("api/[controller]")]
public class SettingsController : ControllerBase
{
    private static readonly string SettingsDir;
    private static readonly string SettingsPath;
    private static readonly string BackgroundsDir;

    private static readonly string[] ImageExts = [".png", ".jpg", ".jpeg", ".webp", ".bmp"];

    static SettingsController()
    {
        SettingsDir = Path.Combine(AppPaths.BaseDir, "QML");
        SettingsPath = Path.Combine(SettingsDir, "settings.json");
        BackgroundsDir = Path.Combine(SettingsDir, "backgrounds");
    }

    [HttpGet]
    public IActionResult Get()
    {
        if (!System.IO.File.Exists(SettingsPath)) return Ok(new JsonObject());
        var json = System.IO.File.ReadAllText(SettingsPath);
        return Ok(JsonSerializer.Deserialize<JsonElement>(json));
    }

    [HttpPut]
    public IActionResult Put([FromBody] JsonElement body)
    {
        System.IO.Directory.CreateDirectory(SettingsDir);
        var json = JsonSerializer.Serialize(body, new JsonSerializerOptions { WriteIndented = true });
        System.IO.File.WriteAllText(SettingsPath, json);
        return Ok(body);
    }

    private static readonly (int Id, string Name, string Url)[] DownloadSources =
    [
        (0, "官方源", "https://libraries.minecraft.net"),
        (1, "BMCLAPI 镜像", "https://bmclapi2.bangbang93.com"),
    ];

    [HttpGet("download-sources/ping")]
    public async Task<IActionResult> PingDownloadSources()
    {
        var results = new List<object>();
        foreach (var (id, name, url) in DownloadSources)
        {
            try
            {
                using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(5));
                using var client = new HttpClient { Timeout = TimeSpan.FromSeconds(5) };
                var sw = Stopwatch.StartNew();
                using var response = await client.SendAsync(new HttpRequestMessage(HttpMethod.Head, url), cts.Token);
                sw.Stop();
                results.Add(new { id, name, url, latencyMs = (int)sw.ElapsedMilliseconds, available = response.IsSuccessStatusCode });
            }
            catch
            {
                results.Add(new { id, name, url, latencyMs = -1, available = false });
            }
        }
        return Ok(results);
    }

    [HttpGet("download-source/auto-select")]
    public async Task<IActionResult> AutoSelectDownloadSource()
    {
        var bestId = 0;
        var bestLatency = int.MaxValue;

        foreach (var (id, _, url) in DownloadSources)
        {
            try
            {
                using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(5));
                using var client = new HttpClient { Timeout = TimeSpan.FromSeconds(5) };
                var sw = Stopwatch.StartNew();
                using var response = await client.SendAsync(new HttpRequestMessage(HttpMethod.Head, url), cts.Token);
                sw.Stop();
                if (response.IsSuccessStatusCode && sw.ElapsedMilliseconds < bestLatency)
                {
                    bestLatency = (int)sw.ElapsedMilliseconds;
                    bestId = id;
                }
            }
            catch { }
        }

        try
        {
            var json = System.IO.File.Exists(SettingsPath) ? System.IO.File.ReadAllText(SettingsPath) : "{}";
            var doc = JsonSerializer.Deserialize<JsonObject>(json) ?? new JsonObject();
            doc["downloadSource"] = bestId;
            System.IO.Directory.CreateDirectory(SettingsDir);
            System.IO.File.WriteAllText(SettingsPath, JsonSerializer.Serialize(doc, new JsonSerializerOptions { WriteIndented = true }));
        }
        catch { }

        return Ok(new { id = bestId, latencyMs = bestLatency == int.MaxValue ? -1 : bestLatency });
    }

    private static readonly (int Id, string Name, string ModrinthUrl, string CurseForgeUrl)[] ModSources =
    [
        (0, "Modrinth/CurseForge 官方", "https://api.modrinth.com/v2/statistics", "https://api.curseforge.com"),
        (1, "MCIM 镜像", "https://mod.mcimirror.top/statistics?modrinth=true", "https://mod.mcimirror.top/curseforge"),
    ];

    [HttpGet("mod-sources/ping")]
    public async Task<IActionResult> PingModSources()
    {
        var results = new List<object>();
        using var client = new HttpClient { Timeout = TimeSpan.FromSeconds(5) };
        foreach (var (id, name, modrinthUrl, curseforgeUrl) in ModSources)
        {
            var modrinthOk = false;
            var modrinthLatency = -1;
            try
            {
                using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(5));
                var sw = Stopwatch.StartNew();
                using var response = await client.SendAsync(new HttpRequestMessage(HttpMethod.Get, modrinthUrl), cts.Token);
                sw.Stop();
                modrinthOk = response.IsSuccessStatusCode;
                modrinthLatency = (int)sw.ElapsedMilliseconds;
            }
            catch { }

            results.Add(new { id, name, modrinthUrl, modrinthOk, modrinthLatency, available = modrinthOk });
        }
        return Ok(results);
    }

    [HttpGet("mod-source/auto-select")]
    public async Task<IActionResult> AutoSelectModSource()
    {
        var bestId = 0;
        var bestLatency = int.MaxValue;

        using var client = new HttpClient { Timeout = TimeSpan.FromSeconds(5) };
        foreach (var (id, _, modrinthUrl, _) in ModSources)
        {
            try
            {
                using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(5));
                var sw = Stopwatch.StartNew();
                using var response = await client.SendAsync(new HttpRequestMessage(HttpMethod.Get, modrinthUrl), cts.Token);
                sw.Stop();
                if (response.IsSuccessStatusCode && sw.ElapsedMilliseconds < bestLatency)
                {
                    bestLatency = (int)sw.ElapsedMilliseconds;
                    bestId = id;
                }
            }
            catch { }
        }

        try
        {
            var json = System.IO.File.Exists(SettingsPath) ? System.IO.File.ReadAllText(SettingsPath) : "{}";
            var doc = JsonSerializer.Deserialize<JsonObject>(json) ?? new JsonObject();
            doc["modMirror"] = bestId;
            System.IO.Directory.CreateDirectory(SettingsDir);
            System.IO.File.WriteAllText(SettingsPath, JsonSerializer.Serialize(doc, new JsonSerializerOptions { WriteIndented = true }));
        }
        catch { }

        return Ok(new { id = bestId, latencyMs = bestLatency == int.MaxValue ? -1 : bestLatency });
    }

    [HttpGet("backgrounds")]
    public IActionResult ListBackgrounds()
    {
        System.IO.Directory.CreateDirectory(BackgroundsDir);
        var files = System.IO.Directory.GetFiles(BackgroundsDir)
            .Where(f => ImageExts.Contains(Path.GetExtension(f).ToLowerInvariant()))
            .Select(f => Path.GetFileName(f))
            .OrderBy(f => f)
            .ToList();
        return Ok(files);
    }

    [HttpGet("backgrounds/{filename}")]
    public IActionResult GetBackground(string filename)
    {
        var path = Path.GetFullPath(Path.Combine(BackgroundsDir, filename));
        if (!path.StartsWith(BackgroundsDir, StringComparison.OrdinalIgnoreCase) || !System.IO.File.Exists(path))
            return NotFound();
        var ext = Path.GetExtension(filename).ToLowerInvariant();
        var mime = ext switch
        {
            ".png" => "image/png",
            ".jpg" or ".jpeg" => "image/jpeg",
            ".webp" => "image/webp",
            ".bmp" => "image/bmp",
            _ => "application/octet-stream",
        };
        return File(System.IO.File.OpenRead(path), mime);
    }

    [HttpGet("backgrounds-path")]
    public IActionResult GetBackgroundsPath()
    {
        System.IO.Directory.CreateDirectory(BackgroundsDir);
        return Ok(new { path = BackgroundsDir });
    }

    [HttpPost("open-backgrounds")]
    public IActionResult OpenBackgrounds()
    {
        System.IO.Directory.CreateDirectory(BackgroundsDir);
        try
        {
            var psi = new System.Diagnostics.ProcessStartInfo(BackgroundsDir) { UseShellExecute = true };
            System.Diagnostics.Process.Start(psi);
        }
        catch { }
        return Ok();
    }

    [HttpPost("open-folder")]
    public IActionResult OpenFolder([FromBody] JsonElement body)
    {
        var path = body.GetProperty("path").GetString() ?? "";
        if (string.IsNullOrEmpty(path)) return BadRequest();
        if (!Path.IsPathRooted(path))
            path = Path.GetFullPath(Path.Combine(Directory.GetCurrentDirectory(), path));
        try
        {
            Directory.CreateDirectory(path);
            System.Diagnostics.Process.Start(new System.Diagnostics.ProcessStartInfo
            {
                FileName = path,
                UseShellExecute = true,
                Verb = "open"
            });
        }
        catch { }
        return Ok();
    }
}
