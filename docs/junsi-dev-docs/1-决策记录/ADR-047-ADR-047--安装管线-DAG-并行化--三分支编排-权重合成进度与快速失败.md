# ADR-047：ADR-047: 安装管线 DAG 并行化——三分支编排、权重合成进度与快速失败

| 属性 | 内容 |
|---|---|
| 状态 | 已采纳 |
| 日期 | 2026-08-23 |
| 决策者 | AI Agent |

## 背景

安装管线原为纯串行：实例安装 fetching-json→installer→base→loader-libs→addons→install-loader→verify 逐阶段阻塞，总耗时=各网络阶段之和。读码确认：resolve_addons 仅依赖请求参数可提前；DownloadManager 有全局信号量自动排队限流（manager.rs）；forge 系 loader-libs 扫描依赖 installer_path 必须链式，而 Fabric/Quilt 类无此依赖；CF 整合包逐条反查链接刻意串行防限流须保留；overrides 与 mods 写同一目录树且存在"overrides 覆盖优先"语义（Modrinth/CurseForge overrides 可含 mods/*.jar）。上一任务已落地后端结构化 steps[]（InstallStep{id,status,percent}）。

## 决策

DAG 分支并行 + 权重合成进度：①实例管线 fetching-json 串行 → tokio::join! 三分支［installer→loader-libs 链式(forge系)／base(含 vanilla JSON 写盘)／addons 解析+下载］→ 串行尾 optifine-standalone→installing-loader→verify-jar→finishing；②整合包外层 包体下载→manifest解析 串行 → 三路全并行［游戏本体管线(step_budget=40 嵌套追加子步骤)／mods 下载(CF 反查串行段保留)／overrides 解压］；③InstallStep 增加 weight，define_steps 改 append+budget 因子缩放（budget/100），新增 mark_step/set_step_percent 取代线性 begin_step（支持多步骤同时 active），合成总进度 progress = Σ(w_i×pct_i)/Σw 由 tracker 在每次更新后统一重算；④快速失败：任一分支 Err → handle.request_cancel()，其余分支在 download_batch 既有轮询点自行退出并返回"安装已取消"，错误聚合取首个非取消类错误，手动取消路径经 check_cancel 保留。用户知情接受的权衡：overrides 对 mods 的同名覆盖优先不再保证（三路全并行）；speed/currentFile/totalFiles 在多活跃批次间为 last-writer-wins 抖动显示（v1 已知限制）。

## 备选方案

### 方案 仅并行纯下载批
- 优点：改动小 ~150 行
- 缺点：进度抖动、收益打折
- 为何不选：未说明

### 方案 通用 DAG 任务图调度器
- 优点：可扩展任意依赖图
- 缺点：为两条固定管线引入通用抽象属过度设计
- 为何不选：未说明

### 方案 保守：overrides 保持覆盖序
- 优点：无文件写竞争风险
- 缺点：用户明确选择激进三路全并行
- 为何不选：未说明

## 影响
- install_service.rs run_install_pipeline 编排重构（签名 +step_budget 参数）
- modpack.rs run_modpack_pipeline 外层三路并行编排
- install_tracker.rs 步骤原语改造（define_steps/mark_step/set_step_percent/recompute_progress/request_cancel；删 begin_step/set_active_step_percent）
- download_batch 签名改为 step_id 定向驱动（start_pct/end_pct 区间插值废弃）
- SSE InstallProgress.steps 增加 weight 字段（camelCase，向后兼容）

## 修订记录
| 日期 | 版本 | 修改内容 | 修改人 |
|---|---|---|---|
| 2026-08-23 | v1.0 | 初版创建 | AI Agent |