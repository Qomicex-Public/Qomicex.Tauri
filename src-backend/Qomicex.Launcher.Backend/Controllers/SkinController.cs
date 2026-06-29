using Microsoft.AspNetCore.Mvc;
using Qomicex.Launcher.Backend.Services;

namespace Qomicex.Launcher.Backend.Controllers;

[ApiController]
[Route("api/[controller]")]
public class SkinController : ControllerBase
{
    private readonly SkinService _skin;

    public SkinController(SkinService skin)
    {
        _skin = skin;
    }

    [HttpGet("profile/{uuid}")]
    public async Task<IActionResult> GetProfile(string uuid, [FromQuery] string type = "Microsoft", [FromQuery] string? server = null)
    {
        var profile = await _skin.FetchProfile(uuid, type, server);
        if (profile == null) return NotFound(new { error = "profile not found" });
        return Ok(profile);
    }

    [HttpGet("texture/{uuid}")]
    public async Task<IActionResult> GetTexture(string uuid, [FromQuery] string type = "Microsoft", [FromQuery] string? server = null)
    {
        if (type == "Offline")
            return File(SkinService.GetDefaultSkinBytes(), "image/png");
        var profile = await _skin.FetchProfile(uuid, type, server);
        if (profile?.SkinUrl == null) return NotFound();
        var data = await _skin.DownloadSkin(profile.SkinUrl);
        if (data == null) return NotFound();
        return File(data, "image/png");
    }

    [HttpGet("avatar/{uuid}")]
    public async Task<IActionResult> GetAvatar(string uuid, [FromQuery] string type = "Microsoft", [FromQuery] string? server = null, [FromQuery] int size = 64)
    {
        var data = await _skin.GetHeadAvatar(uuid, type, server, size);
        if (data == null) return NotFound();
        return File(data, "image/png");
    }
}
