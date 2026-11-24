# ADR-141 毛玻璃改为整页预模糊底，移除卡片级 backdrop-filter

状态：已批准，待实施
日期：2026-11-24
关联：[动画系统](../2-架构设计/动画系统.md)、[UI 动画优化方案](../6-UI/UI动画优化方案.md) 5.1、ADR-035（glassEffect/glassBlur）、ADR-036（组件材质）、ADR-042（glass-surface 接入）、ADR-075（亮色液态玻璃）、issue #327

## 背景

`data-material` 四档材质（毛玻璃 / 亚克力 / Aero / 液态）依赖 `.glass-surface` 上的 `backdrop-filter` 逐元素采样背景。在 WebView2（Chromium）下，只要元素或任意祖先被 transform / 3D / 祖先 opacity 提升为独立合成层，合成器就不再逐帧重采样 backdrop，只在层重建时刷新一次。

后果（用户实测 + issue #327 既有结论）：

1. 动画播放期间卡片完全不模糊，动画结束或鼠标移入触发重绘后模糊「跳」出来。
2. 仓库现有 `src/hooks/useGlassRepaint.ts` 用 `html.glass-repaint` + 强制 reflow 补一次重采样，但触发点只有路由切换（0ms / 450ms）、媒体加载、节点新增、材质切换——覆盖不到「动画进行中」，450ms 那个定时器其实是在「猜」动画结束。
3. 这也让动画设计被迫退让：玻璃卡不能位移、不能 scale，大量入场只能做 opacity，分层感被削掉一截。

继续在动画侧规避，只能让 pop 变准时，不能消除。根因在「每张卡片都要在动画里采样背景」这件事本身。

## 决策

把「材质模糊」从**每个玻璃表面**上移到**一整页的静态背景层**，使得参与动画的元素不再持有 `backdrop-filter`。

### 1. 背景层（唯一持有模糊的地方）

- 新增**一层全窗口静态模糊层**：`position: fixed; inset: 0; z-index: 0;`，内容只有一条 `backdrop-filter: blur(effectiveBgBlur) saturate(1.5)`，放在壁纸之后、应用内容之前。
- `materialBlur = material === 'default' ? 0 : glassBlur`；`effectiveBgBlur = max(bgBlur, materialBlur)`；两者都为 0 时不渲染这一层，成本为零。
- 媒体元素（图 / 视频 / 冻结动图）**保持原样**，禁用媒体上的 `filter`（`bgBlur` 也改由这一层承担），避免动图/视频每帧走额外的 filter 通道。
- 移除 `Layout.tsx:251` 内容区外壳的 `backdropFilter`（并入全窗口层），外壳只保留 `bg-background/50` 负责压暗。
- 这一层不做任何动画、不接收指针事件，永远采样正确；卡片/侧栏/标题栏全部落在它之上，因此可以自由位移。

### 1.1 动态壁纸（视频 / 动图 / 冻结帧）适配

这是本 ADR 的硬要求：`backgroundVideoEnabled` 与动图背景用户占比高，不能退化。

| 背景类型 | 渲染方式 | 本方案下的行为 |
|---|---|---|
| 静态图 | `<img>` | 模糊层每帧只算一次，等价于一整张预模糊图 |
| 视频（mp4/webm/ogv/mov） | `<video autoplay loop muted>` | **不改媒体本身**，模糊层对合成后的每一帧做一次全屏 backdrop 采样；浏览器硬解/叠加路径不受 `filter` 打断 |
| 动图（GIF/WebP/APNG） | `<img>` 或 `FrozenAnimation` 的 canvas | 同上；关闭「播放动图」时是静态首帧，成本等于静态图 |
| 无壁纸 | 纯色 | 不渲染模糊层 |

代价与上限：

- 成本从「N 张卡每帧重采样」变成「1 层全屏重采样」，总量下降，但单次是全屏尺寸。4K 视频 + 18px 模糊在中低端 GPU 上仍可能吃力。
- 视频/动图背景时对 `effectiveBgBlur` **封顶 12px**（可通过设置覆盖），并把模糊层标 `will-change: backdrop-filter` 仅在播放中开启。
- 窗口不可见（`document.visibilityState === 'hidden'`）或视频暂停时移除该层，停止无意义采样。
- 若实测某类设备仍掉帧，降级顺序：模糊减半 → 关闭该层并在设置里提示「动态壁纸下组件模糊不可用」→ 仅保留 `bgBlur` 的媒体 `filter`。

