using Qomicex.Launcher.Backend.Modules.Helpers.LogAnalysis.Models;
using Qomicex.Launcher.Backend.Modules.Helpers.LogAnalysis.Patterns;
using System;
using System.Collections.Generic;
using System.Linq;
using System.Text.RegularExpressions;

namespace Qomicex.Launcher.Backend.Modules.Helpers.LogAnalysis.Analyzers;

/// <summary>
/// 内存问题分析器
/// 检测OOM错误、GC问题、内存泄漏
/// </summary>
public sealed class MemoryIssueAnalyzer
{
    private readonly LogPatternDatabase _patternDatabase;

    public MemoryIssueAnalyzer(LogPatternDatabase patternDatabase)
    {
        _patternDatabase = patternDatabase;
    }

    /// <summary>
    /// 分析内存相关问题
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
                // 只处理内存类别的问题
                if (match.Pattern.Category == IssueCategory.Memory)
                {
                    var issue = CreateDetectedIssue(match);

                    // 为内存问题添加上下文
                    EnrichMemoryIssueContext(ref issue, lines, i);

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

        // 额外的启发式内存分析
        AnalyzeHeuristicMemoryIssues(lines, issues);

        return issues;
    }

    /// <summary>
    /// 启发式内存分析
    /// </summary>
    private static void AnalyzeHeuristicMemoryIssues(string[] lines, List<DetectedIssue> issues)
    {
        // 分析GC日志
        var gcLines = lines.Where(l =>
            l.Contains("[GC") ||
            l.Contains("Full GC") ||
            l.Contains("GC pause")).ToList();

        if (gcLines.Count > 10 && !issues.Any(i => i.Category == IssueCategory.Memory))
        {
            // 频繁的GC可能表示内存压力
            var firstGcLine = gcLines.First();
            var lineIndex = Array.IndexOf(lines, firstGcLine) + 1;

            issues.Add(new DetectedIssue
            {
                PatternId = "frequent-gc",
                Name = "频繁垃圾回收",
                Category = IssueCategory.Memory,
                Severity = IssueSeverity.Warning,
                MatchedText = firstGcLine,
                LineNumber = lineIndex,
                Solutions =
                [
                    new SuggestedSolution
                    {
                        Priority = 1,
                        Description = "检测到频繁的垃圾回收，可能是内存分配不足",
                        ActionType = "IncreaseMemory"
                    },
                    new SuggestedSolution
                    {
                        Priority = 2,
                        Description = "考虑安装内存优化Mod（如FerriteCore、ModernFix、LazyDFU）",
                        ActionType = "InstallOptimizationMod"
                    }
                ]
            });
        }

        // 分析内存使用趋势
        var memoryTrend = AnalyzeMemoryTrend(gcLines);
        if (memoryTrend.IsCritical && !issues.Any(i => i.PatternId == "memory-trend-critical"))
        {
            issues.Add(new DetectedIssue
            {
                PatternId = "memory-trend-critical",
                Name = "内存使用趋势危险",
                Category = IssueCategory.Memory,
                Severity = IssueSeverity.Warning,
                MatchedText = "内存使用持续增长，可能导致崩溃",
                LineNumber = 0,
                Solutions =
                [
                    new SuggestedSolution
                    {
                        Priority = 1,
                        Description = $"检测到内存使用持续高位（平均{memoryTrend.AverageMemory}MB），建议增加内存分配",
                        ActionType = "IncreaseMemory"
                    }
                ]
            });
        }
    }

    /// <summary>
    /// 为内存问题添加上下文 - 使用 switch 表达式
    /// </summary>
    private static void EnrichMemoryIssueContext(ref DetectedIssue issue, string[] lines, int lineIndex)
    {
        if (issue.PatternId.Contains("out-of-memory"))
        {
            EnrichOutOfMemoryContext(ref issue, lines, lineIndex);
        }
        else if (issue.PatternId == "out-of-memory-metaspace")
        {
            EnrichMetaspaceContext(ref issue, lines, lineIndex);
        }
    }

