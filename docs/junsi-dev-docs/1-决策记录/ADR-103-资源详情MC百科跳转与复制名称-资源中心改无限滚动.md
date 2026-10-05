# ADR-103：资源详情页 MC百科跳转与复制名称 / 资源中心改无限滚动（issue #188）

| 属性 | 内容 |
|---|---|
| 状态 | 已采纳 |
| 日期 | 2026-10-05 |
| 决策者 | AI Agent |
| 关联 | issue #188、i18n PR Qomicex.Tauri.i18n#19 |

## 背景

资源详情页（`src/pages/ResourceDetail.tsx`）此前只有「原始页面」外链，没有 mod 管理（`ModCard.tsx` 右键菜单「MC百科」，跳 `https://www.mcmod.cn/class/{mcmodId}`）那样直达 mcmod.cn 的入口，也没有复制资源名的入口——用户想复制名称只能手动选中标题，而详情标题在中文环境下渲染成「中文名 | 英文名」两段拼接文本，选中会带上竖线与两段名字。资源中心列表（`src/pages/ResourceCenter.tsx`）采用手动「加载更多」按钮分页（`pageSize=20`）。

Gate 0 预检：`git fetch` 后确认 `origin/main` 上 `ResourceDetail.tsx` 仅消费 `lookupChineseName`、`ResourceCenter.tsx` 仍是按钮式分页（提交 1aa953e 等均无相关改动），上游未实现本需求；`gh issue list` 搜索亦无重复 issue。

技术约束（调研得出，决定了方案形状）：
1. 详情页拿不到 mcmod id：`/api/mcmod/lookup` 只返回 `cnName`（`endpoints/mcmod.rs` 的 `CnNameResponse`），而后端 `McmodData::lookup_with_id()` 早已存在，仅被 `instance_files.rs` 的模组列表 enrich 使用，**未接线到该端点**。
2. 资源中心的滚动发生**内层容器**（`PageShell` 自带 `p-8 overflow-y-auto scroll-fade-mask`），不是 `main`；`useAnimatedList` 的滚动暂停逻辑也是向上找最近 `overflowY: auto|scroll|overlay` 的祖先，可佐证。
3. 聚合分类的 `total` 是各源 total 之**和**（`resource_center.rs` 明确注释「近似」），跨源混合页语义本就近似 → 不能只靠 `items.length < total` 判断有没有下一页。
4. `IntersectionObserver` 在快速滚动下可能在 React 提交 `setLoading(true)` 之前连续回调，纯状态守卫会重复请求同一页。

CLARIFY 阶段与用户确认三项选择：①MC百科——「只在能解析出 mcmod id 时显示按钮，否则不显示」（不做搜索页兜底）；②复制——复制资源原标题 `detail.title`，按钮放标题行右侧；③无限滚动——自动加载替换按钮，底部显示「加载中…」/「已显示全部」，请求失败显示重试按钮。

## 决策

三项变更：

**① 后端补齐 mcmod 词条 id（纯新增字段）**
`GET /api/mcmod/lookup` 响应体由 `{ cnName }` 扩为 `{ cnName, mcmodId }`。handler 改用 `lookup_with_id()`（原为 `lookup()`），并按 `id > 0` 归一：索引里 id 缺失/为 0 时返回 `mcmodId: null`，避免前端拼出 `/class/0`。字段为可选序列化，只读 `cnName` 的现有调用方（`ResourceCenter` 批量中文名、`ResourceDetail` 中文名）零影响，`/mcmod/batch` 保持不变。

**② 详情页：MC百科跳转 + 复制名称**
- 新增 `resolveMcmodEntry(title, slug)`：标题精确命中优先，未中退回 slug（与后端对末尾括号后缀的剥离 fallback 对齐）；与详情请求**并行**、失败静默，`cnName` 与 `mcmodId` 一次拿到。
- `mcmodId` 存在才渲染 Header actions 里的「MC百科」按钮（`BookOpen` + 文案），点击 `openUrl('https://www.mcmod.cn/class/{id}')`；打开失败提示 `dialogs.common.openFailed`。拿不到 id 时不渲染入口。
- 标题行右侧加复制按钮（图标 `Copy`，成功后 800ms `Check` + `text-primary`）：复制 `detail.title`，成功 toast `common.copied`，失败 toast `resourceDetail.copyNameFailed`——剪贴板在非安全上下文/无权限时会 reject，静默失败等于按钮没反应。
- 前端 API 层新增 `lookupChineseEntry()` 返回 `{ cnName, mcmodId }`；`lookupChineseName()` 改为其薄封装，现有调用方无需改动。

