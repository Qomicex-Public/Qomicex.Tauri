using System.Collections.Generic;

namespace Qomicex.Core.Modules.Helpers.LogAnalysis.Models;

/// <summary>
/// 建议的解决方案 - 使用 record 代替 readonly record struct
/// 因为 IReadOnlyDictionary 作为属性初始化比较复杂
/// </summary>
public sealed record SuggestedSolution
{
    /// <summary>优先级（数字越小优先级越高）</summary>
    public int Priority { get; init; }

    /// <summary>解决方案描述（已填充变量）</summary>
    public required string Description { get; init; }

    /// <summary>操作类型标识</summary>
    public required string ActionType { get; init; }

    /// <summary>操作参数</summary>
    public IReadOnlyDictionary<string, object> Parameters { get; init; } = new Dictionary<string, object>();

    public override string ToString() => $"[P{Priority}] {Description}";
}
