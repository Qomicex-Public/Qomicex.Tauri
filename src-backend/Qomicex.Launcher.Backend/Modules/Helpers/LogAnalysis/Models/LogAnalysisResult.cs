using System;
using System.Collections.Generic;

namespace Qomicex.Launcher.Backend.Modules.Helpers.LogAnalysis.Models;

/// <summary>
/// 日志分析结果 - 使用 record 实现不可变性
/// </summary>
public sealed record LogAnalysisResult
{
    /// <summary>分析的文件路径</summary>
    public required string FilePath { get; init; }

    /// <summary>分析执行时间</summary>
    public DateTime AnalysisTime { get; init; } = DateTime.Now;

    /// <summary>崩溃发生时间（从文件名或日志内容提取）</summary>
    public DateTime CrashTime { get; init; }

    /// <summary>Minecraft版本</summary>
    public required string MinecraftVersion { get; init; }

    /// <summary>Mod加载器类型（Forge/Fabric/Quilt等）</summary>
    public required string ModLoader { get; init; }

    /// <summary>检测到的问题列表 - 使用 IReadOnlyList 表示不可变集合</summary>
    public IReadOnlyList<DetectedIssue> Issues { get; init; } = [];

    /// <summary>加载的Mod列表 - 使用 IReadOnlyList</summary>
    public IReadOnlyList<ModInfo> LoadedMods { get; init; } = [];

    /// <summary>异常堆栈追踪 - 使用 IReadOnlyList</summary>
    public IReadOnlyList<string> StackTrace { get; init; } = [];

    /// <summary>原始日志摘录（前100行关键内容）</summary>
    public required string RawLogExcerpt { get; init; }

    /// <summary>是否检测到游戏崩溃</summary>
    public bool IsGameCrashed { get; init; }

    /// <summary>分析是否成功完成</summary>
    public bool IsSuccess { get; init; } = true;

    /// <summary>分析过程中的错误信息</summary>
    public required string ErrorMessage { get; init; }

    /// <summary>
    /// 创建成功结果
    /// </summary>
    public static LogAnalysisResult Success(
        string filePath,
        string minecraftVersion,
        string modLoader,
        IReadOnlyList<DetectedIssue> issues,
        IReadOnlyList<ModInfo> loadedMods,
        IReadOnlyList<string> stackTrace,
        string rawLogExcerpt,
        bool isGameCrashed = false)
    {
        return new LogAnalysisResult
        {
            FilePath = filePath,
            MinecraftVersion = minecraftVersion,
            ModLoader = modLoader,
            Issues = issues,
            LoadedMods = loadedMods,
            StackTrace = stackTrace,
            RawLogExcerpt = rawLogExcerpt,
            IsGameCrashed = isGameCrashed,
            IsSuccess = true,
            ErrorMessage = string.Empty
        };
    }

    /// <summary>
    /// 创建失败结果
    /// </summary>
    public static LogAnalysisResult Failure(string filePath, string errorMessage)
    {
        return new LogAnalysisResult
        {
            FilePath = filePath,
            MinecraftVersion = string.Empty,
            ModLoader = string.Empty,
            ErrorMessage = errorMessage,
            RawLogExcerpt = string.Empty,
            IsSuccess = false
        };
    }
}

/// <summary>
/// Mod信息 - 使用 readonly record struct 作为值对象
/// </summary>
public readonly record struct ModInfo
{
    public string Id { get; init; }
    public string Name { get; init; }
    public string Version { get; init; }
    public string FileName { get; init; }

    public override string ToString() => $"{Id}@{Version}";
}
