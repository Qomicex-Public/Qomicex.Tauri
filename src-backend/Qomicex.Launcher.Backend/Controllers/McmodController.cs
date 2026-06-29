using Microsoft.AspNetCore.Mvc;
using Qomicex.Launcher.Backend.Services;

namespace Qomicex.Launcher.Backend.Controllers;

[ApiController]
[Route("api/[controller]")]
public class McmodController : ControllerBase
{
    private readonly McmodService _mcmod;

    public McmodController(McmodService mcmod) => _mcmod = mcmod;

    [HttpGet("lookup")]
    public IActionResult Lookup([FromQuery] string name)
    {
        var cn = _mcmod.Lookup(name);
        if (cn == null) return NotFound(new { cn_name = (string?)null });
        return Ok(new { cn_name = cn });
    }

    [HttpPost("batch")]
    public IActionResult Batch([FromBody] List<string> names)
    {
        if (names == null || names.Count == 0)
            return Ok(new Dictionary<string, string?>());
        return Ok(_mcmod.BatchLookup(names));
    }
}
