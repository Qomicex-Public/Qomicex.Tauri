using Microsoft.AspNetCore.Mvc;
using Qomicex.Launcher.Backend.Modules.Launcher;
using static Qomicex.Launcher.Backend.DataModules;
using static Qomicex.Launcher.Backend.DataModules.DataDetails;

namespace Qomicex.Launcher.Backend.Controllers;

[ApiController]
[Route("api/[controller]")]
public class LauncherController : ControllerBase
{
    [HttpPost("build-arguments")]
    public IActionResult BuildArguments([FromBody] LauncherRequest request)
    {
        var launcher = new Modules.Launcher.Launcher();
        var param = new Modules.Launcher.Launcher.LauncherParam
        {
            Version = request.Version,
            MaxMemory = request.MaxMemory,
            AdditionalParam = request.AdditionalParam ?? "",
            DevideVersion = request.DevideVersion,
            GameDir = request.GameDir,
            LauncherName = request.LauncherName ?? "qomicex"
        };
        param.Account.Name = request.AccountName ?? "Player";
        param.Account.Uuid = request.AccountUuid ?? "";
        param.Account.AccessToken = request.AccessToken ?? "faked-token-for-offline";
        param.Java.Path = request.JavaPath ?? "java";
        param.Java.VersionID = request.JavaVersionId;

        var args = launcher.SelectParam(param, param.LauncherName);
        return Ok(new { arguments = args });
    }
}

public class LauncherRequest
{
    public string Version { get; set; } = "";
    public string GameDir { get; set; } = "";
    public string MaxMemory { get; set; } = "2048";
    public string? AdditionalParam { get; set; }
    public bool DevideVersion { get; set; }
    public string? AccountName { get; set; }
    public string? AccountUuid { get; set; }
    public string? AccessToken { get; set; }
    public string? JavaPath { get; set; }
    public int JavaVersionId { get; set; }
    public string? LauncherName { get; set; }
}
