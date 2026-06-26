using Microsoft.AspNetCore.Mvc;
using Qomicex.Launcher.Backend.ScaffoldingConnector.Core;

namespace Qomicex.Launcher.Backend.Controllers;

[ApiController]
[Route("api/[controller]")]
public class RoomCodeController : ControllerBase
{
    [HttpPost("generate")]
    public IActionResult Generate()
    {
        var code = RoomCode.Generate();
        return Ok(new { code });
    }

    [HttpPost("validate")]
    public IActionResult Validate([FromBody] RoomCodeValidateRequest request)
    {
        var valid = RoomCode.Validate(request.Code);
        return Ok(new { valid });
    }
}

public class RoomCodeValidateRequest
{
    public string Code { get; set; } = "";
}
