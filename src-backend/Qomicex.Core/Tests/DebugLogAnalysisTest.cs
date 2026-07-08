using Qomicex.Core.Common;
using Qomicex.Core.Modules.Helpers.LogAnalysis;
using System;
using System.Linq;
using System.Threading.Tasks;

namespace Qomicex.Core.Tests;

/// <summary>
/// 用于表示无副作用的操作的返回值
/// </summary>
public readonly record struct Unit
{
    public static readonly Unit Value = new();
}

/// <summary>
/// 调试日志分析重复问题的测试
/// </summary>
public class DebugLogAnalysisTest
{
    public static async Task AnalyzeWithDetails()
    {
        string testLog = @"[21:32:07] [main/INFO]: Loading Minecraft 1.20.1 with Fabric Loader 0.18.4
[21:32:09] [main/WARN]: Mod resolution failed
[21:32:09] [main/INFO]: Immediate reason: [HARD_DEP_NO_CANDIDATE endepicintro 1.0.0 {depends architectury @ [>=9.0.0]}, ROOT_FORCELOAD_SINGLE endepicintro 1.0.0]
[21:32:09] [main/INFO]: Reason: [HARD_DEP endepicintro 1.0.0 {depends architectury @ [>=9.0.0]}]
[21:32:09] [main/INFO]: Fix: add [add:architectury 9.0.0 ([[9.0.0,∞)])], remove [], replace []
[21:32:09] [main/ERROR]: Incompatible mods found!
net.fabricmc.loader.impl.FormattedException: Some of your mods are incompatible with the game or each other!
确定了一种可能的解决方法，这样做可能会解决你的问题：
	 - 安装 architectury，9.0.0 及以上版本。
更多信息：
	 - 模组 'End Epic Intro' (endepicintro) 1.0.0 需要 architectury 的 9.0.0 及以上版本，但没有安装它！
	 at net.fabricmc.loader.impl.FormattedException.ofLocalized(FormattedException.java:51)";

        Console.WriteLine("=== Log Debug Test ===\n");

        var analyzer = new MinecraftLogAnalyzer();
        var result = await analyzer.AnalyzeContentAsync(testLog, "debug-fabric.log");

        // 使用 Result 类型的 Match 方法来处理成功和失败情况
        result.Match<Unit>(
            onSuccess: analysisResult =>
            {
                // 详细分析输出
                Console.WriteLine($"File: {analysisResult.FilePath}");
                Console.WriteLine($"Time: {analysisResult.AnalysisTime:HH:mm:ss}");
                Console.WriteLine($"MC Version: {analysisResult.MinecraftVersion}");
                Console.WriteLine($"Mod Loader: {analysisResult.ModLoader}");
                Console.WriteLine($"Loaded Mods: {analysisResult.LoadedMods.Count}");
                Console.WriteLine($"Total Issues: {analysisResult.Issues.Count}");
                Console.WriteLine($"Crash Detected: {analysisResult.IsGameCrashed}");
                Console.WriteLine();

                if (analysisResult.Issues.Count > 0)
                {
                    Console.WriteLine("=== 检测到的问题详解 ===\n");

                    for (int i = 0; i < analysisResult.Issues.Count; i++)
                    {
                        var issue = analysisResult.Issues[i];
                        Console.WriteLine($"{i + 1}. [{issue.Severity}] {issue.Name}");
                        Console.WriteLine($"   PatternID: {issue.PatternId}");
                        Console.WriteLine($"   Category: {issue.Category}");
                        Console.WriteLine($"   Line: {issue.LineNumber}");
                        Console.WriteLine($"   Text: {Truncate(issue.MatchedText, 150)}");

                        if (issue.CapturedGroups.Any())
                        {
                            var groups = string.Join(", ",
                                issue.CapturedGroups.Select(kv => $"{kv.Key}={kv.Value}").Take(5));
                            Console.WriteLine($"   Groups: {groups}");
                        }

                        if (issue.Solutions.Any())
                        {
                            Console.WriteLine($"   Solution: {issue.Solutions.OrderBy(s => s.Priority).First().Description}");
                        }
                        Console.WriteLine();
                    }

                    // 分组统计
                    var byPattern = analysisResult.Issues.GroupBy(i => i.PatternId).ToList();
                    Console.WriteLine("=== 按模式ID分组 ===\n");
                    foreach (var group in byPattern)
                    {
                        Console.WriteLine($"{group.Key}: {group.Count()} 个问题");
                        foreach (var issue in group)
                        {
                            Console.WriteLine($"  - Line {issue.LineNumber}: {issue.Name}");
                        }
                        Console.WriteLine();
                    }
                }

                // 首要建议
                var primary = MinecraftLogAnalyzer.GetPrimarySolution(analysisResult);
                Console.WriteLine($"首要建议: {primary?.Description ?? "无建议"}");

                return Unit.Value;
            },
            onFailure: error =>
            {
                Console.WriteLine($"分析失败: [{error.Code}] {error.Message}");
                if (!string.IsNullOrEmpty(error.Details))
                {
                    Console.WriteLine($"详细信息: {error.Details}");
                }
                return Unit.Value;
            }
        );
    }

    public static string Truncate(string value, int maxLength)
    {
        if (string.IsNullOrEmpty(value)) return value;
        return value.Length <= maxLength ? value : value.Substring(0, maxLength) + "...";
    }
}
