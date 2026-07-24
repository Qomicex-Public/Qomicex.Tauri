# 复测记录

## 问题
安装实例、下载自定义文件时卡住不动，且没有任何日志输出。

## 根因
`DownloadEngine.ProbeFileSizeAsync` 三重合击导致卡死：
1. `HttpClient.Timeout = Timeout.InfiniteTimeSpan` — HEAD 请求无超时
2. `catch { }` 静默吞掉所有异常
3. `EnqueueBatchAsync` 串行调用每个文件的 HEAD 探测，任一个卡住则全线阻塞

## 修复
1. HEAD 探测加 `CancellationTokenSource(5s)` 超时
2. 批量探测从串行改为 `SemaphoreSlim(16)` + `Task.WhenAll` 并行
3. `catch` 块从静默改为 `Log(...)` 输出

## 复测记录

### 测试 1: 正常单文件下载
- 复测时间: 2026-07-25
- 操作: `POST /api/resource-download/download-to` → `https://httpbin.org/bytes/1024`
- 实际输出: `{"progress":100,"downloadedBytes":1024,"totalBytes":1024,"status":"completed"}`
- 预期输出: 正常完成，不卡死
- 结论: ✅ PASS

### 测试 2: 不可达 URL 下载
- 复测时间: 2026-07-25
- 操作: `POST /api/resource-download/download-to` → `https://10.255.255.1/nonexistent`
- 实际输出: 约 40s 后完成（HEAD 5s 超时 + TCP 连接超时 + 重试），无永久卡死
- 预期输出: 不无限卡死
- 结论: ✅ PASS

### 编译
- `dotnet build`: 0 错误, 0 警告 ✅
