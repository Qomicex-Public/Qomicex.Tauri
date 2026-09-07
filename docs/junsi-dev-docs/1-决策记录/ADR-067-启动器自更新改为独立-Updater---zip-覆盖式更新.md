# ADR-067：启动器自更新改为独立 Updater + zip 覆盖式更新

| 属性 | 内容 |
|---|---|
| 状态 | 已采纳 |
| 日期 | 2026-09-07 |
| 决策者 | AI Agent |

## 背景

启动器当前用 tauri-plugin-updater 插件更新：插件内置下载器（不可控、不走下载中心），Windows NSIS 默认向导需手动点安装，Linux AppImage 走未压缩产物无法被插件替换，DEB/RPM/DMG 安装形态完全无更新链路。用户要求：点「立即更新」后更新包作为下载中心任务高速多线程下载，下载完由独立 updater 全自动完成安装+重启。打包形态含 Windows x64/ARM64 EXE(NSIS)、Linux x64/ARM64 AppImage/DEB/RPM、macOS x64/ARM64 DMG，共 8 个 target 组合。

## 决策

采用「独立 Updater + 文件布局 zip 覆盖」架构：\n1. 新仓库 Qomicex.Updater（Rust 无 GUI CLI）：minisign 校验（公钥内嵌，复用现有 TAURI_SIGNING_PRIVATE_KEY）→ 按 strategy 覆盖 → 拉起新版启动器。策略四种：dir(Windows 解压覆盖安装目录)、appimage(替换单文件+chmod)、app(macOS 覆盖 .app，osascript 提权)、system(DEB/RPM 解压覆盖 /，pkexec 提权)。staging 目录解压→逐文件 move，等 --wait-pid 进程退出后动手。\n2. CI 生成平台更新包：Windows 用 NSIS /S /D 静默安装到收集目录再 zip；AppImage zip 内放本体；DEB/RPM 用 dpkg-deb -x / rpm2cpio 解包 zip；macOS zip .app 内容；合并产出自定义格式 updates.json（含 strategy 字段）并保留 Tauri 格式 latest.json 供存量旧版兼容。\n3. 启动器侧：后端新增 /api/update/plan 端点（version/check 判新 + 拉 updates.json 选 {os}-{arch}[-mode] 条目）；前端点「立即更新」→ 更新包注册为下载中心任务（DownloadSessionManager 多线程）→ 完成后自动经 Tauri command run_updater 释放内嵌 updater 到 temp 并退出启动器；彻底移除 tauri-plugin-updater（Rust/JS/配置）；updater 二进制经 include_bytes! 嵌入（同 backend.exe 机制）。\n4. 忙时策略：实例运行/下载中直接弹窗手点；required 强制更新保留弹窗不可关语义。

## 备选方案

### 方案 继续用 tauri-plugin-updater + 修 installMode/CI
- 优点：改动最小，签名/manifest 格式现成
- 缺点：下载器不可控（无多线程/不可暂停）、installMode 只能到 passive 进度条、Linux AppImage 替换链路在 CI 中断裂（未压缩 AppImage 无 tar.gz）、无法接管 deb/rpm/macOS 安装形态
- 为何不选：用户明确要求下载走下载中心高速下载且安装全自动；插件链路无法满足

### 方案 updater 内跑 NSIS /S 或 dpkg/rpm 安装器
- 优点：安装逻辑交给官方包管理器
- 缺点：updater 需理解各发行版包管理器/依赖，风险高
- 为何不选：zip 覆盖对全平台统一，CI 只需收集安装后文件布局，逻辑最简单

## 影响
- src-tauri/Cargo.toml + lib.rs + capabilities（移除 updater 插件，新增 run_updater command 与 updater 嵌入）
- src-tauri/tauri.conf.json（删 plugins.updater）
- src-backend/qomicex-backend/src/endpoints/update.rs（新增 /api/update/plan）
- src/App.tsx + src/pages/Settings.tsx + src/components/UpdateDialog.tsx（检查/更新流程改造，移除 @tauri-apps/plugin-updater）
- .github/workflows/release.yml + debug.yml（各平台更新包产出 + updates.json 合并）
- 新仓库 Qomicex.Updater（updater 实现）

## 修订记录
| 日期 | 版本 | 修改内容 | 修改人 |
|---|---|---|---|
| 2026-09-07 | v1.0 | 初版创建 | AI Agent |