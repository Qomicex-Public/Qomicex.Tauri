using System.Text.Json;
using Qomicex.Launcher.Backend.Modules.Helpers.LogAnalysis.Models;
using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Text.RegularExpressions;

namespace Qomicex.Launcher.Backend.Modules.Helpers.LogAnalysis.Patterns;

/// <summary>
/// 日志错误模式数据库
/// </summary>
public sealed class LogPatternDatabase
{
    private readonly List<ErrorPattern> _patterns = new();
    private readonly string _externalConfigPath;

    /// <summary>
    /// 初始化模式数据库
    /// </summary>
    /// <param name="externalConfigPath">外部配置文件路径（可选，用于用户自定义模式）</param>
    public LogPatternDatabase(string externalConfigPath = "")
    {
        _externalConfigPath = externalConfigPath;
    }

    /// <summary>
    /// 加载所有错误模式
    /// </summary>
    public void LoadPatterns()
    {
        _patterns.Clear();

        // 1. 加载嵌入的默认配置
        LoadEmbeddedPatterns();

        // 2. 加载外部用户自定义配置（如果存在）
        if (!string.IsNullOrEmpty(_externalConfigPath) && File.Exists(_externalConfigPath))
        {
            LoadExternalPatterns(_externalConfigPath);
        }

        // 3. 加载用户目录下的自定义模式
        var userPatternsDir = GetUserPatternsDirectory();
        if (Directory.Exists(userPatternsDir))
        {
            foreach (var file in Directory.GetFiles(userPatternsDir, "*.json"))
            {
                try
                {
                    LoadExternalPatterns(file);
                }
                catch (Exception ex)
                {
                    System.Diagnostics.Debug.WriteLine($"加载用户自定义模式失败 {file}: {ex.Message}");
                }
            }
        }
    }

    /// <summary>
    /// 从嵌入资源加载默认模式
    /// </summary>
    private void LoadEmbeddedPatterns()
    {
        try
        {
            var assembly = Assembly.GetExecutingAssembly();
            const string resourceName = "Qomicex.Launcher.Backend.Resources.LogAnalysis.error-patterns.json";

            using var stream = assembly.GetManifestResourceStream(resourceName);
            if (stream == null)
            {
                System.Diagnostics.Debug.WriteLine($"找不到嵌入资源: {resourceName}");
                return;
            }

            using var reader = new StreamReader(stream);
            var jsonContent = reader.ReadToEnd();
            ParsePatterns(jsonContent);
        }
        catch (Exception ex)
        {
            System.Diagnostics.Debug.WriteLine($"加载嵌入模式失败: {ex.Message}");
        }
    }

    /// <summary>
    /// 从外部文件加载模式
    /// </summary>
    private void LoadExternalPatterns(string filePath)
    {
        try
        {
            var jsonContent = File.ReadAllText(filePath);
            ParsePatterns(jsonContent, true);
        }
        catch (Exception ex)
        {
            System.Diagnostics.Debug.WriteLine($"加载外部模式失败 {filePath}: {ex.Message}");
        }
    }

    /// <summary>
    /// 解析模式JSON
    /// </summary>
    private void ParsePatterns(string jsonContent, bool isUserPattern = false)
    {
        using var doc = JsonDocument.Parse(jsonContent);
        var root = doc.RootElement;

        if (!root.TryGetProperty("patterns", out var patternsElement))
            return;

        foreach (var pattern in patternsElement.EnumerateArray())
        {
            try
            {
                var solutions = new List<PatternSolution>();
                if (pattern.TryGetProperty("solutions", out var solutionsElement))
                {
                    foreach (var s in solutionsElement.EnumerateArray())
                    {
                        solutions.Add(new PatternSolution(
                            Priority: s.GetProperty("priority").GetInt32(),
                            Description: s.GetProperty("description").GetString() ?? "",
                            ActionType: s.GetProperty("actionType").GetString() ?? "Unknown",
                            Parameters: DeserializeParameters(s)
                        ));
                    }
                }

                var i18nNames = new Dictionary<string, I18nInfo>();
                if (pattern.TryGetProperty("i18n", out var i18nElement))
                {
                    foreach (var lang in i18nElement.EnumerateObject())
                    {
                        i18nNames[lang.Name] = new I18nInfo(
                            Name: lang.Value.GetProperty("name").GetString() ?? "",
                            Description: lang.Value.GetProperty("description").GetString() ?? ""
                        );
                    }
                }

                var regexPatterns = new List<string>();
                if (pattern.TryGetProperty("regexPatterns", out var regexElement))
                {
                    foreach (var r in regexElement.EnumerateArray())
                    {
                        regexPatterns.Add(r.GetString() ?? "");
                    }
                }

                var errorPattern = new ErrorPattern(
                    Id: pattern.GetProperty("id").GetString() ?? Guid.NewGuid().ToString(),
                    Category: ParseCategory(pattern.GetProperty("category").GetString()),
                    Severity: ParseSeverity(pattern.GetProperty("severity").GetString()),
                    RegexPatterns: regexPatterns,
                    CompiledRegexes: regexPatterns
                        .Select(r => new Regex(r, RegexOptions.Compiled | RegexOptions.IgnoreCase))
                        .ToList(),
                    Solutions: solutions,
                    I18nNames: i18nNames,
                    IsUserPattern: isUserPattern
                );

                _patterns.Add(errorPattern);
            }
            catch (Exception ex)
            {
                System.Diagnostics.Debug.WriteLine($"解析模式失败: {ex.Message}");
            }
        }
    }

