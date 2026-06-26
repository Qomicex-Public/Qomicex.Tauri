using System.Net.Http.Headers;
using System.Text.Json;
using System.Text.Json.Serialization;
using Microsoft.AspNetCore.Mvc;
using Qomicex.Launcher.Backend.Modules.Helpers.Resources;

namespace Qomicex.Launcher.Backend.Controllers;

[ApiController]
[Route("api/[controller]")]
public class LoadersController : ControllerBase
{
    private static readonly HttpClient _httpClient = new();

    private static readonly Dictionary<string, string[]> LoaderAddonMap = new()
    {
        ["Fabric"] = ["fabric-api"],
        ["Quilt"] = ["qsl"],
    };

    static LoadersController()
    {
        _httpClient.DefaultRequestHeaders.UserAgent.Clear();
        _httpClient.DefaultRequestHeaders.UserAgent.Add(new ProductInfoHeaderValue("Qomicex-Launcher", "1.0"));
        _httpClient.DefaultRequestHeaders.UserAgent.Add(new ProductInfoHeaderValue("(+https://github.com/qomicex)"));
        _httpClient.DefaultRequestHeaders.Accept.Add(new MediaTypeWithQualityHeaderValue("application/json"));
        _httpClient.Timeout = TimeSpan.FromSeconds(10);
    }

    [HttpGet("versions")]
    public async Task<IActionResult> GetLoaderVersions([FromQuery] string gameVersion, [FromQuery] string loader = "All")
    {
        if (string.IsNullOrWhiteSpace(gameVersion))
            return BadRequest(new { error = "gameVersion is required" });

        ModLoaderResourceHelper.ModLoaderType loaderType;
        try
        {
            loaderType = Enum.Parse<ModLoaderResourceHelper.ModLoaderType>(loader, ignoreCase: true);
        }
        catch
        {
            return BadRequest(new { error = $"Invalid loader: {loader}" });
        }

        var helper = new ModLoaderResourceHelper(downloadSourceId: 0);
        var versions = await helper.GetAvailableModLoaders(gameVersion, loaderType);
        return Ok(versions);
    }

    [HttpGet("addons")]
    public async Task<IActionResult> GetLoaderAddons([FromQuery] string loader)
    {
        if (string.IsNullOrWhiteSpace(loader))
            return BadRequest(new { error = "loader is required" });

        var result = new List<object>();

        // OptiFine for Forge
        if (string.Equals(loader, "Forge", StringComparison.OrdinalIgnoreCase))
        {
            result.Add(new
            {
                id = "optifine",
                label = "OptiFine",
                recommended = false,
                description = "Minecraft 性能优化与光影支持，提升 FPS 并支持光影着色器",
                iconUrl = "https://optifine.net/favicon.ico",
                projectUrl = "https://optifine.net/downloads",
                downloads = 0,
            });
        }

        // Modrinth addons for Fabric / Quilt
        if (LoaderAddonMap.TryGetValue(loader, out var slugs))
        {
            foreach (var slug in slugs)
            {
                var info = await FetchModrinthProject(slug);
                if (info != null)
                {
                    result.Add(new
                    {
                        id = slug,
                        label = info.Title,
                        recommended = true,
                        description = info.Description,
                        iconUrl = info.IconUrl ?? "",
                        projectUrl = $"https://modrinth.com/mod/{slug}",
                        downloads = info.Downloads,
                    });
                }
            }
        }

        return Ok(result);
    }

    private async Task<ModrinthProject?> FetchModrinthProject(string slug)
    {
        try
        {
            var response = await _httpClient.GetAsync($"https://api.modrinth.com/v2/project/{slug}");
            if (!response.IsSuccessStatusCode) return null;
            var json = await response.Content.ReadAsStringAsync();
            return JsonSerializer.Deserialize<ModrinthProject>(json, new JsonSerializerOptions { PropertyNamingPolicy = JsonNamingPolicy.SnakeCaseLower });
        }
        catch
        {
            return null;
        }
    }

    private class ModrinthProject
    {
        public string Title { get; set; } = string.Empty;
        public string Description { get; set; } = string.Empty;
        public string? IconUrl { get; set; }
        public long Downloads { get; set; }
    }
}
