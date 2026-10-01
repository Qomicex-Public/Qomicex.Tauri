# ADR-091：资源收藏功能（#132）后端 JSON 持久化 + 资源中心视图切换

| 属性 | 内容 |
|---|---|
| 状态 | 已采纳 |
| 日期 | 2026-10-01 |
| 决策者 | AI Agent |

## 背景

Issue #132 要求「新增资源收藏功能，以便收集常用模组方便下载」，痛点重复搜索，期望「点击收藏可以到一个单独的分类中找寻」，影响范围列了前端 UI + 后端。

现状（落地前核实）：
- 资源中心 `src/pages/ResourceCenter.tsx` 用页面内本地组件 `ResourceCard` 渲染搜索结果（**不用** `src/components/ModCard.tsx`），分类（mod/modpack/...）只存在于页面状态与 URL query，`ResourceItem`（`src/types/index.ts`）本身没有 `type` 字段。
- 小型 JSON 持久化的既有先例是 `services/instance_group.rs`（`{BaseDir}/data/groups.json` + `Mutex<Vec<_>>`），但该实现**忽略保存错误、非原子写**。
- `state.rs` 的 `AppState` 已注册 `instance_groups`；`endpoints/resource_center.rs` 暴露单个 `Router<SharedState>`，同时服务 HTTP 与 Tauri IPC（IPC 复用同一 Axum Router，新增普通路由无需改传输层）。
- i18n 在 submodule `qomicex-tauri-i18n`，7 语言（zh-CN/zh-TW/zh-HK/en-US/en-GB/ja-JP/ru-RU），zh-CN 为 schema 基准，`types.ts` 用 `DeepStringify` 做编译期多语言结构校验。

用户确认的完整能力范围是「基础收藏 + 收藏夹分组 + 备注 + 自定义标签」，并要求**分两阶段交付**。

## 决策

**存储位置**：后端 JSON 持久化。新增 `services/resource_favorite.rs`，写 `{BaseDir}/data/resource_favorites.json`，沿用 `instance_group.rs` 的 `Mutex<Vec<_>>` 结构，但改进三点：① 修改与保存放在同一锁临界区内（避免并发写互相覆盖）；② 保存走「临时文件 + rename」原子写；③ `save` 返回 `Result` 并向上传播为 `ApiError::internal`，不再吞错。中毒锁用 `into_inner()` 恢复，文件缺失/损坏按空列表启动且不覆盖原文件。

**收藏条目存资源快照**：除唯一键 `source + id + category` 外，同时保存 `title/description/author/iconUrl/downloadCount/categories/projectUrl/slug/latestVersion`，使收藏视图无需任何资源搜索请求即可复用 `ResourceCard` 渲染与安装。列表按服务端生成的 `createdAt`（RFC3339 UTC）降序。

**P2 字段前移落盘**：`folderId` / `note` / `tags` 在 P1 即写入结构（`#[serde(default)]`），P2 只加 UI 与端点，**不需要对既有 JSON 做数据迁移**。

**入口形态**：资源中心顶部新增「搜索 / 收藏（N）」视图切换，保留既有来源 / 分类 Tabs 作**本地过滤器**（`source=all` 时不按来源过滤）。收藏视图：不调搜索接口、不读写 `searchCache`、不拉类别列表；隐藏关键词/排序/游戏版本/加载器/类别筛选/加载更多；`view` 写入 `savedSnapshot` 与 URL（`?view=favorites`），从详情页返回仍停在收藏视图。不参与 `freshEntry` 判定，避免从详情页返回时被误判为「全新进入」而丢掉快照。

**路由**：追加在 `resource_center.rs` 既有 Router 上（`/resource-favorites` 的 GET/POST/DELETE），不改 `app.rs` 与 IPC 传输层。路径用 `/resource-favorites` 而非 `/resources/favorites`，避免与 `/resources/{id}` 通配段争抢同一路径形状；删除的唯一键走 query 参数（避免资源 id/source 中的特殊字符影响路径匹配），三段缺失或全空白返回 400 `INVALID_FAVORITE_KEY`。

**前端状态**：新增 Zustand `src/stores/favoritesStore.ts`（本地已有 `pluginStore.ts` 先例），`load()` 默认只加载一次、支持 `force`；`toggleFavorite()` 先乐观更新、失败回滚并抛出，由调用方 `notify` 提示；`useFavoriteKeys()` 提供 Set 供卡片/详情页 O(1) 判断。

**舍弃的方案**：
- 存储用 localStorage：清 WebView 数据即丢失，且 issue 明确列出「后端」。
- 入口用「收藏」并入 `SOURCES`：`favorites` 会流入 `searchResources` / `cacheKey` / 标签体系 / URL 语义，需处处加 guard 且易漏。
- 入口用独立路由 `/favorites`：需另起页面壳，且与资源中心的来源/分类筛选割裂。
- 只存 `source + id + category` 不存快照：进收藏视图要对每条收藏逐个请求 `getResourceDetail`（N 次网络请求）。

## 备选方案

