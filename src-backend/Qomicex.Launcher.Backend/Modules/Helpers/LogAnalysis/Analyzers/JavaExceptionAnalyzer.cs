using Qomicex.Launcher.Backend.Modules.Helpers.LogAnalysis.Models;
using Qomicex.Launcher.Backend.Modules.Helpers.LogAnalysis.Patterns;
using System.Collections.Generic;
using System.Linq;
using System.Text.RegularExpressions;

namespace Qomicex.Launcher.Backend.Modules.Helpers.LogAnalysis.Analyzers;

/// <summary>
/// Java异常分析器
/// 分析Java异常类型、堆栈追踪
/// </summary>
public sealed class JavaExceptionAnalyzer
{
    private readonly LogPatternDatabase _patternDatabase;

    public JavaExceptionAnalyzer(LogPatternDatabase patternDatabase)
    {
        _patternDatabase = patternDatabase;
    }

    /// <summary>
    /// 分析日志中的Java异常
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
                // 只处理Java相关和未知类别的问题
                if (match.Pattern.Category is IssueCategory.JavaRelated or IssueCategory.Unknown)
                {
                    var issue = CreateDetectedIssue(match);

                    // 如果有堆栈，收集相关的堆栈行
                    if (IsExceptionLine(line))
                    {
                        var stackTrace = CollectStackTrace(lines, i);
                        if (stackTrace.Count > 0)
                        {
                            issue = issue.AddCapturedGroup("stackTrace", string.Join("\n", stackTrace));
                        }
                    }

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

        return issues;
    }

    /// <summary>
    /// 分析单行
    /// </summary>
    public IReadOnlyList<DetectedIssue> AnalyzeLine(string line, int lineNumber)
    {
        var matches = _patternDatabase.MatchPatterns(line, lineNumber);
        return matches
            .Where(m => m.Pattern.Category is IssueCategory.JavaRelated or IssueCategory.Unknown)
            .Select(CreateDetectedIssue)
            .ToList();
    }

    /// <summary>
    /// 判断是否是异常行 - 使用模式匹配优化
    /// </summary>
    private static bool IsExceptionLine(string line)
    {
        return line switch
        {
            var s when s.StartsWith("java.lang.") => true,
            var s when s.StartsWith("java.net.") => true,
            var s when s.StartsWith("java.io.") => true,
            var s when s.StartsWith("Exception in thread") => true,
            _ => false
        };
    }

    /// <summary>
    /// 收集堆栈追踪上下文
    /// </summary>
    private static IReadOnlyList<string> CollectStackTrace(string[] lines, int startIndex)
    {
        var stackTrace = new List<string>();

        // 收集异常行及其后续堆栈行
        for (int i = startIndex; i < lines.Length && i < startIndex + 50; i++)
        {
            var line = lines[i].Trim();

            // 包含异常信息或堆栈行
            if (IsStackTraceLine(line) || IsExceptionLine(line))
            {
                stackTrace.Add(line);
            }
            // 空行或非堆栈行表示结束
            else if (string.IsNullOrWhiteSpace(line) ||
                     (!line.StartsWith("at ") && !line.StartsWith("Caused by:")))
            {
                // 继续检查几行，确保不是间断
                if (i > startIndex + 5)
                    break;
            }
        }

        return stackTrace;
    }

    /// <summary>
    /// 判断是否是堆栈行 - 使用模式匹配优化
    /// </summary>
    private static bool IsStackTraceLine(string line)
    {
        return line switch
        {
            var s when s.StartsWith("at ") => true,
            var s when s.StartsWith("Caused by:") => true,
            var s when s.StartsWith("... ") => true,
            var s when s.Contains("Exception:") => true,
            var s when s.Contains("Error:") => true,
            _ => false
        };
    }

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
}
