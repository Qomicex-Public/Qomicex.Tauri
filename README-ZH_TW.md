[English](README.md) | [简体中文](README-ZH_CN.md) | **繁體中文** | [日本語](README-JA_JP.md) | [Русский](README-RU_RU.md)

<div align="center">

<img width="96" height="96" alt="QML Icon" src="public/logo.svg" />

# Qomicex Minecraft Launcher (QML)

以純粹優雅重構你的 Minecraft 體驗 —— 專為創作者與玩家打造的現代、快速、開源啟動器。

[![Stars](https://img.shields.io/github/stars/Qomicex-Public/Qomicex.Tauri?style=for-the-badge&logo=github&labelColor=282C34&color=EAC54F)](https://github.com/Qomicex-Public/Qomicex.Tauri/)
[![Release](https://img.shields.io/github/v/release/Qomicex-Public/Qomicex.Tauri?style=for-the-badge&logo=github&labelColor=282C34&color=4CAF50)](https://github.com/Qomicex-Public/Qomicex.Tauri/releases)
[![Pre-release](https://img.shields.io/github/v/release/Qomicex-Public/Qomicex.Tauri?include_prereleases&style=for-the-badge&logo=github&label=pre-release&labelColor=282C34&color=9C27B0)](https://github.com/Qomicex-Public/Qomicex.Tauri/releases)
[![Downloads](https://ghapi.qomicex.top/?style=for-the-badge&color=2196F3)](https://github.com/Qomicex-Public/Qomicex.Tauri/releases)
[![Build Status](https://img.shields.io/github/actions/workflow/status/Qomicex-Public/Qomicex.Tauri/ci.yml?style=for-the-badge&logo=githubactions&labelColor=282C34)](https://github.com/Qomicex-Public/Qomicex.Tauri/actions)
[![License: GPLv3](https://img.shields.io/badge/License-GPL_v3-yellow?style=for-the-badge&labelColor=282C34)](LICENSE)

[![Rust](https://img.shields.io/badge/Rust-stable-000000?style=flat-square&logo=rust)](https://www.rust-lang.org)
[![React 19](https://img.shields.io/badge/React-19-61DAFB?style=flat-square&logo=react)](https://react.dev)
[![Tauri v2](https://img.shields.io/badge/Tauri-v2-FFC131?style=flat-square&logo=tauri)](https://tauri.app)

[🌐 官方網站](https://www.qomicex.top) • [📥 下載最新版](https://github.com/Qomicex-Public/Qomicex.Tauri/releases/latest) • [💬 交流反饋 QQ 群](https://qm.qq.com/q/rKiwzrkg8w)

</div>

---

## ✨ 核心亮點一覽

### 🚀 輕鬆啟動，告別繁瑣
原版、Forge、Fabric、NeoForge 等主流載入器一鍵完成。點一下就能玩，再也不用為複雜的環境設定頭痛。
<!-- TODO: 插入遊戲啟動與安裝介面截圖 -->

### 🔐 帳號登入，簡單直覺
支援微軟正版安全登入，也支援離線模式隨心暢畫。想用個人面板造型？把面板站連結直接拖曳進去就能自動匯入。
<!-- TODO: 插入帳號登入介面截圖 -->

### 🌐 隨時隨地，輕鬆連線
無需設定麻煩的公網 IP，與朋友一鍵就能連線開黑。安全防護完善，並完美相容其他主流連線啟動器。
<!-- TODO: 插入連線大廳或房間截圖 -->

### 📐 3D 藍圖投影預覽
不用進遊戲，直接在啟動器裡就能用 3D 視角檢視 Litematica 投影檔案。支援分層切片與材料統計，直觀又好用。
<!-- TODO: 插入 3D 投影預覽截圖 -->

### 📦 模組與版本井然有序
每個版本的 Mod、存檔與材質包完全獨立隔離。直連各大資源站一鍵搜尋下載，連前置依賴都能幫你自動補齊！
<!-- TODO: 插入版本管理與資源中心截圖 -->

### 📥 整合包一鍵匯入匯出
看到喜歡的整合包直接拖進軟體就能玩；想分享自己的傑作？一鍵打包就能輕鬆分享給好友。
<!-- TODO: 插入匯入匯出介面截圖 -->

---

## 🖥️ 支援平台

| 平台 | 架構 | 最低系統要求 | 狀態 |
|:---|:---|:---|:---|
| **Windows** | `x64`, `ARM64` | Windows 10 (1809+) | ✅ 穩定支援 |
| **macOS** | `x64`, `ARM64` | macOS 10.15+ | ✅ 穩定支援 |
| **Linux** | `x64`, `ARM64` | Ubuntu 20.04+ / glibc 2.28+ | ✅ 穩定支援 |

---

## 🔗 關聯專案與合作

- **[qomicex-core-rust](https://github.com/Qomicex-Public/qomicex-core-rust)** — 啟動器核心業務邏輯庫。
- **[qomicex-downloader-rust](https://github.com/Qomicex-Public/qomicex-downloader-rust)** — 高效能非同步多線程下載引擎。
- **[qomicex-connector-rust](https://github.com/Qomicex-Public/qomicex-connector-rust)** — 連線網路與 Scaffolding 協定通訊庫。
- **[EuoraCraft-Launcher (ECLteam)](https://github.com/ECLteam/EuoraCraft-Launcher)** — ECLteam 團隊開發的啟動器（共享連線節點並相容跨啟動器連線）。

---

## ⭐ Star 增長趨勢

<a href="https://www.star-history.com/?repos=Qomicex-Public%2FQomicex.Tauri&type=date&legend=bottom-right">
 <picture>
   <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/chart?repos=Qomicex-Public/Qomicex.Tauri&type=date&theme=dark&legend=bottom-right&sealed_token=3kRKTiCGJWMYcUcMNuRameNqf5F2KOLMXywaK7Sxym5ZUX3u2Jh3yAam-_le6HA2Jb2oLupvmK1VlTarzTSBkPWaKb7z5gnA7hkq0ZLXwEaAxPsH1o0GQg" />
   <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/chart?repos=Qomicex-Public/Qomicex.Tauri&type=date&legend=bottom-right&sealed_token=3kRKTiCGJWMYcUcMNuRameNqf5F2KOLMXywaK7Sxym5ZUX3u2Jh3yAam-_le6HA2Jb2oLupvmK1VlTarzTSBkPWaKb7z5gnA7hkq0ZLXwEaAxPsH1o0GQg" />
   <img alt="Star History Chart" src="https://api.star-history.com/chart?repos=Qomicex-Public/Qomicex.Tauri&type=date&legend=bottom-right&sealed_token=3kRKTiCGJWMYcUcMNuRameNqf5F2KOLMXywaK7Sxym5ZUX3u2Jh3yAam-_le6HA2Jb2oLupvmK1VlTarzTSBkPWaKb7z5gnA7hkq0ZLXwEaAxPsH1o0GQg" />
 </picture>
</a>

---

## ❤️ 貢獻者們

感謝所有為 Qomicex Launcher 做出貢獻的大神們！

<a href="https://github.com/Qomicex-Public/Qomicex.Tauri/graphs/contributors">
  <img src="https://contrib.rocks/image?repo=Qomicex-Public/Qomicex.Tauri" />
</a>

---

## 📄 發音指南與開源協議

- **讀音**：Qomicex `/kˈɑːmaɪsˌɛks/` (q·om·ic·ex)
- **開源協議**：本專案基於 [GPLv3 協議](LICENSE) 開源。
