# ADR-088：补齐 mod 换版本/安装端点并接通可配置的全局请求超时（issue #117 + #133）

| 属性 | 内容 |
|---|---|
| 状态 | 已采纳 |
| 日期 | 2026-10-01 |
| 决策者 | AI Agent |

## 背景

issue #117（mod 更换版本"立即完成"但未生效、无进度无下载记录，报告版本 0.1.0-beta32.0）与 issue #133（"下载时 15s 未完成前端就报请求超时"）经远程预检（origin/main fa68705）确认均未修复。

诊断阶段用独立后端探针实例（独立端口 + 独立 QOMICEX_HOME）实测，以响应体区分路由层与处理器层 404：

| 请求 | 状态 | body code | 含义 |
|---|---|---|---|
| /instance/{id}/files/mods/metadata（路由表存在） | 404 | INSTANCE_NOT_FOUND | 处理器层，路由在 |
| /instance/{id}/files/mods/change-version | 404 | NOT_FOUND / "route was not found" | 路由层，路由不存在 |

结论：Rust 后端重写时漏移植 C# 的 ChangeModVersion 与 InstallMod。#117 表现为"立即完成"是三链路叠加：changeModVersion() 对非 2xx 抛 ApiError → VersionPickerDialog 的 catch 只 console.error 不提示 → onDone/onClose 在 try 内 await 之后，抛错时被跳过（弹窗不关、列表不刷新），用户判定"已完成但没生效"；镜像内根本没有 newFileName，旧文件还在原位。

#133 澄清与实测：用户所指 15s 是**前端请求后端的客户端超时**（client.ts REQUEST_TIMEOUT_MS），不是下载器超时。该常量由 c5f2f58「请求超时兜底」硬编码引入；设置项 downloadTimeout 自 5386316 init 起只被塞进 POST /instance/{id}/install 请求体，而接收端 InstallerRequest（instance.rs）**无该字段**，被 serde 静默丢弃；后端 settings.rs 的 download_timeout 亦**零消费**（全仓仅定义与默认值两处引用）。二者同值(15)但不同源，故用户改设置完全无效。

排查期间另发现（超出两个 issue 范围，未在本次修复，另行报告）：/instance/{id}/verify-resources、/repair-resources、/repair 同样为路由层 404，而前端在调用它们（InstanceDetail.tsx:3116、Instances.tsx:1092、3145）。

## 决策

1) #117 修根因，不接受"只把 catch 加提示"的症状级修法：后端补齐 POST /instance/{id}/files/mods/change-version 与 /files/mods/install（与 C# API 对齐），并修正 C# 原版的两处缺陷——改为 reqwest `chunk()` 流式落盘（原版 `bytes()` 会把数百 MB 整包读进内存）+ `.part` 临时文件后原子 rename（进程中断不会把半截文件留给 mods 扫描）+ 文件名必须为纯文件名（拒绝 `../` 穿越，原版未校验）。

2) 换版本语义采用「先下载成功、再替换旧文件」，而非原版 C# 与 quickInstall 的「先删旧、再下载」：后者在下载失败时直接损失用户原 mod。前端改走已有的 quickInstallViaDownloadCenter（其 toDelete 参数注释本就写着"版本切换替换"），并把 quickInstall.ts 的删除时机从「启动前」改为「aggregate 全部成功后」；同名（原地重下同一版本）时跳过删除，避免删掉刚下好的新文件。不选 updateModsViaDownloadCenter：其 deleteMod 取 u.fileName（旧文件名），换版本会删错文件。

3) #133 采用方案A：把 downloadTimeout 真正接通为前端全局默认请求超时（client.ts `setDefaultRequestTimeout`，0 = 不设总超时），并给长耗时请求逐项放宽（repairInstance/verifyResources/repairResources 30min；getResourceVersions/getResourceDependencies 90s）。默认值 15 → 60（前后端同步）。

