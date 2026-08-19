**简体中文** | [English](README-EN.md) | [繁體中文](README-ZH_TW.md)

<div align="center">
  
<img width="80" height="80" alt="QML Icon" src="/public/logo.svg" />

# Qomicex Minecraft Launcher

[![Stars](https://img.shields.io/github/stars/Qomicex-Public/Qomicex.Tauri?style=for-the-badge&logo=data:image/svg%2bxml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZlcnNpb249IjEiIHdpZHRoPSIxNiIgaGVpZ2h0PSIxNiI+PHBhdGggZD0iTTggLjI1YS43NS43NSAwIDAgMSAuNjczLjQxOGwxLjg4MiAzLjgxNSA0LjIxLjYxMmEuNzUuNzUgMCAwIDEgLjQxNiAxLjI3OWwtMy4wNDYgMi45Ny43MTkgNC4xOTJhLjc1MS43NTEgMCAwIDEtMS4wODguNzkxTDggMTIuMzQ3bC0zLjc2NiAxLjk4YS43NS43NSAwIDAgMS0xLjA4OC0uNzlsLjcyLTQuMTk0TC44MTggNi4zNzRhLjc1Ljc1IDAgMCAxIC40MTYtMS4yOGw0LjIxLS42MTFMNy4zMjcuNjY4QS43NS43NSAwIDAgMSA4IC4yNVoiIGZpbGw9IiNlYWM1NGYiLz48L3N2Zz4=&logoSize=auto&label=stars&labelColor=444444&color=eac54f)](https://github.com/Qomicex-Public/Qomicex.Tauri/)
![GitHub Release](https://img.shields.io/github/v/release/Qomicex-Public/Qomicex.Tauri?label=release&logo=github&style=for-the-badge)
![GitHub Actions Workflow Status](https://img.shields.io/github/actions/workflow/status/Qomicex-Public/Qomicex.Tauri/ci.yml?style=for-the-badge)

[![Issues](https://img.shields.io/github/issues/Qomicex-Public/Qomicex.Tauri?style=for-the-badge&label=issues&labelColor=444444&color=1F883D&logo=github)](https://github.com/Qomicex-Public/Qomicex.Tauri/issues)
[![Pull requests](https://img.shields.io/github/issues-pr/Qomicex-Public/Qomicex.Tauri?style=for-the-badge&label=pull%20requests&labelColor=444444&color=1F883D&logo=github)](https://github.com/Qomicex-Public/Qomicex.Tauri/pulls)
![GitHub Downloads (all assets, all releases)](https://ghapi.qomicex.top/?style=for-the-badge&color=green)

[![Rust](https://img.shields.io/badge/Rust-stable-000000?style=flat-square&logo=rust)](https://www.rust-lang.org)
[![React 19](https://img.shields.io/badge/React-19-61DAFB?style=flat-square&logo=react)](https://react.dev)
[![Tauri v2](https://img.shields.io/badge/Tauri-2-FFC131?style=flat-square&logo=tauri)](https://tauri.app)
[![License: GPLv3](https://img.shields.io/badge/License-GPL%20V3-yellow?style=flat-square)](LICENSE)
[![Release](https://github.com/Qomicex-Public/Qomicex.Tauri/actions/workflows/release.yml/badge.svg)](https://github.com/Qomicex-Public/Qomicex.Tauri/actions/workflows/release.yml)

<div align="center">
  
[官方网站](https://www.qomicex.top)
[立即下载](https://github.com/Qomicex-Public/Qomicex.Tauri/releases/latest)

</div>

</div>

[Qomicex Minecraft Launcher](https://github.com/Qomicex-Public/Qomicex.Tauri) 简称 QML 目前处于测试阶段,欢迎大家来试试看

**Qomicex Launcher 测试 ①群** [623362446](https://qm.qq.com/q/rKiwzrkg8w)

> 启动器后端已用 Rust (axum) 完整重写，核心库与下载器也已迁移为 Rust 子模块（`qomicex-core-rust` / `qomicex-connector-rust` / `qomicex-downloader-rust`），不再依赖 .NET SDK。

## ✨ 功能特性

> 桌面版（Tauri v2）当前能力，核心逻辑全部由 Rust 实现。

Qomicex Launcher（简称 QML）的目标，是让「启动、安装、管理实例」这些日常操作足够简单直接——无论你是日常游玩、装整合包，还是和朋友联机。

### 🚀 游戏启动

支持启动原版 Minecraft，也支持绝大多数 Mod Loader 的**一键自动安装**：

- Vanilla
- Forge
- Fabric
- NeoForge
- Quilt
- Babric
- LegacyFabric
- Cleanroom

启动器会读取实例配置，自动组装游戏所需的 libraries、assets、natives、JVM 参数和游戏参数，启动后记录完整启动日志，方便排查崩溃或 Mod 冲突。

### 🔐 账号登录

支持多种登录方式：

- **Microsoft 正版**（OAuth 设备码登录）：一个一次性设备码即可授权，登录信息本地保存，下次直接使用
- **离线玩家名**：适合本地测试、单机游玩或无需正版验证的环境
- **Yggdrasil 皮肤站**：内置 LittleSkin、Blessing Skin 等常见皮肤站预设，也可快速导入其它服务器

皮肤站支持**拖入链接一键添加**：Yggdrasil 服务器地址会自动解析（authlib-injector 规范），省去手动填写的麻烦。

### 🌐 内置联机

QML 内置**Scaffolding 协议联机**，无需公网 IP 即可与好友组网联机：

- 建房 / 加入房间、NAT 类型检测（STUN 多端口降级）、中继组网
- 踢出升级为 **deny 持久物理封禁**：被踢的玩家即使重连、重启也无法再进入房间
- 误踢可救：重连审核弹窗（允许 / 拒绝 / 拒绝且不再提示），房主黑名单列表可一键解除封禁
- 主机 Mod 校验：缺失标记、与主机不一致时强制同步
- 支持与HMCL、PCL-CE、PCL.Mac等基于陶瓦、实现了SCF协议的启动器互通联机

### 📦 实例管理

每个游戏版本或整合包都会作为一个**独立实例**保存，目录按版本隔离，互不干扰：

- 一键安装版本与 Forge / Fabric / NeoForge / Quilt 等加载器
- 每个实例单独管理 Mod、存档、材质包、光影包、配置文件、Java 与内存、JVM 参数
- 实例自定义分组，让大量版本井井有条

### 📐 投影原理图管理 · Deepslate 3D 预览

实例详情页内置 **Litematica 投影原理图**管理与预览：

- 列表 / 搜索 / 打开文件夹 / 本地导入（multipart，扩展名白名单）/ 重命名 / 单个删除 + 批量删除
- **Deepslate WebGL 3D 预览**：查看投影完整内容 + 材质面板 + Y 层滑块 + 多 region + 方块/材料统计列表
- 材质从原理图调色板子集、按需从用户游戏 jar 运行时提取并本地缓存，**不捆绑 Mojang 素材**（版权合规）
- schematics 目录纳入版本隔离，随实例独立存放

### 🗂️ 资源中心

聚合 **Modrinth / CurseForge / FTB** 三大数据源，一站式查找资源：

- 支持模组、整合包、光影、资源包、数据包、存档等分类检索
- MC 百科中文名补全，浏览更友好
- 在线搜索并安装 Mod、材质包、光影包
- 资源详情一站式查看

### ⬇️ 下载中心

统一下载器负责游戏文件、依赖库、资源文件、Loader 安装器、整合包与在线 Mod 下载：

- 自研高速下载引擎，多文件异步下载、单任务进度实时显示
- 断点续传、暂停 / 恢复 / 取消
- 慢速或失败时自动换源、当前源冷却，避免持续请求已限流的源

实例安装、模组下载、Java 运行时等所有下载任务都集中到下载中心统一管理，随时查看进度与失败原因。

### 📥 整合包导入 / 导出

- **导入**：本地 `zip` / Modrinth `.mrpack` 上传解析并一键安装，自动识别版本、Loader、Mod、配置与资源目录；安装中断或失败会自动清理半成品，不留残留
- **导出**：可导出为 CurseForge `zip`、Modrinth `mrpack` 或 Qomicex 专属 `.qmodpack`，哈希反查自动生成文件清单
- HMCL 风格**逐文件勾选**导出：自定义包名 / 版本 / 作者，异步任务带进度、可取消、可自定义保存路径

### 🧩 Mod 管理

每个实例都有独立的管理页面：

- 查看已安装 Mod、启用 / 禁用、删除
- 打开实例目录，以及 mods、saves、resourcepacks、shaderpacks、config 等常用文件夹
- 在线搜索并安装 Mod、下载材质包与光影包
- **模组更新检查**：Modrinth / CurseForge 批量哈希匹配，列出变更后交给下载中心编排更新

禁用 Mod 时保留文件、只改启用状态，方便排查冲突。

### 📎 模组前置自动安装

安装 Mod 时，QML 会自动解析其所在的 Modrinth / CurseForge 数据源的**依赖清单**：

- 识别并展示**必需前置（required dependencies）**，支持递归解析深层依赖
- 一键连同前置一起安装到目标实例，避免「缺前置开不了服、报红名错误」的困扰
- 可选跳过非必需依赖，按需选择安装范围

### ☕ Java 运行时管理

不同版本需要不同 Java，QML 根据实例版本自动选择：

- 自动扫描本机已安装的 Java
- 缺失的 Java 8 / 17 / 21 在线下载
- 手动指定 Java 路径、按实例单独设置
- 启动时检查 Java 是否匹配当前游戏版本

### 💾 存档与游戏设置编辑

- **存档设置编辑器（level.dat NBT）**：游戏模式、难度、天气、出生点、世界边界、游戏规则等可视化编辑，支持从 `level.dat_old` 恢复
- **游戏设置**：`options.txt` 可视化编辑，带多语言描述，数组值（resourcePacks / datapacks 等）以 chips 形式增删

### 🩺 日志分析与崩溃排查

游戏崩溃后可读取启动日志分析：

- **本地规则分析**：内置 44 种错误模式库，按 Critical > Error > Warning > Info 排序，无需额外配置
- **AI 分析**（插件提供）：填写兼容 OpenAI 格式的 API 地址、Key 与模型名后调用

### 🧩 插件系统

QML 提供可扩展的插件生态：

- 清单贡献点、内联渲染 / iframe 浮层、插件间方法调用
- **L3 WASM 插件网关**（wasmtime 沙箱，Rust 编写），插件以 WebAssembly 形式在受限沙箱内安全运行
- 插件包（`.qplugin`）上传安装，状态本地持久化

### 🎨 个性化与多语言

- **I18N 国际化**：中 / 英 / 繁 / 日 / 俄等 **7 种语言**，支持「跟随系统」，运行时实时切换
- 自定义 UI 字体（枚举系统字体、实时预览）
- 内置 / 自定义背景、主题色等界面个性化选项

## 🔗 依赖与相关项目

QML 的核心能力由以下 **Rust 子模块**承载（仓库根 git submodule，`git submodule update --recursive` 拉取）：

- [qomicex-core-rust](https://github.com/Qomicex-Public/qomicex-core-rust) — 核心库（GameCore 游戏核心、实例 / 账号 / Java / 下载等业务逻辑）
- [qomicex-downloader-rust](https://github.com/Qomicex-Public/qomicex-downloader-rust) — 统一高速下载器
- [qomicex-connector-rust](https://github.com/Qomicex-Public/qomicex-connector-rust) — 联机 / SCF 协议库（依赖 EasyTier4QML 分支）
- [Qomicex.Tauri.i18n](https://github.com/Qomicex-Public/Qomicex.Tauri.i18n) — 前端多语言资源仓库

**合作 / 相关社区项目**：

- [EuoraCraft-Launcher（ECLteam）](https://github.com/ECLteam/EuoraCraft-Launcher) — ECLteam 维护的 Python + Tauri 第三方 Minecraft 启动器，与QML**共用联机节点**，并**兼容 SCF 拓展协议**实现互相联机

## 🔗 相关链接

| 链接 | 地址 |
|:--|:--|
| 官方网站 | <https://www.qomicex.top> |
| 项目仓库 | <https://github.com/Qomicex-Public/Qomicex.Tauri> |
| 发布下载 | <https://github.com/Qomicex-Public/Qomicex.Tauri/releases> |
| 问题反馈 | <https://github.com/Qomicex-Public/Qomicex.Tauri/issues> |
| 多语言仓库 | <https://github.com/Qomicex-Public/Qomicex.Tauri.i18n> |
| 测试反馈群 | [623362446](https://qm.qq.com/q/rKiwzrkg8w) |

## 🎯 适合场景

QML 适合这些使用场景：

- 日常启动 Minecraft，管理多个版本与整合包
- 与好友联机（无需公网 IP，内置组网）
- 拖入整合包快速安装 / 一键导出分享
- 管理 Mod、材质包、光影包与存档
- 给不同实例分别配置 Java 与内存
- 排查启动失败和崩溃日志
- 使用带个性化界面与多语言支持的轻量启动器

## ℹ️ 小Tips - 读音
Qomicex
/kˈɑːmaɪsˌɛks/
≈ q·om·ic·ex

## 🖥️ 支持平台

> 以下表格列出了当前支持的平台、最低版本要求和测试状态。

 平台 | 支持架构 | 最低系统版本 | 测试状态 | 安装包/方式 |
| :--- | :--- | :--- | :--- | :--- |
| **Windows** | `x64`, `ARM64` | Windows 10 1809+ | ✅ 稳定 | `.exe`（NSIS 安装器）|
| **macOS** | `x64`（Intel）<br>`ARM64`（Apple Silicon） | macOS 10.15+ | ✅ 稳定 | `.dmg` / `.app` |
| **Linux** | `x64`, `ARM64`<br>`LoongArch64` (理论可用但无机器)<br>`RISC-V 64`(实验性,推进中) | Ubuntu 20.04+ / Fedora 34+ / glibc 2.28+ | ✅ 稳定 | `.deb` / `.rpm` / AppImage |


> 您也可以通过下方的状态徽章快速查看支持情况：
### 🚀 支持
![Windows](https://img.shields.io/badge/Windows-10%2B-blue?logo=windows)
![macOS](https://img.shields.io/badge/macOS-10.15%2B-black?logo=apple)
![Linux](https://img.shields.io/badge/Linux-Ubuntu%2020.04%2B-yellow?logo=linux)


## 🔧 开发、调试与构建

> 技术栈：**Rust**（axum 后端 + Tauri v2）+ **React 19 / Vite / TypeScript**（前端）+ **pnpm**（workspace 依赖 `@qomicex/plugin-ui`）。核心库与多语言资源以 git submodule 引入。

### 环境要求

- Rust 工具链（stable）+ `cargo`；推荐 `rust-analyzer`（编辑器补全）与 `codelldb`（调试，可参考 `.vscode/launch.json` 的 Rust 后端调试配置）
- Node.js + pnpm（workspace 管理）
- Windows 联机构建需要 npcap（`Packet.dll`）等运行时，具体前置见 `AGENTS.md` 与 CI `setup-connector-build`

### 初始化（全新检出）

```bash
git submodule update --recursive
pnpm install --frozen-lockfile
pnpm --filter @qomicex/plugin-ui build   # 组件库 dist/ 为 gitignored，前端依赖此产物
```

### 后端开发（Rust API）

```bash
cargo run --manifest-path src-backend/qomicex-backend/Cargo.toml
```

默认监听 `127.0.0.1:5000`，可用环境变量 `QOMICEX_PORT` 覆盖端口；开发期可用 VS Code `codelldb` 附加断点调试 Rust 后端。

### 前端开发（Vite）

```bash
pnpm run dev        # http://localhost:1420，/api 代理到 :5000
```

### 桌面开发（Tauri，集成窗口与后端进程）

```bash
pnpm run tauri dev
```

### 测试

```bash
cargo test --manifest-path src-backend/qomicex-backend/Cargo.toml   # 后端单元测试（含 kick 审核状态机等）
cd src-tauri && cargo test --lib plugin_gateway                      # Tauri WASM 插件网关测试
pnpm exec tsc --noEmit                                                # 前端 + i18n 类型检查
bash scripts/test-api-filters.sh    # 或 test-api-filters.ps1，针对 :5000 的行为验证
```

### 构建与格式

```bash
pnpm run build    # 先 tsc 再 vite build，类型错误会中断构建
cargo fmt         # 修改 Rust 代码后必跑，CI 会校验格式
```

> 修改 `packages/plugin-ui/src/` 后需重建组件库；修改 i18n 需在 `qomicex-tauri-i18n` 子模块单独提交推送。


---

## 📄 许可证

[GPLv3](LICENSE)

## ❤️ 贡献者

[![](https://contrib.rocks/image?repo=Qomicex-Public/Qomicex.Tauri)](https://github.com/Qomicex-Public/Qomicex.Tauri/graphs/contributors)
