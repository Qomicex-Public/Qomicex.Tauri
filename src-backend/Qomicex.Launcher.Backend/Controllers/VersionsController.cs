using Microsoft.AspNetCore.Mvc;
using Qomicex.Core.Modules.Helpers;
using Qomicex.Core.Modules.Helpers.Resources;
using System.Text.Json;

namespace Qomicex.Launcher.Backend.Controllers;

[ApiController]
[Route("api/[controller]")]
public class VersionsController : ControllerBase
{
    [HttpGet("scan")]
    public IActionResult ScanLocalVersions([FromQuery] string gameDir)
    {
        if (string.IsNullOrWhiteSpace(gameDir))
            return BadRequest(new { error = "gameDir is required" });

        if (!Directory.Exists(gameDir))
            return BadRequest(new { error = "Directory does not exist" });

        var helper = new GeneralHelper();
        var versions = helper.SearchVersions(gameDir);

        var result = versions.Select(v => new
        {
            v.Name,
            v.GameVersion,
            v.State,
            v.StateDescribe,
            Loaders = v.Type.Select(l => new { l.Type, l.Version }),
            Modpack = ReadModpackMeta(Path.Combine(gameDir, "versions", v.Name)),
        });

        return Ok(result);
    }

    private static object? ReadModpackMeta(string versionDir)
    {
        var metaPath = Path.Combine(versionDir, ".qomicex-modpack.json");
        if (!System.IO.File.Exists(metaPath)) return null;
        try
        {
            using var doc = JsonDocument.Parse(System.IO.File.ReadAllBytes(metaPath));
            return new
            {
                IconData = doc.RootElement.TryGetProperty("iconData", out var icon) ? icon.GetString() : null,
                ModpackName = doc.RootElement.TryGetProperty("modpackName", out var name) ? name.GetString() : null,
                ModpackVersion = doc.RootElement.TryGetProperty("modpackVersion", out var ver) ? ver.GetString() : null,
                ModpackAuthor = doc.RootElement.TryGetProperty("modpackAuthor", out var author) ? author.GetString() : null,
                ModpackSummary = doc.RootElement.TryGetProperty("modpackSummary", out var summary) ? summary.GetString() : null,
            };
        }
        catch { return null; }
    }

    [HttpGet("remote")]
    public async Task<IActionResult> GetRemoteVersions([FromQuery] int source = 1)
    {
        var resourceHelper = new GameResourceHelper();
        var versions = await resourceHelper.GetMinecraftListAsync(source);
        return Ok(versions);
    }
}
