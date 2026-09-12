# 下载中心 UI 规范（下载进度卡片）

## 速度统计图（DownloadSpeedGraph）

- **显示条件**：仅按任务状态判断 —— `status === 'downloading' || status === 'paused'`。
- **不要**再用 stage 门控（旧逻辑按 `downloading-*` 前缀过滤）。整合包的 `modpack-files`、安装管线的各阶段同样在下载字节，按前缀过滤会让图在多个 step 间消失/重挂，而组件卸载会清空历史采样，视觉上表现为「图只在个别 step 出现」。
- 组件每 500ms 采样一次 `speed`，约 20s 窗口；卸载即清空，因此必须避免不必要的挂载/卸载。

## 左下角详细信息行

- 文案优先级：`completed` → `failed` → `paused` → `queued` → **有 steps 的管线任务（从 dominantStep 派生）** → 字节进度回退 → `connecting`。
- **并行管线的闪烁根因**：后端并行三支路共用同一个 `ProgressField`，各自的 `set_stage` / `current_file` / `speed` 每 ~300ms 互相覆写。前端直接渲染 `task.stage` / `task.currentFile` 就会在多个分支文案间乱跳。
- **修复方式**：管线任务（有 `steps`）时，用 `dominantStep(steps)` 取「权重最大的 active step」派生文案 `t('downloads.steps.{id}')`，确定性且不随并行分支抖动；不再显示易变的 `task.currentFile`。
- **百分比**：仅当该 active step 自身 `percent > 0` 时才显示数字（扫描/安装类步骤无字节进度则不显示），避免把合成总进度误读成该步完成度。

## 相关文件

- `src/pages/DownloadCenter.tsx`（`dominantStep`、`showSpeedGraph`）
- `src/components/DownloadSpeedGraph.tsx`
- `src/components/InstallStepsList.tsx`
