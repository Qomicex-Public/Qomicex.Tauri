# UI 动画优化方案 v2：覆盖与分层

| 属性 | 内容 |
|---|---|
| 状态 | v2 已实施（B0/B1/B1.5/B1.6/B2/B6 完成，B3/B4/B5/B7 部分完成，见「实施进度」） |
| 日期 | 2026-11-23 |
| 参照 | `D:\Project\PCLCE\PCL-CE`（Avalonia，`PCL.Core.UI.Animation` + 控件基类内置动效） |
| v1 变更 | v1 按「批次」组织、只覆盖十余个场景；本版改为**按 UI 层级全覆盖**，并把分散写法收敛为 3 个原语 |
| 新增依赖 | 无 |

---

## 实施进度（2026-11-24）

| 批次 | 状态 | 备注 |
|---|---|---|
| B0 前提修复 | 完成 | 页面入场收敛到 `PageShell`；全局门控；折叠竞态；死代码清理 |
| B1 原语 | 完成 | `src/lib/motion.ts`、`PageShell` 内建 Reveal、motion 工具类；`Presence` 未抽公共 hook，等价行为分别落在 ContextMenu / Toast / 更新横幅 |
| B1.5 列表 | 完成 | `useAnimatedList` 改 MutationObserver + FLIP；`listDiff.ts` + 24 项单测 |
| B1.6 骨架溶解 | 完成 | 实例列表、资源中心、实例详情 9 个标签页、插件商店×2、资源详情、导入弹窗；`skeletonVisible` 不传时内部按 400ms/300ms 处理 |
| B2 页面与二级导航 | 完成 | 顶层块自动分层；Tabs 指示器 transform；TabContent 方向感知 |
| B3 浮层与菜单 | 部分 | 右键菜单退场+错位、Toast 退场+强调、更新横幅进出场；Select/Combobox 选项错位、Dialog 内容三段 stagger 已做；Select 单选高亮未单独处理（沿用原有底色） |
| B4 列表与结构件 | 部分 | Card/TableRow/实例卡/账户行/ModCard 统一 `anim-row`；分组头补齐未做 |
| B5 输入与反馈 | 大部分 | 拖选框、合规提示、错误行高度展开、滑块按压、进度条 scaleX、加载延迟；搜索框清除按钮未做（缺 `common.clear` 文案） |
| B6 布局与全局 | 完成 | 侧栏指示条回弹、标题栏 `anim-tap`、滚动到顶、启动屏 320ms |
| B7 材质重构 | B7.1~B7.3 完成 | 全窗口静态模糊层、`.glass-surface` 去 `backdrop-filter`、浮层去 blur、Dialog 默认 88%；B7.4 仅剩调试小浮层与设置文案（i18n 在子模块） |

**已知剩余**：搜索框清除按钮（需 i18n 新增 key）、分组头入场、液态玻璃物理移除（quidlass 依赖与 `Card` 分支）。

---

## 0. 结论：问题不是「没有动画」，是「动画互相抵消 + 结构件缺口」

先摆事实。仓库里现在**已经有**动画的地方（已逐一核对源码）：

| 已有动效 | 位置 | 实际参数 |
|---|---|---|
| 页面根入场 | `PageShell.tsx`（12 个页面） | `animate-in slide-up`：150ms，8px |
| 路由容器入场 | `Layout.tsx` `main` | GSAP：250ms，8px，`opacity 0→1` |
| 首页/运行中入场 | `usePageAnimation.ts` | GSAP：350ms，12px |
| 二级 Tab 内容 | `TabContent`（Settings / InstanceDetail / Connect / PluginStoreManage） | `animate-slide-in-right`：200ms，12px |
| 列表/网格入场 | `useAnimatedList`（15 处调用） | 250ms + stagger，限 35 项，滚动暂停 |
| Dialog / Select / Combobox / Popover | GSAP | 进 150–200ms / 出 100–150ms |
| Tooltip / Badge / Label / Input / Textarea | CSS keyframes | 150–450ms |
| Switch / Checkbox | CSS transition | 200ms |
| 批量工具栏 | `pop-in` / `pop-out` | 300ms / 200ms |
| 侧栏展开与导航项入场 | CSS + GSAP | 150ms / 250ms stagger |
| 骨架 shimmer / 进度条 | CSS | 1.6s / 500ms |

所以「一坨切进来」的根因是三条：

1. **层级叠加**：一个页面入场同时跑 2 层动画（`main` 250ms/8px + `PageShell` 150ms/8px），位移叠加成 16px、时长不一致、缓动不同。用户看到的不是「分两段」，而是「一次有点糊的淡入」。首页更糟，是 `main` + `usePageAnimation` 两层不同时长。
2. **所有层级用同一档参数**：一级页面 150ms/8px、二级 Tab 200ms/12px、卡片无。切换深度不同，动作却几乎一样，用户感知不到「我进了多深」。
3. **覆盖缺口集中在结构件**：菜单项、下拉项、表格行、卡片悬停、内联提示、错误文本、空状态、分组头、进度条、标题栏按钮、Slider、搜索清除按钮——这些是「界面到处都有」的元素，缺一块就显得整体没做过动效。PCL-CE 正是靠「每个控件基类都内置状态动效」拿到覆盖率的。

---

## 1. PCL-CE 的覆盖模型（可迁移的三条机制）

### 1.1 覆盖率来自控件基类，不来自页面

PCL-CE 没有在页面里逐个写动画，而是把动效写进控件基类，页面只负责布局：

