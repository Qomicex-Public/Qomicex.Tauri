using Qomicex.Core.Common;
using Qomicex.Core.Modules.Helpers.LogAnalysis.Analyzers;
using Qomicex.Core.Modules.Helpers.LogAnalysis.Models;
using Qomicex.Core.Modules.Helpers.LogAnalysis.Patterns;
using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;

namespace Qomicex.Core.Modules.Helpers.LogAnalysis;

/// <summary>
/// Minecraft 日志分析器主类
/// 整合所有分析器，提供统一的分析接口
/// </summary>
public sealed class MinecraftLogAnalyzer
{
    private readonly LogPatternDatabase _patternDatabase;
    private readonly CrashReportAnalyzer _crashReportAnalyzer;
    private readonly JavaExceptionAnalyzer _javaExceptionAnalyzer;
    private readonly ModConflictAnalyzer _modConflictAnalyzer;
    private readonly MemoryIssueAnalyzer _memoryIssueAnalyzer;

    /// <summary>
    /// 初始化日志分析器
    /// </summary>
    /// <param name="externalConfigPath">外部配置文件路径（可选）</param>
    public MinecraftLogAnalyzer(string externalConfigPath = "")
    {
        _patternDatabase = new LogPatternDatabase(externalConfigPath);
        _patternDatabase.LoadPatterns();

        _crashReportAnalyzer = new CrashReportAnalyzer();
        _javaExceptionAnalyzer = new JavaExceptionAnalyzer(_patternDatabase);
        _modConflictAnalyzer = new ModConflictAnalyzer(_patternDatabase);
        _memoryIssueAnalyzer = new MemoryIssueAnalyzer(_patternDatabase);
    }

    /// <summary>
    /// 分析崩溃报告文件
    /// </summary>
    public async Task<Result<LogAnalysisResult, LogAnalysisError>> AnalyzeAsync(
        string filePath,
        CancellationToken cancellationToken = default)
    {
        try
        {
            var content = await File.ReadAllTextAsync(filePath, cancellationToken);
            return await AnalyzeContentAsync(content, filePath, cancellationToken);
        }
        catch (OperationCanceledException)
        {
            throw;
        }
        catch (Exception ex)
        {
            return Result<LogAnalysisResult, LogAnalysisError>.Failure(new LogAnalysisError
            {
                Code = "FILE_READ_ERROR",
                Message = $"读取文件失败: {ex.Message}",
                Details = ex.ToString()
            });
        }
    }

    /// <summary>
    /// 分析日志内容字符串
    /// </summary>
    public async Task<Result<LogAnalysisResult, LogAnalysisError>> AnalyzeContentAsync(
        string content,
        string fileName = "",
        CancellationToken cancellationToken = default)
    {
        try
        {
            var lines = content.Split(['\r', '\n'], StringSplitOptions.None);

            // 1. 使用 CrashReportAnalyzer 解析基本信息
            var crashInfo = _crashReportAnalyzer.AnalyzeContent(content, fileName);

            if (crashInfo.IsFailure)
            {
                return Result<LogAnalysisResult, LogAnalysisError>.Failure(crashInfo.Error);
            }

            var crashReportInfo = crashInfo.Value;

            // 2. 使用各个专项分析器分析问题
            cancellationToken.ThrowIfCancellationRequested();

            var allIssues = new List<DetectedIssue>();

            // Java异常分析
            var javaIssues = _javaExceptionAnalyzer.Analyze(lines);
            allIssues.AddRange(javaIssues);

            cancellationToken.ThrowIfCancellationRequested();

            // Mod冲突分析
            var modIssues = _modConflictAnalyzer.Analyze(lines);
            allIssues.AddRange(modIssues);

            cancellationToken.ThrowIfCancellationRequested();

            // 内存问题分析
            var memoryIssues = _memoryIssueAnalyzer.Analyze(lines);
            allIssues.AddRange(memoryIssues);

            // 3. 去重和排序
            var deduplicatedIssues = DeduplicateAndSortIssues(allIssues);

            return Result<LogAnalysisResult, LogAnalysisError>.Success(
                LogAnalysisResult.Success(
                    filePath: fileName,
                    minecraftVersion: crashReportInfo.MinecraftVersion,
                    modLoader: crashReportInfo.ModLoader,
                    issues: deduplicatedIssues,
                    loadedMods: crashReportInfo.LoadedMods,
                    stackTrace: crashReportInfo.StackTrace,
                    rawLogExcerpt: crashReportInfo.RawLogExcerpt,
                    isGameCrashed: true
                ));
        }
        catch (OperationCanceledException)
        {
            throw;
        }
        catch (Exception ex)
        {
            return Result<LogAnalysisResult, LogAnalysisError>.Failure(new LogAnalysisError
            {
                Code = "ANALYSIS_ERROR",
                Message = $"分析失败: {ex.Message}",
                Details = ex.ToString()
            });
        }
    }

