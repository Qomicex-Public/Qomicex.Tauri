## Task 4 Report: 下载/解压/注册流程

### 变更文件

- `src-backend/Qomicex.Launcher.Backend/Services/JavaDownloadService.cs`
- `src-backend/Qomicex.Launcher.Backend/Qomicex.Launcher.Backend.csproj`

### 已实现内容

1. 在 `JavaDownloadService` 中补齐了 `GetBaseDir()`。
2. 将 `StartAsync` 从占位实现替换为真实任务创建逻辑：
   - 先解析供应商下载地址和文件名。
   - 创建任务状态并写入 `_tasks`。
   - 异步启动下载/解压/注册流程。
3. 实现了 `RunTaskAsync(...)`：
   - 使用现有 `DownloadManager` 下载归档。
   - 更新进度和速度。
   - 解压归档。
   - 查找 `java` / `java.exe` 并调用 `JavaRuntimeStore.AddCustomAsync` 注册。
   - 正确处理 `completed` / `cancelled` / `failed` 状态。
4. 实现了 `ResolvePackageAsync(...)` 的真实供应商分支：
   - `temurin`: Adoptium API
   - `zulu`: Azul Metadata API
   - `microsoft-jdk`: Microsoft JDK catalog JSON
   - `oracle`: Oracle 直链模式
5. 增加了平台/架构映射 helper，避免直接把前端枚举值原样传给上游 API 导致命名不匹配。
6. 增加了 `IsPlainZuluPackage(...)` 过滤，优先避开 `fx` / `crac` 变体，减少下载到非普通 JDK 包的概率。
7. 用 `SharpCompress` 实现了真实 `tar.gz` 解压。
8. 实现了 `FindJavaExecutable(...)`。
9. 在 backend csproj 中添加了：
   - `SharpCompress` `0.39.0`

### 与 brief 的偏差说明

1. `tar.gz` 解压没有使用 brief 示例中的 `TarArchive.Open(..., ReaderOptions ...)` / `entry.WriteToDirectory(...)` 组合。
   - 原因：`SharpCompress 0.39.0` 下该写法编译失败。
   - 处理：改为 `ReaderFactory.Open(stream)` + `reader.WriteEntryToDirectory(...)`，构建通过，行为仍满足真实 `tar.gz` 解压要求。
2. `ResolvePackageAsync(...)` 没有完全照抄 brief 的参数映射。
   - 原因：现有 catalog 使用 `macos` / `arm64` / `x86` 等内部值，而上游供应商接口并不统一。
   - 处理：增加供应商专属映射，避免请求参数失配。

### 构建验证

执行命令：

```bash
dotnet build src-backend/Qomicex.Launcher.Backend/Qomicex.Launcher.Backend.csproj
```

结果：

- 构建成功
- 0 errors
- 存在 7 个 warning，其中：
  - 5 个是已有 `AccountController.cs` 空引用警告，非本任务引入
  - 2 个是 `SharpCompress 0.39.0` 的 `NU1902` 已知漏洞警告

### 自审结论

1. 代码改动范围符合任务要求，仅实现下载 URL 解析、下载、解压、注册主流程。
2. 没有修改共享 `Core` / `Downloader` 子模块。
3. `StartAsync` 仍保持任务式异步返回，不阻塞请求线程。
4. `Oracle` 直链模式已按 brief 实现，但我本地探测到示例 `jdk-17_windows-x64_bin.zip` 返回 404，说明 Oracle 直链命名或版本支持可能与预期存在偏差；当前实现保留 brief 指定模式，并将该风险明确记录。
5. `microsoft-jdk` 的 catalog JSON 在当前网络环境下会被重定向干扰，代码实现基于 brief 指定结构和常见字段完成，实际联调时需要再确认线上返回结构未变化。

### 关注点 / 风险

1. `SharpCompress 0.39.0` 有已知中危漏洞警告；本任务按 brief 指定版本实现，没有擅自升级版本。
2. `Oracle` 下载 URL 很可能需要后续联调修正，尤其是平台和文件名模式。
3. `ResolvePackageAsync(...)` 当前没有单独为上游非 200 响应做细粒度转换，异常会在任务中落为 `failed`，这对当前流程可接受，但后续若要提升诊断质量，可以把 `HttpRequestException` 映射为更明确的上游错误码。

### Review 修复追加

1. 已按首版范围要求移除 `Oracle` 支持：
   - `GetCatalogAsync()` 不再返回 `oracle` vendor。
   - `ResolvePackageAsync()` 删除 `oracle` 分支。
   - 当请求 `request.Vendor == "oracle"` 时，当前会走统一未命中路径并返回 `JAVA_DOWNLOAD_PACKAGE_NOT_FOUND`。
2. 已加固 `microsoft-jdk` catalog 解析：
   - 对 `releases`、`version`、`files`、`platform`、`arch`、`fileName`、`url` 全部改为防御式 `TryGetProperty` / 空值检查。
   - 上游 JSON 结构缺失、类型不符或字段为空时，不再抛出原始 JSON 属性异常，而是继续跳过无效项并最终返回 `JAVA_DOWNLOAD_PACKAGE_NOT_FOUND`。
3. 已检查 `JavaDownloadService.cs` 中文文案编码：
   - 当前源码中的中文字符串为正常可读文本，未发现 mojibake，无需额外修复。

### Review 修复后构建验证

执行命令：

```bash
dotnet build src-backend/Qomicex.Launcher.Backend/Qomicex.Launcher.Backend.csproj
```

结果：

- 构建成功
- 0 errors
- 7 个 warning
- warning 构成未变化：
  - `SharpCompress 0.39.0` 的 `NU1902` 漏洞警告 2 条
  - `AccountController.cs` 既有空引用警告 5 条
