using Microsoft.AspNetCore.Mvc;
using Qomicex.Launcher.Backend.Models;
using Qomicex.Launcher.Backend.Services;

namespace Qomicex.Launcher.Backend.Controllers;

[ApiController]
[Route("api/java/download")]
public class JavaDownloadController : ControllerBase
{
    private readonly JavaDownloadService _service;

    public JavaDownloadController(JavaDownloadService service)
    {
        _service = service;
    }

    [HttpGet("catalog")]
    public async Task<ActionResult<JavaDownloadCatalogResponse>> GetCatalog()
    {
        return Ok(await _service.GetCatalogAsync());
    }

    [HttpPost("start")]
    public async Task<ActionResult<JavaDownloadStartResponse>> Start([FromBody] JavaDownloadStartRequest request)
    {
        return Ok(await _service.StartAsync(request));
    }

    [HttpGet("progress/{taskId}")]
    public ActionResult<JavaDownloadProgressResponse> GetProgress(string taskId)
    {
        var progress = _service.GetProgress(taskId);
        if (progress == null) return NotFound();
        return Ok(progress);
    }

    [HttpDelete("{taskId}")]
    public IActionResult Cancel(string taskId)
    {
        if (_service.Cancel(taskId)) return NoContent();
        return NotFound();
    }

    [HttpPost("{taskId}/pause")]
    public IActionResult Pause(string taskId)
    {
        if (_service.Pause(taskId)) return NoContent();
        return NotFound();
    }

    [HttpPost("{taskId}/resume")]
    public IActionResult Resume(string taskId)
    {
        if (_service.Resume(taskId)) return NoContent();
        return NotFound();
    }
}
