using Microsoft.AspNetCore.Mvc;
using Qomicex.Core.Modules.Helpers.LogAnalysis;
using Qomicex.Core.Modules.Helpers.LogAnalysis.Models;

namespace Qomicex.Launcher.Backend.Controllers;

[ApiController]
[Route("api/[controller]")]
public class LogAnalysisController : ControllerBase
{
    [HttpPost("analyze")]
    public async Task<IActionResult> Analyze([FromBody] LogAnalysisRequest request)
    {
        var analyzer = new MinecraftLogAnalyzer();
        var result = await analyzer.AnalyzeAsync(request.LogContent);
        return Ok(result);
    }
}

public class LogAnalysisRequest
{
    public string LogContent { get; set; } = "";
}