| 控件 | 内置动效（参数来自源码） |
|---|---|
| `MyButton` | hover 变色 100/200ms、按下变色 30ms、按下 0.955@80ms、松开 300ms、离开 800ms |
| `MyTextButton` / `MyIconButton` / `MyExtraTextButton` | 同上 + `Show` 切换宽度/透明度/缩放 120/150ms |
| `MyListItem` | hover 120/180ms、背景层 0.8→1、按下 0.98、选中竖条 scaleY 300ms 回弹、右侧按钮淡入 |
| `MyCard` | 阴影 0.07→0.4 @90ms、标题色 90ms、**内容高度变化动画**、交换按钮旋转 180° |
| `MyMenuItem` | hover 背景+前景 100/200ms |
| `MyComboBox` | 边框/前景过渡、下拉箭头旋转 180°@200ms |
| `MyComboBoxItem` | hover/选中 100ms 进、300ms 出（含字色） |
| `MyTextBox` | 聚焦边框 10ms、鼠标 100ms、**校验错误层高度 21px 展开@200ms**、禁用 200ms |
| `MySearchBox` | 清除按钮 90ms 淡入淡出 |
| `MySlider` | 进度宽度动画（300ms + 缓动）、拖拽圆点缩放、数值气泡 100ms |
| `MyHint` | 关闭时缩放 0.92 + 淡出 200ms + 高度收拢 150ms |
| `MyToast` | 进入 100/150ms、强调抖动 70/70/60ms、自动退场 200/150/100ms |
| `MyLoading` | 循环旋转、错误态形变（-20° + 弹性） |
| `MyScrollViewer` | 滚轮滚动 300ms 动画（不是瞬跳） |
| `MyPageLeft` | 子导航逐项入场（30→14ms 递减）、退出 70ms |
| `MyPageRight` | 内容逐项入场（25ms 错位，上限 250ms）、退出 70ms、加载环 400ms 延迟 |

### 1.2 页面转场按「内容控件」枚举，不是按容器整体

`MyPageRight.TriggerEnterAnimation` 遍历后代的 `MyCard` / `MyListItem` / `MyHint` / `TextBlock` / `MyTextButton`，逐个生成动画并错位。所以页面里自然就有层次。

### 1.3 高度变化也是动画

卡片内容变更、错误文本出现、提示条关闭，都做高度过渡。Web 上对应 `<Reveal>` 的 `collapse` 变体。

> 结论：React 里不需要「每个组件写一遍 GSAP」。需要的是 **3 个原语 + 一张覆盖表**，让新增 UI 默认就有动效。

---

## 2. 三个原语（先建底层，再铺覆盖）

### 2.1 `<Reveal>` —— 分层入场（替代现在的 2 层叠加）

```tsx
// 页面根：自动发现 [data-reveal] 子块，按 level 决定位移与延迟
<PageShell>
  <PageHeader />                              {/* 默认 L1 */}
  <div data-reveal="1">…统计卡…</div>
  <div data-reveal="2">…列表…</div>
</PageShell>
```

规则（对应 PCL 的「逐项」）：

| level | 位移 | 时长 | 用途 |
|---|---|---|---|
| 1 | `y -16 → +5 → 0` | 250ms + 350ms 回弹 | 页面标题、工具栏、**不含玻璃**的区块 |
| 2 | `y -8 → 0` | 220ms | 次级区块、表单 |
| 3 | `opacity 0→1` | 180ms | 详情正文、表格、**任何包含 `.glass-surface` 的区块** |

- stagger：组内 25ms，跨 level 不累计；上限 8 个块、总时长 ≤ 700ms。
- 无 `[data-reveal]` 时退化为整页单段入场（保证不出现「不动」的页面）。
- **含玻璃的区块只能用 level 3（opacity）**，原因见 5.1：祖先 transform 会让 `backdrop-filter` 停止采样。
- 仅动画 `transform/opacity`，结束后 `clearProps`（避免合成层残留导致 `backdrop-filter` 不重绘，issue #327）并调用 `queueGlassRepaint()`。

### 2.2 `<Presence>` —— 浮层进出场（把 4 份重复实现收敛成 1 份）

现在 `Dialog.tsx`、`Popover.tsx`、`Select.tsx`、`Combobox.tsx` 各自维护 `isClosing / mounted / closeAnimRef / timer`，`ContextMenu.tsx` 则完全没有退出动画。统一为：

```tsx
const { mounted, ref, closing } = usePresence(open, { enter: 160, exit: 120, y: -4, scale: 0.94 })
```

- 统一 `overwrite: 'auto'`，消除快速开关时的双 tween。
- 统一读 `readAnimConfig()`（multiplier），关闭动画时直接落终值。
- `ContextMenu`、`UpdateReadyToast`、内联提示（`ComplianceNotice`、错误条）迁入后自动获得退出动画与门控。

### 2.3 `motion` 工具类 —— 状态反馈（替代散落的 `transition-all` / `active:scale-95`）

```css
/* 全部读倍率；关闭动画时由全局规则落终值 */
.anim-press      /* 按下 80ms scale .955 → 松开 300ms → 离开 600ms */
.anim-tap        /* 图标按钮：按下 90ms scale .9 → 松开 220ms */
.anim-hover      /* 列表项背景层：0.85→1，进 120ms / 出 180ms */
.anim-row        /* 表格行/紧凑行：只做背景色 100/200ms，不做位移 */
.anim-lift       /* 非玻璃卡片：hover y -2px + shadow，180ms */
.anim-collapse   /* 高度展开/收起：220/160ms，带 killTweensOf 与终值复位 */
```

禁止在 `.glass-surface`（`backdrop-filter`）上使用 `anim-hover` / `anim-lift`。

---

## 3. 覆盖矩阵（本方案的主体）

标注：**✔** 已有；**✎** 需改；**＋** 新增。

### 3.1 L0 一级页面（13 条路由）

| 界面 | 现状 | 目标 | 原语 | 批次 |
|---|---|---|---|---|
| 页面根（12 页用 `PageShell`） | ✎ 150ms/8px，与 `main` 叠加 | `PageShell` 独占；`Reveal` 驱动 | Reveal | B2 |
| 首页 / 运行中 | ✎ `usePageAnimation` 350ms/12px 叠加 | 删除该 hook，改用 `PageShell` | — | B0 |
| `Layout` 路由容器 | ✎ 250ms/8px 淡入 | 只保留「首屏挂载」一次；切页不再播 | — | B0 |
| `PageHeader` | ＋ 无 | L1 入场；返回键 `anim-tap` | Reveal | B2 |
| 页面骨架 → 内容 | ✔ 有 `ContentTransition` 组件但 0 引用；页面里是硬三元切换 | 溶解过渡（3.7.1）：骨架 120ms 淡出 → 内容 240ms 上浮淡入 | ContentTransition | B5 |
| 空状态（实例/资源/下载） | ＋ 无 | 180ms 淡入 + 4px 上移 | motion | B4 |
| 页面滚动位置 | ＋ 无 | 切页 `scrollTop = 0`（无动画） | — | B2 |
| 深链/外部唤起落地 | ＋ 无 | 落地页走正常 Reveal，不额外弹动画 | — | — |

