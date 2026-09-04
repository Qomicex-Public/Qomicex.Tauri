# ADR-065：主页小组件化：react-grid-layout 编辑模式网格

| 属性 | 内容 |
|---|---|
| 状态 | 已采纳 |
| 日期 | 2026-09-04 |
| 决策者 | AI Agent |

## 背景

原主页 Dashboard.tsx 为固定布局：居中水印 + 右侧绝对定位卡片区（账户/插件槽/公告）+ 底部启动栏。用户需求：像手机桌面一样可添加/移除组件、自定义大小与位置，插件也能创建组件。现有基建：slots.tsx 插件槽注册（dashboard:widgets）、saveSettings 走后端。

## 决策

引入 react-grid-layout 2.2.4（B 方案，用户确认）：cols=4 网格 + 编辑模式（非编辑态禁用拖拽/缩放）。水印/账户/公告/默认实例/启动全部组件化；插件经 dashboard:widgets 槽注册自动成为组件（id=plugin:{pluginId}:{index}）。布局+hidden 标记存 localStorage（qomicex.dashboard.layout.v1），不进后端 settings——纯前端展示偏好，避免动 Rust 类型。新增 src/pages/dashboard/{context,widgets,WidgetGrid}.tsx；i18n 7 语言新增 dashboard.editLayout/editMode/addWidget/resetLayout/done/widget.* 键。编辑模式含：拖动排列、右下/右/下缩放、hover ✕ 隐藏、👁 恢复、恢复默认布局、完成退出。

## 备选方案

### 方案 CSS Grid + HTML5 拖拽（自研，方案 A）
- 优点：零依赖、约 300 行、可控性强
- 缺点：自由拖放/碰撞推挤需大量手写代码，体验细节（placeholder、推挤动画）难以达到库的水平
- 为何不选：用户明确选择网格库的自由拖放推挤体验，且 RGL 2.2.4 peer 声明兼容 React 19、API 全新化（useContainerWidth hook 替代 WidthProvider HOC）

### 方案 gridstack.js
- 优点：框架无关、功能全
- 缺点：非 React 生态、接入成本更高
- 为何不选：React 项目优先选 React 原生生态库

## 影响
- src/pages/Dashboard.tsx 重写为 DashboardProvider + WidgetGrid
- src/pages/dashboard/ 新目录（context/widgets/WidgetGrid/types）
- qomicex-tauri-i18n 7 语言 dashboard.ts 新增键（submodule 单独提交）
- package.json 新增 react-grid-layout ^2.2.4
- src/index.css 新增 .dashboard-grid/.dashboard-editing 编辑态样式

## 修订记录
| 日期 | 版本 | 修改内容 | 修改人 |
|---|---|---|---|
| 2026-09-04 | v1.0 | 初版创建 | AI Agent |

### 2026-09-04 更新
## 修订 (2026-09-04 v1.1)

用户反馈两问题，已修复并复测通过：

1. **无法自由拖动**：原用 `verticalCompactor`（垂直压缩，组件被自动吸附回顶部，类似"自动排列图标"）→ 改为 `noCompactor`（自由放置：拖走后留空隙，其余组件保持原位）。
2. **启动按钮与实例分离**：原拆成 `instance`（实例信息）+ `launch`（启动按钮）两个组件 → 合并回一体 `instance` 组件（图标+实例名+版本+状态+启动按钮，同原版底栏布局），`DEFAULT_WIDGETS` 删除 `launch`，instance 默认 w4 h1（占满整行，minW2 maxH2）。

复测：公告组件自由拖至 y=7 且 y=4~6 留空隙 ✅；instance 卡内含启动按钮（同卡一体）✅；退出编辑态布局持久化 ✅。

i18n：`widget.launch` 键已不再被引用（7 语言文件中保留，作为预留键无害）。


### 2026-09-04 更新
## 修订 (2026-09-04 v1.2)

用户反馈四问题，已修复并浏览器实测通过：

1. **拖动误触发点击**（拖公告弹公告页）：RGL item wrapper 加 `onMouseDownCapture` 记录起点 + `onClickCapture` 位移 >4px（`DRAG_CLICK_SLOP`，配合 RGL 3px drag threshold）则 `stopPropagation+preventDefault`。实测拖公告 y4→y6 无弹窗 ✅。
2. **组件尺寸自适应（新能力）**：`context.tsx` 新增 `WidgetSizeContext`/`useWidgetSize()`（w/h 格数），`WidgetGrid` 每个 item 内用 `WidgetSizeProvider` 包裹。注意：**Provider 不能作为 RGL GridLayout 的直接子元素**（无 DOM，RGL clone child 注入 className/ref 失效 → item 全部消失），必须 DOM div 作直接子元素、Provider 包在内部。resize 松手后生效（onLayoutChange 才更新 layout state）。
3. **各组件自适应规则**：
   - Account：h=1 紧凑（无「账户」label 行、头像 h-8、垂直居中）修溢出圆角；h≥2 完整（label+头像 h-9+副标题行）
   - Announcement：h=1 单行标题；h≥2 显示摘要 `line-clamp-3`
   - Watermark：h=1 单行（标题+副标题 inline）；h≥2 双行大字（h≥3 text-7xl）
   - Instance：compact(h=1) 隐藏状态块、按钮 h-10 px-5、副行只显 gameVersion
4. **AnnouncementCard.tsx 删除**（仅 Dashboard 引用），逻辑搬入 `dashboard/widgets.tsx` 的 `AnnouncementWidget`（保留弹窗/关闭/轮播）。

