# Minecraft 日志分析功能使用指南

## 快速开始

```csharp
using Qomicex.Core.Modules.Helpers.LogAnalysis;
using Qomicex.Core.Modules.Helpers.LogAnalysis.Models;

// 1. 创建分析器实例
var analyzer = new MinecraftLogAnalyzer();

// 2. 分析崩溃报告文件
LogAnalysisResult result = await analyzer.AnalyzeAsync(
    @"C:\Game\.minecraft\crash-reports\crash-2026-02-08.txt"
);

// 3. 检查结果
if (result.IsSuccess && result.IsGameCrashed)
{
    Console.WriteLine($"Minecraft版本: {result.MinecraftVersion}");
    Console.WriteLine($"Mod加载器: {result.ModLoader}");
    Console.WriteLine($"检测到问题: {result.Issues.Count}个");
    
    // 4. 显示所有问题
    foreach (var issue in result.Issues)
    {
        Console.WriteLine($"[{issue.Severity}] {issue.Name}");
        Console.WriteLine($"  位置: 第{issue.LineNumber}行");
        Console.WriteLine($"  匹配: {issue.MatchedText}");
        
        foreach (var solution in issue.Solutions.OrderBy(s => s.Priority))
        {
            Console.WriteLine($"  → {solution.Description}");
        }
    }
}
```

## 获取最近的崩溃报告

```csharp
// 获取最近的崩溃报告路径
string? latestCrash = MinecraftLogAnalyzer.GetLatestCrashReport(@"C:\Game\.minecraft");
if (latestCrash != null)
{
    var result = await analyzer.AnalyzeAsync(latestCrash);
    // ...
}

// 获取最近7天的所有崩溃报告
var recentCrashes = MinecraftLogAnalyzer.GetRecentCrashReports(
    @"C:\Game\.minecraft", 
    days: 7
);
```

## 生成分析摘要

```csharp
// 生成可读性强的摘要
string summary = MinecraftLogAnalyzer.GenerateSummary(result);
Console.WriteLine(summary);
// 输出:
// Minecraft版本: 1.20.1
// Mod加载器: Forge
// 加载Mod数: 47
// 检测到问题: 3个
//   - 严重问题: 1个
//   - 错误: 2个
//   - 问题类型: 内存(1), Mod冲突(2)
```

## 获取解决方案

```csharp
// 获取首要解决方案（最推荐的）
var primarySolution = MinecraftLogAnalyzer.GetPrimarySolution(result);
if (primarySolution != null)
{
    Console.WriteLine($"建议: {primarySolution.Description}");
}

// 获取所有解决方案
var allSolutions = MinecraftLogAnalyzer.GetAllSolutions(result);
foreach (var solution in allSolutions)
{
    Console.WriteLine($"[{solution.Priority}] {solution.ActionType}: {solution.Description}");
}
```

## 按类别筛选问题

```csharp
// 只查看内存相关问题
var memoryIssues = MinecraftLogAnalyzer.GetIssuesByCategory(result, IssueCategory.Memory);

// 只查看严重问题
var criticalIssues = MinecraftLogAnalyzer.GetIssuesBySeverity(result, IssueSeverity.Critical);

// 获取Mod冲突摘要
string modSummary = analyzer.GetModConflictSummary(result);
// 输出: "严重问题: 1个; 错误: 2个; 问题类型: Mod重复(1), 缺少依赖(2)"
```

## 自定义错误模式

用户可以在应用程序目录下创建 `LogAnalysisPatterns` 文件夹，并添加自定义的 JSON 模式文件：

```csharp
// 自动加载默认配置 + 用户自定义配置
var analyzer = new MinecraftLogAnalyzer();
```

自定义模式文件格式（custom-patterns.json）：
```json
{
  "version": "1.0.0",
  "patterns": [
    {
      "id": "custom-error",
      "category": "Unknown",
      "severity": "Error",
      "i18n": {
        "zh": { "name": "自定义错误", "description": "..." }
      },
      "regexPatterns": ["自定义正则表达式"],
      "solutions": [
        {
          "priority": 1,
          "description": "建议...",
          "actionType": "CustomAction"
        }
      ]
    }
  ]
}
```