### 3.2 L1 二级导航（18 处 `Tabs`）

| 界面 | 现状 | 目标 | 原语 | 批次 |
|---|---|---|---|---|
| Tabs 指示器 | ✎ `transition-all 200ms`（同时动 `width/height/left/top`，触发 layout） | 改为 `transform: translate() scale()` + 单独宽度；200ms out-expo；点击时 `scale .98` | Tabs | B2 |
| Tab 按钮 | ✎ 只有颜色 | 加 `anim-press`；图标按 `MorphIcon` 规则 | motion | B2 |
| `TabContent` | ✎ 200ms 从左侧 12px（横竖排都用同一方向） | 方向感知：横排从下 4px、竖排从右 4px；240ms | Reveal | B2 |
| 未包 `TabContent` 的调用点：Instances 远程分类与过滤器、DownloadCenter 过滤器 | ✎ Instances 的 `useAnimatedList` 依赖是 `[filtered.length, viewMode, …]`，不含 `remoteCategory` / `filterType` / `groupFilter`，结果数不变时不播；DownloadCenter 完全没有列表动画 | 内容区加 `key={activeTab}` 的 Reveal，或把 `activeTab` 加入 list deps | Reveal | B2 |
| ResourceCenter 分类与来源切换 | ✔ `useAnimatedList` 依赖已含 `category / source` | 保留 | — | — |
| 设置页左侧竖排导航（7 类） | ✎ 同 TabContent | 同上；指示块用 `anim-hover` 质感 | Reveal | B2 |
| 实例详情左侧 9 组导航 | ✎ 同上 | 同上 + 分组标题 180ms 淡入 | Reveal | B2 |
| 联机页房间内 Tabs（玩家/模组/实例） | ✎ 同上 | 同上 | Reveal | B2 |
| 下载中心按资源类型分组折叠 | ✔ `anim-transition` 高度 + MorphIcon 箭头 | 折叠内容加 Reveal；箭头加回弹 | Reveal | B2 |
| 面包屑 / 返回层级 | ＋ 无 | 返回按钮 `anim-tap`；标题切换 180ms 淡入 | motion | B2 |

### 3.3 L2 详情页内部

| 界面 | 现状 | 目标 | 原语 | 批次 |
|---|---|---|---|---|
| 资源详情：简介折叠 | ✎ `max-h-[180px]` + `transition-all`（高度不可预测） | `anim-collapse`：先量高度再动画，带中断复位 | collapse | B4 |
| 资源详情：版本/文件列表 | ✔ `useAnimatedList` | 保留 | — | — |
| 资源详情：复制名称/链接 | ✔ `CopyActionIcon`（MorphIcon） | 保留 | — | — |
| 实例详情：9 个 tab 内容 | ✎ `TabContent` | 同 3.2 | Reveal | B2 |
| 实例详情：模组/资源包/光影/数据包/存档/截图 | ✔ `useAnimatedList`（5 处） | 保留 + 行悬停层 | — | B4 |
| 账户详情：皮肤/披风切换 | ＋ 无 | 3D 预览淡入 200ms；开关联动走 Switch | — | B5 |
| 插件商店：详情 tab | ✎ `TabContent` | 同上 | Reveal | B2 |
| 世界预览 / 截图大图 | ＋ 无 | Dialog 已覆盖；图片 `opacity` 200ms | — | B5 |

### 3.4 浮层与菜单

| 界面 | 现状 | 目标 | 原语 | 批次 |
|---|---|---|---|---|
| Dialog（约 30 个对话框共用） | ✔ 200/150ms | 加内容三段 stagger（header/body/footer 20ms）；打开/关闭完成时 `queueGlassRepaint()`（对话框本体是 glass-surface，见 5.1） | Presence | B3 |
| MessageBox | ✔ 复用 Dialog | 保留 | — | — |
| Select | ✔ 150/120ms | 选项逐项 12ms stagger；选中项高亮 100ms | Presence | B3 |
| Combobox | ✔ 150/120ms | 同上 | Presence | B3 |
| Popover | ✔ 150/120ms | 同上 + 触发箭头旋转 200ms | Presence | B3 |
| ContextMenu（右键菜单） | ✎ 仅 CSS 150ms，无退出、无错位、项只有 `transition-colors` | 迁入 Presence；菜单 160/120ms；项 stagger 15ms；项 hover 100/200ms（对齐 `MyMenuItem`） | Presence | B3 |
| 账户下拉（首页小组件） | ✎ 用了 `slide-in-from-top-2`（仓库无此 keyframe，等于没动） | 改用 Presence | Presence | B3 |
| 资源安装弹窗内的下拉 | ✎ 仅 CSS | 同上 | Presence | B3 |
| Tooltip | ✔ 进场 150ms；300ms 延迟；无退场（ADR-069 决定） | 延迟降到 150ms；其余不动 | — | B3 |
| Toast（`notify`） | ✎ `transition-all 300ms`，无退出、无强调 | Presence + 120ms 退出 + 重复触发抖动（70/70/60ms） | Presence | B3 |
| 更新就绪横幅（UpdateReadyToast） | ✎ 常驻，无进出 | 进入 200ms 上浮；关闭 120ms | Presence | B3 |
| 内联提示（ComplianceNotice / 各页告警条） | ＋ 无 | 出现：高度展开 180ms；关闭：收起 150ms（对齐 `MyHint`） | collapse | B5 |

### 3.5 列表、卡片、表格

