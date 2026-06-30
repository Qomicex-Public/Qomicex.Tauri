# Qomicex Launcher

## 路径约束

源码原始路径 `D:\C#\Project\qomicex-launcher` 包含 `#` 字符，会导致 Vite/Rollup 路径解析失败。工作副本位于 `D:\qomicex-launcher`（无 `#`），用于开发/构建。**所有 npm 命令必须从 `D:\qomicex-launcher` 执行。**

## 架构

三层桌面启动器（面向 Minecraft）：

| 层 | 技术 | 目录 | 端口 |
|-------|------|------|------|
| 桌面壳 | Tauri v2 (Rust) | `src-tauri/` | 无 |
| 前端 | React 19 + Vite 7 + TypeScript + Tailwind | `src/` | 1420 |
| 后端 API | ASP.NET Core (.NET 10 Web API) | `src-backend/Qomicex.Launcher.Backend/` | 5000 |

Vite 将 `/api/*` 代理到 `http://localhost:5000`（`vite.config.ts`）。

`src-backend/` 包含 3 个项目：`Qomicex.Launcher.Backend`（主 API）、`Qomicex.Core`（共享启动器逻辑）、`Qomicex.Downloader`（下载库）。Backend 同时引用 Core 和 Downloader。

`Qomicex.Avalonia/` 是**独立仓库**（有自己的 `.git`）。不要假定与 Tauri 应用共享工具链。

## 启动方式

```bash
# 后端
cd src-backend/Qomicex.Launcher.Backend && dotnet run

# 前端开发
npm run dev          # vite on :1420

# Tauri 桌面开发（替代 plain vite）
npm run tauri dev

# 构建（tsc 类型检查 + vite build）
npm run build
```

## 导入规则（Vite 路径 bug 规避）

所有本地 import **必须**包含完整文件扩展名：
```ts
import { foo } from './bar.ts'               // 正确
import { Baz } from './components/Baz.tsx'   // 正确
import { x } from './baz'                    // 错误 —— Vite 会报错
```

## 前端约定

- **样式**：Tailwind + shadcn/ui 风格组件（`class-variance-authority`、`radix-ui`）。使用 `src/lib/utils.ts` 中的 `cn()` 合并 class。
- **主题**：深色模式 CSS 变量定义在 `src/index.css`。Tailwind 配置了 `darkMode: "class"`。
- **严格 TS**：启用了 `noUnusedLocals`、`noUnusedParameters`、`strict: true`。`tsc` 是构建的一部分，开发时必须修复这些错误。
- **路由**：`BrowserRouter` → `MessageBoxProvider` → `Layout.tsx` 侧边栏 → 9 个已注册路由：`/`、`/instances`、`/instances/:id`、`/downloads`、`/accounts`、`/accounts/:uuid`、`/resource-center`、`/resource-center/:resourceId`、`/settings`。
- **UI 组件**在 `src/components/ui/`：badge、button、card、checkbox、combobox、dialog、input、label、message-box、select、separator、table、textarea、tooltip。
  - **Tooltip**（`tooltip.tsx`）— 替代原生 `title` 属性。包裹所有纯图标按钮。
  - **Select**（`select.tsx`）— 使用 `Select`/`SelectOption`/`SelectDivider` 替代原生 `<select>`。
  - 导入路径需带文件扩展名：`'../components/ui/<name>.tsx'`。
- `src/pages/LogAnalysis.tsx` 存在但**未注册**到路由中。

## 后端要点

- `Program.cs` 注册了：控制器、CORS（允许任意来源）、4 个 `HttpClient`（Modrinth、CurseForge、FTB、默认）、`DownloadManager`、`InstanceInstallService`、`FtbService`、`ResourceDownloadService`、`JavaRuntimeStore`、`JavaDownloadService`、`SkinService`、`McmodService`、`AccountService`、`MsAccount`、`TraceBufferStore`/`TraceDumpService`。
- `Controllers/` 中的控制器对应 `api/<name>` 路由。共 16 个控制器（Account、Instance、InstanceFiles、Java、JavaDownload、Launcher、Loaders、LogAnalysis、Mcmod、ResourceDownload、Resources、RoomCode、Settings、Skin、SystemInfo、Versions）。
- 内嵌资源：`error-patterns.json`（日志分析）、`java_launch_wrapper-1.4.4.jar`。
- `appsettings.json` 中 `CurseForge:ApiKey` 默认为空。

## 错误处理

**后端** — 所有未捕获异常由 `Middleware/ErrorHandlingMiddleware.cs` 统一处理，返回格式：
```json
{ "code": "ERROR_CODE", "message": "...", "detail": "...", "traceId": "...", "timestamp": "...", "status": 500 }
```
- **不要**在控制器中 try/catch 只为返回错误 — 让异常冒泡到中间件。
- 业务预期错误抛 `ApiException`：`throw ApiException.BadRequest("...")`、`throw ApiException.NotFound("...")` 等（`Common/ApiError.cs`）。
- 异常 → HTTP 状态码映射在 `ErrorHandlingMiddleware.MapException`：`ApiException` → 自身 StatusCode，`ArgumentNullException` → 400，`FileNotFoundException` → 404，`HttpRequestException` → 502，`TaskCanceledException` → 499，`JsonException` → 400，default → 500。新增映射加在此处。

**前端** — `src/api/client.ts` 导出 `ApiError` 类。所有 API 错误抛出 `ApiError`，包含 `.code`、`.status`、`.detail`、`.traceId`、`.displayMessage`。

## 测试

本仓库未检测到测试项目或测试框架。