    /// <summary>
    /// 去重并按严重级别排序
    /// </summary>
    private static IReadOnlyList<DetectedIssue> DeduplicateAndSortIssues(List<DetectedIssue> issues)
    {
        // 去重：相同PatternId且相同关键信息（如modA/modB组合）认为是同一个问题
        var uniqueIssues = new List<DetectedIssue>();

        foreach (var issue in issues)
        {
            bool isDuplicate = uniqueIssues.Any(existing =>
                IsDuplicateIssue(existing, issue));

            if (!isDuplicate)
            {
                uniqueIssues.Add(issue);
            }
        }

        // 排序：按严重级别（Critical > Error > Warning > Info），然后按行号
        return uniqueIssues
            .OrderByDescending(i => i.Severity)
            .ThenBy(i => i.LineNumber)
            .ToList();
    }

    /// <summary>
    /// 检查两个Issue是否是重复
    /// </summary>
    private static bool IsDuplicateIssue(DetectedIssue existing, DetectedIssue candidate)
    {
        // 不同PatternId也可能是重复（如果实质相同）
        bool isSamePattern = existing.PatternId == candidate.PatternId;
        bool isSimilarPattern = false;

        // 使用模式匹配简化条件逻辑
        if (!isSamePattern)
        {
            var dependencyPatterns = new[] { "missing-dependency", "fabric-dependency-missing", "quilt-mod-resolution" };
            isSimilarPattern = dependencyPatterns.Contains(existing.PatternId) &&
                               dependencyPatterns.Contains(candidate.PatternId);

            if (!isSimilarPattern)
            {
                var errorPatterns = new[] { "fabric-error", "quilt-error", "incompatible-mod-set" };
                isSimilarPattern = errorPatterns.Contains(existing.PatternId) &&
                                   errorPatterns.Contains(candidate.PatternId);
            }
        }

        // 行号接近（±10行）认为是同一个问题的多次出现
        if ((isSamePattern || isSimilarPattern) && Math.Abs(existing.LineNumber - candidate.LineNumber) <= 10)
            return true;

        // 对于依赖缺失问题，检查modA和modB是否相同
        if (isSamePattern || isSimilarPattern)
        {
            return IsSameDependencyIssue(existing, candidate);
        }

        // 对于Mod冲突，检查冲突的Mod是否相同
        if (existing.PatternId == "mod-version-conflict")
        {
            return IsSameModConflict(existing, candidate);
        }

        // 对于重复的Mod问题
        if (existing.PatternId == "mod-duplicate")
        {
            return IsSameDuplicateMod(existing, candidate);
        }

        // 对于通用错误，检查行号接近或匹配文本相似
        if (existing.PatternId is "fabric-error" or "quilt-error" &&
            candidate.PatternId is "fabric-error" or "quilt-error")
        {
            if (Math.Abs(existing.LineNumber - candidate.LineNumber) <= 10)
                return true;

            // 匹配文本包含相同的关键类名
            if (existing.MatchedText.Contains("FormattedException") &&
                candidate.MatchedText.Contains("FormattedException"))
                return true;
        }

        // 检查匹配文本是否完全相同
        return string.Equals(existing.MatchedText.Trim(), candidate.MatchedText.Trim(), StringComparison.Ordinal) &&
               existing.PatternId == candidate.PatternId;
    }