实测矩阵：拖动无弹窗 ✅ / 公告 h3 摘要出现 ✅ / 账户 h1 无溢出+h2 完整 ✅ / 水印 h1 单行 ✅ / instance w2 隐藏状态块 ✅。


### 2026-09-04 更新
## 修订 (2026-09-04 v1.3)

用户反馈默认组件位置全是从上到下堆叠，丢失原版布局。修复：DEFAULT_WIDGETS 恢复原版主页结构（cols=4 网格内重建）：

- **watermark**：x0 y0 w3 h3（左侧大区，占上方 3/4 宽 × 3 行高）
- **account**：x3 y0 w1 h1（右上角小卡）
- **announcements**：x3 y1 w1 h2（右侧公告列，账户下方）
- **instance**：x0 y3 w4 h1（底部整行实例+启动一体栏）

存储键 `qomicex.dashboard.layout.v1` → `v2`（v1 含旧测试的堆叠布局，直接作废避免用户看到错误默认值；旧键自然遗弃无害）。

实测：水印左大区 771×240 / 右列账户 249×72 → 公告 249×156 / 底部实例栏 1032×72，与原版布局一致 ✅；账户 1 列窄卡（249px）无水平/垂直溢出 ✅。


### 2026-09-04 更新
## 修订 (2026-09-04 v1.4)

用户反馈默认布局实例栏下方有大片空白。原因：rowHeight 固定 72px，4 行网格总高约 348px，视口剩余空间全空白。

修复（WidgetGrid.tsx）：
1. WidgetGrid 根 div `flex min-h-0 flex-1 flex-col`，网格区域包 `flex-1 min-h-0` 容器（areaRef），ResizeObserver + 300ms/1200ms 延迟重测 + window resize 兜底（初始 mount 时测量偏小的时序问题）。
2. `rowHeight = max(56, floor((areaH - (rows+1)*12) / rows))`，`rows = max(4, 布局最低边界)`。
3. 效果：默认 4 行精确填满视口（实例栏底 = 视口底 - 44px 页面 padding）；行数超多时行高 clamp 56px，网格顶部对齐、超出可视区时页面滚动。

实测：viewport 800px → rowHeight 151，instanceBottom 756，blankBelow=44（=p-8 32 + margin 12）✅；10 行布局 rowHeight clamp 56、无溢出 ✅。

注意：编辑模式工具条出现在网格上方时，areaRef 高度自动收缩（flex 布局），行高随之重算 ✅。


### 2026-09-04 更新
## 修订 (2026-09-04 v1.5)

用户反馈三问题，已修复并实测通过：

1. **卡片最小 2x2**：watermark/instance 的 `minW=2` 挡住缩到 1 列。全部组件 minW/minH 放开到 1（1x1 可达），实测 watermark 缩到 {w:1,h:1} ✅。紧凑渲染已有适配（h=1 单行/无 label）。
2. **默认布局大块笨重**：原默认 4 行 → 行高被撑到 151px。改为 8 行细粒度布局（cols=4）：
   - account：x3 y0 w1 h1（右上小卡，69px）
   - announcements：x3 y1 w1 h2（右列）
   - watermark：x1 y2 w2 h4（居中透明区，不占卡片视觉，对应原版居中大水印）
   - instance：x0 y7 w4 h1（底部整行贴边）
3. **1格高度=旧2格**：行高公式加 clamp `min(84, max(64, (areaH-(rows+1)*12)/rows))`，rows 下限从 4 提到 8。800px 视口实测 1 格 = 69px ≈ 旧版 72px ✅；实例栏底 blankBelow=48（页面 padding 32 + margin 12）✅。

存储键 v2 → v3（丢弃旧的 4 行大块布局）。注意：HMR 半更新场景下旧 state 会以新键 persist 造成测试污染（本次测试遇到），真实用户不受影响（正常启动全量加载）。


### 2026-09-04 更新
# 关于页鸣谢数据勘误（2026-09-04）

## 变更

`src/constants/credits.ts` 鸣谢数据修正（用户指认原始描述有误）：

1. **xphost008 移入 SERVICES 鸣谢区**（原误放 REFERENCE_PROJECTS 参考项目——个人不属于"参考项目"）：
   - `{ name: 'xphost008', description: '启动流程参考教程', url: 'https://github.com/xphost008', icon: 'https://github.com/xphost008.png' }`
   - icon 直接使用其 GitHub 头像（服务区 icon 本为 img src，天然支持外链头像）
2. **PCL 更名 PCL-CE**（url 同步改为社区版仓库 PCL-Community/PCL2-CE），description 修正为"模组中文名数据文件来源"
3. `Settings.tsx` REF_DESC_KEYS：删除 xphost008 映射、'PCL' 改 'PCL-CE'→`settings.about.refModCnData`
4. 回滚上轮临时加的 `ReferenceProject.avatar` 字段与渲染分支（xphost008 挪走后无消费者）
5. i18n 7 语言新增 `settings.about.refModCnData`（refLaunchFlow 成为孤儿键保留）

## 关联

- 验证：tsc ✅ / vitepress build ✅ / grep 断言（credits.ts:92、:124；Settings.tsx:117）
- 文档同步：qml-docs `docs/guide/legal.md` 服务致谢表与参考项目表
- 启动流程参考的真实来源：xphost008（https://github.com/xphost008 ，用户证言；GitHub 在线验证因网络不通未完成）