| 界面 | 现状 | 目标 | 原语 | 批次 |
|---|---|---|---|---|
| 实例卡（网格/列表） | ✔ 入场 stagger；✎ hover 仅颜色 | hover 背景层 `anim-hover`；按下 `anim-press`；选中竖条 300ms 回弹 | motion | B4 |
| 远程版本卡 | ✔ / ✎ 同上 | 同上 | motion | B4 |
| 资源卡（资源中心/收藏） | ✔ 入场；✎ hover 仅边框 | 非玻璃卡 `anim-lift`（y -2px） | motion | B4 |
| Mod 卡 / 资源包卡 / 光影卡 / 数据包卡 | ✔ 入场；✎ hover 仅颜色 | `anim-row` + 右侧操作按钮淡入（84ms，延迟 36ms） | motion | B4 |
| 存档卡 / 截图卡 | ✎ 选中态 | 选中条回弹 + 缩略图 hover 1.02（仅非玻璃） | motion | B4 |
| 表格行（`Table`） | ✎ 只有 `transition-colors` | `anim-row`：背景 100/200ms；批量选中 Checkbox 已有 | motion | B4 |
| 列表分组头 | ✎ 仅折叠 | 展开时子项 Reveal；分组计数数字变化 150ms 淡入 | Reveal | B4 |
| 批量操作栏 | ✔ pop-in/out | 保留；`pop-in` 目前不受门控，由 B0 全局规则兜住 | — | B0 |
| 拖选框（`DragSelectArea`） | ＋ 无 | 出现 100ms scale .98→1 + fade | motion | B4 |
| Dashboard 小组件 | ＋ 无入场 | RGL 布局稳定后首屏 40ms stagger（仅首次） | Reveal | B4 |

### 3.5.1 列表动效专项（插入 / 位移 / 退场）

#### 现象 → 机制对照（已按源码核对）

| 你看到的 | 实际发生 | 位置 |
|---|---|---|
| 账户列表的逐个入场没了 | 入场时机完全由手写 `deps` 决定（`[filteredAccounts.length, search, filterType]`），效果对渲染顺序极度敏感：空态/骨架先占掉上一批基线、或数据在 deps 之外变化时就会整段跳过。属于「偶发丢动画」，本身就说明这个模型不可靠——需要在 dev 里打点确认是哪种时序，但无论哪种，换成 DOM 变更驱动都能一次性消除 | `Accounts.tsx:145`、`useGsapAnimations.ts:217` |
| 只有尾部插入有动画 | 入场集合只看「key 不在上一批」，与位置无关；但**已有元素位置变化没有任何补间**，头/中间插入时其它行瞬移，视觉上只有新元素在动 | `listEnterSelection.ts` |
| 后面的项目不往后移 | 没有 FLIP：`getBoundingClientRect` 只在退出克隆里用过，从没用于位移补间 | `useGsapAnimations.ts` 退出块 |
| 只有整体退出、没有局部退出 | 退场对象是「上一批有、这一批没有」的 key，但只在 deps 变化时计算；整组替换时新旧 key 全不同 → 35 个克隆同时飞出，观感是整块 | 同上 |
| 实例切分组直接跳出 / 从头播 | deps 是 `filtered.length`：新组数量相同 → 完全不跑；数量不同 → 所有 key 都是新的 → 全部从头 stagger | `Instances.tsx:877/880` |
| 搜索时整行飞出去 | `search` 是 deps → 被搜索过滤掉的项被当成「删除」，播克隆退场 | `Accounts.tsx:145` |
| 远程版本切分类无动画 | `remoteCategory` 不在 deps 里 | `Instances.tsx:930/931` |

一句话：**现在的列表动画是「deps 驱动 + key 差集」，不是「DOM 变更驱动 + 布局补间」**。前者要求每个调用方手写正确的依赖数组（15 处里已有 3 处写错），后者才是列表动效该有的模型。

#### 新机制（重写 `useAnimatedList` 内部，签名不变）

1. **触发**：`MutationObserver({ childList: true })` 监听容器，DOM 变更后一帧内处理。参数里的 `deps` 保留但忽略（兼容 15 个调用点，零改动）。
2. **快照**：`Map<key, DOMRect>`，key 取 `data-key`；每次变更后更新。
3. **分类**：
   - 只在新快照里 → **enter**
   - 只在旧快照里 → **exit**（按旧 rect 克隆，播完移除）
   - 两边都有但 rect 变了 → **FLIP**（`translate(dx,dy)` → 0）
   - 新旧 key 交集 < 35% → 判定为**整组替换**，走容器级 crossfade，不跑几十条 tween
4. **参数**：

| 动作 | 时长 | 曲线 | 说明 |
|---|---|---|---|
| enter | 140ms opacity（玻璃卡）/ +200ms 位移 8px（非玻璃） | `power3.out` | 玻璃卡只做自身 opacity，见 5.1；stagger 20ms，上限 35 项，总时长 ≤ 260ms |
| move（FLIP） | 220ms | `power3.out` | 无 stagger，全部同时归位；玻璃卡移动期间不 blur，结束补重采样 |
| exit | 160ms | `power2.in` | 克隆：opacity + 4px + `scale .98` |
| replace | 出 80ms / 进 140ms | `power2.in` / `power3.out` | 容器级，新内容淡入（玻璃卡只淡入，不位移） |

5. **保护**：
   - 只处理与视口相交的元素；`content-visibility: auto` 的离屏项直接落终态（避免误测高度）。
   - 滚动过程中触发的变更：跳过动画直接落终态（不再用 pause/resume，避免 transform 残留）。
   - 每个元素同一时刻只有一个 tween（`overwrite: 'auto'`）；结束 `clearProps: 'transform,opacity'`。
   - 玻璃卡动画结束调用 `queueGlassRepaint()`（5.1），否则模糊要等 hover 才恢复。
   - 关闭动画 / reduced-motion：全部跳过，写终值。
6. **key 稳定性**：`Instances.tsx` 的 `listKeyOf` 在缺 `dirName` 时用 `index` 兜底，会导致增删时 key 抖动（误判 enter/exit）。改为 `dirName ?? `${gameVersion}-${loader?.type}-${loader?.version}``，仍缺再用路径。

#### 组切换语义（需确认）

整组替换走容器 crossfade（快、不闪）；单条增删走逐项 enter/exit/FLIP。若希望分组切换也逐项「旧项退、新项进」，把阈值调到 100% 即可，但 60+ 项时会明显掉帧——这是 PCL 也没做的事（它换页直接整栏重建）。

#### 迁移与测试

- 15 个调用点不改签名。
- `scripts/test-list-enter-selection.mjs`：把「整页替换 → 动画新一批」的断言改为「整页替换 → crossfade」，保留 issue #355 的「追加分页只动画新增项」断言。
- 新增纯函数 `computeListDiff(oldItems, newItems) -> { enter, exit, move }` 及单测（不依赖 DOM，可直接 node 跑）。
- 新增 harness 场景：头插入、中间插入、尾部插入、删除中间项、切换分组、搜索过滤。

### 3.6 输入控件

