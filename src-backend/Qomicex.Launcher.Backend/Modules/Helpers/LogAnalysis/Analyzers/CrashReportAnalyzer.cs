using Qomicex.Launcher.Backend.Common;
using Qomicex.Launcher.Backend.Modules.Helpers.LogAnalysis.Models;
using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;

namespace Qomicex.Launcher.Backend.Modules.Helpers.LogAnalysis.Analyzers;

/// <summary>
/// 崩溃报告信息 - 使用 record
/// </summary>
public sealed record CrashReportInfo
{
    public required string FilePath { get; init; }
    public DateTime AnalysisTime { get; init; } = DateTime.Now;
    public DateTime CrashTime { get; init; }
    public required string MinecraftVersion { get; init; }
    public required string ModLoader { get; init; }
    public string ModLoaderVersion { get; init; } = string.Empty;
    public IReadOnlyList<ModInfo> LoadedMods { get; init; } = [];
    public IReadOnlyList<string> StackTrace { get; init; } = [];
    public required string RawLogExcerpt { get; init; }
}

/// <summary>
/// 崩溃报告分析器
/// 解析 crash-reports/*.txt 文件格式
/// </summary>
public sealed class CrashReportAnalyzer
{
    /// <summary>
    /// 分析崩溃报告文件
    /// </summary>
    public async Task<Result<CrashReportInfo, LogAnalysisError>> AnalyzeAsync(
        string filePath,
        CancellationToken cancellationToken = default)
    {
        try
        {
            var content = await File.ReadAllTextAsync(filePath, cancellationToken);
            return AnalyzeContent(content, filePath);
        }
        catch (OperationCanceledException)
        {
            throw;
        }
        catch (Exception ex)
        {
            return Result<CrashReportInfo, LogAnalysisError>.Failure(new LogAnalysisError
            {
                Code = "FILE_READ_ERROR",
                Message = $"读取崩溃报告失败: {ex.Message}"
            });
        }
    }

    /// <summary>
    /// 分析崩溃报告内容
    /// </summary>
    public Result<CrashReportInfo, LogAnalysisError> AnalyzeContent(
        string content,
        string fileName = "")
    {
        try
        {
            var lines = content.Split(new[] { '\r', '\n' }, StringSplitOptions.RemoveEmptyEntries);

            // 使用 Span 优化字符串处理
            var crashTime = ParseHeader(lines.AsSpan());
            var minecraftVersion = ExtractVersionInfo(lines.AsSpan());
            var (modLoader, modLoaderVersion) = ExtractModLoaderInfo(lines.AsSpan());
            var loadedMods = ExtractModList(lines.AsSpan());
            var stackTrace = ExtractStackTrace(lines.AsSpan());
            var rawLogExcerpt = ExtractLogExcerpt(lines.AsSpan());

            return Result<CrashReportInfo, LogAnalysisError>.Success(new CrashReportInfo
            {
                FilePath = fileName,
                CrashTime = crashTime,
                MinecraftVersion = minecraftVersion,
                ModLoader = modLoader,
                ModLoaderVersion = modLoaderVersion,
                LoadedMods = loadedMods,
                StackTrace = stackTrace,
                RawLogExcerpt = rawLogExcerpt
            });
        }
        catch (Exception ex)
        {
            return Result<CrashReportInfo, LogAnalysisError>.Failure(new LogAnalysisError
            {
                Code = "PARSE_ERROR",
                Message = $"解析崩溃报告失败: {ex.Message}"
            });
        }
    }

    /// <summary>
    /// 解析文件头 - 使用 Span 优化
    /// </summary>
    private static DateTime ParseHeader(ReadOnlySpan<string> lines)
    {
        if (lines.IsEmpty) return default;

        // 查找时间行
        foreach (var line in lines.Slice(0, Math.Min(5, lines.Length)))
        {
            var span = line.AsSpan();
            if (span.StartsWith("Time:", StringComparison.OrdinalIgnoreCase))
            {
                var timeStr = span.Slice(5).Trim().ToString();
                if (DateTime.TryParse(timeStr, out var crashTime))
                {
                    return crashTime;
                }
                break;
            }
        }

        return default;
    }

    /// <summary>
    /// 提取版本信息 - 使用 Span 和模式匹配优化
    /// </summary>
    private static string ExtractVersionInfo(ReadOnlySpan<string> lines)
    {
        // 查找 Minecraft Version 行（崩溃报告格式）
        foreach (var line in lines)
        {
            var span = line.AsSpan();
            if (span.StartsWith("Minecraft Version:", StringComparison.OrdinalIgnoreCase))
            {
                return span.Slice(18).Trim().ToString();
            }
        }

        // 从日志内容提取（如："Loading Minecraft 1.20.1-Quilt"）
        foreach (var line in lines)
        {
            var span = line.AsSpan();

            // Quilt/Fabric 启动日志格式: "Loading Minecraft 1.20.1-Quilt"
            var match = Regex.Match(line, @"Loading Minecraft\s+(\d+\.\d+\.?\d*)", RegexOptions.IgnoreCase);
            if (match.Success)
            {
                return match.Groups[1].Value;
            }

            // 其他格式: "Minecraft version: 1.20.1"
            match = Regex.Match(line, @"Minecraft[\s\w]*[:\s]+(\d+\.\d+\.?\d*)", RegexOptions.IgnoreCase);
            if (match.Success)
            {
                return match.Groups[1].Value;
            }
        }

        return string.Empty;
    }

