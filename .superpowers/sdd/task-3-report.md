# Task 3 Report: JavaDownloadService HttpClient 注入 + GetAllActiveStates

## Status: 完成

## Commits

- `91f37c6` — `feat(java-download): inject IHttpClientFactory, add GetAllActiveStates`

## 修改内容

| 修改 | 行号 | 描述 |
|------|------|------|
| 添加 `_httpClient` 字段 | line 15 | `private readonly HttpClient _httpClient;` |
| 构造函数注入 `IHttpClientFactory` | line 33-37 | 通过 `httpClientFactory.CreateClient("default")` 初始化 |
| `ResolvePackageAsync` 改为实例方法 | line 174 | 移除 `static`，用 `_httpClient` 替代 `new HttpClient()` |
| 添加 `GetAllActiveStates()` | line 151-165 | 返回所有活跃任务的状态列表 |

## Build Summary

```
dotnet build — 0 errors, 7 warnings (all pre-existing)
```

## Concerns

无。所有修改严格按 brief 执行，无额外变更。