| 界面 | 现状 | 目标 | 原语 | 批次 |
|---|---|---|---|---|
| Switch | ✔ 200ms | thumb 加 180ms 轻微回弹 | motion | B5 |
| Checkbox | ✔ 200ms + indicator scale | 勾选确认 150ms scale 1→1.1→1 | motion | B5 |
| Input / Textarea | ✔ focus-glow 450ms | 错误态：边框 200ms + **错误文本高度 21px 展开**（对齐 `MyTextBox`） | collapse | B5 |
| Select 触发器箭头 | ＋ 无旋转 | 打开/关闭 200ms rotate 180° | motion | B5 |
| Slider（原生 range） | ✎ 仅 thumb `box-shadow` | 按下 thumb 1.15；进度填充用 `transform: scaleX` | motion | B5 |
| 搜索框清除按钮 | ＋ 无 | 有内容 90ms 淡入（对齐 `MySearchBox`） | motion | B5 |
| Label | ✔ label-swap | 保留 | — | — |
| Radio / 分段控件（各页自绘） | ＋ 无 | 统一改用 `Tabs` 或 `anim-press` | motion | B5 |

### 3.7 反馈与加载

| 界面 | 现状 | 目标 | 原语 | 批次 |
|---|---|---|---|---|
| 全局加载（`Loader2 animate-spin`） | ✎ 立刻出现 | 延迟 400ms 出现 + 最短停留 300ms + 150ms 淡出 | — | B5 |
| 进度条 | ✎ `transition-all duration-500` | 改 `transform: scaleX`（避免每帧重排），保留单调不回退（ADR-114） | motion | B5 |
| 成功/失败图标 | ＋ 无 | 200ms scale + fade（对齐 `MyLoading` 错误态） | motion | B5 |
| 任务完成通知 | ＋ 无 | 走 Toast | Presence | B5 |
| 错误边界（ErrorBoundary） | ＋ 无 | 内容 200ms 淡入 | motion | B5 |
| 骨架 → 内容 | ✎ 硬三元切换，内容瞬间出现（`ContentTransition.tsx` 存在但全仓 0 引用，是死代码） | 溶解过渡，见 3.7.1 | ContentTransition | B5 |

#### 3.7.1 骨架 → 内容「沙画浮现」过渡

**现状**：`Instances.tsx:1643`、`InstanceDetail` 6 处、`ResourceCenter.tsx:1906`、`ResourceDetail.tsx:772`、`PluginStore*`、`ImportDialog` 全部是硬三元：`loading ? 骨架 : 内容`。加载完成时整棵骨架被移除、内容同一帧出现，没有任何过渡。

**机制**（复用 `src/components/ContentTransition.tsx`，重写内部，保留文件名）：

```tsx
<ContentTransition
  loading={loading || scanning}
  skeleton={<VersionSkeleton view={viewMode} />}
>
  {content}
</ContentTransition>
```

状态机 `loading → leaving(120ms) → ready`：

| 阶段 | 画面 | 动画 |
|---|---|---|
| `loading` | 骨架（shimmer 继续） | — |
| 数据到达 → `leaving` | 骨架原地淡出 | `opacity 1→0` 120ms `power2.in` + `scale 1→0.995`（**不动高度**） |
| `leaving` 结束 → `ready` | 内容淡入 | 列表：**容器不做动画**，每个卡片自身 `opacity 0→1` 180ms + 20ms stagger；非玻璃区块可 `y 6→0` 240ms，`power3.out`，结束 `clearProps` |

两种模式：

- **`mode="overlay"`（固定高度容器）**：详情页头部、插件卡这类高度稳定的容器，骨架绝对定位覆盖，内容同时淡入（240ms），容器 `min-height` 保持到结束。重叠期间玻璃不 blur（见 5.1），结束时由 `queueGlassRepaint()` 补一次。
- **`mode="sequence"`（默认，高度不定）**：上面的三段式，不重叠、无高度动画。

- 总感知约 320ms；骨架与内容不重叠，因此没有高度动画、没有双重布局，也不会有「内容先被骨架压着、解锁时跳一下」的问题。
- **沙画感**：`ready` 阶段在内容容器上叠一层普通 `div` 遮罩（`pointer-events-none`，`linear-gradient(hsl(var(--card)/.85), transparent)`），260ms 淡出。**不用 `mask-image`**——ADR-037 已确认遮罩会切断 `backdrop-filter` 采样，玻璃卡片会失效。
- 列表页与 `useAnimatedList` 天然叠加：卡片自身错位淡入 + 遮罩退去，就是「沙子沉下去、画浮现出来」的观感。玻璃卡片**不参与位移**（理由见 5.1），所以这里不做 6px 上浮。
- 三道门控：关闭动画 / reduced-motion → 直接 `ready`；`maxFrameRate < 60` → 跳过遮罩层，只保留卡片淡入。

**不采用「真交叉淡入淡出」的原因**：骨架与内容同时挂载时高度不同，要么容器高度瞬间跳，要么逐帧做高度动画（大列表每帧重排，与第 5 节规则冲突）。真交叉淡入只适合固定高度容器，作为 `mode="overlay"` 可选项留给详情页头部，不作为默认。

**接线清单（10 处）**：

| 位置 | 说明 |
|---|---|
| `Instances.tsx:1643` | 本地实例 grid/list 两套骨架 |
| `Instances.tsx:1001/1016` 区块 | 远程版本 grid/list |
| `InstanceDetail.tsx:462` | 概览 |
| `InstanceDetail.tsx:1160/1167` | 模组 compact/detailed |
| `InstanceDetail.tsx:1460/1711/1962` | 资源包 / 光影 / 数据包 |
| `InstanceDetail.tsx:2476/2926` | 存档 / 截图 |
| `ResourceCenter.tsx:1906` | 搜索列表（含 `isReplacing`；替换也走溶解，但**不清空滚动位置**） |
| `ResourceDetail.tsx:772` | 详情页头部（可用 `mode="overlay"`） |
| `PluginStoreBrowse.tsx:230` / `PluginStoreManage.tsx:236` | 插件商店两个列表 |
| `ImportDialog.tsx:294` | 对话框内，可留到最后 |

**与「加载防闪烁」配合**：骨架显示本身由 `useDelayedFlag(400)` 控制——400ms 内返回则不出现骨架，直接内容淡入。否则每次快速切换都会闪一下骨架，比现在的硬切更糟。

