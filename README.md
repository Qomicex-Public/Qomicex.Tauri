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

> 桌面版（Tauri v2）当前能力，核心逻辑全部由 Rust 实现：

### 🏆 特色功能

- **联机（自研 SCF 协议 + EasyTier 虚拟局域网）**
  - 建房 / 加入房间、NAT 类型检测（STUN 多端口降级）、中继组网
  - 踢出升级为 **deny 持久物理封禁**：被踢玩家即使重连、重启也无法再进入房间
  - 误踢可救：重连审核弹窗（允许 / 拒绝 / 拒绝且不再提示），房主黑名单列表可一键解除封禁
  - 主机 Mod 校验：缺失标记、与主机不一致时强制同步
- **整合包 导入 / 导出**
  - 本地导入：zip / mrpack 上传解析并一键安装
  - 实例导出：CurseForge zip、Modrinth mrpack、Qomicex 专属 `.qmodpack`，哈希反查自动生成文件清单
  - HMCL 风格**逐文件勾选**导出，异步任务（进度 / 取消 / 自定义保存路径），自定义包名 / 版本 / 作者
- **存档设置编辑器（level.dat NBT）**：游戏模式、难度、天气、出生点、世界边界、游戏规则等可视化编辑，支持从 `level.dat_old` 恢复
- **I18N 国际化**：中 / 英 / 繁 / 日 / 俄等 **7 种语言**，支持「跟随系统」，运行时实时切换
- **皮肤站快速导入**：Yggdrasil 服务器地址自动解析（authlib-injector 规范），支持把皮肤站链接**拖入表单一键添加**
- **个性化**：自定义 UI 字体（枚举系统字体、实时预览）、实例自定义分组

### 🧩 核心功能

- **实例管理**：多实例、版本隔离目录；一键安装版本与 Forge / Fabric / NeoForge / Quilt 等加载器
- **资源中心**：聚合 **Modrinth / CurseForge / FTB** 三源，支持模组、整合包、光影、资源包、数据包、存档分类检索，MC 百科中文名补全
- **下载中心**：统一任务管理（实例安装 / 模组下载 / Java 运行时），断点续传、暂停 / 恢复 / 取消、实时进度
- **账号体系**：Microsoft（OAuth 设备码登录）、离线、Yggdrasil 皮肤站（LittleSkin、Blessing Skin 等预设）
- **模组更新检查**：Modrinth / CurseForge 批量哈希匹配，变更列表 + 下载中心编排更新
- **游戏设置**：`options.txt` 可视化编辑，多语言描述，数组值（resourcePacks / datapacks 等）以 chips 增删
- **插件系统**：清单贡献点、内联渲染 / iframe 浮层、L3 WASM 插件网关（wasmtime 沙箱，Rust 编写）
- **Java 运行时管理**：自动扫描已安装 Java，缺失的 8 / 17 / 21 在线下载，内存分配设置
- **自动更新**：Tauri updater，alpha / latest 双更新通道

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


---

## 📄 许可证

[GPLv3](LICENSE)

## ❤️ 贡献者

[![](https://contrib.rocks/image?repo=Qomicex-Public/Qomicex.Tauri)](https://github.com/Qomicex-Public/Qomicex.Tauri/graphs/contributors)
