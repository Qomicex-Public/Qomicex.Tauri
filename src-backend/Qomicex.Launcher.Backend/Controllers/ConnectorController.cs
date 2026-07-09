using Microsoft.AspNetCore.Mvc;
using Qomicex.Launcher.Backend.Services.Connector;

namespace Qomicex.Launcher.Backend.Controllers;

[ApiController]
[Route("api/[controller]")]
public class ConnectorController : ControllerBase
{
    private readonly ConnectorService _connector;

    public ConnectorController(ConnectorService connector) => _connector = connector;

    [HttpPost("host/port")]
    public async Task<IActionResult> HostByPort([FromBody] HostByPortRequest req, CancellationToken ct)
    {
        var roomCode = await _connector.HostByPortAsync(req.Port, ct);
        return Ok(new { roomCode });
    }

    [HttpPost("host/instance")]
    public async Task<IActionResult> HostByInstance([FromBody] HostByInstanceRequest req, CancellationToken ct)
    {
        await _connector.HostByInstanceAsync(req.InstanceId, ct);
        return Ok(new { status = "hosting" });
    }

    [HttpPost("join")]
    public async Task<IActionResult> Join([FromBody] JoinRequest req, CancellationToken ct)
    {
        var (host, port) = await _connector.JoinAsync(req.Code, ct);
        return Ok(new { mcHost = host, mcPort = port });
    }

    [HttpGet("status")]
    public IActionResult Status() => Ok(_connector.GetStatus());

    [HttpGet("easytier/status")]
    public IActionResult EasyTierStatus() => Ok(_connector.GetEasyTierStatus());

    [HttpPost("easytier/download")]
    public IActionResult EasyTierDownload()
    {
        _connector.EnsureEasyTierDownloadStarted();
        return Ok(_connector.GetEasyTierStatus());
    }

    [HttpPost("leave")]
    public async Task<IActionResult> Leave(CancellationToken ct)
    {
        await _connector.LeaveAsync(ct);
        return Ok(new { status = "idle" });
    }

    [HttpGet("scan-ports")]
    public IActionResult ScanPorts()
    {
        var port = _connector.ScanJavaPort();
        return Ok(new { port });
    }
}

public class HostByPortRequest { public int Port { get; set; } }
public class HostByInstanceRequest { public string InstanceId { get; set; } = ""; }
public class JoinRequest { public string Code { get; set; } = ""; }
