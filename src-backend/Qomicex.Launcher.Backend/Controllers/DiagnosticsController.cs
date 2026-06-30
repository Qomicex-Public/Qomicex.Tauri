using Microsoft.AspNetCore.Mvc;
using Qomicex.Launcher.Backend.Diagnostics;
using Qomicex.Launcher.Backend.Services;
using System.Diagnostics;

namespace Qomicex.Launcher.Backend.Controllers;

[ApiController]
[Route("api/diagnostics")]
public class DiagnosticsController : ControllerBase
{
    private readonly TraceBufferStore _traceBuffer;
    private readonly TraceDumpService _traceDump;
    private readonly IHttpClientFactory _httpClientFactory;

    public DiagnosticsController(
        TraceBufferStore traceBuffer,
        TraceDumpService traceDump,
        IHttpClientFactory httpClientFactory)
    {
        _traceBuffer = traceBuffer;
        _traceDump = traceDump;
        _httpClientFactory = httpClientFactory;
    }

    [HttpGet("trace")]
    public IActionResult GetTrace()
    {
        return Ok(_traceBuffer.Snapshot());
    }

    [HttpPost("dump")]
    public IActionResult DumpTrace()
    {
        var path = _traceDump.Dump("manual");
        return Ok(new { path });
    }

    [HttpGet("health")]
    public async Task<IActionResult> Health()
    {
        var result = new
        {
            backend = true,
            modrinth = await PingUrl("https://api.modrinth.com/v2/statistics"),
            curseforge = await PingUrl("https://api.curseforge.com"),
        };
        return Ok(result);
    }

    private async Task<object> PingUrl(string url)
    {
        try
        {
            var client = _httpClientFactory.CreateClient();
            var sw = Stopwatch.StartNew();
            var response = await client.GetAsync(url);
            sw.Stop();
            return new { ok = response.IsSuccessStatusCode, latency = sw.ElapsedMilliseconds };
        }
        catch
        {
            return new { ok = false, latency = -1 };
        }
    }
}
