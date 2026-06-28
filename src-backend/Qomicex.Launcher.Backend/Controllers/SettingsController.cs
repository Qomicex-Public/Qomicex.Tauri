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

    static SettingsController()
    {
        SettingsDir = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "QML");
        SettingsPath = Path.Combine(SettingsDir, "settings.json");
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
}
