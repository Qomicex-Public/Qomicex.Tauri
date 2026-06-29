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
    private readonly IHttpClientFactory _httpFactory;

    public ResourceDownloadController(ResourceDownloadService downloadService, IInstanceRepository instanceRepository, IHttpClientFactory httpFactory)
    {
        _downloadService = downloadService;
        _instanceRepository = instanceRepository;
        _httpFactory = httpFactory;
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

    [HttpPost("download-to")]
    public async Task<IActionResult> DownloadTo([FromBody] DownloadToRequest request)
    {
        try
        {
            Directory.CreateDirectory(Path.GetDirectoryName(request.TargetPath)!);
            var http = _httpFactory.CreateClient();
            var response = await http.GetAsync(request.Url);
            if (!response.IsSuccessStatusCode)
                return BadRequest(new { error = "下载失败" });
            using var stream = await response.Content.ReadAsStreamAsync();
            using var fileStream = System.IO.File.Create(request.TargetPath);
            await stream.CopyToAsync(fileStream);
            return Ok(new { path = request.TargetPath });
        }
        catch (Exception ex)
        {
            return BadRequest(new { error = ex.Message });
        }
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

    [HttpPost("cancel-batch")]
    public IActionResult CancelBatch([FromBody] CancelBatchRequest request)
    {
        foreach (var taskId in request.TaskIds)
            _downloadService.Cancel(taskId);
        return Ok(new { message = "已取消" });
    }
}

public class StartResourceDownloadRequest
{
    public string InstanceId { get; set; } = "";
    public string Url { get; set; } = "";
    public string FileName { get; set; } = "";
    public string Category { get; set; } = "mods";
}

public class DownloadToRequest
{
    public string Url { get; set; } = "";
    public string TargetPath { get; set; } = "";
}

public class CancelBatchRequest
{
    public List<string> TaskIds { get; set; } = [];
}
