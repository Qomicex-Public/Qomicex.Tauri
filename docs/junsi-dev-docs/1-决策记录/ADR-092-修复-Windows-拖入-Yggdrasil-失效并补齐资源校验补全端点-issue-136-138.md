# ADR-092：修复 Windows 拖入 Yggdrasil 卡片失效（Rust 侧解析 .url）+ 补齐资源校验/补全三端点（issue #136 + #138）

| 属性 | 内容 |
|---|---|
| 状态 | 已采纳 |
| 日期 | 2026-10-01 |
| 决策者 | AI Agent |

## 背景

两个独立缺陷，均在 origin/main（911b145）复核未修（Gate 0）。

#136：LittleSkin 快速拖入卡片无效（v0.1.1-beta1 / Win11）。根因：Tauri 在 Windows 上替换了 WebView2 的拖放处理器，DOM 的 HTML5 dragover/drop 不再派发，onYggDrop 永不触发。证据两条：(1) 本机 tauri 2.11.3 实际依赖 tauri-utils 2.9.3 的 config.rs 对 drag_drop_enabled 的文档原文「Disabling it is required to use HTML5 drag and drop on the frontend on Windows」，而 tauri.conf.json 从未设置该项（默认 true），引入该功能的 95f6f1a 也没动过配置 —— 即该功能在 Windows 上从未生效过（非回归）；(2) Playwright + 项目文档的 Tauri mock 注入实测：向 Accounts.tsx 的真实 drop zone 派发 drop 事件，前端 handler 完全正常（defaultPrevented、确认框弹出、地址被填入），证明前端逻辑无 bug，故障纯在 Tauri/WebView2 层。

约束：不能简单关 dragDropEnabled —— lib.rs 正是靠该接管发 file-drop 事件，GlobalDropInstaller / ImportDialog / PluginEventBridge 都依赖它，关掉会破坏「拖入文件一键安装」；且 Tauri 的 DragDropEvent::Drop 只带 paths、不带文本。

#138：verify-resources / repair-resources / repair 三个端点前端在调用（api/instance.ts:145/150/155）而后端路由表（instance.rs）根本没有，实测均为路由层 404（code=NOT_FOUND，区别于处理器层 INSTANCE_NOT_FOUND）。「检查资源完整性」因 InstanceDetail 的 catch 误报绿色「资源完整」，用户会误以为文件没问题；「补全文件」则永远停在排队无进度。

## 决策

#136 采用「保留 Tauri 接管 + Rust 侧解析 .url」：从浏览器把链接拖进原生窗口时 Windows 会落成一个 .url InternetShortcut 文件，Rust 在 DragDropEvent::Drop 分支读它取出 authlib-injector:yggdrasil-server: URI，经新事件 ygg-server-drop 交前端；前端把解析+确认+填入抽成共用 handler，DOM 路径（非 Windows 仍有效）与事件路径共用。**只接管「单文件 + 内容以该前缀开头」**，普通链接/.jar/多文件一律返回 None 走原 file-drop，避免吞掉拖入安装。

#138 采用「补齐三端点 + 修 catch 误报」：复用启动前完整性检查的同一套能力（build_repair_core + locator().get_miss_files_from_json），verify-resources 只读返回 {complete,totalCount,missingFiles}；repair-resources 与 repair 注册进 InstallTracker（用既有的 start_resource_completion，kind=resource）后台跑 download_batch，复用其同 dest 合并/镜像备选/暂停取消/看门狗，进度经 /install/progress 与 SSE 的 installs 一并暴露；缺 0 个文件时直接返回 completed，不留空任务。前端 handleVerifyResources 的 catch 改为如实报错（新增 verifyFailed），handleRepairResources 的 catch 也不再静默（新增 repairFailed）。

顺带修复：合并 origin/main 时漏掉的 change_mod_version 错误传播（#140 之后 delete_mod_file 返回 Result，原样忽略会导致「新版本已落盘、旧版本仍在」却报成功；已改为传播并映射 409 MOD_FILE_IN_USE）。

## 备选方案

### 方案 #136：设 dragDropEnabled: false，让 DOM 的 HTML5 拖放恢复
- 优点：Yggdrasil 拖拽在 Windows 上直接可用
- 缺点：DOM 拿不到真实文件路径（这正是 Tauri 要接管的原因），「拖入文件一键安装」会彻底失效；改动面大、回归广
- 为何不选：不选：会破坏拖入文件一键安装

### 方案 #136：改成“粘贴链接”或要求用户手动输入
- 优点：不依赖拖放，100% 可控
- 缺点：改动最大，需要 rehype 依赖，且在 Windows 上拿不到路径的核心问题依然存在
- 为何不选：不选：不满足 issue 字面诉求（对话框已有预设按钮+输入框作为兼底）

### 方案 #138：只修 catch 不再假绿，不补端点
- 优点：改动最小
- 缺点：用户仍需手动一步，不如拖放顺滑
- 为何不选：不选：补全功能仍然不可用

## 影响
- src-tauri/src/lib.rs — 新增 read_dropped_link_text / parse_internet_shortcut_url，Drop 分支优先当链接文本处理；3 个单元测试
- src/pages/Accounts.tsx — 抽 applyYggDroppedUri 共用 handler，监听 ygg-server-drop
- src-backend/qomicex-backend/src/endpoints/instance.rs — 新增 3 条路由 + scan_missing_files / verify_resources / repair_resources / repair_instance / spawn_repair_task
- src-backend/qomicex-backend/src/endpoints/instance_files.rs — change_mod_version 恢复删除错误传播
- src/pages/InstanceDetail.tsx — handleVerifyResources 不再假绿、handleRepairResources 不再静默
- qomicex-tauri-i18n — 7 语言新增 settingsTab.verifyFailed / repairFailed

## 修订记录
| 日期 | 版本 | 修改内容 | 修改人 |
|---|---|---|---|
| 2026-10-01 | v1.0 | 初版创建 | AI Agent |