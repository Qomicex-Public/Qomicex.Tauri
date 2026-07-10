using System.Diagnostics;
using System.Text.RegularExpressions;
using Microsoft.AspNetCore.Mvc;
using Qomicex.Core.Modules.Helpers;
using Qomicex.Launcher.Backend.Common;
using Qomicex.Launcher.Backend.Services;

namespace Qomicex.Launcher.Backend.Controllers;

[ApiController]
[Route("api/[controller]")]
public class JavaController : ControllerBase
{
    private readonly JavaRuntimeStore _javaRuntimeStore;

    public JavaController(JavaRuntimeStore javaRuntimeStore)
    {
        _javaRuntimeStore = javaRuntimeStore;
    }

    [HttpGet("search")]
    public IActionResult SearchJava([FromQuery] string? mode)
    {
        var searchMode = ParseSearchMode(mode);
        var runtimes = JavaHelper.SearchJava(new JavaHelper.JavaSearchOptions { Mode = searchMode });

        var merged = new Dictionary<string, JavaHelper.JavaInfoExtended>(OperatingSystem.IsWindows() ? StringComparer.OrdinalIgnoreCase : StringComparer.Ordinal);
        foreach (var j in runtimes)
            merged[Path.GetFullPath(j.Path)] = j;
        foreach (var j in JavaRuntimeStore.ScanJavaDownloadDir())
            merged.TryAdd(Path.GetFullPath(j.Path), j);
        return Ok(merged.Values.ToList());
    }

    [HttpGet("custom")]
    public async Task<IActionResult> GetCustomJava()
    {
        var runtimes = await _javaRuntimeStore.GetCustomAsync();
        return Ok(runtimes);
    }

    [HttpPost("custom")]
    public async Task<IActionResult> AddCustomJava([FromBody] JavaValidateRequest request)
    {
        var runtime = await _javaRuntimeStore.AddCustomAsync(request.Path);
        return Ok(runtime);
    }

    [HttpDelete("custom")]
    public async Task<IActionResult> RemoveCustomJava([FromBody] JavaValidateRequest request)
    {
        await _javaRuntimeStore.RemoveCustomAsync(request.Path);
        return NoContent();
    }

    [HttpGet("list")]
    public async Task<IActionResult> GetJavaList([FromQuery] string? mode)
    {
        var runtimes = await _javaRuntimeStore.GetMergedAsync(ParseSearchMode(mode));
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

    private static JavaHelper.JavaSearchMode ParseSearchMode(string? mode)
    {
        if (string.IsNullOrWhiteSpace(mode) || string.Equals(mode, "quick", StringComparison.OrdinalIgnoreCase))
        {
            return JavaHelper.JavaSearchMode.Quick;
        }

        if (string.Equals(mode, "deep", StringComparison.OrdinalIgnoreCase))
        {
            return JavaHelper.JavaSearchMode.Deep;
        }

        throw ApiException.BadRequest("无效的 Java 搜索模式", "JAVA_SEARCH_MODE_INVALID");
    }

    private static JavaHelper.JavaInfoExtended? ValidatePath(string javaPath)
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

            var result = new JavaHelper.JavaInfoExtended();
            result.Path = javaPath;
            result.State = JavaHelper.JavaState.Valid;

            var verMatch = Regex.Match(output, @"(\d+)\.(\d+)\.(\d+)");
            if (verMatch.Success)
            {
                result.Version = verMatch.Value;
                if (int.TryParse(verMatch.Groups[1].Value, out var major))
                    result.VersionID = major;
            }
            result.Name = result.Version;
            if (output.Contains("aarch64") || output.Contains("ARM64"))
                result.Arch = "arm64";
            else if (output.Contains("64-Bit") || output.Contains("64-Bits"))
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