    /// <summary>
    /// 提取Mod Loader信息 - 使用模式匹配优化
    /// </summary>
    private static (string ModLoader, string Version) ExtractModLoaderInfo(ReadOnlySpan<string> lines)
    {
        foreach (var line in lines)
        {
            // 使用模式匹配简化逻辑
            if (line.Contains("Quilt") || line.Contains("quilt"))
            {
                var match = Regex.Match(line, @"Quilt\s+Loader\s+(\d+\.\d+\.?\d*)", RegexOptions.IgnoreCase);
                return ("Quilt", match.Success ? match.Groups[1].Value : string.Empty);
            }

            if (line.Contains("Forge") || line.Contains("FML") || line.Contains("modloader"))
            {
                var match = Regex.Match(line, @"Forge[^\d]*(\d+\.\d+\.\d+)");
                return ("Forge", match.Success ? match.Groups[1].Value : string.Empty);
            }

            if (line.Contains("Fabric") && !line.Contains("quilt"))
            {
                var match = Regex.Match(line, @"Fabric[^\d]*(\d+\.\d+\.\d+)");
                return ("Fabric", match.Success ? match.Groups[1].Value : string.Empty);
            }

            if (line.Contains("NeoForge"))
            {
                return ("NeoForge", string.Empty);
            }
        }

        return ("Vanilla", string.Empty);
    }

    /// <summary>
    /// 提取Mod列表
    /// </summary>
    private static IReadOnlyList<ModInfo> ExtractModList(ReadOnlySpan<string> lines)
    {
        var mods = new List<ModInfo>();

        // 查找Mod列表部分
        int modListStart = -1;
        for (int i = 0; i < lines.Length; i++)
        {
            if (lines[i].Contains("-- Loaded Mods --") ||
                lines[i].Contains("Loaded coremods") ||
                lines[i].Contains("Loading X mods"))
            {
                modListStart = i;
                break;
            }
        }

        if (modListStart == -1) return mods;

        // 解析Mod列表
        for (int i = modListStart + 1; i < lines.Length && i < modListStart + 200; i++)
        {
            var line = lines[i];

            // 检查是否到达下一个部分
            if (line.StartsWith("-- ") || line.StartsWith("===="))
                break;

            // Forge格式: | ID | Version | Source |
            var forgeMatch = Regex.Match(line, @"^\|\s*([^|]+)\s*\|\s*([^|]+)\s*\|\s*([^|]+)\s*\|");
            if (forgeMatch.Success)
            {
                mods.Add(new ModInfo
                {
                    Id = forgeMatch.Groups[1].Value.Trim(),
                    Version = forgeMatch.Groups[2].Value.Trim(),
                    FileName = forgeMatch.Groups[3].Value.Trim()
                });
                continue;
            }

            // Fabric格式: - modid version
            var fabricMatch = Regex.Match(line, @"^-\s+(\S+)\s+(\S+)");
            if (fabricMatch.Success)
            {
                mods.Add(new ModInfo
                {
                    Id = fabricMatch.Groups[1].Value,
                    Version = fabricMatch.Groups[2].Value
                });
                continue;
            }

            // 简单格式: modid-version.jar
            var simpleMatch = Regex.Match(line, @"(\S+)-(\d[\d.]+.*)\.jar", RegexOptions.IgnoreCase);
            if (simpleMatch.Success)
            {
                mods.Add(new ModInfo
                {
                    Id = simpleMatch.Groups[1].Value,
                    Version = simpleMatch.Groups[2].Value
                });
            }
        }

        return mods;
    }

    /// <summary>
    /// 提取异常堆栈
    /// </summary>
    private static IReadOnlyList<string> ExtractStackTrace(ReadOnlySpan<string> lines)
    {
        var stackTrace = new List<string>();

        // 查找异常描述
        int descriptionStart = -1;
        for (int i = 0; i < lines.Length; i++)
        {
            if (lines[i].Contains("Description:") ||
                lines[i].Contains("Exception:") ||
                lines[i].StartsWith("java.lang."))
            {
                descriptionStart = i;
                break;
            }
        }

        if (descriptionStart == -1) return stackTrace;

        // 提取堆栈
        for (int i = descriptionStart; i < lines.Length && i < descriptionStart + 100; i++)
        {
            var line = lines[i].Trim();

            // 遇到空行或分隔符停止
            if (string.IsNullOrWhiteSpace(line) || line.StartsWith("===="))
                break;

            // 包含异常信息的行
            if (line.StartsWith("java.lang.") ||
                line.StartsWith("at ") ||
                line.StartsWith("Caused by:") ||
                line.Contains("Exception:") ||
                line.Contains("Error:"))
            {
                stackTrace.Add(line);
            }
        }

        // 如果没有找到，尝试从其他部分提取
        if (stackTrace.Count == 0)
        {
            var stackLines = lines.ToArray()
                .Where(l => l.TrimStart().StartsWith("at ") || l.Contains("Exception in thread"))
                .Take(50);
            stackTrace.AddRange(stackLines);
        }

        return stackTrace;
    }

    /// <summary>
    /// 提取日志摘录
    /// </summary>
    private static string ExtractLogExcerpt(ReadOnlySpan<string> lines)
    {
        var excerptLines = new List<string>();

        // 获取前100行，但跳过纯分隔符行
        for (int i = 0; i < Math.Min(lines.Length, 100); i++)
        {
            var line = lines[i];
            if (!line.All(c => c == '-' || c == '=' || c == '#'))
            {
                excerptLines.Add(line);
            }
        }

        return string.Join(Environment.NewLine, excerptLines);
    }
}