**验收**：

| 场景 | 期望 |
|---|---|
| 首次加载（>400ms） | 骨架 shimmer → 骨架 120ms 淡出 → 内容 240ms 上浮淡入，无高度跳动 |
| 快速返回（<400ms） | 完全不出现骨架，内容直接淡入 |
| 刷新/切换分类 | 骨架→溶解，但滚动位置不重置 |
| 关闭动画 | 瞬间切换，无残留 transform/opacity |
| 毛玻璃材质 | 玻璃卡片在过渡中仍能采样背景（遮罩层是普通 div，不是 mask） |

### 3.8 布局与全局

| 界面 | 现状 | 目标 | 原语 | 批次 |
|---|---|---|---|---|
| 侧栏展开/收起 | ✔ 宽度 150ms；✎ 标签透明度同时变 | 标签延迟 60ms 淡入；图标不缩放（避免抖动） | motion | B6 |
| 导航项首次入场 | ✔ 250ms + 30ms stagger | 保留 | — | — |
| 当前页指示条 | ✎ scaleY 200ms 线性 | 300ms `back-soft`（对齐 PCL 选中条） | motion | B6 |
| 导航项 hover | ✎ 仅颜色 | `anim-hover` 背景层 + `anim-press` | motion | B6 |
| 标题栏按钮 | ＋ 无 | `anim-tap` | motion | B6 |
| 启动屏退出 | ✎ 500ms 淡出 | 320ms；主界面同时 200ms 淡入（**不位移**，主界面含玻璃） | — | B6 |
| 滚动到顶部按钮 | ✎ 300ms `transition-all` | 改 `opacity/transform` 120ms；`scrollTo` 用 `behavior: smooth` | motion | B6 |
| 主题切换 | ＋ 瞬时 | **不做**（`backdrop-filter`/`mask` 合成根会反复重建） | — | — |
| 背景视频/动图 | ✔ 已有开关 | 保留 | — | — |

### 3.9 明确不做

| 界面 | 理由 |
|---|---|
| 插件 iframe / webview 内容 | 跨域 + 独立合成层，动画会撕裂 |
| 3D 皮肤 / 世界预览 / 地图 canvas | 由渲染库自管，套 `transform` 会掉帧 |
| 代码编辑器（CodeMirror） | 自带动画，外部干预会破坏光标 |
| `react-grid-layout` 拖动/缩放 | 库自带，且动画会与指针位置打架 |
| 页面退出动画 / View Transition | React 立即卸载；快照式过渡与上述重型页面冲突 |
| 液态玻璃材质 | 移除候选：B7.0 下架设置项并把存量值迁移到 `frosted`，代码与 `quidlass` 依赖暂存，见 [ADR-141](../1-决策记录/ADR-141-毛玻璃改为整页预模糊底并移除卡片级-backdrop-filter.md) 2.1 |
| 主题色渐变 | 同上，风险高于收益 |

---

## 4. 批次与依赖

| 批次 | 内容 | 为什么必须先做 |
|---|---|---|
| **B0 前提修复** | ① 去掉 `main` + `PageShell` + `usePageAnimation` 的叠加，页面入场只留一处 ② 全局门控（关闭动画 / `prefers-reduced-motion` 真正生效） ③ `useExpandAnimation` 竞态 ④ 删除 `slide-in-from-top-2` 等无效类 | 不先修，后面每加一层动画都会继续叠在一起，「越做越糊」 |
| **B1 原语** | `Reveal` / `Presence` / `motion` 类 + 动效 token；`computeListDiff` 纯函数与单测 | 后面所有批次只调用原语，不再写一次性 GSAP |
| **B1.5 列表动效重构** | `useAnimatedList` 内部改 MutationObserver + 快照 FLIP + 局部退场 + 整组替换判定（3.5.1）；玻璃卡只做 opacity；`listKeyOf` 稳定化 | 15 个列表调用点共用同一实现，这里是「增删位移」的唯一出口；必须先于页面/导航改造，否则 Reveal 与列表入场会再次叠加 |
| **B1.6 骨架→内容溶解** | 重写 `ContentTransition`（3.7.1）+ 10 处接线 + `useDelayedFlag(400)`；固定高度容器用 overlay 模式 | 只依赖 B0 的门控，可与 B1.5 并行；观感收益最直接（当前是硬切） |
| **B2 页面与二级导航** | 12 页接入 Reveal；`Tabs` 指示器 transform 化；`TabContent` 方向感知；未包裹的 6 处补上 | 这是「分层感」的主要来源 |
| **B3 浮层与菜单** | `Presence` 收敛 6 类浮层；右键菜单、账户下拉、更新横幅迁入；选项错位；玻璃动画结束补 `queueGlassRepaint()` | 覆盖缺口最大的一块 |
| **B4 列表与结构件** | 卡片/表格行/分组头/空状态/拖选框/折叠 | 「到处都有」的元素 |
| **B5 输入与反馈** | 错误文本展开、清除按钮、Slider、加载延迟、进度条、内联提示 | 状态变化的可感知性 |
| **B6 布局与全局** | 侧栏指示条、标题栏按钮、启动、滚动到顶 | 收尾 |
| **B7 材质重构（已立项）** | 按 [ADR-141](../1-决策记录/ADR-141-毛玻璃改为整页预模糊底并移除卡片级-backdrop-filter.md)：B7.0 液态玻璃下架+迁移 → B7.1 全窗口静态模糊层 → B7.2 卡片去 blur → B7.3 浮层 → B7.4 清理与文案 | 唯一能彻底消除「动画期间不糊、结束才跳出来」的路径；同时解决 #327 与低端机卡顿。可与主线并行，B7.2 完成后 5.1 的位移禁令解除 |

依赖：**B0 → B1 → (B1.5 ∥ B1.6) → (B2 ∥ B3) → (B4 ∥ B5) → B6**；B7 独立立项。B2/B3/B4/B5 之间无强依赖，但 B1.5 必须早于 B2——页面 Reveal 与列表入场同时播会重现「两层叠加」。

预估：B0 6 文件；B1 5 文件（2 个新原语 + `computeListDiff` + CSS + preset）；B1.5 3 文件；B1.6 3 文件 + 10 处包裹；B2 约 8 文件；B3 约 10 文件；B4 约 12 文件；B5 约 10 文件；B6 约 5 文件。**不新增依赖**。

