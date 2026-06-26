using Microsoft.AspNetCore.Mvc;
using Qomicex.Launcher.Backend.Modules.Helpers;
using static Qomicex.Launcher.Backend.DataModules;

namespace Qomicex.Launcher.Backend.Controllers;

[ApiController]
[Route("api/[controller]")]
public class SystemInfoController : ControllerBase
{
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
            memory = Modules.Helpers.MultiPlatforms.SystemMemoryHelper.GetTotalPhysicalMemory()
        });
    }
}
