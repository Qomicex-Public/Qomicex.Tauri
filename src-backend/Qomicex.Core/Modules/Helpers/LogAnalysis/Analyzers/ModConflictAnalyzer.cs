using Qomicex.Core.Modules.Helpers.LogAnalysis.Models;
using Qomicex.Core.Modules.Helpers.LogAnalysis.Patterns;
using System.Collections.Generic;
using System.Linq;
using System.Text.RegularExpressions;

namespace Qomicex.Core.Modules.Helpers.LogAnalysis.Analyzers;

/// <summary>
/// Mod冲突分析器
/// 检测重复Mod、版本冲突、缺失依赖
/// </summary>
public sealed class ModConflictAnalyzer
{
    private readonly LogPatternDatabase _patternDatabase;

    public ModConflictAnalyzer(LogPatternDatabase patternDatabase)
    {
        _patternDatabase = patternDatabase;
    }

    /// <summary>
    /// 分析Mod相关冲突
    /// </summary>
    public IReadOnlyList<DetectedIssue> Analyze(string[] lines)
    {
        var issues = new List<DetectedIssue>();

        for (int i = 0; i < lines.Length; i++)
        {
            var line = lines[i];

            // 使用模式数据库匹配
            var matches = _patternDatabase.MatchPatterns(line, i + 1);
            foreach (var match in matches)
            {
                // 只处理Mod冲突类别的问题
                if (match.Pattern.Category == IssueCategory.ModConflict)
                {
                    var issue = CreateDetectedIssue(match);

                    // 为特定问题添加额外上下文
                    EnrichIssueContext(ref issue, lines, i);

                    // 在上下文增强后填充解决方案
                    FillSolutions(ref issue, match.Pattern);

                    // 去重
                    if (!issues.Any(existing =>
                        existing.PatternId == issue.PatternId &&
                        existing.LineNumber == issue.LineNumber))
                    {
                        issues.Add(issue);
                    }
                }
            }
        }

        // 额外的启发式分析
        AnalyzeHeuristicIssues(lines, issues);

        return issues;
    }

    /// <summary>
    /// 启发式分析其他Mod问题
    /// </summary>
    private static void AnalyzeHeuristicIssues(string[] lines, List<DetectedIssue> issues)
    {
        // 检查是否有大量Mod加载失败的迹象
        var failedModLines = lines.Where(l =>
            l.Contains("failed to load") ||
            l.Contains("Failed to create mod instance") ||
            l.Contains("Could not create mod instance")).ToList();

        if (failedModLines.Count > 5)
        {
            // 可能是系统性问题，而不是单个Mod问题
            var firstLine = failedModLines.First();
            var lineIndex = System.Array.IndexOf(lines, firstLine) + 1;

            issues.Add(new DetectedIssue
            {
                PatternId = "multiple-mods-failed",
                Name = "多个Mod加载失败",
                Category = IssueCategory.ModConflict,
                Severity = IssueSeverity.Critical,
                MatchedText = firstLine,
                LineNumber = lineIndex,
                Solutions = new List<SuggestedSolution>
                {
                    new()
                    {
                        Priority = 1,
                        Description = $"检测到 {failedModLines.Count} 个Mod加载失败，可能是Java版本或Mod Loader版本不兼容",
                        ActionType = "CheckCompatibility"
                    }
                }
            });
        }

        // 检查版本隔离问题
        var versionLines = lines.Where(l =>
            (l.Contains("version mismatch") ||
             (l.Contains("incompatible with") && !l.Contains("mods are incompatible")) ||
             l.Contains("requires Minecraft")) &&
            !issues.Any(i => i.MatchedText.Contains(l.Trim()))).ToList();

        foreach (var line in versionLines)
        {
            if (!issues.Any(i => i.MatchedText == line))
            {
                var lineIndex = System.Array.IndexOf(lines, line) + 1;
                issues.Add(new DetectedIssue
                {
                    PatternId = "version-mismatch",
                    Name = "Mod版本不匹配",
                    Category = IssueCategory.ModConflict,
                    Severity = IssueSeverity.Error,
                    MatchedText = line,
                    LineNumber = lineIndex,
                    Solutions = new List<SuggestedSolution>
                    {
                        new()
                        {
                            Priority = 1,
                            Description = "Mod与当前游戏版本不兼容，请更新Mod或寻找适配版本",
                            ActionType = "UpdateMod"
                        }
                    }
                });
            }
        }
    }

