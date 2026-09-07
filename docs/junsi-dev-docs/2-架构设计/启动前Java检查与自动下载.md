# 启动流程

> 生成时间：2026-09-07 19:07

# 启动前 Java 检查与自动下载

## 概述

启动实例时前端自动预检 Java 环境：本地无满足版本要求的运行时则自动下载所需版本，下载完成后再继续启动。覆盖所有启动入口（实例列表、实例详情、主页仪表盘、联机快捷启动）。

## 流程

```
launchInstance (RunningContext)
  ├─ launchProgress = { stage: 'java' }          ← LaunchProgressDialog 新增首个步骤行
  ├─ info 不全时 getInstance(id) 兜底补全
  ├─ ensureJavaForLaunch
  │    ├─ 用户指定了 Java？ → 跳过（保留既有"版本不匹配确认弹窗"）
  │    ├─ GET /api/java/requirement?gameDir&version   （含 Cleanroom/Babric 加成）
  │    ├─ GET /api/java/search?mode=quick（已合并下载目录+自定义注册）
  │    ├─ 存在 state=Valid 且 majorVersion ≥ required → 通过
  │    └─ 无 → 自动下载：
  │         GET /api/java/download/catalog → 选含该版本的 vendor（temurin 优先）
  │         POST /api/java/download/start {vendor, version, platform, arch}
  │         轮询 GET /api/java/download/progress/{taskId}（800ms）
  │           ├─ 启动被取消（seq 失配）→ DELETE /api/java/download/{taskId}，中止启动
  │           ├─ completed → 复扫确认 → 继续
  │           └─ failed/cancelled → toast 警告，仍继续启动（后端最终裁决）
  ├─ launchProgress = { stage: 'starting' }      ← 回到既有管线
  └─ POST /api/instance/{id}/launch
```

## UI（LaunchProgressDialog）

- `STEP_STAGES` 头部新增 `{ id: 'java', stages: ['java'] }`，标签 `dialogs.launchProgress.stage.java`
- java 步骤行内显示原始下载百分比；总进度条映射到前 10%（`progress = 下载% / 10`，上限 9.9），避免下载完成后进度回跳
- 下载中途点"取消"联动取消下载任务（`launchSeqRef` 序号机制）

## 后端配套

- `endpoints/instance.rs` `resolve_java_path`：候选列表从 `scan_quick`（仅 Quick 扫描）改为 `merged_java_runtimes`（Quick + 下载目录 + 自定义注册）——修复"向导下载的 Java 启动链路看不到"的既有缺陷
- `endpoints/java.rs` `/api/java/requirement`：应用 `apply_loader_java_requirement`（Cleanroom ≥0.5 → Java 25，Babric → Java 17），与启动链路解析口径一致；`minecraft_to_java_version` 对 MC 26.x 返回 25
- `scan_quick` 因无调用方已删除

## 决策记录

- 下载失败不中止启动：后端 recommand 可选替代运行时，或以标准错误弹窗收场
- 仅自动模式（实例未指定 Java）触发下载；用户指定 Java 只做版本不匹配确认
- Connect 快捷启动未单独改代码：由 launchInstance 内 `getInstance` 兜底统一覆盖

## 已知限制

- 前端判定条件为 `majorVersion ≥ required`，后端 `recommand` 若要求精确匹配（如需要 21 而只有 25）仍可能启动失败并弹标准错误
- 下载中导航离开页面不会中断下载任务本身（后台继续，完成后注册进自定义列表）


## 修订记录
| 日期 | 版本 | 修改内容 | 修改人 |
| 2026-09-07 | v1.0 | 初版创建 | AI Agent |