---

## 5. 动效语言（防止「到处都有动画」变成噪音）

1. **深度决定幅度**：L0 16px / L1 8px / L2 4px；越深越快越轻。
2. **同一时刻最多两段位移**（PCL 的「250ms + 350ms 回弹」算一段，因为它连续）。
3. **高频操作不做位移**：hover、滚动、输入、拖动只做 ≤120ms 的颜色/透明度；位移留给「内容出现/消失」。
4. **一个元素同一时刻只有一个动画**（`overwrite: 'auto'` / `killTweensOf`）。
5. **列表上限 35 项**（已有）；页面 Reveal 上限 8 块；单帧并行 tween ≤ 40。
6. **玻璃表面只做自身透明度与颜色**，不做位移/缩放；含玻璃的区块不套位移动画（见 5.1）。
7. **所有动效可被三重门控关闭**：用户开关 → 系统 reduced-motion → 帧率上限档位。

### 5.1 毛玻璃与动画的硬约束（WebView2 实测行为）

**现象**：只有 `data-material !== "default"` 时出现——动画播放期间卡片完全不模糊，动画结束（或鼠标移入触发重绘）后模糊「跳」出来。`default` 材质没有 `backdrop-filter`，不受影响。

**根因**：`backdrop-filter` 在合成器栅格化时采样背后内容。元素或任意祖先被 transform / 3D / 祖先 opacity 提升为独立合成层后，WebView2 不会逐帧重新采样 backdrop，只在层重建（动画结束、样式失效、强制重绘）时刷新一次。仓库里已有的 `useGlassRepaint`（`html.glass-repaint` + 强制 reflow）正是为此写的（issue #327），但它只在**路由切换 / 媒体加载 / 新增节点**时触发，覆盖不到「动画进行中」和「动画刚结束」。

**规则（本方案所有动画必须遵守）**：

| 对象 | 允许 | 禁止 |
|---|---|---|
| `.glass-surface` / `[data-liquid-glass]` 自身 | 自身 `opacity`、颜色、边框、阴影 | 自身 transform / scale / 位移 |
| 玻璃元素的祖先 | 保持静止 | transform / 3D / `will-change: transform` / 祖先 opacity |
| 非玻璃块（标题、工具栏、文本、图标） | transform + opacity | — |

推论（已回改到各处参数）：

1. 列表卡片入场只做 `opacity`，**不能整卡 x/y/scale**；需要位移时，位移放在卡片内部的非玻璃内容层上。
2. `FLIP` 的目标若是玻璃卡片，移动期间同样无模糊。默认接受；若观感明显，改为「只移动卡片内部内容层」。
3. 页面 `Reveal` 只标在非玻璃区块上；含玻璃的区块交给列表/卡片自身的 opacity。
4. 每次玻璃相关动画结束必须调用 `queueGlassRepaint()`（把 `useGlassRepaint.ts` 内部的 `repaintGlass` 导出并做 rAF 合批），保证「动画结束 → 1 帧内模糊恢复」，不再依赖鼠标移入。`useGlassRepaint` 现在的 `setTimeout(…, 450)` 是「猜」动画结束时间，改造后由原语的完成回调直接触发；450ms 只保留为兜底。

**短期 / 长期**：

- 短期（B1.6、B2、B3）：按上表约束 + 结束即重采样。模糊仍会在结束时出现，但时机确定，且不再需要 hover。
- 长期（B7，**已立项，见 [ADR-141](../1-决策记录/ADR-141-毛玻璃改为整页预模糊底并移除卡片级-backdrop-filter.md)**）：把材质模糊上移到**全窗口静态模糊层**，卡片不再持有 `backdrop-filter`；`liquid` 下架并迁移到 `frosted`。落地后上表「玻璃只做 opacity、祖先不位移」的约束随之上解除，`Reveal` / `useAnimatedList` / 骨架溶解可恢复位移参数，且彻底消除 pop。动态壁纸（视频/动图）不做媒体 `filter`，由模糊层对合成帧逐帧采样，按 12px 封顶与三级降级兜住。

---

## 6. 验收：以「覆盖率」为准

### 6.1 可感知状态清单（逐项打勾）

页面进入 / 页面返回 / 二级导航切换 / 三级 tab 切换 / 分组折叠展开 / **骨架→内容（首次 / 快速返回 / 刷新）** / 列表头部插入 / 列表中间插入 / 列表尾部插入 / 列表项位移 / 列表局部退场 / 切换分组 / 搜索过滤 / 右键菜单打开 / 右键菜单关闭 / 下拉打开 / 下拉关闭 / 下拉选项悬停 / 对话框打开 / 对话框关闭 / 提示框出现 / 提示框关闭 / Toast 出现 / Toast 重复 / Toast 消失 / 卡片悬停 / 卡片按下 / 列表项悬停 / 列表项选中 / 表格行悬停 / 按钮按下松开 / 图标按钮切换 / 开关切换 / 复选框勾选 / 输入聚焦 / 输入校验失败 / 搜索框清除 / 加载出现 / 加载结束 / 进度推进 / 拖选框出现 / 侧栏展开 / 启动进入主界面。

### 6.2 分层验收（针对「整块切进来」）

同一页面连续截图/录屏对比，必须能看出：标题先到、主卡片随后、列表最后；位移方向一致向下；总时长 600–700ms。
度量方式：`page.evaluate` 采样各 `[data-reveal]` 的 `getComputedStyle().transform`，确认时间序列递增（不用截图比对）。

### 6.3 门控验收

1. 关闭「界面动画」：清单全部无动画，且**没有残留 transform/opacity**（否则 `backdrop-filter` 不重绘）。
2. 系统 reduced-motion：同上，且不依赖应用内开关。
3. 0.25x / 2x：所有场景同向变化。
4. 30 FPS 上限 + 毛玻璃：列表与页面入场不卡顿。

### 6.3.1 毛玻璃验收（对应 5.1）

| 场景 | 期望 |
|---|---|
| 非 default 材质（毛玻璃/亚克力/Aero）动画结束后 | **1 帧内**模糊恢复，不需要鼠标移入 |
| 动画进行中 | 允许不模糊（WebView2 限制），但不允许出现「锯齿边/空白块/颜色跳变」 |
| 玻璃卡入场 | 无位移，只淡入；位移只出现在非玻璃内容层 |
| default 材质 | 与非毛玻璃一致，不额外重采样 |
| 关闭动画 | 无 `glass-repaint` 抖动（重采样不能造成可见闪烁） |

