# ADR-095：更新可用性提升为会话级共享状态，设置页常驻「发现新版本」提示（issue #147）

| 属性 | 内容 |
|---|---|
| 状态 | 已采纳 |
| 日期 | 2026-10-02 |
| 决策者 | AI Agent |
| 影响面 | 前端 `src/stores/updaterStore.ts`、`src/App.tsx`、`src/pages/Settings.tsx`（不动后端、不动 i18n submodule） |

## 背景

> 编号说明：ADR-094 已被在途的资源收藏 P2 分支（#132 / PR #148）占用，故本文取 095，
> 避免两处 PR 合并时编号撞车。README 索引中 093 → 095 的间隔待 #148 合并后自然补齐。

用户在 [#147](https://github.com/Qomicex-Public/Qomicex.Tauri/issues/147) 报告：

> 存在更新时，若玩家手动取消后，在检查更新附近不会提示有新版本，应予以提示。

期望位置是「设置 → 关于 → 更新」那张卡片里、通道选择器与「检查更新」按钮的同一行右侧。

### 现状（修复前）

更新检测有**两条独立的检查路径**，二者互不知情：

| 路径 | 位置 | 命中「有更新」后的行为 |
|---|---|---|
| 启动后台检查 | `App.tsx`，`backendState === 'ready'` 后 5s | 写 `pendingUpdate` → 弹 `UpdateDialog` |
| 手动检查 | `Settings.tsx` `AboutTab.checkForUpdate` | 写本地 `pendingUpdate` → 弹 `UpdateDialog` |

`AboutTab` 里 `updateState` 的类型**声明了** `'available'`，但 JSX 只渲染了 `devBuild` / `uptodate` / `error` 三个分支，`'available'` **没有任何渲染出口**。

### 根因

「存在可用更新」这一事实只存在两条路径各自的局部 state 里，**没有任何共享、可达的载体**：

1. 用户在自动弹窗点「下次再说」→ `App.tsx` 的 `onClose` 只写 `snooze-update` 并 `setPendingUpdate(null)`，该事实**被清除**；
2. 之后去设置页看，`AboutTab` 的 `updateState` 仍是 `'idle'`（它从未被告知过），什么都看不到；
3. 手动检查虽然会再次弹窗，但用户取消后同样只剩 `'available'` 这个**渲染不出来的**状态值。

结果是：**有新版本却哪都不说**——只有再点一次「检查更新」并让弹窗一直开着才看得见。

## 决策

### 1. 把「已探知可用更新」提升为 store 里的唯一事实源

`src/stores/updaterStore.ts` 新增：

```ts
available: UpdatePlan | null
setAvailable: (plan: UpdatePlan | null) => void
```

- `App.tsx` 的后台检查与 `Settings.tsx` 的手动检查**都写入它**；
- `Settings.tsx` 订阅它渲染常驻提示；
- `setAvailable` 内部把「缺少 `version` 的计划」归一为 `null`——提示与弹窗都依赖 `version`，没有 `version` 就不该提示（与 `App.tsx`/`Settings.tsx` 里 `!plan.hasUpdate || !plan.version` 的既有守卫同口径）。

### 2. 提示的 UI 与交互

「设置 → 关于 → 更新」行内，「检查更新」按钮右侧渲染一个**可点击的提示**：`↓ 发现新版本 0.1.0-beta32.0`，点击**重新打开更新弹窗**（让用户不必再点一次检查、再等一次网络往返）。

- 点击路径复用新抽出的 `showUpdate(plan)`（手动检查与提示点击共用同一段打开逻辑，避免两处漂移）；
- 请求进行中（`updateState === 'checking'`）暂不渲染提示，避免与「检查中...」抢注意力；
- 开发构建（`isDevBuild`）不渲染——它根本不参与更新检查。

### 3. 文案复用既有 key，不新增 i18n key

提示直接用 `dialogs.update.foundNew`（`发现新版本 {version}`）——与更新弹窗标题**同口径**，且比"有新版本"多带一个版本号。

**这是本决策里最关键的取舍**：i18n 资源在**独立 submodule 仓库**（`Qomicex.Tauri.i18n`）。为一句「有新版本」新增 key 意味着：改 7 种语言 → 单独开 i18n 仓库 PR → 等它合并 → 回主仓库更新 gitlink。收益（文案与 issue 字面一致）远小于成本（跨仓库交付链路），而既有 key 语义完全吻合。

### 4. 「下次再说」只抑制弹窗，不抑制提示

用户裁决：提示**常驻到装上为止**。

`App.tsx` 里把 `setUpdateAvailable(plan)` 放在 **snooze 裁决之前**：`snooze-update` 的语义是「别再弹窗烦我」，而设置页的提示反映「确实存在新版本」这一**客观事实**，两者不应互相取消。用户点了「下次再说」后进设置页，仍应看到有新版本。

### 5. 仅会话内存，不持久化

`available` 故意不落 `localStorage`：计划里含签名与下载地址，跨会话缓存可能已被更新的版本取代或已失效。启动后后台检查会在 5s 内重新探知——**短暂不提示优于提示过期信息**。

### 6. 权威「无更新」清提示，请求失败保留

手动检查收到确定的 `hasUpdate: false` 时调用 `setAvailable(null)`：用户可能刚切换了通道（另一条列车无更新），或版本已被别的途径装上——继续提示一个不存在的"新版本"是错误信息。

网络异常走 `catch` 分支，**不**清提示：一次请求失败不能推翻上一次的确凿发现。

### 7. `reset()` 不复位 `available`

`reset()` 是更新弹窗里「重试」的入口（`UpdateDialog` 在 `phase === 'error'` 时调用），语义是**复位下载流程**、不是**否定更新存在**。清掉提示会让用户重试后凭空少一条「有新版本」。

## 备选方案

| 方案 | 未采纳原因 |
|---|---|
| `Settings.tsx` 自持一份 `available` state | App 的后台检查与设置页的手动检查两条来源会分叉；设置页只有在用户**恰好手动检查过**时才有提示，issue 场景（自动检查发现 → 去设置页）依然不覆盖 |
| 新增 i18n key「有新版本」 | 需改 7 种语言 + 跨仓库 i18n PR + 更新 gitlink，交付链路变长且信息量更少（无版本号）；见决策 3 |
| 持久化到 `localStorage` | 需额外的失效/过期清理逻辑，并与既有 `snooze-update` 键语义重叠；收益仅是"重启后仍提示"，而重启后 5s 内会重新探知 |
| 复用 `snooze-update` 作为提示开关 | 两者语义正交（抑制弹窗 vs. 陈述事实），耦合后「下次再说」会连提示一起消掉——正是 issue 要修的症状 |

## 验证

**代码门禁**（隔离 worktree，分支 `fix/147-update-available-hint`）：

- `tsc --noEmit` → 退出码 0；
- `vite build` → 成功；
- `eslint src/App.tsx src/pages/Settings.tsx src/stores/updaterStore.ts` → 仅 3 个 error，全部位于**未改动的既有代码行**（`Settings.tsx:560/605` 的 `rules-of-hooks`、`855` 的 `prefer-const`，属 AGENTS.md 记载的存量）；
- `node scripts/test-update-channel.mjs` → 20 条断言全部通过。

**行为验证**（Playwright + Tauri mock 注入，隔离 Vite :1440，拦截 `/api/update/plan` 返回假计划，只观察提示、不触发真实下载）：

用 `docs/junsi-dev-docs/2-架构设计/前端浏览器调试-Playwright-Tauri-mock注入.md` 的方法注入 mock，断言「检查更新」所在 flex 行内是否存在提示按钮、是否在其右侧：

| 场景 | 结果 |
|---|---|
| A1 后台检查发现更新后自动弹窗 | PASS（`planCalls=1`） |
| B1 点「下次再说」关闭弹窗 | PASS |
| **B2 取消后设置页仍提示「有新版本」** | **PASS** |
| B3 提示文案带版本号（`0.1.0-beta32.0`） | PASS |
| B4 提示位于「检查更新」右侧同一行 | PASS |
| C1 点提示可重新打开更新弹窗（含「立即更新」按钮） | PASS |
| D1/D2 手动检查弹窗 → 取消 → 提示仍在 | PASS |
| E1 权威「已是最新」后提示被清除 | PASS |

**反向对照（证明测试真的测到了修复）**：`git stash` 掉三处源码改动后跑同一脚本，B2/B3/B4/D2 四项全部 FAIL，行文本只剩 `测试版 检查更新`——**正是 issue 报告的症状**；恢复改动后 10/10 全通过。

> 保真度限制：Chromium ≠ WebView2（见上述文档「已知差异」）。本 PR 只改 React 状态与 JSX 布局，不涉及文件拖放/合成层等引擎差异敏感的路径；但按仓库约定，UI 变更仍应在真实 Tauri/WebView2 里复核一次。

## 影响

- **不新增 i18n key**，无跨仓库依赖，单 PR 可交付；
- **不改后端**：`/api/update/plan` 契约与语义均未变；
- 用户可见变化：设置 → 关于 → 更新，存在更新时按钮右侧常驻可点击提示。

## 修订记录

| 日期 | 版本 | 内容 |
|---|---|---|
| 2026-10-02 | v1.0 | 初版：根因（`'available'` 无渲染出口 + 事实无共享载体）、7 项决策、5 个备选方案、门禁与行为验证（含反向对照） |
