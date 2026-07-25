# C# 编码规范

从项目 `AGENTS.md` 和代码库提取的约定。

## 跨平台规则

- 使用 `Path.Combine(...)` 拼接路径，禁止硬编码盘符或 `\\`
- 使用 `Process.Start(new ProcessStartInfo(path) { UseShellExecute = true })` 打开文件/URL
- 平台判断使用 `OperatingSystem.IsWindows()` / `IsLinux()` / `IsMacOS()` (不用 `PlatformID.Win32NT`)
- Shell: 使用 `/bin/sh` 作为后备 (不是 `/bin/bash`)
- dotnet publish 需要 `-p:IncludeNativeLibrariesForSelfExtract=true` (SkiaSharp)
- 数据目录使用 `LocalApplicationData` + 应用名称，支持 `QOMICEX_HOME` 环境变量覆盖

## 错误处理

- Controller/Endpoint 中不要添加 try/catch，让异常向上冒泡
- 对于预期错误，抛出 `ApiException`:
  - `ApiException.BadRequest(...)`
  - `ApiException.NotFound(...)`
- 异常 → HTTP 映射由 `ErrorHandlingMiddleware` 统一处理

## API 风格

- 使用 Minimal API (`MapGet`/`MapPost`)，不使用传统 Controller
- 使用 `JsonSerializerContext` (NativeAOT 序列化)
- NativeAOT 限制: 避免反射，必须显式注册序列化类型

## Qomicex.Core.AOT 注意事项

- 访问 `obj["natives"]` 前先检查 `ContainsKey(osName)`
- 检测 `aarch64`/`ARM64` 后再回退到 `x86`