### 6.4 回归锁

- `scripts/test-expand-race.mjs`（Playwright + 现有 Tauri mock）：连续折叠 10 次后断言 `height/display` 终态。
- 新增 `scripts/test-reveal-order.mjs`：断言 `[data-reveal]` 的动画开始时间递增、总时长 ≤ 700ms。
- `scripts/test-list-enter-selection.mjs`：改为覆盖 `computeListDiff`（不依赖 DOM）。
- 新增 `scripts/test-skeleton-transition.mjs`：采样骨架 `opacity` 与内容 `opacity` 的时序（骨架先归零、内容后升起），并断言「400ms 内返回时骨架从未出现」。

### 6.5 列表验收（对应 3.5.1）

| 场景 | 期望 |
|---|---|
| 账户列表首次进入（数据已在 store） | 逐项入场，stagger 可见，不依赖任何 deps |
| 账户新增（尾/头/中间） | 新项淡入 + 位移；**其余行 FLIP 让位**，无瞬移 |
| 删除中间一项 | 该项 160ms 缩小淡出；其余行 FLIP 合拢 |
| 搜索过滤 | 被过滤项不播退场（直接消失），命中项不重播入场 |
| 实例切换分组 | 容器 crossfade（80/140ms），不从顶部逐项重播 |
| 滚动中触发数据变化 | 不播动画，直接落终态，无 transform 残留 |
| 关闭动画 | 全部瞬时，无残留 |

---

## 7. 风险

| 风险 | 规避 |
|---|---|
| 覆盖面变大后整体「太晃」 | 第 5 节语言约束 + 覆盖率清单里显式标注「只做颜色」的项 |
| `Presence` 统一改造触及 30 个对话框 | 只改 `Dialog/Popover/Select/Combobox/ContextMenu/Toast` 六个入口，调用方不动 |
| Reveal 在重页面上掉帧 | 上限 8 块；只标容器不标子项；`data-reveal` 由页面显式标记，不自动扫全树 |
| `Tabs` 指示器 transform 化后宽度测量出错 | 保留宽度过渡，只把位置改 `translate`；指示器是单一元素，重排成本可忽略 |
| 全局门控规则影响依赖 `transitionend` 的组件 | 时长用 `0.01ms` 而非 `0ms`；先验证 Dialog/MorphIcon |
| 毛玻璃在动画期间不模糊、结束才 pop（5.1） | 玻璃只做 opacity、不位移；动画结束即 `queueGlassRepaint()`；根治需 B7 预模糊背景 |
| 玻璃只做 opacity 后「分层感」变弱 | 位移放在非玻璃的内容层（标题/图标/文本），卡片面板本身只淡入；页面 Reveal 仍保留位移 |
| 改动面大 | 按批次独立提交；B0/B1 先合，其余每批可单独回滚 |

---

## 8. 与 v1 的差异

- v1 只列了 5 批、约 12 个场景，未回答「为什么整体看起来没做动画」。
- v2 增加：现有动画清单与叠加诊断、PCL 控件级覆盖模型、**8 类界面 × 50 余个界面的覆盖矩阵**、3 个原语、动效语言约束、覆盖率验收清单。
- v2 保留 v1 的缺陷修复（门控/竞态/叠加），作为 B0「前提修复」，不再单列。
- v2.1 增加 **3.5.1 列表动效专项**：把 `useAnimatedList` 从「deps 驱动 + key 差集」改为「DOM 变更驱动 + 快照 FLIP + 局部退场 + 整组替换判定」，并把该批提前到 B1.5（页面 Reveal 之前），同时新增列表验收场景与 `computeListDiff` 单测。
- v2.2 增加 **3.7.1 骨架→内容溶解**：复用 0 引用的 `ContentTransition.tsx`，改为 `loading → leaving(120ms) → ready(240ms)` 三段式，配普通 div 遮罩营造「沙画浮现」，并给出 10 处接线清单；同时接入 `useDelayedFlag(400)` 防止快速返回时闪骨架。
- v2.3 增加 **5.1 毛玻璃硬约束**：确认 WebView2 下 `backdrop-filter` 在合成层动画期间不重采样，规定「玻璃只做自身 opacity、祖先不位移」，动画结束统一 `queueGlassRepaint()`；固定高度容器允许 overlay 交叉淡入；把骨架溶解独立为 **B1.6**，并新增可选的 **B7 预模糊背景**（根治方案）。
- v2.4 **B7 立项**：新增 [ADR-141](../1-决策记录/ADR-141-毛玻璃改为整页预模糊底并移除卡片级-backdrop-filter.md)，把材质模糊上移到整页静态背景层、卡片去 `backdrop-filter`，拆为 B7.1~B7.4。落地后 5.1 的位移禁令解除，B1.5/B1.6/B2 里的保守参数可恢复。
- v2.5 按反馈修订 B7：背景模糊改为**全窗口静态模糊层**（不动媒体元素，动态壁纸零改动）；液态玻璃下架并迁移到 `frosted`（B7.0，代码暂存）；补动态壁纸的 12px 封顶与三级降级。

---

## 9. 需要确认的决策

1. **页面退出动画**：仍建议不做（理由见 3.9）。若必须做，只能上 View Transitions，需接受首页/实例详情/插件页可能撕裂。
2. **主题切换过渡**：建议不做。
3. **列表整组替换语义**：切换分组时走容器 crossfade（建议，快且不闪），还是逐项「旧项退、新项进」（更"活"，但 60+ 项会掉帧）？
4. **首批范围**：建议 B0 + B1 + B1.5 + B1.6 一次合入。B1.5 修正列表行为，B1.6 修正骨架硬切，两者都不改调用方契约；B2 起才是观感铺开。
5. **B7 材质重构**：已立项，见 [ADR-141](../1-决策记录/ADR-141-毛玻璃改为整页预模糊底并移除卡片级-backdrop-filter.md)。建议与 B0/B1 并行推进——B7.0 先下架液态玻璃，B7.2 一落地，5.1 的「玻璃只做 opacity」禁令即可解除。动态壁纸在 B7.1 必须同批验证（视频 + 动图各跑一遍）。
