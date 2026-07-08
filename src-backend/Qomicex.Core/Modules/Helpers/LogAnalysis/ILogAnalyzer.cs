using Qomicex.Core.Common;
using Qomicex.Core.Modules.Helpers.LogAnalysis.Models;
using System.Threading;
using System.Threading.Tasks;

namespace Qomicex.Core.Modules.Helpers.LogAnalysis;

/// <summary>
/// 日志分析器接口
/// </summary>
public interface ILogAnalyzer
{
    /// <summary>
    /// 分析崩溃报告文件
    /// </summary>
    /// <param name="filePath">崩溃报告文件路径</param>
    /// <param name="cancellationToken">取消令牌</param>
    /// <returns>分析结果</returns>
    Task<Result<LogAnalysisResult, LogAnalysisError>> AnalyzeAsync(
        string filePath,
        CancellationToken cancellationToken = default);

    /// <summary>
    /// 分析日志内容字符串
    /// </summary>
    /// <param name="content">日志内容</param>
    /// <param name="fileName">原始文件名（用于上下文）</param>
    /// <param name="cancellationToken">取消令牌</param>
    /// <returns>分析结果</returns>
    Task<Result<LogAnalysisResult, LogAnalysisError>> AnalyzeContentAsync(
        string content,
        string fileName = "",
        CancellationToken cancellationToken = default);
}
