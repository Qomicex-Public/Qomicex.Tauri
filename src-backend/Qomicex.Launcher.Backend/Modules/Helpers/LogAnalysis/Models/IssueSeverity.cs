namespace Qomicex.Launcher.Backend.Modules.Helpers.LogAnalysis.Models;

/// <summary>
/// 问题严重级别枚举
/// </summary>
public enum IssueSeverity
{
    /// <summary>严重（无法启动/立即崩溃）</summary>
    Critical,
    /// <summary>错误（功能异常）</summary>
    Error,
    /// <summary>警告（潜在问题）</summary>
    Warning,
    /// <summary>信息</summary>
    Info
}