**③ 资源中心：手动加载更多 → 无限滚动**
- 底部 `sentinelRef` 哨兵**常驻渲染**（条件渲染会让 IO 目标消失、自动加载断链），状态文案（加载中 / 已显示全部 N 个结果 / 错误+重试）叠在其上。
- IO 的 `root` 取**最近的可滚动祖先**（`PageShell` 自身），`rootMargin: '300px 0px'` 预取；用 viewport 作 root 在内层容器滚动下哨兵永不相交。
- 三重防护：`loadMoreBusyRef` 同步防重入（IO 可能在 `setLoading` 提交前连发）→ 追加按 `source-id` 去重（聚合分页近似，相邻页可能吐同一条）→ `exhausted`（空页或未满 `pageSize` 即到底，不依赖近似 total）。
- 追加失败不再复用整页 `error` 分支（那会把已加载列表整片换成错误页并丢滚动位置），改为 `loadMoreError` 页脚内联提示 + 重试按钮，并暂停自动加载。重试按 `page + 1` 重打失败的那一页（失败时 `setPage` 不执行，页码未推进）。
- i18n 复用既有 `resource.loading` / `resource.allShown` / `resource.retry`；按 814e325「移除无消费方键」的先例删除已成死键的 `resource.loadMore`（7 语言）。

**新增 i18n 键（7 语言，`resourceDetail.ts`）**：`mcmod` / `copyName` / `copyNameFailed`——对齐同文件已有的 `dialogs.mod.mcwiki` 译法（zh「MC百科」/ en「MC Encyclopedia」/ ru「MCWiki」）。

**备选方案与否决理由**：
- MC百科兜底跳 `search.mcmod.cn/s?key={标题}`：用户明确否决——宁可没有入口，也不要点了落到搜索页。
- 保留「加载更多」按钮作 IO 兜底：否决，底部两个入口与「自动加载」意图重复且视觉噪音大。
- 用 `main` 或 viewport 作 IO root：否决，页面滚动在内层 `PageShell`，哨兵不会相交（实测卡死）。
- 保留 `resource.loadMore` 键不删：否决，仓库已有删除死键的先例且键会误导后续维护者。
- 复制中文名（cnName）：否决，非中文环境与中文名缺失时行为不一致，原标题跨语言稳定。

## 备选方案

### 方案 MC百科拿不到 id 时兜底跳 search.mcmod.cn 搜索页
- 优点：任何资源都有入口，用户少一次操作
- 缺点：落到搜索结果页而非词条本身，与 mod 管理体验不一致；用户明确否决
- 为何不选：用户选择「只在能解析出 mcmod id 时显示按钮，否则不显示」——宁缺勿误导

### 方案 后端新增独立端点（如 /mcmod/entry）返回 id，不动现有 lookup 响应
- 优点：现有响应契约零改动
- 缺点：详情页要为同一份数据打两次请求（中文名 + id 本属同一次索引查询），徒增延迟与代码量
- 为何不选：响应加可选字段是向后兼容的纯新增，旧调用方只读 cnName 不受影响

### 方案 无限滚动保留「加载更多」按钮作为 IO 不触发时的兜底
- 优点：IO 异常时用户仍有手动入口
- 缺点：底部同时存在两个入口，与「自动」的意图重复；失败场景已由内联重试覆盖
- 为何不选：失败重试按钮已覆盖「自动加载没工作」的实际可操作场景

### 方案 用 viewport / main 元素作 IntersectionObserver 的 root
- 优点：实现最简单，无需向上找滚动祖先
- 缺点：页面滚动发生在 PageShell 内层容器上，哨兵相对 viewport 永不相交 → 自动加载完全不触发（实测卡死）
- 为何不选：必须用最近的可滚动祖先作 root

### 方案 复制中文名（cnName），无中文名时回退原标题
- 优点：复制用户当前最可能想搜的名字
- 缺点：非中文环境与中文名缺失时行为不一致，且复制结果依赖词库收录情况
- 为何不选：复制原标题跨语言稳定、可预期

## 影响
- src-backend/qomicex-backend/src/endpoints/mcmod.rs（响应体新增 mcmodId，handler 改用 lookup_with_id）
- src/api/mcmod.ts（新增 lookupChineseEntry + McmodLookupResult，lookupChineseName 改为薄封装）
- src/pages/ResourceDetail.tsx（resolveMcmodEntry、useState mcmodId/nameCopied、handleCopyName、handleOpenMcmod、Header MC百科按钮、标题行复制按钮）
- src/pages/ResourceCenter.tsx（exhausted/loadMoreError/sentinelRef/loadMoreBusyRef、doSearch 追加分支去重与失败分流、loadMore/retryLoadMore、IO effect、页脚渲染）
- qomicex-tauri-i18n/src/{zh-CN,zh-TW,zh-HK,en-US,en-GB,ja-JP,ru-RU}/resourceDetail.ts（新增 3 键）与 resource.ts（删除死键 loadMore）
- docs/junsi-dev-docs/3-API规范/API列表.md（第 12 节 mcmod lookup 响应文档）
- docs/junsi-dev-docs/2-架构设计/资源中心流程.md（无限滚动机制、详情页 MC百科/复制说明）

## 修订记录
| 日期 | 版本 | 修改内容 | 修改人 |
|---|---|---|---|
| 2026-10-05 | v1.0 | 初版创建 | AI Agent |