    private static Dictionary<string, object> DeserializeParameters(JsonElement solutionElement)
    {
        if (!solutionElement.TryGetProperty("parameters", out var parametersElement))
            return [];

        var dict = new Dictionary<string, object>();
        foreach (var prop in parametersElement.EnumerateObject())
        {
            dict[prop.Name] = prop.Value.ValueKind switch
            {
                JsonValueKind.String => prop.Value.GetString() ?? "",
                JsonValueKind.Number => prop.Value.GetRawText(),
                _ => prop.Value.GetRawText()
            };
        }
        return dict;
    }

    /// <summary>
    /// 获取用户自定义模式目录
    /// </summary>
    private static string GetUserPatternsDirectory()
    {
        // 在应用程序目录下创建 patterns 文件夹
        var appDir = Path.GetDirectoryName(Assembly.GetExecutingAssembly().Location) ?? ".";
        return Path.Combine(appDir, "LogAnalysisPatterns");
    }

    /// <summary>
    /// 匹配文本中的所有错误模式
    /// </summary>
    public IReadOnlyList<PatternMatchResult> MatchPatterns(string text, int lineNumber = 0)
    {
        var results = new List<PatternMatchResult>();

        foreach (var pattern in _patterns)
        {
            foreach (var regex in pattern.CompiledRegexes)
            {
                var match = regex.Match(text);
                if (match.Success)
                {
                    var capturedGroups = match.Groups
                        .Cast<Group>()
                        .Where(g => !string.IsNullOrEmpty(g.Name) && g.Name != "0")
                        .ToDictionary(g => g.Name, g => g.Value);

                    results.Add(new PatternMatchResult(
                        Pattern: pattern,
                        MatchedText: match.Value,
                        LineNumber: lineNumber,
                        CapturedGroups: capturedGroups
                    ));
                    break;
                }
            }
        }

        return results;
    }

    /// <summary>
    /// 获取本地化名称 - 使用 switch 表达式简化
    /// </summary>
    public string GetLocalizedName(ErrorPattern pattern, string language = "zh")
    {
        return pattern.I18nNames switch
        {
            { } i18n when i18n.TryGetValue(language, out var i) => i.Name,
            { } i18n when i18n.TryGetValue("en", out var en) => en.Name,
            _ => pattern.Id
        };
    }

    /// <summary>
    /// 获取本地化描述
    /// </summary>
    public string GetLocalizedDescription(ErrorPattern pattern, string language = "zh")
    {
        return pattern.I18nNames switch
        {
            { } i18n when i18n.TryGetValue(language, out var i) => i.Description,
            _ => string.Empty
        };
    }

    /// <summary>
    /// 解析分类字符串 - 使用 switch 表达式
    /// </summary>
    private static IssueCategory ParseCategory(string? category)
    {
        return category?.ToLowerInvariant() switch
        {
            "memory" => IssueCategory.Memory,
            "modconflict" => IssueCategory.ModConflict,
            "javarelated" => IssueCategory.JavaRelated,
            "resource" => IssueCategory.Resource,
            "performance" => IssueCategory.Performance,
            _ => IssueCategory.Unknown
        };
    }

    /// <summary>
    /// 解析严重级别字符串 - 使用 switch 表达式
    /// </summary>
    private static IssueSeverity ParseSeverity(string? severity)
    {
        return severity?.ToLowerInvariant() switch
        {
            "critical" => IssueSeverity.Critical,
            "error" => IssueSeverity.Error,
            "warning" => IssueSeverity.Warning,
            "info" => IssueSeverity.Info,
            _ => IssueSeverity.Error
        };
    }

    /// <summary>
    /// 获取所有模式
    /// </summary>
    public IReadOnlyList<ErrorPattern> GetAllPatterns() => _patterns.AsReadOnly();

    /// <summary>
    /// 根据ID查找模式
    /// </summary>
    public ErrorPattern? GetPatternById(string id)
    {
        return _patterns.FirstOrDefault(p => p.Id == id);
    }
}

/// <summary>
/// 错误模式定义 - 使用 sealed record
/// </summary>
public sealed record ErrorPattern(
    string Id,
    IssueCategory Category,
    IssueSeverity Severity,
    IReadOnlyList<string> RegexPatterns,
    IReadOnlyList<Regex> CompiledRegexes,
    IReadOnlyList<PatternSolution> Solutions,
    IReadOnlyDictionary<string, I18nInfo> I18nNames,
    bool IsUserPattern = false
);

/// <summary>
/// 国际化信息 - 使用 readonly record struct
/// </summary>
public readonly record struct I18nInfo(
    string Name,
    string Description
);

/// <summary>
/// 模式解决方案 - 使用 readonly record struct
/// </summary>
public readonly record struct PatternSolution(
    int Priority,
    string Description,
    string ActionType,
    IReadOnlyDictionary<string, object> Parameters
);

/// <summary>
/// 模式匹配结果 - 使用 readonly record struct
/// </summary>
public readonly record struct PatternMatchResult(
    ErrorPattern Pattern,
    string MatchedText,
    int LineNumber,
    IReadOnlyDictionary<string, string> CapturedGroups
);
