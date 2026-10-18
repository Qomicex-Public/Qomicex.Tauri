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

## 按资源类型分组与折叠（issue #131）

- **分组顺序固定**：game → modpack → mod → resourcepack → shader → datapack → save → java → other。空分组不渲染。
- **分组在状态 Tabs 过滤之后**：顶部任务数与空状态沿用过滤后结果；「清除已完成」行为不变。
- **分类来源**：`DownloadTask.resourceKind`（可选）。缺失时按 `type` 回退，仍判不出的（`file`/`batch`/`resource` 及旧任务）归「其他」。
  **绝不允许把缺分类的任务默认归为 `mod`**——那会把光影/资源包误报成模组。
- **折叠必须用 `hidden` 做视觉隐藏，不能条件渲染**：卸载会清空 `DownloadSpeedGraph` 的采样历史（本规范第 1 节），并中断卡片上的 SSE 更新对账。
- **卡片组件必须在模块级定义**：定义在页面组件体内会因每轮渲染产生新组件身份，React 卸载重挂整棵子树 —— 等价于条件渲染，同样清空速度图历史。
- **折叠状态持久化**在独立 localStorage 键 `qomicex-download-groups-collapsed`（与任务数据 `qomicex-download-tasks` 隔离）。解析失败 / 非数组 / 含非法键一律回退为「全部展开」。
- **分组头**用原生 `button` + `aria-expanded` + `aria-controls` 指向内容容器 id；`ChevronDown` 配 `transition-transform`，折叠时 `-rotate-90`。
- **过渡动画**加 `.anim-transition` 类：`[data-anim-enabled="false"]` 与 `prefers-reduced-motion: reduce` 下 `transition: none`（Tailwind 的 `transition-*` 不读 `--anim-duration-multiplier`，必须在 `index.css` 兜住）。

## 相关文件

- `src/pages/DownloadCenter.tsx`（`dominantStep`、`showSpeedGraph`、`TaskCard`、`TaskGroupSection`）
- `src/lib/downloadGroups.ts`（`normalizeResourceKind`、`getTaskGroup`、`groupTasks`、折叠状态读写）
- `src/components/DownloadSpeedGraph.tsx`
- `src/components/InstallStepsList.tsx`


### 2026-10-06 更新

## 步骤/阶段文案的 i18n 覆盖（护栏）

下载中心卡片有两处「后端标识 → i18n 词条」映射，**任何一处缺词条都会把键名直接显示给用户**——`t()` 查不到键时原样返回键名（`src/i18n/index.tsx:60`）：

| 映射 | 标识来源 | 词条位置 |
|---|---|---|
| `downloads.steps.<id>` | 后端安装管线 step id（`InstallStepSpec { id }` / `mark_step`） | `qomicex-tauri-i18n/src/*/downloads.ts` 的 `steps` |
| `downloads.stage.<stage>` | `DownloadCenter.tsx` 的 `STAGE_LABELS` 白名单 | 同上，`stage` |

- **已发生的缺陷（2026-10-06 修复）**：Technic Solder 管线（issue #181 / 期3）新定义 6 个 step，只补了 `install-game` / `copy-files`，`download-mods` / `verify` / `extract-merge` / `jarmod` 缺词条 → 卡片上显示 `downloads.steps.download-mods` 之类的键名。同源缺陷另有两处：`repair-files`（实例缺资源补全，`endpoints/instance.rs:1445`）与 stage `modpack-update-finalize`（整合包原地更新收尾，`endpoints/modpack_update.rs:874`）。均已补齐 7 语言。
- **护栏**：`pnpm run test:i18n-steps`（`scripts/test-i18n-step-keys.mjs`）—— 扫后端 Rust 源码提取 step id（含 `#[cfg(test)]` 里假 id 的剔除、`id: step_id` 间接赋值的回溯），再取 `STAGE_LABELS` 白名单，逐语言比对 `downloads.ts` 的 `steps` / `stage` 键；缺任一键即退出码 1，并打印缺失键的后端定义位置。CI frontend-check 作业已接入。
- **新增管线步骤 / 往 `STAGE_LABELS` 加 stage 时**：先补 7 语言词条再跑护栏。zh-CN 是 `TranslationSchema` 基准，其它语言 `satisfies TranslationSchema` 做编译期结构校验（漏翻 tsc 也会报错），但**只有护栏能同时守住「后端新增了标识」这一侧**。
- **不算缺陷的情况**：`STAGE_LABELS` 未登记的 stage（如 `repairing` / `packing` / `verifying`）走通用「下载中」文案，不会显示键名。

