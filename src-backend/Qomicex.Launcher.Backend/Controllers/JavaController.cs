using System.Diagnostics;
using Microsoft.AspNetCore.Mvc;
using Qomicex.Core.Modules.Helpers;

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
        var result = ValidatePath(request.Path);
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

    private static Qomicex.Core.DataModules.DataDetails.Java? ValidatePath(string javaPath)
    {
        if (!System.IO.File.Exists(javaPath)) return null;
        try
        {
            var psi = new ProcessStartInfo(javaPath, "-version")
            {
                RedirectStandardError = true,
                UseShellExecute = false
            };
            using var proc = Process.Start(psi);
            if (proc == null) return null;
            var output = proc.StandardError.ReadToEnd();
            proc.WaitForExit(3000);
            if (proc.ExitCode != 0 || string.IsNullOrEmpty(output)) return null;

            var result = new Qomicex.Core.DataModules.DataDetails.Java();
            result.Path = javaPath;
            var verMatch = System.Text.RegularExpressions.Regex.Match(output, @"(\d+)\.(\d+)\.(\d+)");
            if (verMatch.Success)
            {
                result.Version = verMatch.Value;
                if (int.TryParse(verMatch.Groups[1].Value, out var major))
                    result.VersionID = major;
            }
            if (output.Contains("64-Bit") || output.Contains("64-Bits"))
                result.Arch = "x64";
            else
                result.Arch = "x86";
            if (output.Contains("OpenJDK") || output.Contains(" adopt"))
                result.Type = "OpenJDK";
            else if (output.Contains("Oracle"))
                result.Type = "Oracle";
            return result;
        }
        catch { return null; }
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