    /// <summary>
    /// 为Issue添加上下文信息
    /// </summary>
    private static void EnrichIssueContext(ref DetectedIssue issue, string[] lines, int lineIndex)
    {
        // 使用 switch 表达式简化条件逻辑
        switch (issue.PatternId)
        {
            case "missing-dependency":
                EnrichMissingDependencyContext(ref issue, lines, lineIndex);
                break;

            case "mixin-transformer-error":
                EnrichMixinContext(ref issue, lines, lineIndex);
                break;

            case "quilt-mod-resolution":
            case "quilt-invalid-mod-json":
                EnrichQuiltContext(ref issue, lines, lineIndex);
                break;

            case "fabric-dependency-missing":
                EnrichFabricContext(ref issue, lines, lineIndex);
                break;

            case "class-not-found" when !issue.CapturedGroups.ContainsKey("class"):
                EnrichClassNotFoundContext(ref issue);
                break;

            case "no-such-method":
                EnrichNoSuchMethodContext(ref issue);
                break;
        }
    }

    /// <summary>
    /// 增强依赖缺失上下文
    /// </summary>
    private static void EnrichMissingDependencyContext(ref DetectedIssue issue, string[] lines, int lineIndex)
    {
        // 检查后续几行是否有更多细节
        for (int i = lineIndex + 1; i < lines.Length && i < lineIndex + 10; i++)
        {
            var line = lines[i];
            if (line.Contains("Required by:") || line.Contains("required by:"))
            {
                issue = issue.AddCapturedGroup("requiredBy", line.Trim());
                break;
            }
        }
    }

    /// <summary>
    /// 增强Mixin错误上下文
    /// </summary>
    private static void EnrichMixinContext(ref DetectedIssue issue, string[] lines, int lineIndex)
    {
        var mixinDetails = new List<string>();
        for (int i = lineIndex; i < lines.Length && i < lineIndex + 20; i++)
        {
            var line = lines[i];
            if (line.Contains("Mixin apply failed") ||
                line.Contains("target class") ||
                line.Contains("NoClassDefFoundError"))
            {
                mixinDetails.Add(line.Trim());
            }
        }

        if (mixinDetails.Count > 0)
        {
            issue = issue.AddCapturedGroup("mixinDetails", string.Join(" | ", mixinDetails.Take(5)));
        }
    }

    /// <summary>
    /// 增强Quilt上下文
    /// </summary>
    private static void EnrichQuiltContext(ref DetectedIssue issue, string[] lines, int lineIndex)
    {
        // 查找包含Mod路径的行
        for (int i = lineIndex; i < lines.Length && i < lineIndex + 30; i++)
        {
            var line = lines[i];
            var modPathMatch = Regex.Match(line, @"Mod at [""']([^""']+\.jar)[""']");
            if (modPathMatch.Success)
            {
                var fullPath = modPathMatch.Groups[1].Value;
                var fileName = System.IO.Path.GetFileName(fullPath);
                issue = issue.AddCapturedGroup("modFile", fileName)
                             .AddCapturedGroup("modPath", fullPath);
                break;
            }
        }

        // 查找ParseException的具体信息
        for (int i = lineIndex; i < lines.Length && i < lineIndex + 30; i++)
        {
            var line = lines[i];
            if (line.Contains("ParseException"))
            {
                issue = issue.AddCapturedGroup("parseError", line.Trim());
                break;
            }
        }
    }

    /// <summary>
    /// 增强Fabric上下文
    /// </summary>
    private static void EnrichFabricContext(ref DetectedIssue issue, string[] lines, int lineIndex)
    {
        // 查找Fix行获取精确版本
        for (int i = lineIndex - 10; i < lines.Length && i < lineIndex + 20; i++)
        {
            if (i < 0) continue;
            var line = lines[i];

            // 匹配 Fix: add [add:architectury 9.0.0 ([[9.0.0,∞)])]
            var fixMatch = Regex.Match(line, @"Fix: add \[add:(?<modB>\S+)\s+(?<version>[\d.]+)");
            if (fixMatch.Success)
            {
                issue = issue.AddCapturedGroup("modB", fixMatch.Groups["modB"].Value)
                             .AddCapturedGroup("version", fixMatch.Groups["version"].Value);
            }
        }

        // 查找 Immediate reason 行获取modA
        for (int i = lineIndex - 10; i < lines.Length && i < lineIndex + 20; i++)
        {
            if (i < 0) continue;
            var line = lines[i];

            var reasonMatch = Regex.Match(line, @"HARD_DEP_NO_CANDIDATE\s+(?<modA>\S+)\s+\S+\s+\{depends\s+(?<modB2>\S+)");
            if (reasonMatch.Success)
            {
                if (!issue.CapturedGroups.ContainsKey("modA"))
                    issue = issue.AddCapturedGroup("modA", reasonMatch.Groups["modA"].Value);

                if (!issue.CapturedGroups.ContainsKey("modB"))
                {
                    var modBFromDepends = reasonMatch.Groups["modB2"].Value;
                    if (!string.IsNullOrEmpty(modBFromDepends))
                        issue = issue.AddCapturedGroup("modB", modBFromDepends);
                }
            }
        }

        // 匹配中文提示
        for (int i = lineIndex - 10; i < lines.Length && i < lineIndex + 20; i++)
        {
            if (i < 0) continue;
            var line = lines[i];
            var chineseMatch = Regex.Match(line, @"模组.*\((?<modA>[^)]+)\).*需要.*?(?<modB>\w+).*?(?<version>\d+\.\d+\.\d+)");
            if (chineseMatch.Success)
            {
                if (!issue.CapturedGroups.ContainsKey("modA"))
                    issue = issue.AddCapturedGroup("modA", chineseMatch.Groups["modA"].Value);
                if (!issue.CapturedGroups.ContainsKey("modB"))
                    issue = issue.AddCapturedGroup("modB", chineseMatch.Groups["modB"].Value);
                if (!issue.CapturedGroups.ContainsKey("version"))
                    issue = issue.AddCapturedGroup("version", chineseMatch.Groups["version"].Value);
            }
        }
    }

