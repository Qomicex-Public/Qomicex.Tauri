# Qomicex Launcher

A cross-platform Minecraft launcher built with Tauri + React + ASP.NET Core.

<div align="center">

**Qomicex Launcher** (QML)

<img width="64" height="64" alt="QML Icon" src="https://github.com/user-attachments/assets/ff6cf36c-7ab0-40f5-93ec-996619a93461" />

[![.NET 10](https://img.shields.io/badge/.NET-10.0-512BD4?style=flat-square&logo=dotnet)](https://dotnet.microsoft.com)
[![React 19](https://img.shields.io/badge/React-19-61DAFB?style=flat-square&logo=react)](https://react.dev)
[![Tauri v2](https://img.shields.io/badge/Tauri-2-FFC131?style=flat-square&logo=tauri)](https://tauri.app)
[![License: GPLv3](https://img.shields.io/badge/License-GPL%20V3-yellow?style=flat-square)](LICENSE)
[![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20Linux%20%7C%20macOS-blue?style=flat-square)]()

</div>

---

## Features

- **Instance Management** — Create, import, export, duplicate, and launch Minecraft instances with full mod loader support (Forge, Fabric, NeoForge, Quilt, OptiFine, LiteLoader). Version isolation for mods, saves, resource packs, shader packs, datapacks, and screenshots.
- **Multi-Source Mod Browser** — Search and install mods, shaders, resource packs, and modpacks from Modrinth, CurseForge, and Feed The Beast with Chinese mod name lookup (MCMod.cn).
- **Account System** — Microsoft OAuth (device code flow), offline mode, Yggdrasil-compatible auth servers (LittleSkin, Blessing Skin), and Tongyi auth. Credentials encrypted with AES-256-GCM.
- **Java Management** — Auto-detect system Java (registry, env vars, standard paths), download bundled JDK from Adoptium/Zulu/BMCLAPI, custom JRE registration, per-instance Java selection.
- **Download Manager** — Multi-threaded range downloads with pause/resume/cancel/retry. Tracks game installs, Java downloads, mod downloads, and resource repairs in one unified view.
- **LAN Multiplayer** — UDP multicast discovery for local Minecraft servers, room code generation for easy join.
- **Log Analysis** — Paste Minecraft crash logs or debug output; backend analyzes against a pattern database and returns categorized issues with suggested fixes.
- **Skin Viewer** — 3D rotating skin preview (skinview3d), upload/reset custom skins per account.
- **System Info** — Displays OS, architecture, memory, GPU, and launcher version from the dashboard.
- **Customizable UI** — Dark mode, animated transitions (GSAP), randomizable background images, watermark toggle, debug overlay (press F8 eight times).

## Architecture

```
┌─────────────────┐     ┌──────────────────┐     ┌─────────────────────┐
│  Tauri (Rust)   │────▶│  React Frontend  │────▶│  ASP.NET Core API   │
│  Desktop shell  │     │  :1420           │     │  :5000              │
│  Backend embed  │     │                  │     │  + Qomicex.Core     │
└─────────────────┘     └──────────────────┘     └─────────────────────┘
                              │                           │
                         Modrinth/CF/FTB              Minecraft instances
                         Skin rendering                Java runtimes
                         Settings persistence          .minecraft files
```

| Layer | Tech | Directory |
|-------|------|-----------|
| Desktop shell | Tauri v2 (Rust) | `src-tauri/` |
| Frontend | React 19 + Vite 7 + TypeScript + Tailwind | `src/` |
| Backend API | ASP.NET Core 10 | `src-backend/Qomicex.Launcher.Backend/` |
| Shared logic | .NET 10 (submodule) | `Qomicex.Avalonia/Qomicex.Core/` |
| Download lib | .NET 10 | `src-backend/Qomicex.Downloader/` |

## Quick Start

### Prerequisites

- **Node.js** 20+ (npm)
- **.NET 10 SDK**
- **Rust** (for Tauri desktop builds)
- **Webkit2GTK 4.1** (Linux only, for Tauri)

### Development

```bash
# Install frontend dependencies
npm install

# Start backend (Terminal 1)
cd src-backend/Qomicex.Launcher.Backend && dotnet run

# Start frontend dev server (Terminal 2)
npm run dev          # http://localhost:1420

# Or use Tauri (combines both — recommended for desktop development)
npm run tauri dev
```

### Build

```bash
# Type-check + production build
npm run build

# Local Windows release build (publishes backend, embeds into Tauri)
pwsh ./build-release.ps1
```

### CI/CD

Automated builds via GitHub Actions — manual trigger at `.github/workflows/release.yml`. Supports Windows (NSIS), Linux (AppImage/DEB/RPM), and macOS (DMG, universal or per-arch).

Requires `QOMICEX_PAT` secret for submodule checkout.

## Project Structure

```
├── src/                    # React frontend
│   ├── pages/              # 9 routed pages (Dashboard, Instances, Downloads, etc.)
│   ├── components/         # Layout, UI primitives, modals
│   ├── api/                # Typed API client modules
│   ├── stores/             # In-memory + localStorage state
│   └── lib/                # Utilities (cn(), animations)
├── src-tauri/              # Tauri Rust shell
│   ├── src/lib.rs          # Backend embedding + child process lifecycle
│   └── binaries/           # Embedded backend binary (release builds)
├── src-backend/            # .NET backend
│   ├── Qomicex.Launcher.Backend/   # API controllers + services
│   ├── Qomicex.Core/                       # Shared launcher logic (git submodule)
│   └── Qomicex.Downloader/                 # Multi-threaded download engine
├── Qomicex.Avalonia/       # Separate repo (Avalonia desktop, shares Qomicex.Core)
├── scripts/                # Test scripts (API filter tests)
└── build-release.ps1       # Local Windows release builder
```

## Key Conventions

- **Frontend**: All local imports must include `.ts`/`.tsx` extensions (Vite path bug). Internal navigation uses `<Link>`, not `<a>`.
- **Backend**: Exceptions bubble to `ErrorHandlingMiddleware` — don't add try/catch in controllers. Use `ApiException` for expected errors.
- **Cross-platform**: Never assume Windows. Use `Path.Combine()`, `OperatingSystem.Is*()`, and platform-aware file pickers.
- **Version isolation**: Instance paths use `inst.Name` (folder name), not `inst.GameVersion`. Always resolve `inst.GameDir` as the base.

## License

[GPLv3](LICENSE)

---

# Qomicex 启动器

基于 Tauri + React + ASP.NET Core 构建的跨平台 Minecraft 启动器。

<div align="center">

**Qomicex Launcher** (QML)

<img width="64" height="64" alt="QML Icon" src="https://github.com/user-attachments/assets/ff6cf36c-7ab0-40f5-93ec-996619a93461" />

[![.NET 10](https://img.shields.io/badge/.NET-10.0-512BD4?style=flat-square&logo=dotnet)](https://dotnet.microsoft.com)
[![React 19](https://img.shields.io/badge/React-19-61DAFB?style=flat-square&logo=react)](https://react.dev)
[![Tauri v2](https://img.shields.io/badge/Tauri-2-FFC131?style=flat-square&logo=tauri)](https://tauri.app)
[![License: GPLv3](https://img.shields.io/badge/License-GPL%20V3-yellow?style=flat-square)](LICENSE)
[![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20Linux%20%7C%20macOS-blue?style=flat-square)]()

</div>

---

## 功能特性

- **实例管理** — 创建、导入、导出、复制和启动 Minecraft 实例，完整支持各类模组加载器（Forge、Fabric、NeoForge、Quilt、OptiFine、LiteLoader）。支持按实例隔离 mods、存档、资源包、光影包、数据包和截图。
- **多源模组浏览** — 从 Modrinth、CurseForge 和 Feed The Beast 搜索和安装模组、光影、资源包和整合包，内置 MCMod.cn 中文名称查询。
- **账号系统** — 支持微软 OAuth（设备码流程）、离线模式、Yggdrasil 兼容认证服务器（小皮皮肤、 blessing skin）和通义账号。凭据使用 AES-256-GCM 加密存储。
- **Java 管理** — 自动检测系统 Java（注册表、环境变量、标准路径），从 Adoptium/Zulu/BMCLAPI 下载集成 JDK，支持自定义 JRE 注册和按实例选择 Java。
- **下载管理器** — 多线程范围下载，支持暂停/恢复/取消/重试。统一管理游戏安装、Java 下载、模组下载和资源修复任务。
- **局域网联机** — UDP 组播发现本地 Minecraft 服务器，房间码生成方便好友加入。
- **日志分析** — 粘贴 Minecraft 崩溃日志或调试输出，后端根据模式数据库分析，返回分类问题和修复建议。
- **皮肤查看器** — 3D 旋转皮肤预览（skinview3d），支持按账号上传/重置自定义皮肤。
- **系统信息** — 仪表盘展示操作系统、架构、内存、GPU 和启动器版本信息。
- **自定义界面** — 暗色模式、GSAP 动画过渡、随机背景图片、水印开关、调试面板（连按 F8 八次解锁）。

## 架构

```
┌─────────────────┐     ┌──────────────────┐     ┌─────────────────────┐
│  Tauri (Rust)   │────▶│  React 前端      │────▶│  ASP.NET Core API   │
│  桌面外壳       │     │  :1420           │     │  :5000              │
│  后端嵌入       │     │                  │     │  + Qomicex.Core     │
└─────────────────┘     └──────────────────┘     └─────────────────────┘
                              │                           │
                         Modrinth/CF/FTB              Minecraft 实例
                         皮肤渲染                      Java 运行时
                         设置持久化                    .minecraft 文件
```

| 层级 | 技术 | 目录 |
|------|------|------|
| 桌面外壳 | Tauri v2 (Rust) | `src-tauri/` |
| 前端 | React 19 + Vite 7 + TypeScript + Tailwind | `src/` |
| 后端 API | ASP.NET Core 10 | `src-backend/Qomicex.Launcher.Backend/` |
| 共享逻辑 | .NET 10 (子模块) | `Qomicex.Avalonia/Qomicex.Core/` |
| 下载库 | .NET 10 | `src-backend/Qomicex.Downloader/` |

## 快速开始

### 前置要求

- **Node.js** 20+ (npm)
- **.NET 10 SDK**
- **Rust** (用于 Tauri 桌面构建)
- **Webkit2GTK 4.1** (Linux 专用，Tauri 依赖)

### 开发环境

```bash
# 安装前端依赖
npm install

# 启动后端（终端 1）
cd src-backend/Qomicex.Launcher.Backend && dotnet run

# 启动前端开发服务器（终端 2）
npm run dev          # http://localhost:1420

# 或使用 Tauri（合并两者 — 推荐桌面开发使用）
npm run tauri dev
```

### 构建

```bash
# 类型检查 + 生产构建
npm run build

# 本地 Windows 发布构建（发布后端并嵌入 Tauri）
pwsh ./build-release.ps1
```

### CI/CD

通过 GitHub Actions 自动构建 — 在 `.github/workflows/release.yml` 手动触发。支持 Windows (NSIS)、Linux (AppImage/DEB/RPM) 和 macOS (DMG，通用或分架构)。

需要 `QOMICEX_PAT` 密钥以检出子模块。

## 项目结构

```
├── src/                    # React 前端
│   ├── pages/              # 9 个路由页面（Dashboard、Instances、Downloads 等）
│   ├── components/         # 布局组件、UI 基础组件、弹窗
│   ├── api/                # 类型化 API 客户端模块
│   ├── stores/             # 内存 + localStorage 状态管理
│   └── lib/                # 工具函数（cn()、动画）
├── src-tauri/              # Tauri Rust 外壳
│   ├── src/lib.rs          # 后端嵌入 + 子进程生命周期
│   └── binaries/           # 嵌入的后端二进制文件（发布构建）
├── src-backend/            # .NET 后端
│   ├── Qomicex.Launcher.Backend/   # API 控制器 + 服务
│   ├── Qomicex.Core/                       # 共享启动器逻辑（git 子模块）
│   └── Qomicex.Downloader/                 # 多线程下载引擎
├── Qomicex.Avalonia/       # 独立仓库（Avalonia 桌面端，共享 Qomicex.Core）
├── scripts/                # 测试脚本（API 过滤器测试）
└── build-release.ps1       # 本地 Windows 发布构建脚本
```

## 关键约定

- **前端**: 所有本地导入必须包含 `.ts`/`.tsx` 扩展名（Vite 路径 bug）。内部导航使用 `<Link>`，而非 `<a>`。
- **后端**: 异常冒泡至 `ErrorHandlingMiddleware` — 不要在控制器中添加 try/catch。预期错误使用 `ApiException`。
- **跨平台**: 切勿假设 Windows 环境。使用 `Path.Combine()`、`OperatingSystem.Is*()` 和平台感知的文件选择器。
- **版本隔离**: 实例路径使用 `inst.Name`（文件夹名），而非 `inst.GameVersion`。始终以 `inst.GameDir` 作为路径构建基准。

## 许可证

[GPLv3](LICENSE)
