# Task 1 Report: Java Runtime Store

- 改动文件：`src-backend/Qomicex.Launcher.Backend/Services/JavaRuntimeStore.cs`
- 改动文件：`src-backend/Qomicex.Launcher.Backend/Program.cs`
- 报告文件：`.superpowers/sdd/task-1-report-java-runtime.md`

- 验证命令：`dotnet build src-backend/Qomicex.Launcher.Backend/Qomicex.Launcher.Backend.csproj --configuration Debug`
- 验证结果：构建成功，`0` warnings，`0` errors。

- 说明：新增 `JavaRuntimeStore`，使用 `AppContext.BaseDirectory/QML/java-runtimes.json` 持久化 custom Java 路径；通过 `JavaHelper.SearchJava` 的 `Custom` 模式校验并读取 Java 信息；`GetMergedAsync` 按归一化路径合并扫描结果与 custom 结果并去重。

- concerns：无。