    /// <summary>
    /// 增强类未找到上下文
    /// </summary>
    private static void EnrichClassNotFoundContext(ref DetectedIssue issue)
    {
        var match = Regex.Match(issue.MatchedText, @"(?:ClassNotFoundException|NoClassDefFoundError):\s*(\S+)");
        if (match.Success)
        {
            issue = issue.AddCapturedGroup("class", match.Groups[1].Value);
        }
    }

    /// <summary>
    /// 增强方法未找到上下文
    /// </summary>
    private static void EnrichNoSuchMethodContext(ref DetectedIssue issue)
    {
        var match = Regex.Match(issue.MatchedText, @"NoSuchMethodError:\s*(\S+)\.(\S+)");
        if (match.Success)
        {
            issue = issue.AddCapturedGroup("class", match.Groups[1].Value)
                         .AddCapturedGroup("method", match.Groups[2].Value);
        }
    }

    /// <summary>
    /// 从匹配结果创建DetectedIssue
    /// </summary>
    private DetectedIssue CreateDetectedIssue(PatternMatchResult match)
    {
        var pattern = match.Pattern;

        return new DetectedIssue
        {
            PatternId = pattern.Id,
            Name = _patternDatabase.GetLocalizedName(pattern, "zh"),
            Category = pattern.Category,
            Severity = pattern.Severity,
            MatchedText = match.MatchedText,
            LineNumber = match.LineNumber,
            CapturedGroups = new Dictionary<string, string>(match.CapturedGroups),
            Solutions = []
        };
    }

    /// <summary>
    /// 填充解决方案
    /// </summary>
    private static void FillSolutions(ref DetectedIssue issue, ErrorPattern pattern)
    {
        var solutions = new List<SuggestedSolution>();

        // 填充解决方案中的变量
        foreach (var solution in pattern.Solutions)
        {
            var description = solution.Description;

            // 替换捕获组变量
            foreach (var group in issue.CapturedGroups)
            {
                description = description.Replace($"{{{group.Key}}}", group.Value);
            }

            // 替换参数变量
            foreach (var param in solution.Parameters)
            {
                description = description.Replace($"{{{param.Key}}}", param.Value?.ToString() ?? "");
            }

            solutions.Add(new SuggestedSolution
            {
                Priority = solution.Priority,
                Description = description,
                ActionType = solution.ActionType,
                Parameters = solution.Parameters ?? new Dictionary<string, object>()
            });
        }

        issue = issue with { Solutions = solutions };
    }

    /// <summary>
    /// 提取Mod冲突摘要信息 - 使用 switch 表达式和模式匹配
    /// </summary>
    public static string ExtractConflictSummary(IReadOnlyList<DetectedIssue> issues)
    {
        if (issues.Count == 0) return "未检测到Mod冲突";

        var summary = new List<string>();

        // 使用 switch 表达式统计
        var counts = issues.Aggregate(
            (Critical: 0, Error: 0, Warning: 0),
            (acc, issue) => issue.Severity switch
            {
                IssueSeverity.Critical => (acc.Critical + 1, acc.Error, acc.Warning),
                IssueSeverity.Error => (acc.Critical, acc.Error + 1, acc.Warning),
                IssueSeverity.Warning => (acc.Critical, acc.Error, acc.Warning + 1),
                _ => acc
            });

        if (counts.Critical > 0)
            summary.Add($"严重问题: {counts.Critical}个");
        if (counts.Error > 0)
            summary.Add($"错误: {counts.Error}个");
        if (counts.Warning > 0)
            summary.Add($"警告: {counts.Warning}个");

        // 添加具体问题类型
        var issueTypes = issues
            .GroupBy(i => i.Name)
            .Select(g => $"{g.Key}({g.Count()})")
            .Take(5);

        summary.Add("问题类型: " + string.Join(", ", issueTypes));

        return string.Join("; ", summary);
    }
}