## 错误模式列表

内置支持的错误模式（25种+）：

### 内存问题
- 堆内存不足 (OutOfMemoryError: Java heap space)
- Metaspace内存不足 (OutOfMemoryError: Metaspace)
- 频繁垃圾回收警告

### Mod冲突
- Mod重复
- 缺少依赖Mod
- Mod版本冲突
- 实体Tick异常
- Mixin转换错误
- 类未找到 (ClassNotFoundException)
- 方法未找到 (NoSuchMethodError)
- Mod加载失败

### Java相关
- Java版本过旧
- Java版本过新
- GLFW错误
- LWJGL错误

### 资源问题
- 缺少本地库文件
- 访问违规/显卡驱动问题
- 光影包错误
- 纹理图集过大
- 资源包错误
- 网络错误

### 其他
- Forge配置错误
- Fabric错误
- 未知崩溃

## 数据结构

### LogAnalysisResult
```csharp
public class LogAnalysisResult
{
    public string FilePath;                    // 文件路径
    public DateTime AnalysisTime;              // 分析时间
    public DateTime CrashTime;                 // 崩溃时间
    public string MinecraftVersion;            // MC版本
    public string ModLoader;                   // Mod加载器
    public List<DetectedIssue> Issues;         // 检测到的问题
    public List<ModInfo> LoadedMods;           // 加载的Mod列表
    public List<string> StackTrace;            // 异常堆栈
    public string RawLogExcerpt;               // 原始日志摘录
    public bool IsGameCrashed;                 // 是否崩溃
    public bool IsSuccess;                     // 分析是否成功
    public string ErrorMessage;                // 错误信息
}
```

### DetectedIssue
```csharp
public class DetectedIssue
{
    public string PatternId;                   // 模式ID
    public string Name;                        // 问题名称
    public IssueCategory Category;             // 分类
    public IssueSeverity Severity;             // 严重级别
    public string MatchedText;                 // 匹配的文本
    public int LineNumber;                     // 行号
    public Dictionary<string, string> CapturedGroups; // 正则捕获组
    public List<SuggestedSolution> Solutions;  // 解决方案
}
```

### IssueSeverity (严重级别)
- `Critical` - 严重（无法启动/立即崩溃）
- `Error` - 错误（功能异常）
- `Warning` - 警告（潜在问题）
- `Info` - 信息

### IssueCategory (问题分类)
- `Memory` - 内存问题
- `ModConflict` - Mod冲突
- `JavaRelated` - Java相关问题
- `Resource` - 资源问题
- `Performance` - 性能问题
- `Unknown` - 未知问题

## 注意事项

1. **线程安全**：MinecraftLogAnalyzer 实例是线程安全的，可以在多个任务中并发使用
2. **性能**：分析大型崩溃报告（>10MB）可能需要几百毫秒
3. **文件编码**：支持 UTF-8 和 ANSI 编码的崩溃报告文件
4. **崩溃报告格式**：支持标准 Forge/Fabric/Quilt/NeoForge 崩溃报告格式

## 集成示例

```csharp
// 在启动器中使用
public class MyLauncher
{
    private readonly MinecraftLogAnalyzer _analyzer = new();
    
    public async Task OnGameCrashed(string gameDir)
    {
        var crashReport = MinecraftLogAnalyzer.GetLatestCrashReport(gameDir);
        if (crashReport != null)
        {
            var result = await _analyzer.AnalyzeAsync(crashReport);
            
            // 显示给用户
            ShowCrashAnalysis(result);
            
            // 获取首要建议
            var solution = MinecraftLogAnalyzer.GetPrimarySolution(result);
            if (solution != null)
            {
                ShowRecommendedFix(solution);
            }
        }
    }
}
```
