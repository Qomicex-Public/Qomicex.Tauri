using System.Text.Json;
using Microsoft.AspNetCore.Mvc;
using Qomicex.Launcher.Backend.Services;

namespace Qomicex.Launcher.Backend.Controllers;

[ApiController]
[Route("api/progress")]
public class ProgressSseController : ControllerBase
{
    [HttpGet("stream")]
    public async Task StreamProgress(
        [FromServices] InstanceInstallService installService,
        [FromServices] JavaDownloadService javaService,
        [FromServices] ResourceDownloadService resourceService,
        CancellationToken ct)
    {
        Response.Headers.ContentType = "text/event-stream";
        Response.Headers.CacheControl = "no-cache";
        Response.Headers.Connection = "keep-alive";

        while (!ct.IsCancellationRequested)
        {
            await Task.Delay(300, ct);

            var installs = installService.GetAllActiveStates();
            var javaDownloads = javaService.GetAllActiveStates();
            var resources = resourceService.GetAllActiveStates();

            double totalSpeed = 0;

            foreach (var i in installs) { totalSpeed += i.Speed; }
            foreach (var j in javaDownloads) { totalSpeed += j.Speed; }
            foreach (var r in resources) { totalSpeed += r.Speed; }

            var payload = new
            {
                type = "progress",
                installs,
                javaDownloads,
                resources,
                summary = new
                {
                    activeCount = installs.Count + javaDownloads.Count + resources.Count,
                    totalSpeed
                }
            };

            var json = JsonSerializer.Serialize(payload, new JsonSerializerOptions
            {
                PropertyNamingPolicy = JsonNamingPolicy.CamelCase
            });
            await Response.WriteAsync($"data: {json}\n\n", ct);
            await Response.Body.FlushAsync(ct);
        }
    }
}