    /// <summary>
    /// 检查是否是相同的依赖问题
    /// </summary>
    private static bool IsSameDependencyIssue(DetectedIssue existing, DetectedIssue candidate)
    {
        // 使用模式匹配检查 PatternId
        if (existing.PatternId is not ("missing-dependency" or "fabric-dependency-missing") &&
            candidate.PatternId is not ("missing-dependency" or "fabric-dependency-missing"))
        {
            return false;
        }

        // 获取捕获组值
        existing.CapturedGroups.TryGetValue("modA", out var existingModA);
        existing.CapturedGroups.TryGetValue("modB", out var existingModB);
        candidate.CapturedGroups.TryGetValue("modA", out var candidateModA);
        candidate.CapturedGroups.TryGetValue("modB", out var candidateModB);

        // 如果都包含modA和modB，且相同，认为是重复
        if (!string.IsNullOrEmpty(existingModA) && !string.IsNullOrEmpty(candidateModA) &&
            existingModA == candidateModA && existingModB == candidateModB)
            return true;

        // 如果只有modB（缺少依赖的Mod），且相同，也认为是重复
        return string.IsNullOrEmpty(existingModA) && string.IsNullOrEmpty(candidateModA) &&
               existingModB == candidateModB && !string.IsNullOrEmpty(existingModB);
    }

    /// <summary>
    /// 检查是否是相同的Mod冲突
    /// </summary>
    private static bool IsSameModConflict(DetectedIssue existing, DetectedIssue candidate)
    {
        existing.CapturedGroups.TryGetValue("modA", out var existingModA);
        existing.CapturedGroups.TryGetValue("modB", out var existingModB);
        candidate.CapturedGroups.TryGetValue("modA", out var candidateModA);
        candidate.CapturedGroups.TryGetValue("modB", out var candidateModB);

        return existingModA == candidateModA && existingModB == candidateModB;
    }

    /// <summary>
    /// 检查是否是相同的重复Mod问题
    /// </summary>
    private static bool IsSameDuplicateMod(DetectedIssue existing, DetectedIssue candidate)
    {
        existing.CapturedGroups.TryGetValue("modId", out var existingMod);
        candidate.CapturedGroups.TryGetValue("modId", out var candidateMod);

        return existingMod == candidateMod && !string.IsNullOrEmpty(existingMod);
    }

    /// <summary>
    /// 获取崩溃报告目录中的所有崩溃报告文件
    /// </summary>
    public static IReadOnlyList<string> GetCrashReportFiles(string gameDir)
    {
        var crashDir = Path.Combine(gameDir, "crash-reports");
        if (!Directory.Exists(crashDir))
        {
            return [];
        }

        return Directory.GetFiles(crashDir, "*.txt")
            .OrderByDescending(f => File.GetLastWriteTime(f))
            .ToList();
    }

    /// <summary>
    /// 获取最近的崩溃报告文件
    /// </summary>
    public static string? GetLatestCrashReport(string gameDir)
    {
        return GetCrashReportFiles(gameDir).FirstOrDefault();
    }

    /// <summary>
    /// 获取最近N天内的崩溃报告
    /// </summary>
    public static IReadOnlyList<string> GetRecentCrashReports(string gameDir, int days = 7)
    {
        var cutoff = DateTime.Now.AddDays(-days);
        return GetCrashReportFiles(gameDir)
            .Where(f => File.GetLastWriteTime(f) >= cutoff)
            .ToList();
    }

