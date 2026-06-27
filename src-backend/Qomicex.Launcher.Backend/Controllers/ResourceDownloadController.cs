using Microsoft.AspNetCore.Mvc;
using Qomicex.Launcher.Backend.Models;
using Qomicex.Launcher.Backend.Services;

namespace Qomicex.Launcher.Backend.Controllers;

[ApiController]
[Route("api/resource-download")]
public class ResourceDownloadController : ControllerBase
{
    private readonly ResourceDownloadService _downloadService;
    private readonly IInstanceRepository _instanceRepository;

    public ResourceDownloadController(ResourceDownloadService downloadService, IInstanceRepository instanceRepository)
    {
        _downloadService = downloadService;
        _instanceRepository = instanceRepository;
    }

    [HttpPost("start")]
    public IActionResult StartDownload([FromBody] StartResourceDownloadRequest request)
    {
        var instance = _instanceRepository.GetById(request.InstanceId);
        if (instance == null) return NotFound(new { error = "实例不存在" });

        var gameDir = instance.GameDir;
        if (!Path.IsPathRooted(gameDir))
            gameDir = Path.GetFullPath(Path.Combine(Directory.GetCurrentDirectory(), gameDir));

        var category = request.Category?.ToLowerInvariant() switch
        {
            "mods" => "mods",
            "resourcepacks" => "resourcepacks",
            "shaderpacks" => "shaderpacks",
            "saves" => "saves",
            "screenshots" => "screenshots",
            _ => "mods",
        };

        // version isolation
        var versionsDir = Path.Combine(gameDir, "versions");
        if (Directory.Exists(versionsDir))
        {
            var expectedId = !string.IsNullOrEmpty(instance.Loader) && !string.IsNullOrEmpty(instance.LoaderVersion)
                ? $"{instance.GameVersion}-{instance.Loader}-{instance.LoaderVersion}"
                : instance.GameVersion;
            var expectedDir = Path.Combine(versionsDir, expectedId);
            if (Directory.Exists(expectedDir))
                gameDir = expectedDir;
        }

        var targetDir = Path.Combine(gameDir, category);
        var taskId = _downloadService.StartDownload(request.Url, targetDir, request.FileName);
        return Ok(new { taskId, fileName = request.FileName });
    }

    [HttpGet("{taskId}/progress")]
    public ActionResult<ResourceDownloadState> GetProgress(string taskId)
    {
        var state = _downloadService.GetProgress(taskId);
        if (state == null) return NotFound();
        return Ok(state);
    }

    [HttpPost("{taskId}/cancel")]
    public IActionResult Cancel(string taskId)
    {
        if (_downloadService.Cancel(taskId))
            return Ok(new { message = "已取消" });
        return NotFound();
    }
}

public class StartResourceDownloadRequest
{
    public string InstanceId { get; set; } = "";
    public string Url { get; set; } = "";
    public string FileName { get; set; } = "";
    public string Category { get; set; } = "mods";
}
