## Task 8: ConnectorController + DI 注册 + 生命周期清理

**Files:**
- Create: `src-backend/Qomicex.Launcher.Backend/Controllers/ConnectorController.cs`
- Modify: `src-backend/Qomicex.Launcher.Backend/Program.cs`

**Interfaces:**
- Consumes: `ConnectorService`（Task 5-7）。
- Produces: HTTP 端点 `api/connector/{host/port, host/instance, join, status, leave}`。

- [ ] **Step 1: 创建 ConnectorController.cs**

```csharp
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

    [HttpPost("leave")]
    public async Task<IActionResult> Leave(CancellationToken ct)
    {
        await _connector.LeaveAsync(ct);
        return Ok(new { status = "idle" });
    }
}

public class HostByPortRequest { public int Port { get; set; } }
public class HostByInstanceRequest { public string InstanceId { get; set; } = ""; }
public class JoinRequest { public string Code { get; set; } = ""; }
```

- [ ] **Step 2: Program.cs 注册 DI**

在 `builder.Services.AddSingleton<LanGameListenerService>();` 之后追加：

```csharp
builder.Services.AddSingleton<Qomicex.Launcher.Backend.Services.Connector.GameProcessInspector>();
builder.Services.AddSingleton<Qomicex.Launcher.Backend.Services.Connector.ConnectorService>();
```

- [ ] **Step 3: Program.cs 生命周期清理**

在 `app.Lifetime.ApplicationStopping.Register(() => lanService.Stop());` 之后追加：

```csharp
var connectorService = app.Services.GetRequiredService<Qomicex.Launcher.Backend.Services.Connector.ConnectorService>();
app.Lifetime.ApplicationStopping.Register(() => { try { connectorService.LeaveAsync().GetAwaiter().GetResult(); } catch { } });
```

- [ ] **Step 4: 验证 build + 运行**

Run: `dotnet build src-backend/Qomicex.Launcher.Backend/Qomicex.Launcher.Backend.csproj`
Expected: Build succeeded。

手动：`cd src-backend/Qomicex.Launcher.Backend && dotnet run`，另开终端 `curl http://localhost:5000/api/connector/status`，应返回 `{"mode":"idle",...}`。

- [ ] **Step 5: Commit**

```bash
git add src-backend/Qomicex.Launcher.Backend/Controllers/ConnectorController.cs src-backend/Qomicex.Launcher.Backend/Program.cs
git commit -m "feat: add ConnectorController and register ConnectorService"
```

---