    /// <summary>
    /// 生成分析报告摘要
    /// </summary>
    public static string GenerateSummary(LogAnalysisResult result)
    {
        if (!result.IsSuccess)
        {
            return $"分析失败: {result.ErrorMessage}";
        }

        var summary = new List<string>
        {
            $"Minecraft版本: {result.MinecraftVersion}",
            $"Mod加载器: {result.ModLoader}",
            $"加载Mod数: {result.LoadedMods.Count}",
            $"检测到问题: {result.Issues.Count}个"
        };

        if (result.Issues.Count > 0)
        {
            // 使用模式匹配和聚合统计
            var counts = result.Issues.Aggregate(
                (Critical: 0, Error: 0, Warning: 0),
                (acc, issue) => issue.Severity switch
                {
                    IssueSeverity.Critical => (acc.Critical + 1, acc.Error, acc.Warning),
                    IssueSeverity.Error => (acc.Critical, acc.Error + 1, acc.Warning),
                    IssueSeverity.Warning => (acc.Critical, acc.Error, acc.Warning + 1),
                    _ => acc
                });

            if (counts.Critical > 0)
                summary.Add($"  - 严重问题: {counts.Critical}个");
            if (counts.Error > 0)
                summary.Add($"  - 错误: {counts.Error}个");
            if (counts.Warning > 0)
                summary.Add($"  - 警告: {counts.Warning}个");

            // 问题分类统计
            var categoryGroups = result.Issues
                .GroupBy(i => i.Category)
                .Select(g => $"{GetCategoryName(g.Key)}({g.Count()})")
                .ToList();

            summary.Add($"  - 问题类型: {string.Join(", ", categoryGroups)}");
        }

        return string.Join(Environment.NewLine, summary);
    }

    /// <summary>
    /// 获取分类的本地化名称 - 使用 switch 表达式
    /// </summary>
    private static string GetCategoryName(IssueCategory category) => category switch
    {
        IssueCategory.Memory => "内存",
        IssueCategory.ModConflict => "Mod冲突",
        IssueCategory.JavaRelated => "Java相关",
        IssueCategory.Resource => "资源",
        IssueCategory.Performance => "性能",
        _ => "其他"
    };

    /// <summary>
    /// 获取首要解决方案（优先级最高的第一个解决方案）
    /// </summary>
    public static SuggestedSolution? GetPrimarySolution(LogAnalysisResult result)
    {
        return result.Issues
            .OrderByDescending(i => i.Severity)
            .SelectMany(i => i.Solutions)
            .MinBy(s => s.Priority);
    }

    /// <summary>
    /// 获取所有建议的解决方案（按优先级排序）
    /// </summary>
    public static IReadOnlyList<SuggestedSolution> GetAllSolutions(LogAnalysisResult result)
    {
        return result.Issues
            .SelectMany(i => i.Solutions)
            .OrderBy(s => s.Priority)
            .ToList();
    }

    /// <summary>
    /// 获取指定类别的所有问题
    /// </summary>
    public static IReadOnlyList<DetectedIssue> GetIssuesByCategory(
        LogAnalysisResult result,
        IssueCategory category)
    {
        return result.Issues
            .Where(i => i.Category == category)
            .ToList();
    }

    /// <summary>
    /// 获取指定严重级别的所有问题
    /// </summary>
    public static IReadOnlyList<DetectedIssue> GetIssuesBySeverity(
        LogAnalysisResult result,
        IssueSeverity severity)
    {
        return result.Issues
            .Where(i => i.Severity == severity)
            .ToList();
    }

    /// <summary>
    /// 获取Mod冲突摘要
    /// </summary>
    public string GetModConflictSummary(LogAnalysisResult result)
    {
        var modIssues = result.Issues.Where(i => i.Category == IssueCategory.ModConflict).ToList();
        return ModConflictAnalyzer.ExtractConflictSummary(modIssues);
    }

    /// <summary>
    /// 获取内存使用摘要
    /// </summary>
    public string GetMemorySummary(LogAnalysisResult result)
    {
        var memoryIssues = result.Issues.Where(i => i.Category == IssueCategory.Memory).ToList();
        return MemoryIssueAnalyzer.GenerateMemorySummary(memoryIssues);
    }
}