    /// <summary>
    /// 增强OOM上下文
    /// </summary>
    private static void EnrichOutOfMemoryContext(ref DetectedIssue issue, string[] lines, int lineIndex)
    {
        // 查找GC日志中的内存信息
        for (int i = Math.Max(0, lineIndex - 50); i < lineIndex; i++)
        {
            var line = lines[i];

            // 尝试提取已用内存信息
            var memoryMatch = Regex.Match(line, @"(\d+)M->(\d+)M\((\d+)M\)");
            if (memoryMatch.Success)
            {
                issue = issue.AddCapturedGroup("memoryBeforeGc", memoryMatch.Groups[1].Value)
                             .AddCapturedGroup("memoryAfterGc", memoryMatch.Groups[2].Value)
                             .AddCapturedGroup("memoryTotal", memoryMatch.Groups[3].Value);
                break;
            }
        }

        // 查找当前内存设置
        for (int i = Math.Max(0, lineIndex - 100); i < lineIndex; i++)
        {
            var line = lines[i];
            if (line.Contains("-Xmx"))
            {
                var match = Regex.Match(line, @"-Xmx(\d+)");
                if (match.Success)
                {
                    var currentMemory = int.Parse(match.Groups[1].Value);
                    var (current, recommended) = line.Contains("G")
                        ? (currentMemory * 1024, currentMemory * 2 * 1024)
                        : (currentMemory, currentMemory * 2);

                    issue = issue.AddCapturedGroup("currentMemory", current.ToString())
                                 .AddCapturedGroup("recommendedMemory", recommended.ToString());
                }
                break;
            }
        }

        // 如果没有找到当前内存设置，使用默认值
        if (!issue.CapturedGroups.ContainsKey("currentMemory"))
        {
            issue = issue.AddCapturedGroup("currentMemory", "2048")
                         .AddCapturedGroup("recommendedMemory", "4096");
        }
    }

    /// <summary>
    /// 增强Metaspace上下文
    /// </summary>
    private static void EnrichMetaspaceContext(ref DetectedIssue issue, string[] lines, int lineIndex)
    {
        for (int i = Math.Max(0, lineIndex - 30); i < lineIndex; i++)
        {
            var line = lines[i];
            var metaspaceMatch = Regex.Match(line, @"Metaspace.*?(\d+)K");
            if (metaspaceMatch.Success)
            {
                issue = issue.AddCapturedGroup("metaspaceUsed", metaspaceMatch.Groups[1].Value);
                break;
            }
        }
    }

    /// <summary>
    /// 分析内存趋势
    /// </summary>
    private static MemoryTrendInfo AnalyzeMemoryTrend(List<string> gcLines)
    {
        var memoryUsages = new List<int>();

        foreach (var line in gcLines)
        {
            // 匹配 GC 日志中的内存信息
            var match = Regex.Match(line, @"(\d+)M->\d+M\((\d+)M\)");
            if (match.Success && int.TryParse(match.Groups[1].Value, out var usedMemory))
            {
                memoryUsages.Add(usedMemory);
            }
        }

        if (memoryUsages.Count < 5)
        {
            return new MemoryTrendInfo(false, 0, 0, 0);
        }

        var averageMemory = (int)memoryUsages.Average();
        var maxMemory = memoryUsages.Max();
        var recentAverage = (int)memoryUsages.TakeLast(5).Average();

        // 判断是否为危险趋势
        bool isCritical = recentAverage > averageMemory * 1.2 && maxMemory > 3000;

        return new MemoryTrendInfo(isCritical, averageMemory, maxMemory, recentAverage);
    }

    /// <summary>
    /// 内存趋势信息 - 使用 readonly record struct
    /// </summary>
    private readonly record struct MemoryTrendInfo(
        bool IsCritical,
        int AverageMemory,
        int MaxMemory,
        int RecentAverage);

    /// <summary>
    /// 从匹配结果创建DetectedIssue
    /// </summary>
    private DetectedIssue CreateDetectedIssue(PatternMatchResult match)
    {
        var pattern = match.Pattern;

        var issue = new DetectedIssue
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

        // 填充解决方案中的变量
        var solutions = new List<SuggestedSolution>();
        foreach (var solution in pattern.Solutions)
        {
            var description = solution.Description;

            // 替换捕获组变量
            foreach (var group in match.CapturedGroups)
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

        return issue with { Solutions = solutions };
    }

    /// <summary>
    /// 生成内存使用摘要 - 使用 switch 表达式
    /// </summary>
    public static string GenerateMemorySummary(IReadOnlyList<DetectedIssue> memoryIssues)
    {
        if (memoryIssues.Count == 0) return "内存使用正常";

        var summary = new List<string>();

        foreach (var issue in memoryIssues.Where(i => i.Severity == IssueSeverity.Critical))
        {
            var message = issue.PatternId switch
            {
                var s when s.Contains("heap") => "堆内存不足（严重）",
                var s when s.Contains("metaspace") => "Metaspace内存不足（严重）",
                _ => $"{issue.Name}（严重）"
            };
            summary.Add(message);
        }

        foreach (var issue in memoryIssues.Where(i => i.Severity == IssueSeverity.Warning))
        {
            var message = issue.PatternId switch
            {
                "frequent-gc" => "频繁GC（警告）",
                "memory-trend-critical" => "内存趋势危险（警告）",
                _ => $"{issue.Name}（警告）"
            };
            summary.Add(message);
        }

        return string.Join(", ", summary);
    }
}
