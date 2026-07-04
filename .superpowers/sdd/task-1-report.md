# Task 1 Report: CoreConfig + HTTP 连接池

## 实现内容

### CoreConfig.cs（新建）
- 位于 `Qomicex.Avalonia/Qomicex.Downloader/CoreConfig.cs`
- `public static class CoreConfig`，单一属性 `MaxConnectionsPerServer`，默认值 64
- 声明式命名空间格式 (`namespace Qomicex.Downloader;`)，与其他文件保持一致（注意 `Core.cs` 使用大括号式 `namespace Qomicex.Downloader { }`，但两种方式在 C# 10+ 中等价且互相兼容）

### Core.cs（修改）
- 将 `private static readonly HttpClient _httpClient = new HttpClient();` 替换为 `Lazy<HttpClient>`，底层使用 `SocketsHttpHandler`
- 配置：`MaxConnectionsPerServer = CoreConfig.MaxConnectionsPerServer`、`PooledConnectionLifetime = TimeSpan.FromMinutes(5)`、`EnableMultipleHttp2Connections = true`
- `SharedHttpClient` 属性提供惰性初始化的单例访问
- 全部 4 处 `_httpClient` 引用均替换为 `SharedHttpClient`（第 65、120、143、175 行）

## 构建验证结果

| 项目 | 结果 | 错误 | 新增警告 |
|------|------|------|----------|
| `Qomicex.Downloader` | 成功 | 0 | 0 |
| `Qomicex.Launcher.Backend` | 成功 | 0 | 0 |

所有警告均为已有问题，与本次改动无关。

## 变更文件

- **新建：** `Qomicex.Avalonia/Qomicex.Downloader/CoreConfig.cs`（6 行）
- **修改：** `Qomicex.Avalonia/Qomicex.Downloader/Core.cs`（替换静态 HttpClient 为 Lazy+SocketsHttpHandler，更新所有引用）

## 自审发现

- 无回归问题
- `SocketsHttpHandler` 命名空间 `System.Net.Http` 已在 `Core.cs` 中导入，无需新增 using
- `Core.cs` 使用大括号式命名空间（`namespace Qomicex.Downloader { }`），`CoreConfig.cs` 使用声明式（`namespace Qomicex.Downloader;`）——两种方式互操作无问题，但风格不一致。若需保持一致，可将 `CoreConfig.cs` 改为大括号式
- 提交在子模块 `Qomicex.Avalonia` 内完成（`detached HEAD`），外部仓库需单独更新子模块指针

## 问题与疑虑

- 子模块处于 detached HEAD 状态——工作正常，但如需推送需先创建分支或直接推送提交
- `CoreConfig.cs` 与 `Core.cs` 的命名空间声明风格不一致（声明式 vs 大括号式），建议后续统一
