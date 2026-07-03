using System.Reflection;
using Microsoft.AspNetCore.Mvc;
using Qomicex.Core.Modules.Helpers;
using static Qomicex.Core.DataModules;

namespace Qomicex.Launcher.Backend.Controllers;

[ApiController]
[Route("api/[controller]")]
public class SystemInfoController : ControllerBase
{
    private static readonly string GitHash = typeof(Program).Assembly
        .GetCustomAttributes<AssemblyMetadataAttribute>()
        .FirstOrDefault(a => a.Key == "GitHash")
        ?.Value ?? "unknown";

    [HttpGet]
    public IActionResult Get()
    {
        var info = SystemInfoHelper.GetSystemInfo();
        return Ok(new
        {
            osName = info.OSName,
            os = info.OS,
            osVersion = info.OSVersion,
            architecture = info.Architecture,
            osVersionId = info.OSVersionID,
            osDisplayName = info.OSDisplayName,
            gitCommit = GitHash,
            memory = Qomicex.Core.Modules.Helpers.MultiPlatforms.SystemMemoryHelper.GetTotalPhysicalMemory(),
            availableMemory = Qomicex.Core.Modules.Helpers.MultiPlatforms.SystemMemoryHelper.GetAvailablePhysicalMemory() / (1024 * 1024)
        });
    }
}
