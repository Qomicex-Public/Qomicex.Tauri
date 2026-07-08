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
        if (_skin.GetLocalSkin(uuid) != null) profile.SkinSource = "local";
        return Ok(profile);
    }

    [HttpGet("texture/{uuid}")]
    public async Task<IActionResult> GetTexture(string uuid, [FromQuery] string type = "Microsoft", [FromQuery] string? server = null)
    {
        var local = _skin.GetLocalSkin(uuid);
        if (local != null) return File(local, "image/png");
        if (type == "Offline")
            return File(SkinService.GetDefaultSkinBytes(), "image/png");
        var profile = await _skin.FetchProfile(uuid, type, server);
        if (profile?.SkinUrl != null)
        {
            var data = await _skin.DownloadSkin(profile.SkinUrl);
            if (data != null) return File(data, "image/png");
        }
        return File(SkinService.GetDefaultSkinBytes(), "image/png");
    }

    [HttpPost("upload/{uuid}")]
    public async Task<IActionResult> Upload(string uuid, IFormFile file)
    {
        if (file == null || file.Length == 0)
            return BadRequest(new { error = "No file uploaded" });
        using var ms = new MemoryStream();
        await file.CopyToAsync(ms);
        _skin.SaveSkin(uuid, ms.ToArray());
        return Ok(new { message = "Skin uploaded" });
    }

    [HttpDelete("upload/{uuid}")]
    public IActionResult Reset(string uuid)
    {
        _skin.DeleteSkin(uuid);
        return Ok(new { message = "Skin reset to default" });
    }
}
