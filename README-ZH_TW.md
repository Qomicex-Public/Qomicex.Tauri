[English](README.md) | [简体中文](README-ZH_CN.md) | **繁體中文** | [日本語](README-JA_JP.md) | [Русский](README-RU_RU.md)

<div align="center">
  
<img width="80" height="80" alt="QML Icon" src="/public/logo.svg" />

# Qomicex Minecraft 啟動器

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
  
[官方網站](https://www.qomicex.top)
[立即下載](https://github.com/Qomicex-Public/Qomicex.Tauri/releases/latest)

</div>

</div>

[Qomicex Minecraft 啟動器](https://github.com/Qomicex-Public/Qomicex.Tauri)（簡稱 QML）目前處於測試階段，歡迎試用。

> 啟動器後端已用 Rust（axum）完整重寫，核心庫與下載器也已遷移為 Rust 子模組（`qomicex-core-rust` / `qomicex-connector-rust` / `qomicex-downloader-rust`），不再依賴 .NET SDK。

## ✨ 功能特性

> 桌面版（Tauri v2）目前能力，核心邏輯全部由 Rust 實現。

Qomicex Launcher（簡稱 QML）的目標，是讓「啟動、安裝、管理實例」這些日常操作足夠簡單直接——無論你是日常遊玩、裝整合包，還是和朋友聯機。

### 🚀 遊戲啟動

支援啟動原版 Minecraft，也支援大多數 Mod Loader 的**一鍵自動安裝**：

- Vanilla
- Forge
- Fabric
- NeoForge
- Quilt
- Babric
- LegacyFabric
- Cleanroom

啟動器會讀取實例設定，自動組裝遊戲所需的 libraries、assets、natives、JVM 參數和遊戲參數，啟動後記錄完整啟動日誌，方便排查崩潰或 Mod 衝突。

### 🔐 帳號登入

支援多種登入方式：

- **Microsoft 正版**（OAuth 裝置碼登入）：一個一次性裝置碼即可授權，登入資訊本地儲存，下次直接使用
- **離線玩家名**：適合本地測試、單機遊玩或不需要正版驗證的環境
- **Yggdrasil 皮膚站**：內建 LittleSkin、Blessing Skin 等常見皮膚站預設，也可快速匯入其他伺服器

皮膚站支援**拖入連結一鍵匯入**：Yggdrasil 伺服器地址會自動解析（authlib-injector 規範），省去手動填寫的麻煩。

### 🌐 內建聯機

QML 內建 **Scaffolding 協議聯機**，無需公網 IP 即可與好友組網聯機：

- 建房 / 加入房間、NAT 類型偵測（STUN 多連接埠降級）、中繼組網
- 踢出升級為 **deny 持久物理封禁**：被踢的玩家即使重連、重啟也無法再進入房間
- 誤踢可救：重連審核彈窗（允許 / 拒絕 / 拒絕且不再提示），房主黑名單可一鍵解除封禁
- 主機 Mod 校驗：缺失標記、與主機不一致時強制同步
- 支援與 HMCL、PCL-CE、PCL.Mac 等實作了 SCF 協議的啟動器互通聯機

### 📦 實例管理

每個遊戲版本或整合包都會作為一個**獨立實例**儲存，目錄按版本隔離，互不干擾：

- 一鍵安裝版本與 Forge / Fabric / NeoForge / Quilt 等載入器
- 每個實例單獨管理 Mod、存檔、材質包、光影包、設定檔、Java 與記憶體、JVM 參數
- 實例自訂分組，讓大量版本井井有條

### 📐 原理圖管理 · Deepslate 3D 預覽

實例詳情頁內建 **Litematica 原理圖**管理與預覽：

- 列表 / 搜尋 / 開啟資料夾 / 本機匯入（multipart，副檔名白名單）/ 重新命名 / 單個刪除 + 批次刪除
- **Deepslate WebGL 3D 預覽**：檢視完整原理圖內容 + 材質面板 + Y 層滑桿 + 多 region + 方塊/材料統計清單
- 材質從原理圖調色板子集、按需從使用者遊戲 jar 執行時提取並本地快取，**不綁定 Mojang 素材**（版權合規）
- schematics 目錄納入版本隔離，隨實例獨立儲存

### 🗂️ 資源中心

聚合 **Modrinth / CurseForge / FTB** 三大資料源，一站式瀏覽資源：

- 支援模組、整合包、光影、材質包、資料包、存檔分類檢索
- MC 百科中文名補全，瀏覽更友善
- 線上搜尋並安裝 Mod、材質包、光影包
- 資源詳情一站式檢視

### ⬇️ 下載中心

統一下載器負責遊戲檔案、依賴庫、資源檔案、載入器安裝器、整合包與線上 Mod 下載：

- 自研高速下載引擎，多檔案非同步下載、單任務進度即時顯示
- 斷點續傳、暫停 / 恢復 / 取消
- 慢速或失敗時自動換源、當前源冷卻，避免持續請求已限流的源

實例安裝、模組下載、Java 執行時等所有下載任務都集中到下載中心統一管理，隨時檢視進度與失敗原因。

### 📥 整合包匯入 / 匯出

- **匯入**：本機 `zip` / Modrinth `.mrpack` 上傳解析並一鍵安裝，自動識別版本、載入器、Mod、設定與資源目錄；安裝中斷或失敗會自動清理半成品，不留殘留
- **匯出**：可匯出為 CurseForge `zip`、Modrinth `mrpack` 或 Qomicex 專屬 `.qmodpack`，雜湊反查自動產生檔案清單
- HMCL 風格**逐檔案勾選**匯出：自訂包名 / 版本 / 作者，非同步任務帶進度、可取消、可自訂儲存路徑

### 🧩 Mod 管理

每個實例都有獨立的管理頁面：

- 檢視已安裝 Mod、啟用 / 停用、刪除
- 開啟實例目錄，以及 mods、saves、resourcepacks、shaderpacks、config 等常用資料夾
- 線上搜尋並安裝 Mod、下載材質包與光影包
- **模組更新檢查**：Modrinth / CurseForge 批次雜湊比對，變更清單交給下載中心排程更新

停用 Mod 時保留檔案、只改啟用狀態，方便排查衝突。

### 📎 模組前置自動安裝

安裝 Mod 時，QML 會自動解析其所在的 Modrinth / CurseForge 資料源的**依賴清單**：

- 識別並展示**必需前置（required dependencies）**，支援遞迴解析深層依賴
- 一鍵連同前置一起安裝到目標實例，避免「缺前置開不了服、報紅名錯誤」的困擾
- 可選跳過非必需依賴，按需選擇安裝範圍

### ☕ Java 執行時管理

不同版本需要不同 Java，QML 根據實例版本自動選擇：

- 自動掃描本機已安裝的 Java
- 缺失的 Java 8 / 17 / 21 線上下載
- 手動指定 Java 路徑、按實例單獨設定
- 啟動時檢查 Java 是否符合當前遊戲版本

### 💾 存檔與遊戲設定編輯

- **存檔設定編輯器（level.dat NBT）**：遊戲模式、難度、天氣、出生點、世界邊界、遊戲規則等視覺化編輯，支援從 `level.dat_old` 恢復
- **遊戲設定**：`options.txt` 視覺化編輯，帶多語言描述，陣列值（resourcePacks / datapacks 等）以 chips 形式增刪

### 🩺 日誌分析與崩潰排查

遊戲崩潰後可讀取啟動日誌分析：

- **本地規則分析**：內建 44 種錯誤模式庫，按 Critical > Error > Warning > Info 排序，無需額外設定
- **AI 分析**（外掛提供）：填寫相容 OpenAI 格式的 API 地址、Key 與模型名稱後呼叫

### 🧩 外掛系統

QML 提供可擴充的外掛生態：

- 清單貢獻點、內聯渲染 / iframe 浮層、外掛間方法呼叫
- **L3 WASM 外掛閘道**（wasmtime 沙箱，Rust 編寫），外掛以 WebAssembly 形式在受限沙箱內安全執行
- 外掛包（`.qplugin`）上傳安裝，狀態本地持久化

### 🎨 個人化與多語言

- **I18N 國際化**：中 / 英 / 繁 / 日 / 俄等 **7 種語言**，支援「跟隨系統」，執行時即時切換
- 自訂 UI 字體（列舉系統字體、即時預覽）
- 內建 / 自訂背景、主題色等介面個人化選項

## 🔗 依賴與相關專案

QML 的核心能力由以下 **Rust 子模組**承載（倉庫根 git submodule，`git submodule update --recursive` 拉取）：

- [qomicex-core-rust](https://github.com/Qomicex-Public/qomicex-core-rust) — 核心庫（GameCore 遊戲核心、實例 / 帳號 / Java / 下載等業務邏輯）
- [qomicex-downloader-rust](https://github.com/Qomicex-Public/qomicex-downloader-rust) — 統一高速下載器
- [qomicex-connector-rust](https://github.com/Qomicex-Public/qomicex-connector-rust) — 聯機 / SCF 協議庫（依賴 EasyTier4QML 分支）
- [Qomicex.Tauri.i18n](https://github.com/Qomicex-Public/Qomicex.Tauri.i18n) — 前端多語言資源倉庫

**合作 / 相關社群專案**：

- [EuoraCraft-Launcher（ECLteam）](https://github.com/ECLteam/EuoraCraft-Launcher) — ECLteam 維護的 Python + Tauri 第三方 Minecraft 啟動器，與 QML**共用聯機節點**，並**相容 SCF 拓展協議**實現互通聯機

## 🔗 相關連結

| 連結 | 網址 |
|:--|:--|
| 官方網站 | <https://www.qomicex.top> |
| 專案倉庫 | <https://github.com/Qomicex-Public/Qomicex.Tauri> |
| 發佈下載 | <https://github.com/Qomicex-Public/Qomicex.Tauri/releases> |
| 問題回報 | <https://github.com/Qomicex-Public/Qomicex.Tauri/issues> |
| 多語言倉庫 | <https://github.com/Qomicex-Public/Qomicex.Tauri.i18n> |
| 測試回饋群 | [623362446](https://qm.qq.com/q/rKiwzrkg8w) |

## 🎯 適用場景

QML 適合這些使用場景：

- 日常啟動 Minecraft，管理多個版本與整合包
- 與好友聯機（無需公網 IP，內建組網）
- 拖入整合包快速安裝 / 一鍵匯出分享
- 管理 Mod、材質包、光影包與存檔
- 給不同實例分別配置 Java 與記憶體
- 排查啟動失敗和崩潰日誌
- 使用帶個人化介面與多語言支援的輕量啟動器

## ℹ️ 讀音小提示

Qomicex
/kˈɑːmaɪsˌɛks/
≈ q·om·ic·ex

## 🖥️ 支援平台

> 以下表格列出目前支援的平台、最低版本要求和測試狀態。

| 平台 | 支援架構 | 最低系統版本 | 測試狀態 | 安裝包/方式 |
|:---|:---|:---|:---|:---|
| **Windows** | `x64`, `ARM64` | Windows 10 1809+ | ✅ 穩定 | `.exe`（NSIS 安裝器）|
| **macOS** | `x64`（Intel）, `ARM64`（Apple Silicon） | macOS 10.15+ | ✅ 穩定 | `.dmg` / `.app` |
| **Linux** | `x64`, `ARM64`, `LoongArch64`（理論可用）, `RISC-V 64`（實驗性） | Ubuntu 20.04+ / Fedora 34+ / glibc 2.28+ | ✅ 穩定 | `.deb` / `.rpm` / AppImage |

![Windows](https://img.shields.io/badge/Windows-10%2B-blue?logo=windows)
![macOS](https://img.shields.io/badge/macOS-10.15%2B-black?logo=apple)
![Linux](https://img.shields.io/badge/Linux-Ubuntu%2020.04%2B-yellow?logo=linux)

## 🔧 開發、除錯與建構

> 技術棧：**Rust**（axum 後端 + Tauri v2）+ **React 19 / Vite / TypeScript**（前端）+ **pnpm**（workspace 依賴 `@qomicex/plugin-ui`）。核心庫與多語言資源以 git submodule 引入。

### 環境要求

- Rust 工具鏈（stable）+ `cargo`；推薦 `rust-analyzer`（編輯器補全）與 `codelldb`（除錯，可參考 `.vscode/launch.json`）
- Node.js + pnpm（workspace 管理）
- Windows 聯機構建需要 npcap（`Packet.dll`）等執行時依賴，具體前置見 `AGENTS.md` 與 CI `setup-connector-build`

### 初始化（全新檢出）

```bash
git submodule update --recursive
pnpm install --frozen-lockfile
pnpm --filter @qomicex/plugin-ui build   # 組件庫 dist/ 為 gitignored，前端依賴此產物
```

### 後端開發（Rust API）

```bash
cargo run --manifest-path src-backend/qomicex-backend/Cargo.toml
```

預設監聽 `127.0.0.1:5000`，可用 `QOMICEX_PORT` 環境變數覆蓋連接埠；開發期可用 VS Code `codelldb` 附加除錯。

### 前端開發（Vite）

```bash
pnpm run dev        # http://localhost:1420，/api 代理到 :5000
```

### 桌面開發（Tauri，整合視窗與後端程序）

```bash
pnpm run tauri dev
```

### 測試

```bash
cargo test --manifest-path src-backend/qomicex-backend/Cargo.toml   # 後端單元測試
cd src-tauri && cargo test --lib plugin_gateway                      # Tauri WASM 外掛閘道測試
pnpm exec tsc --noEmit                                                # 前端 + i18n 型別檢查
bash scripts/test-api-filters.sh    # 或 .ps1，針對 :5000 的行為驗證
```

### 建構與格式

```bash
pnpm run build    # 先 tsc 再 vite build，型別錯誤會中斷建構
cargo fmt         # 修改 Rust 程式碼後必跑，CI 會校驗格式
```

> 修改 `packages/plugin-ui/src/` 後需重建元件庫；修改 i18n 需在 `qomicex-tauri-i18n` 子模組單獨提交推送。

---

## ⭐ Star 趨勢

<a href="https://www.star-history.com/?repos=Qomicex-Public%2FQomicex.Tauri&type=date&legend=bottom-right">
 <picture>
   <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/chart?repos=Qomicex-Public/Qomicex.Tauri&type=date&theme=dark&legend=bottom-right&sealed_token=3kRKTiCGJWMYcUcMNuRameNqf5F2KOLMXywaK7Sxym5ZUX3u2Jh3yAam-_le6HA2Jb2oLupvmK1VlTarzTSBkPWaKb7z5gnA7hkq0ZLXwEaAxPsH1o0GQg" />
   <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/chart?repos=Qomicex-Public/Qomicex.Tauri&type=date&legend=bottom-right&sealed_token=3kRKTiCGJWMYcUcMNuRameNqf5F2KOLMXywaK7Sxym5ZUX3u2Jh3yAam-_le6HA2Jb2oLupvmK1VlTarzTSBkPWaKb7z5gnA7hkq0ZLXwEaAxPsH1o0GQg" />
   <img alt="Star History Chart" src="https://api.star-history.com/chart?repos=Qomicex-Public/Qomicex.Tauri&type=date&legend=bottom-right&sealed_token=3kRKTiCGJWMYcUcMNuRameNqf5F2KOLMXywaK7Sxym5ZUX3u2Jh3yAam-_le6HA2Jb2oLupvmK1VlTarzTSBkPWaKb7z5gnA7hkq0ZLXwEaAxPsH1o0GQg" />
 </picture>
</a>

## 📄 授權條款

[GPLv3](LICENSE)

## ❤️ 貢獻者

[![](https://contrib.rocks/image?repo=Qomicex-Public/Qomicex.Tauri)](https://github.com/Qomicex-Public/Qomicex.Tauri/graphs/contributors)
