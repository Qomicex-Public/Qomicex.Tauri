# Mod 名称交叉匹配设计

## 当前状态

- `CrashReportAnalyzer.ExtractModList()` 已解析 Mod 列表 → `LogAnalysisResult.LoadedMods`
- `JavaExceptionAnalyzer` 已提取堆栈 → `DetectedIssue.CapturedGroups["stackTrace"]`
- **没有做交叉匹配**：堆栈关键词和 Mod 列表是独立的

## 方案

在 `MinecraftLogAnalyzer.AnalyzeContentAsync` 分析管线末尾增加一个"堆栈-Mod 交叉匹配"步骤。

### 流程

```
子分析器完成 → 提取堆栈关键词 → 黑名单过滤 → 与 Mod 列表比对 → 生成疑似 Mod 问题
```

### 关键词提取规则

1. 扫描所有 `at com.example.mod.Class.method(...)` 行
2. 提取包名前 4 节（`com.example.mod`）
3. 过滤已知黑名单（java, sun, net.minecraft, com.mojang, org.lwjgl 等）
4. 最多取 10 个关键词

### Mod 匹配规则

对每个关键词，匹配 Mod 的 Id/Name/FileName（不区分大小写）：
- 关键词包含 modId → 匹配
- 关键词包含 modName → 匹配
- 关键词包含文件名（不含.jar）→ 匹配

### 新增模式

在 `error-patterns.json` 中新增 `suspected-mod` 模式，用于解决方案模板。

## 改动文件

| 文件 | 改动 |
|------|------|
| `Core/.../MinecraftLogAnalyzer.cs` | 新增 `CrossReferenceStackWithMods()` + 在管线中调用 |
| `Core/.../error-patterns.json` | 新增 `suspected-mod` 模式 |