### 2. 表面层（不再持有 `backdrop-filter`）

`index.css` 的 `:root[data-material="*"] .glass-surface` 规则改为纯半透明填充 + 边框 + 内高光：

| 材质 | 现状 | 改后 |
|---|---|---|
| default | 半透明填充，无 blur | 不变 |
| frosted | `hsl(card/0.6)` + blur 18px | `hsl(card/0.62)` + 边框 + 内高光 1px |
| acrylic | `0.25` + blur 15px + 顶部高光 | `0.34` + 顶部高光 + 现有阴影 |
| aero | `0.2` + 斜纹 + blur 16px saturate | `0.42` + 斜纹 + 现有内阴影 |
| liquid | quidlass 渲染（canvas/SVG） | **移除候选**，见下节 |

透明度上调用于补偿失去的「折射下方内容」的压低效果；四档之间仍靠透明度、渐变、描边、阴影区分，不再靠 blur 半径。

### 2.1 液态玻璃：暂时下线（移除候选）

- 动机：quidlass 对每张卡做实时位移折射，是当前最重的材质；它与本 ADR 的「静态单层模糊」模型不兼容，留着会挡住 B7 的收益。
- 本期做法（可逆）：设置里**下架 `liquid` 选项**（含预览确认弹窗与性能警告文案），读取到 `componentMaterial === 'liquid'` 时迁移为 `frosted`，`data-material` 不再产出 `liquid`。
- 代码与依赖（`quidlass`、`Card` 的 liquid 分支、`[data-liquid-glass]` CSS、ADR-036/043/075/076）**暂不删除**，等替代方案（预渲染静态模糊 + 位移层）评估完成后再决定；物理移除单独排期。
- 恢复条件：能在不依赖逐卡实时采样的前提下复现折射/位移观感，并且动效不被打破。

### 3. 浮层（不再依赖 `backdrop-filter`）

Dialog / Toast / Dropdown / Menu / Popover 浮在页面内容之上，背景层管不到它们，因此改为「高不透明度 + 阴影 + 描边」表达层级：

- Dialog 内容：`bg-popover/90 → bg-popover`（≥0.95），移除 `backdrop-blur-lg`；模态遮罩 `bg-black/60 backdrop-blur-sm` **保留**（全屏、只做 opacity，且它负责把背景压暗并模糊）。
- Toast / MessageBox Toast：移除 `backdrop-blur-lg`，不透明度 ≥0.94。
- Select / Combobox / Popover / ContextMenu：已是实色 `bg-popover`，只需清理残留 `backdrop-blur-*`。
- 标题栏、侧栏、首页小组件容器：移除 `backdrop-blur-*`，靠 `bg-card/80` 与背景层；侧栏背后就是已模糊的背景，无视觉损失。
- `FpsOverlay` / `LogOverlay` / 世界预览小徽标等不参与动画的小浮层：保留或清理均可，归入收尾清理。

### 4. 重采样兜底

`useGlassRepaint` 保留，但降级为兜底（材质切换、媒体加载、模态遮罩）。动画正确性不再依赖它；`queueGlassRepaint()` 仍由动画原语在结束时调用，覆盖少数保留 `backdrop-filter` 的元素。

## 备选方案

### 每卡片 `background-attachment: fixed` 壁纸副本

- 优点：保留「每张卡按自身位置折射」的效果，且能跟随 transform 正确移动。
- 缺点：`background-attachment: fixed` 在滚动时触发重绘；N 张卡 = N 份壁纸绘制；视频背景无法作为 background-image；与 `content-visibility: auto` 组合行为未定义。
- 为何不选：复杂度与风险都高于收益，且页内卡片背后本来就只有壁纸。

### 动画期间临时关闭 blur，结束后恢复

- 优点：改动最小，绝不出现「半糊」。
- 缺点：pop 依旧存在，只是从「不可预测」变成「可预测」；动画期间材质与静态时不一致，观感上是另一种跳变。
- 为何不选：未解决用户报告的问题。

### `will-change: backdrop-filter` / 逐帧切换 backdrop-filter

- 为何不选：前者不触发重采样；后者每帧强制层重建，必然闪烁且更慢。

