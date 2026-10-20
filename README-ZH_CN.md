[English](README.md) | **简体中文** | [繁體中文](README-ZH_TW.md) | [日本語](README-JA_JP.md) | [Русский](README-RU_RU.md)

<div align="center">

<img width="96" height="96" alt="QML Icon" src="public/logo.svg" />

# Qomicex Minecraft Launcher (QML)

以纯粹优雅重构你的 Minecraft 体验 —— 专为创作者与玩家打造的现代、快速、开源启动器。

[![Stars](https://img.shields.io/github/stars/Qomicex-Public/Qomicex.Tauri?style=for-the-badge&logo=github&labelColor=282C34&color=EAC54F)](https://github.com/Qomicex-Public/Qomicex.Tauri/)
[![Release](https://img.shields.io/github/v/release/Qomicex-Public/Qomicex.Tauri?style=for-the-badge&logo=github&labelColor=282C34&color=4CAF50)](https://github.com/Qomicex-Public/Qomicex.Tauri/releases)
[![Pre-release](https://img.shields.io/github/v/release/Qomicex-Public/Qomicex.Tauri?include_prereleases&style=for-the-badge&logo=github&label=pre-release&labelColor=282C34&color=9C27B0)](https://github.com/Qomicex-Public/Qomicex.Tauri/releases)
[![Downloads](https://ghapi.qomicex.top/?style=for-the-badge&color=2196F3)](https://github.com/Qomicex-Public/Qomicex.Tauri/releases)
[![Build Status](https://img.shields.io/github/actions/workflow/status/Qomicex-Public/Qomicex.Tauri/ci.yml?style=for-the-badge&logo=githubactions&labelColor=282C34)](https://github.com/Qomicex-Public/Qomicex.Tauri/actions)
[![License: GPLv3](https://img.shields.io/badge/License-GPL_v3-yellow?style=for-the-badge&labelColor=282C34)](LICENSE)

[![Rust](https://img.shields.io/badge/Rust-stable-000000?style=flat-square&logo=rust)](https://www.rust-lang.org)
[![React 19](https://img.shields.io/badge/React-19-61DAFB?style=flat-square&logo=react)](https://react.dev)
[![Tauri v2](https://img.shields.io/badge/Tauri-v2-FFC131?style=flat-square&logo=tauri)](https://tauri.app)

[🌐 官方网站](https://www.qomicex.top) • [📥 下载最新版](https://github.com/Qomicex-Public/Qomicex.Tauri/releases/latest) • [💬 交流反馈 QQ 群](https://qm.qq.com/q/rKiwzrkg8w)

</div>

---

## ✨ 核心亮点一览

### 🚀 丝滑启动，告别繁琐
原版、Forge、Fabric、NeoForge 等主流加载器一键搞定。点一下就能玩，再也不用为复杂的运行环境头疼。
<!-- TODO: 插入游戏启动与安装界面截图 -->

### 🔐 账号登录，轻松搞定
支持正版微软账号安全登录，也支持离线模式随心畅玩。想用个性皮肤？把皮肤站链接轻轻一拖就能自动导入。
<!-- TODO: 插入账号登录界面截图 -->

### 🌐 随时随地，轻松联机
无需枯燥繁琐的公网 IP 映射，和朋友一键就能连上开黑。安全防护贴心到位，还能无缝兼容其他主流联机启动器。
<!-- TODO: 插入联机大厅或房间截图 -->

### 📐 3D 蓝图投影预览
不用进游戏，直接在启动器里就能用 3D 视角查看 Litematica 投影文件。支持分层切片和材料统计，方便又直观。
<!-- TODO: 插入 3D 投影预览截图 -->

### 📦 模组与版本井井有条
每个版本的 Mod、存档和材质包都独立隔离，再也不会乱作一团。直连各大资源站一键搜索下载，连前置依赖都能帮你自动补全！
<!-- TODO: 插入版本管理与资源中心截图 -->

### 📥 整合包一键导入导出
看到喜欢的整合包直接拖进软件就能玩；想分享自己的杰作？一键打包带走，分享给好友超轻松。
<!-- TODO: 插入导入导出界面截图 -->

---

## 🖥️ 支持平台

| 平台 | 架构 | 最低系统要求 | 状态 |
|:---|:---|:---|:---|
| **Windows** | `x64`, `ARM64` | Windows 10 (1809+) | ✅ 稳定支持 |
| **macOS** | `x64`, `ARM64` | macOS 10.15+ | ✅ 稳定支持 |
| **Linux** | `x64`, `ARM64` | Ubuntu 20.04+ / glibc 2.28+ | ✅ 稳定支持 |

---

## 🔗 关联项目与合作

- **[qomicex-core-rust](https://github.com/Qomicex-Public/qomicex-core-rust)** — 启动器核心业务逻辑库。
- **[qomicex-downloader-rust](https://github.com/Qomicex-Public/qomicex-downloader-rust)** — 高性能异步多线程下载引擎。
- **[qomicex-connector-rust](https://github.com/Qomicex-Public/qomicex-connector-rust)** — 联机网络与 Scaffolding 协议通讯库。
- **[EuoraCraft-Launcher (ECLteam)](https://github.com/ECLteam/EuoraCraft-Launcher)** — ECLteam 团队开发的启动器（共享联机节点并兼容跨启动器联机）。

---

## ⭐ Star 增长趋势

<a href="https://www.star-history.com/?repos=Qomicex-Public%2FQomicex.Tauri&type=date&legend=bottom-right">
 <picture>
   <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/chart?repos=Qomicex-Public/Qomicex.Tauri&type=date&theme=dark&legend=bottom-right&sealed_token=3kRKTiCGJWMYcUcMNuRameNqf5F2KOLMXywaK7Sxym5ZUX3u2Jh3yAam-_le6HA2Jb2oLupvmK1VlTarzTSBkPWaKb7z5gnA7hkq0ZLXwEaAxPsH1o0GQg" />
   <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/chart?repos=Qomicex-Public/Qomicex.Tauri&type=date&legend=bottom-right&sealed_token=3kRKTiCGJWMYcUcMNuRameNqf5F2KOLMXywaK7Sxym5ZUX3u2Jh3yAam-_le6HA2Jb2oLupvmK1VlTarzTSBkPWaKb7z5gnA7hkq0ZLXwEaAxPsH1o0GQg" />
   <img alt="Star History Chart" src="https://api.star-history.com/chart?repos=Qomicex-Public/Qomicex.Tauri&type=date&legend=bottom-right&sealed_token=3kRKTiCGJWMYcUcMNuRameNqf5F2KOLMXywaK7Sxym5ZUX3u2Jh3yAam-_le6HA2Jb2oLupvmK1VlTarzTSBkPWaKb7z5gnA7hkq0ZLXwEaAxPsH1o0GQg" />
 </picture>
</a>

---

## ❤️ 贡献者们

感谢所有为 Qomicex Launcher 做出贡献的大佬们！

<a href="https://github.com/Qomicex-Public/Qomicex.Tauri/graphs/contributors">
  <img src="https://contrib.rocks/image?repo=Qomicex-Public/Qomicex.Tauri" />
</a>

---

## 📄 发音指南与开源协议

- **读音**：Qomicex `/kˈɑːmaɪsˌɛks/` (q·om·ic·ex)
- **开源协议**：本项目基于 [GPLv3 协议](LICENSE) 开源。

### 合规声明

- 游戏文件从 Mojang 官方服务器及其公开镜像下载。本项目不托管、不转存 Minecraft 游戏本体。
- Qomicex Launcher 是第三方工具，与 Mojang、Microsoft、网易无隶属、背书或赞助关系。
- 离线账户仅用于离线游戏与自建服务器。在要求正版验证的服务器上使用离线账户可能违反该服务器的规则。
- 新增离线 / 第三方登录账户前需先登录 Microsoft 账户（见 [ADR-117](docs/junsi-dev-docs/1-决策记录/ADR-117-离线账户要求先绑定-Microsoft-账户-并按中国大陆区域展示合规提示.md)）。
