# Qomicex Launcher

## 路径约束

源码原始路径 `D:\C#\Project\qomicex-launcher` 包含 `#` 字符，会导致 Vite/Rollup 路径解析失败。工作副本位于 `D:\qomicex-launcher`（无 `#`），用于开发/构建。**所有 npm 命令必须从 `D:\qomicex-launcher` 执行。**

## 架构

三层桌面启动器（面向 Minecraft）：

| 层 | 技术 | 目录 | 端口 |
|-------|------|------|------|
| 桌面壳 | Tauri v2 (Rust) | `src-tauri/` | 无 |
| 前端 | React 19 + Vite 7 + TypeScript + Tailwind + react-router-dom | `src/` | 1420 |
| 后端 API | ASP.NET Core (.NET 10 Web API) | `src-backend/Qomicex.Launcher.Backend/` | 5000 |

Vite 将 `/api/*` 代理到 `http://localhost:5000`（`vite.config.ts:24-29`）。

`npm run build` 执行 `tsc && vite build`（先类型检查，再打包）。

## 启动方式

**终端 1 - 后端：**
```
cd D:\qomicex-launcher\src-backend\Qomicex.Launcher.Backend
dotnet run
```

**终端 2 - 前端：**
```
cd D:\qomicex-launcher
npm run dev
```

**Tauri 桌面开发（替代终端 2）：**
```
cd D:\qomicex-launcher
npm run tauri dev
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
- **主题**：深色模式 CSS 变量定义在 `src/index.css`。Tailwind 配置了 `darkMode: "class"`，但未接入切换开关。
- **布局**：`BrowserRouter` + 侧边栏（`Layout.tsx`）→ 8 个路由页面：`/`、`/instances`、`/downloads`、`/accounts`、`/log-analysis`、`/resource-center`、`/resource-center/:resourceId`、`/settings`。
- **严格 TS**：启用了 `noUnusedLocals`、`noUnusedParameters`、`strict: true`。`tsc` 是构建的一部分，开发时必须修复这些错误。

## 后端要点

- `Program.cs` 注册了：控制器、CORS（允许任意来源）、4 个 `HttpClient`（Modrinth、CurseForge、FTB、默认）、`DownloadManager`、`InstanceInstallService`、`FtbService`、ML.NET 推荐服务。
- `Controllers/` 中的控制器对应 `api/<name>` 路由。
- 内嵌资源：`error-patterns.json`（日志分析）、`java_launch_wrapper-1.4.4.jar`。
- `appsettings.json` 中 `CurseForge:ApiKey` 默认为空。

## 测试

本仓库未检测到测试项目或测试框架。

## 独立项目

`Qomicex.Avalonia/` 是一个独立的 Avalonia 桌面启动器（独立的仓库，有自己的 `.git`）。详见其 `AGENTS.md`。不要假定它与 Tauri 应用共享工具链。

## 同步（如果在原始 `#` 路径下编辑）

```bash
xcopy /E /I /Y "D:\C#\Project\qomicex-launcher\*" "D:\qomicex-launcher"
```
