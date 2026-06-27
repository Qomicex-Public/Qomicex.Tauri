using Microsoft.AspNetCore.Mvc;
using Qomicex.Core.Modules.Helpers;
using Qomicex.Core.Modules.Helpers.Resources;

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
            Loaders = v.Type.Select(l => new { l.Type, l.Version })
        });

        return Ok(result);
    }

    [HttpGet("remote")]
    public async Task<IActionResult> GetRemoteVersions([FromQuery] int source = 1)
    {
        var resourceHelper = new GameResourceHelper();
        var versions = await resourceHelper.GetMinecraftListAsync(source);
        return Ok(versions);
    }
}
