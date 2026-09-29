# ADR-086：触控板拖动优化——拖动区改为位移阈值 + `data-qomicex-drag-region`

| 属性 | 内容 |
|---|---|
| 状态 | 已采纳 |
| 日期 | 2026-09-29 |
| 决策者 | AI Agent |
| 关联 | issue #114「添加触控板针对优化」 |

## 背景

issue #114：触控板拖动时整个启动器 UI 会被拖动。

查 Tauri v2 内置拖动区实现（tauri 2.11.3 `crates/tauri/src/window/scripts/drag.js`，运行时注入）：

- 判定语义：`mousedown`（`button===0`、`detail` 为 1 或 2）的事件路径上若命中 `data-tauri-drag-region`，就**立即** `invoke('plugin:window|start_dragging')`——**没有任何位移阈值**，按下即进入原生拖动循环。
- 触控板上"按下—拖动"的意图远比鼠标模糊：Windows 精确式触控板默认开启的"点两下并拖动"、轻点单击后指尖的自然微移、macOS 默认开启的"三指拖动"，都会产生一次 `mousedown` 加少量 `mousemove`，于是窗口被误拖动。
- 本仓库还有两处放大问题的用法：`SplashScreen` 根容器整屏 `data-tauri-drag-region`（`fixed inset-0` z-9999 全屏覆盖）、`InitialSetupWizard` 根容器整屏挂同一属性（后者被子容器全覆盖、实际不生效，见 ADR-044）。

## 决策

1. **把 Tauri 的拖动区语义原样移植到前端，并加位移阈值**：新增 `src/lib/dragRegions.ts`（`installDragRegions()`），
   - `mousedown` 命中拖动区 → 只记录起点，不启动拖动，也不 `stopPropagation` / `preventDefault`（页面点击、按钮、React 事件流与原来完全一致）；
   - `mousemove` 位移超过 `DRAG_THRESHOLD_PX = 8px` 且 `e.buttons === 1` → 才 `getCurrentWindow().startDragging()`（Windows `WM_NCLBUTTUNDOWN(HTCAPTION)` / macOS `performWindowDragWithEvent` / GTK `begin_move_drag`，与原先同一原生路径）；
   - 双击且未产生显著位移 → `toggleMaximize()`（保留自定义标题栏的双击最大化/还原，统一在 mouseup 触发）；
   - 松手（`mouseup` / `buttons!==1` / 窗口失焦）即放弃手势，松手后的位移不再拖窗。
2. **拖动区属性改名 `data-qomicex-drag-region`**（取值语义与 Tauri 完全一致：空/`"true"`=仅命中自身、`"deep"`=子树命中即拖、`"false"`=禁用、可交互元素裸命中阻断）。换名后 Tauri 内置脚本不再接管这些区域，"mousedown 即拖窗"的通道被彻底移除。
3. **收缩放大问题的整屏拖动区**：`SplashScreen` 整屏可拖改为顶部 36px 拖动条（与主窗口 TitleBar 等高，启动期仍可移动窗口）；`InitialSetupWizard` 根容器不再挂拖动属性（保留品牌栏拖动条，ADR-044 结论不变）。

## 备选方案

### 方案 仅删除整屏拖动区（保留 Tauri 内置零阈值行为）
- 优点：改动最小（SplashScreen + 引导页两处）
- 缺点：标题栏 36px 条仍是"按下即拖"——触控板轻点微移/点两下并拖照样误拖窗，issue 的核心痛点未解决
- 为何不选：治标不治本

### 方案 document capture 层 `stopImmediatePropagation` 拦截内置脚本后自管手势
- 优点：可保留 `data-tauri-drag-region` 属性名
- 缺点：内置脚本在 document 上注册早于业务代码，只能在 capture 阶段阻断；`stopImmediatePropagation` 会连 React 根监听与 document 层冒泡一起挡掉，拖动区内的点击/聚焦行为劣化
- 为何不选：副作用面不可控

### 方案 打补丁 `window.__TAURI_INTERNALS__.invoke` 过滤 `start_dragging`
- 优点：不必动属性名
- 缺点：**不可行**——`invoke` 由 `Object.defineProperty(__TAURI_INTERNALS__, 'invoke', { value })` 定义，`writable`/`configurable` 均为 `false`，无法替换
- 为何不选：技术不可行

## 影响

- `src/lib/dragRegions.ts`（新增，约 170 行，含语义/阈值常量的注释说明）
- `src/main.tsx`（安装调用，主窗口 / game-log-window / plugin-webview-* 共用同一 SPA 入口）
- `src/components/TitleBar.tsx`、`src/components/SplashScreen.tsx`、`src/components/InitialSetupWizard.tsx`、`src/pages/GameLogWindow.tsx`、`packages/plugin-ui/src/components/Dialog.tsx`（属性改名；启动屏改顶部条；引导页根容器去属性）
- `packages/plugin-ui/dist/` 需重新构建（`pnpm run build:plugin-ui`）
- 文档：`docs/junsi-dev-docs/6-UI/组件设计/UI设计系统.md` 的 `data-tauri-drag-region` 示例同步改名
- 行为变化：窗口按钮/输入框等可交互元素、拖动区内的点击与 DOM 行为不变；鼠标拖动超过 8px 后窗口直接跟手（无感知差异）；双击标题栏仍可最大化/还原
- 权限：复用 capability 已有的 `core:window:allow-start-dragging` / `core:window:allow-toggle-maximize`，无需新增
- 验证：`pnpm run typecheck` / `pnpm run build` 通过；Playwright + Tauri mock 实测 17 项全过（微移不拖、8px 外拖、右键不拖、非拖动区不拖、双击最大化、双击带位移只拖不最大化、松手不拖、启动屏背景不拖/顶部条可拖、裸属性仅自身、deep、false、button 阻断、mousedown 冒泡不受影响）

## 修订记录

| 日期 | 版本 | 修改内容 | 修改人 |
|---|---|---|---|
| 2026-09-29 | v1.0 | 初版创建 | AI Agent |