### 只给玻璃卡加 `translateZ(0)` 强制独立层

- 为何不选：issue #327 已证伪——独立合成层正是采样失效的原因，不是解法。

## 影响

- **视觉**：卡片不再模糊「其下方的内容」。本应用卡片背后基本只有壁纸与已模糊的背景层，差异集中在浮层（用不透明度补偿）与「内容从卡片下方滚过」的少数场景（sticky 头部无玻璃，不受影响）。
- **性能**：不再有「N 张卡片每帧重采样 backdrop」，列表入场/滚动成本明显下降，低端机与 30fps 档位受益最大。代价是 1 层全屏 backdrop 采样；静态壁纸约等于一张预模糊图，视频/动图则每帧一次全屏模糊。
- **动画**：玻璃卡可以恢复位移/缩放入场，5.1 的「只做 opacity」约束随之解除；`Reveal`、`useAnimatedList`、骨架溶解的参数可回到原设计。
- **设置语义**：`glassBlur` 从「组件背后的模糊半径」变为「整页底的模糊半径」；`bgBlur` 与它取 `max`，设置页文案需同步（两者都为 0 时不渲染模糊层）。
- **动态壁纸**：媒体元素完全不动，不追加 `filter`，视频硬解/叠加路径保持现状；代价是全屏模糊层每帧重采样，按 1.1 的封顶与降级顺序兜住。
- **液态玻璃**：本期下架设置项并迁移存量值到 `frosted`；代码与 `quidlass` 依赖暂存，单独排期决定彻底移除或重做。

## 待排期

- 液态玻璃的物理移除（`quidlass` 依赖、`Card` 分支、`[data-liquid-glass]` CSS、ADR-036/043/075/076 的替代说明），或按「预渲染静态模糊 + 位移层」重做后恢复。
- 动态壁纸下的自适应模糊强度（按 GPU 档位/分辨率自动降到 8/12px）是否要做，取决于实测掉帧数据。
- 模糊层在窗口不可见、视频暂停时的挂起/恢复细节。

## 实施拆分

| 子批 | 内容 | 验收 |
|---|---|---|
| B7.0 | 下架液态玻璃选项（含确认弹窗/警告/文案），存量 `liquid` 迁移为 `frosted` | 设置页无 liquid；旧配置不报错、不白屏 |
| B7.1 | 新增全窗口静态模糊层 `effectiveBgBlur`；移除媒体 `filter` 与内容区外壳 backdropFilter | 四档材质静态观感与改前一致（截图对比）；视频/动图背景行为不变 |
| B7.2 | `.glass-surface` 四档去 blur 并调不透明度；首页小组件、卡片统一 | 页面入场 / 列表插入期间与结束后观感一致，无 pop |
| B7.3 | 浮层去 blur、提高不透明度；模态遮罩保留 | Dialog / Toast / 菜单打开关闭无 pop，可读性不降 |
| B7.4 | 清理残余 `backdrop-blur-*`、设置文案、`useGlassRepaint` 降级为兜底 | 全仓 grep 只剩模态遮罩持有 backdrop-filter |

## 验证

1. 四档材质（去掉 liquid 后三档）× 三场景（静态 / 页面入场中 / 列表插入中）逐帧截图，要求「动画中」与「结束后」一致。
2. 列表 35 卡入场，记录帧时间与掉帧数，对比改前（应明显下降）。
3. 关闭动画、reduced-motion、30fps 档位下均无 `glass-repaint` 闪烁。
4. **动态壁纸专项**：视频（mp4/webm）与动图（GIF/WebP）各跑一遍，记录播放帧率、GPU 占用；模糊封顶 12px 生效；切到后台时模糊层挂起；暂停视频后不持续采样。
5. `default` 材质行为无变化；旧配置 `componentMaterial = liquid` 升级后落到 `frosted` 且无报错。

## 修订记录

| 日期 | 版本 | 修改内容 | 修改人 |
|---|---|---|---|
| 2026-11-24 | v1.0 | 初版创建（立项） | AI Agent |
| 2026-11-24 | v1.1 | 背景模糊改为「全窗口静态模糊层」而非媒体 `filter`，补动态壁纸适配与降级顺序；液态玻璃改列移除候选（下架 + 迁移，代码暂存） | AI Agent |
