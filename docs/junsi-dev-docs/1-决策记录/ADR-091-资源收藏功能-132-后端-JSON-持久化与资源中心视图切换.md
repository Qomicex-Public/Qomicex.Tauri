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