### 方案 A 后端 JSON + 顶部视图切换（采纳）
- 优点：数据随 BaseDir 持久（换 WebView/清缓存不丢）；与 instance_group 同款落地；收藏视图复用来源/分类筛选；安装行为与分类规则不变
- 缺点：需后端改动（service + 3 路由 + state 注册）；不做跨设备同步
- 为何不选：未说明

### 方案 B 前端 localStorage + 视图切换
- 优点：零后端改动、最快
- 缺点：清 WebView 数据即丢；issue 明确要求涉及后端
- 为何不选：未说明

### 方案 C 后端 JSON + 「收藏」并入来源 Tabs
- 优点：UI 改动更小
- 缺点：favorites 会流入搜索/标签/缓存 key/URL 语义，需处处 guard，容易漏出脏参数
- 为何不选：未说明

### 方案 D 后端 JSON + 独立路由 /favorites
- 优点：完全隔离
- 缺点：多一套页面壳；与资源中心筛选割裂，返回路径复杂
- 为何不选：未说明

## 影响
- 新增 `src-backend/qomicex-backend/src/services/resource_favorite.rs`（服务 + 5 个单测）
- `src-backend/qomicex-backend/src/services/mod.rs`：注册模块
- `src-backend/qomicex-backend/src/state.rs`：`AppState` 增加 `resource_favorites: Arc<ResourceFavoriteService>`
- `src-backend/qomicex-backend/src/endpoints/resource_center.rs`：追加 3 个 handler + 统一路由 + `FavoriteKeyQuery` 校验（2 个单测）
- 新增 `src/stores/favoritesStore.ts`
- `src/types/index.ts`：新增 `ResourceFavorite`
- `src/api/resource.ts`：`listResourceFavorites` / `addResourceFavorite` / `removeResourceFavorite` + `toResourceFavorite` / `toResourceItem`
- `src/pages/ResourceCenter.tsx`：卡片心形按钮、视图切换、收藏视图本地过滤与空态
- `src/pages/ResourceDetail.tsx`：头部收藏 chip
- `qomicex-tauri-i18n`：7 语言 `resource.favorites.*`（单独提交，启动器侧更新 submodule 指针）
- 新增 API：`GET/POST/DELETE /api/resource-favorites`；新增本地文件 `{BaseDir}/data/resource_favorites.json`
- P2（收藏夹分组 / 备注 / 自定义标签）只需加 UI 与端点，无需 JSON 迁移

## 修订记录
| 日期 | 版本 | 修改内容 | 修改人 |
|---|---|---|---|
| 2026-10-01 | v1.0 | 初版创建 | AI Agent |

### 2026-10-01 更新
## 2026-10-01 补充（v1.1）：评审修正 4 项

PR 评审（CodeRabbit）提出 4 条 data-integrity 意见，逐条核对**均为有效**，全部修复。

### 1. 写入侧键裁剪必须与 DELETE 同口径

`POST /resource-favorites` 原先只用 `trim()` 判空，却把**原值**落库；而 `DELETE` 的
`FavoriteKeyQuery::validated()` 会先 `trim` 再精确匹配。结果：形如 `" modrinth "`
的键写进去后**永远无法删除**。

**修法**：写入前统一裁剪，且裁剪实现只有一处 —— `ResourceFavorite::normalize_key()`
（`pub`），端点与落库侧共用，避免两侧口径漂移。

> **契约**：`source` / `id` / `category` 的持久化形态始终是裁剪后的值；三个键段
> 裁剪后为空一律 `400 INVALID_FAVORITE_KEY`。

### 2. 落盘事务性：先落盘、后提交内存

`upsert` / `remove` 原先直接修改锁内的 `Vec`，再调 `save_locked`；若保存失败
（磁盘满 / 权限不足），内存里仍留着**未持久化**的改动 —— 前端已回滚、`GET` 却仍
能读到它、重启后又消失，UI / 内存 / 磁盘三处状态互相矛盾。

**修法**：在**副本**上执行修改 → `save_locked(&next)?` 成功 → 才 `*guard = next`；
`remove` 未命中（无该键）时依旧不触碰磁盘。

### 3. 前端 `load()` 与 mutation 的世代号协调

`load()` 原先无条件用响应覆盖 `favorites` 并置 `loaded: true`。但客户端**没有请求
队列**，`GET /resource-favorites` 与 `POST`/`DELETE` 是彼此独立的请求：若列表请求
取得的是「新增之前」的快照、却在新增成功之后才返回，过期列表会覆盖已成功的乐观
更新；而 `loaded: true` 又让后续 `load()` 直接返回，状态再也修不回来。

**修法**：新增模块级 `mutationEpoch`，`toggleFavorite` 开始与结束各自增一次；
`load()` 发请求前记下世代号，响应回来若已变化则**丢弃该列表且不置 `loaded`**，
交给下一次 `load()` 收敛（自愈）。计数器放在模块作用域而非 store state —— 它不是
渲染依赖，不该触发重渲染。

### 4. 失败只回滚当前键

