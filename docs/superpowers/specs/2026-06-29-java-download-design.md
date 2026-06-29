# Java 下载设计

## 背景与问题

当前 Java 设置页的“下载 Java”按钮只是外链到 `https://adoptium.net`，没有任何内置下载能力：

1. 用户无法在启动器内直接下载并落地 Java。
2. 无法支持多发行版选择（Temurin / Zulu / Microsoft JDK / Oracle）。
3. 没有统一的下载进度、取消、失败重试和安装后自动注册流程。
4. 现有 `DownloadManager` 和 `JavaRuntimeStore` 已具备可复用能力，但尚未用于 Java 下载。

## 目标

在 Settings → Java 运行时页内，提供一个“下载 Java”对话框，支持用户手动选择发行版、主版本、平台、架构；启动器在后台解析下载链接、下载、解压到 `QML/Runtime/Java`，并自动把新 Java 加入 Java 运行时列表。

## 约束

- **Core 不可改动**：`Qomicex.Avalonia/Qomicex.Core/` 和 `Qomicex.Avalonia/Qomicex.Downloader/` 是共享 submodule，所有修改限制在 `src-backend/` 和 `src/` 内。
- **首版支持多源**：Temurin、Zulu、Microsoft JDK、Oracle。
- **首版支持三平台**：Windows、Linux、macOS。
- **下载目录固定**：`AppContext.BaseDirectory/QML/Runtime/Java`。
- **只支持可自动解压的包**：优先 zip / tar.gz；首版不支持 msi / exe / pkg。
- **Java 版本由用户手动选择**：不做按 Minecraft 版本自动推荐的下载入口。
- **系统代理即可**：不做代理配置 UI，由 .NET 默认使用系统代理。

## 设计

### 1. 后端架构

新增 3 个后端文件：

- `src-backend/Qomicex.Launcher.Backend/Controllers/JavaDownloadController.cs`
- `src-backend/Qomicex.Launcher.Backend/Services/JavaDownloadService.cs`
- `src-backend/Qomicex.Launcher.Backend/Models/JavaDownloadModels.cs`

职责划分：

- `JavaDownloadController`：暴露 catalog / start / progress / cancel API。
- `JavaDownloadService`：聚合多源元数据、解析下载链接、下载、解压、注册到 `JavaRuntimeStore`。
- `JavaDownloadModels`：统一的 vendor / version / platform / architecture / download task DTO。

### 2. 多源 catalog 统一模型

对前端暴露统一接口：`GET /api/java/download/catalog`

返回结构：

```json
{
  "vendors": [
    {
      "id": "temurin",
      "name": "Temurin",
      "platforms": ["windows", "linux", "macos"],
      "architectures": ["x64", "arm64", "x86"],
      "versions": [8, 11, 17, 21]
    }
  ]
}
```

关键原则：

- 前端不直接感知各家 API 差异，只消费统一模型。
- 后端内部按 vendor 实现 provider：
  - `TemurinProvider`
  - `ZuluProvider`
  - `MicrosoftJdkProvider`
  - `OracleProvider`
- 首版只暴露“可下载的主版本 / 平台 / 架构”，不把 build number、EA/release type 等细节暴露给前端。

### 3. 下载与落地

接口：`POST /api/java/download/start`

请求：

```json
{
  "vendor": "temurin",
  "version": 17,
  "platform": "windows",
  "architecture": "x64"
}
```

流程：

1. 后端根据 vendor 调用对应 provider，解析最终下载 URL。
2. 下载到临时目录：`QML/Runtime/Java/.tmp/<taskId>/...`
3. 解压到最终目录：`QML/Runtime/Java/<vendor>/<version>/<platform>-<arch>/`
4. 解压完成后自动调用 `JavaRuntimeStore.AddCustomAsync(javaExePath)`，把该 Java 注册到运行时列表。
5. 返回下载任务 ID，前端轮询进度。

格式策略：

- 优先 zip / tar.gz（可自动解压）。
- 若某源某平台只提供 msi / exe / pkg，则首版 catalog 直接过滤掉，不让用户选到不可自动落地的组合。

### 4. 下载进度与任务状态

接口：

- `POST /api/java/download/start`
- `GET /api/java/download/progress/{taskId}`
- `DELETE /api/java/download/{taskId}`

任务状态：

- `queued`
- `downloading`
- `extracting`
- `registering`
- `completed`
- `failed`
- `cancelled`

返回结构：

```json
{
  "taskId": "abc123",
  "status": "downloading",
  "progress": 46,
  "speed": 1234567,
  "fileName": "OpenJDK17U-jdk_x64_windows_hotspot_17.0.12.zip",
  "targetDir": "QML/Runtime/Java/temurin/17/windows-x64",
  "error": null
}
```

实现方式：

- 不复用 `InstallTask`，因为 Java 下载是独立子系统。
- 复用现有 `DownloadManager` 做单文件下载。
- `JavaDownloadService` 内部维护 `ConcurrentDictionary<string, JavaDownloadState>`。

### 5. 前端交互

位置：Settings → Java 运行时页。

“下载 Java”按钮点击后弹出对话框。

对话框内容：

- 发行版：Temurin / Zulu / Microsoft JDK / Oracle
- Java 主版本：8 / 11 / 17 / 21 / ...
- 平台：Windows / Linux / macOS
- 架构：x64 / x86 / arm64
- 目标目录：固定显示 `QML/Runtime/Java`
- 下载按钮

行为：

1. 打开对话框时加载 catalog。
2. 用户选择发行版 / 版本 / 平台 / 架构。
3. 点击下载 → `POST /api/java/download/start`。
4. 对话框内显示进度条和当前状态（downloading / extracting / registering）。
5. 完成后自动刷新 Java 列表，并显示“已安装到 QML/Runtime/Java/...”。
6. 失败时展示错误信息，保留当前选择方便用户重试。

### 6. 错误处理

统一错误码：

- `JAVA_DOWNLOAD_CATALOG_UNAVAILABLE`
- `JAVA_DOWNLOAD_PACKAGE_NOT_FOUND`
- `JAVA_DOWNLOAD_FAILED`
- `JAVA_DOWNLOAD_EXTRACT_FAILED`
- `JAVA_DOWNLOAD_REGISTER_FAILED`

Controller 不做局部 try/catch 包装业务错误；服务层抛 `ApiException`，交给 `ErrorHandlingMiddleware`。

### 7. 首版明确不做

- 不支持 msi / exe / pkg 安装器。
- 不做用户自定义下载目录。
- 不做签名校验 / GPG / 供应商校验链。
- 不做代理配置 UI。
- 不做按 Minecraft 版本自动推荐 Java 下载。

## 涉及文件汇总

| 文件 | 改动 |
|------|------|
| `src-backend/.../Controllers/JavaDownloadController.cs` | 新增 catalog/start/progress/cancel API |
| `src-backend/.../Services/JavaDownloadService.cs` | 新增多源 provider 聚合、下载、解压、注册逻辑 |
| `src-backend/.../Models/JavaDownloadModels.cs` | 新增统一 DTO |
| `src/pages/Settings.tsx` | “下载 Java”改为打开下载对话框 |
| `src/api/java.ts` | 新增 Java 下载相关 API |
| `src/types/index.ts` | 新增 Java 下载 catalog / task 类型 |

## 自检

- 无 TBD / TODO / 占位符
- 与用户确认一致：多源、首批 4 个 vendor、三平台、固定目录、下载对话框、手动选主版本
- 范围聚焦在“内置 Java 下载”，不夹带无关 UI 或资源修复功能
