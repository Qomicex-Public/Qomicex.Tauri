using Microsoft.AspNetCore.Mvc;
using Qomicex.Launcher.Backend.Modules.Helpers;

namespace Qomicex.Launcher.Backend.Controllers;

[ApiController]
[Route("api/[controller]")]
public class JavaController : ControllerBase
{
    [HttpGet("search")]
    public IActionResult SearchJava()
    {
        var runtimes = JavaHelper.SearchJava();
        return Ok(runtimes);
    }

    [HttpPost("validate")]
    public IActionResult ValidateJava([FromBody] JavaValidateRequest request)
    {
        var result = JavaHelper.ValidatePath(request.Path);
        if (result == null) return NotFound(new { message = "无法识别该路径下的 Java 运行时" });
        return Ok(result);
    }

    [HttpPost("recommended")]
    public IActionResult GetRecommended([FromBody] JavaRecommendRequest request)
    {
        var javaList = JavaHelper.SearchJava();
        var recommended = JavaHelper.GetRecommendedJava(javaList, request.MinecraftVersion, request.GameDir);
        return Ok(recommended);
    }
}

public class JavaValidateRequest
{
    public string Path { get; set; } = "";
}

public class JavaRecommendRequest
{
    public string MinecraftVersion { get; set; } = "";
    public string GameDir { get; set; } = "";
}