`toggleFavorite` 失败时原先 `set({ favorites: before })` 整份回滚。但
`ResourceCenter` 的防连点只挡**同一个键**，用户可以在请求 A 未完成时切换资源 B；
若 B 已成功而 A 之后失败，A 的整份回滚会把 B 的改动一起清掉。

**修法**：只恢复/移除本次这个键，其余条目保持当前状态。同时把 `ResourceCenter`
的 `favBusyKey` 单值改为 `Set<string>`：单值时请求 A 完成会把状态置空，从而提前
解除并发请求 B 的忙碌态。

### 验证

| 项 | 结果 |
|---|---|
| `cargo test --bin qomicex-backend` | **289 passed; 0 failed; 2 ignored** |
| 新增 Rust 测试 | `keys_are_trimmed_on_write_and_match_on_delete`、`save_failure_leaves_memory_untouched`（覆盖 upsert 与 remove 两条路径） |
| `cargo fmt -- --check` / clippy（改动文件） | 通过 / 0 警告 |
| `pnpm run typecheck` / `pnpm run build` / `eslint`（改动文件） | 通过 / 通过 / 0 error |
| 浏览器针对性回归（Playwright + mock API） | ① 列表请求延迟 1.2s 期间点击收藏 → 过期空列表到达后仍为已收藏（旧实现会被覆盖）；② A 慢且 500、B 快且 200 并发 → 最终 `["false","true"]`，只回滚 A、B 保留且与服务端一致（旧实现会得到 `["false","false"]`） |

### 回归防护

上面两个浏览器场景是**竞态专用回归**：修复前分别会得到「被覆盖回未收藏」与
`["false","false"]`，可用同一 mock 复现。改前端 store 的 `load()` / `toggleFavorite`
时请连同这两个场景一起复跑。



### 2026-10-01 更新
## 2026-10-01 补充（v1.2）：mutation 在飞时拒绝提交列表，并在其后强制重拉一次

v1.1 只用 `mutationEpoch`（世代号）判断「列表响应是否过期」。评审指出这只覆盖了一半，
且存在另一条**可达**的交错顺序 —— 核对当前代码后确认成立：

1. 首次 `load()` 失败（如后端瞬时 500）→ `loaded` 仍为 `false`；
2. 用户点收藏，mutation 开始（世代号 +1，乐观条目入列）；
3. 此时另一处挂载（例如跳转到资源详情页）再调 `load()`，它取到的世代号**已是最新值**，
   于是 GET 被发在 mutation **之后**；
4. 但服务端尚未落库，该 GET 仍返回旧列表 —— 世代号相同 → 被提交，**乐观条目被抹掉**；
5. POST 随后成功，而原先的「替换」是在列表里找同一个键，键已不在 → 服务端已确认的收藏
   永远进不了列表，**收藏在 UI 上凭空消失**。

> 判断键不足的原因：世代号只能识别「响应早于 mutation 开始」，识别不了
> 「响应发出于 mutation 开始之后、但服务端落库之前」。

### 修法

- 新增 `inFlightMutations` 计数：**有 mutation 在飞时 `load()` 一律不提交列表**（即使
  世代号相同）。这是世代号覆盖不到的那一半。
- 新增 `reloadPending` + `maybeReload()`：任一列表响应被丢弃即登记，等**所有** mutation
  收尾后 `load(true)` 强制重拉一次，收敛到服务端真值 —— 避免「丢弃后没人再拉」。
- 成功路径由「替换」改为「**插入或替换**」：即便该键因任何原因不在当前列表里，服务端
  已确认的条目也必须出现，纯替换会静默丢掉它。
- 按 key 回滚与 `favBusyKeys: Set<string>` 保持不变（v1.1 已修）。

### 回归：场景 C（本条交错，精确控制响应顺序）

| 步骤 | 观测 |
|---|---|
| 首次 GET 返回 500（使 `loaded` 保持 false） | `getCallsAfterMount = 1` |
| 点收藏（POST 延迟 1.8s），乐观为已收藏 | `listPressed = true` |
| 客户端路由到详情页 → 详情页挂载触发第 2 次 GET | `getCallsDuringMutation = 2`（**GET 发在 mutation 在飞时**），返回旧列表 `[]` |
| 该响应到达后 | `chipDuringMutation = true` —— 旧列表**未被提交**（修复前会被抹成未收藏） |
| POST 完成 → mutation 收尾 | `getCallsTotal = 3` —— 第 3 次 GET 即**强制重拉**（修复前不会发生） |
| 最终 | `chipFinal = true`、文案「取消收藏」、服务端含该条目 —— UI 与服务端一致 |

场景 A（响应早于 mutation 开始）与 B（并发回滚）复跑未回归。

### 回归防护

改动 `favoritesStore` 的 `load()` / `toggleFavorite` 时，A / B / C 三个场景需一并复跑：
A 覆盖「响应早于 mutation」，B 覆盖「并发 mutation 的失败回滚」，C 覆盖「响应发出于
mutation 之后但落库之前」+ 强制重拉。

