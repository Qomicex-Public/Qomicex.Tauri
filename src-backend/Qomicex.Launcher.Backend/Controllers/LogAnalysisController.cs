using Microsoft.AspNetCore.Mvc;
using Qomicex.Core.Modules.Helpers.LogAnalysis;
using Qomicex.Core.Modules.Helpers.LogAnalysis.Models;
using Qomicex.Launcher.Backend.Services;

namespace Qomicex.Launcher.Backend.Controllers;

[ApiController]
[Route("api/[controller]")]
public class LogAnalysisController : ControllerBase
{
    private readonly CrashUploadService _crashUploadService;
    private readonly IInstanceRepository _instanceRepository;
    private readonly LaunchService _launchService;

    public LogAnalysisController(
        CrashUploadService crashUploadService,
        IInstanceRepository instanceRepository,
        LaunchService launchService)
    {
        _crashUploadService = crashUploadService;
        _instanceRepository = instanceRepository;
        _launchService = launchService;
    }

    [HttpPost("analyze")]
    public async Task<IActionResult> Analyze([FromBody] LogAnalysisRequest request)
    {
        var analyzer = new MinecraftLogAnalyzer();
        var result = await analyzer.AnalyzeAsync(request.LogContent);
        return Ok(result);
    }

    [HttpPost("analyze-crash/{instanceId}")]
    public async Task<IActionResult> AnalyzeCrash(string instanceId)
    {
        var instance = _instanceRepository.GetById(instanceId);
        if (instance == null)
            return NotFound(new { code = "INSTANCE_NOT_FOUND", message = "实例不存在" });

        var progress = _launchService.Get(instanceId);
        var crashReport = progress?.CrashReport;
        if (string.IsNullOrEmpty(crashReport))
            return BadRequest(new { code = "NO_CRASH_REPORT", message = "无可用崩溃报告" });

        var analyzer = new MinecraftLogAnalyzer();
        var analysisResult = await analyzer.AnalyzeContentAsync(crashReport);

        if (analysisResult.IsFailure)
            return Ok(new CrashAnalysisResponse
            {
                Analysis = new
                {
                    isSuccess = false,
                    minecraftVersion = null as string,
                    modLoader = null as string,
                    loadedMods = Array.Empty<string>(),
                    stackTrace = null as string,
                    rawLogExcerpt = null as string,
                    issues = Array.Empty<object>(),
                    errorMessage = analysisResult.Error.Message
                },
                McloGsUrl = null,
                QrCodeBase64 = null
            });

        var analysis = analysisResult.Value;
        var mapped = MapAnalysisForFrontend(analysis);

        var (url, qrPng) = await _crashUploadService.UploadCrashLogAsync(crashReport);

        return Ok(new CrashAnalysisResponse
        {
            Analysis = mapped,
            McloGsUrl = url,
            QrCodeBase64 = qrPng != null ? "data:image/png;base64," + Convert.ToBase64String(qrPng) : null
        });
    }

    private static object MapAnalysisForFrontend(LogAnalysisResult result)
    {
        return new
        {
            isSuccess = result.IsSuccess,
            minecraftVersion = result.MinecraftVersion,
            modLoader = result.ModLoader,
            loadedMods = result.LoadedMods.Select(m => m.Id).ToArray(),
            stackTrace = result.StackTrace.Count > 0 ? string.Join("\n", result.StackTrace) : null as string,
            rawLogExcerpt = result.RawLogExcerpt,
            issues = result.Issues.Select(i => new
            {
                patternId = i.PatternId,
                category = i.Category.ToString(),
                severity = i.Severity.ToString(),
                lineNumber = i.LineNumber,
                matchedText = i.MatchedText,
                capturedGroups = i.CapturedGroups,
                solutions = i.Solutions.Select(s => new
                {
                    title = s.Description.Length > 30 ? s.Description[..30] + "..." : s.Description,
                    description = s.Description,
                    action = s.ActionType
                }).ToArray()
            }).ToArray(),
            errorMessage = result.ErrorMessage
        };
    }
}

public class LogAnalysisRequest
{
    public string LogContent { get; set; } = "";
}

public class CrashAnalysisResponse
{
    public object? Analysis { get; set; }
    public string? McloGsUrl { get; set; }
    public string? QrCodeBase64 { get; set; }
}
