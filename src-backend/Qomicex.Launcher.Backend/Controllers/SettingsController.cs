using System.Text.Json;
using System.Text.Json.Nodes;
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
        SettingsDir = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "QML");
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
            System.Diagnostics.Process.Start("explorer.exe", BackgroundsDir);
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
