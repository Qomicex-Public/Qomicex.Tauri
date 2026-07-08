using System.Collections.Generic;

namespace Qomicex.Core.Modules.Helpers.LogAnalysis.Models;

/// <summary>
/// 检测到的问题 - 使用 record 实现不可变性
/// </summary>
public sealed record DetectedIssue
{
    /// <summary>错误模式ID</summary>
    public required string PatternId { get; init; }

    /// <summary>问题名称（本地化）</summary>
    public required string Name { get; init; }

    /// <summary>问题分类</summary>
    public IssueCategory Category { get; init; }

    /// <summary>严重级别</summary>
    public IssueSeverity Severity { get; init; }

    /// <summary>匹配的原始文本</summary>
    public required string MatchedText { get; init; }

    /// <summary>在日志中的行号</summary>
    public int LineNumber { get; init; }

    /// <summary>正则捕获组 - 使用 IReadOnlyDictionary 确保不可变</summary>
    public IReadOnlyDictionary<string, string> CapturedGroups { get; init; } = new Dictionary<string, string>();

    /// <summary>建议的解决方案 - 使用 IReadOnlyList 确保不可变</summary>
    public IReadOnlyList<SuggestedSolution> Solutions { get; init; } = [];

    /// <summary>
    /// 使用 with 表达式创建修改后的实例
    /// </summary>
    public DetectedIssue WithCapturedGroups(Dictionary<string, string> groups) =>
        this with { CapturedGroups = groups };

    /// <summary>
    /// 使用 with 表达式添加单个捕获组
    /// </summary>
    public DetectedIssue AddCapturedGroup(string key, string value)
    {
        var newGroups = new Dictionary<string, string>(CapturedGroups)
        {
            [key] = value
        };
        return this with { CapturedGroups = newGroups };
    }
}