4) 迁移策略：download_timeout 在旧版本从未生效，磁盘上的 15 不是用户有效选择，故首次读到 15 时提升为新默认值；用显式一次性标记 download_timeout_migrated 而非「值==15 就改」，否则用户日后主动选 15 会被每次启动改回。全新安装直接置标记为 true。同时补 clamp（0-120），因为 settings.json 可手改、本地 API 也接受插件直调。

5) 顺带修复 Settings.tsx `parseInt(v) || 15`：`0 || 15` 会吃掉 0，使文档承诺的「0=不超时」永远输不进去。

6) 后端已有的死字段 download_timeout 本次**转为真实使用**（不再是死字段），故不删除。

## 备选方案

### 方案 只给 VersionPickerDialog 的 catch 加错误提示（症状级）
- 优点：改动最小，1 行
- 缺点：用户仍无法换版本，只是从静默失败变成提示失败；issue 的核心诉求（能换 + 真实进度 + 下载记录）完全未满足
- 为何不选：拒绝：改根因不改症状

### 方案 前端保持同步等待，仅给 changeModVersion 放宽超时（如 90s）
- 优点：不新增下载中心任务，改动比走下载中心小
- 缺点：仍无真实进度条与下载记录（不满足 #117 明确诉求）；大文件下请求悬挂 90s 且无法取消
- 为何不选：不选：与用户确认的方案不一致

### 方案 换版本也复用 updateModsViaDownloadCenter
- 优点：看似复用现成路径
- 缺点：其 deleteMod(instanceId, u.fileName) 取的是旧文件名，换版本场景语义错误，会删掉旧文件而新文件命名不同导致误删
- 为何不选：不选：语义不匹配，是删错文件的隐患

### 方案 #133 默认设为 0（完全不限时）
- 优点：严格贴合 issue 原话「无限或较高」
- 缺点：底层仅剩下载器 30s 停滞看门狗兜底；慢源上可能长时间无进展而不失败，且 UI 仍有 0 可选项可自行选择
- 为何不选：不选：默认 60 更稳，同时保留 0=不限 的能力

### 方案 迁移用「值 == 15 就改为 60」
- 优点：无需新增字段
- 缺点：用户日后主动选择 15 会被每次启动反复改回，属于绕过用户意图
- 为何不选：不选：改用一次性标记

## 影响
- src-backend/qomicex-backend/src/endpoints/instance_files.rs — 新增 InstallModRequest/ChangeModVersionRequest DTO、download_mod_to_file、change_mod_version、install_mod 及两条路由
- src-backend/qomicex-backend/src/endpoints/resource_download.rs — is_cf_url 改为 pub(crate)，供 instance_files 复用，避免两处域名列表漂移
- src-backend/qomicex-backend/src/settings.rs — 默认值 15→60、新增 DOWNLOAD_TIMEOUT_RANGE 与 clamp、新增 download_timeout_migrated 一次性迁移标记
- src/api/client.ts — REQUEST_TIMEOUT_MS 常量改为可配置（FALLBACK_REQUEST_TIMEOUT_MS + setDefaultRequestTimeout/getDefaultRequestTimeout）
- src/api/settings.ts — 新增 applyDownloadTimeoutSetting，在 loadSettings/saveSettings 唯一咽喉点接通；DEFAULT_SETTINGS.downloadTimeout 15→60
- src/api/instance.ts / src/api/resource.ts — repair 系 30min、资源版本与依赖 90s 长超时
- src/components/VersionPickerDialog.tsx — 改走下载中心 + 失败可见 + 无可用文件提示
- src/lib/quickInstall.ts — 删除时机改为全部成功后，同名跳过；新增 newFileNames 守卫
- src/pages/Settings.tsx — 修复 parseInt||15 导致 0 无法输入
- qomicex-tauri-i18n/ — 8 个 locale 新增 versionPicker.{taskName,addedToDownloadCenter,noDownloadableFile,switchFailed}

## 修订记录
| 日期 | 版本 | 修改内容 | 修改人 |
|---|---|---|---|
| 2026-10-01 | v1.0 | 初版创建 | AI Agent |