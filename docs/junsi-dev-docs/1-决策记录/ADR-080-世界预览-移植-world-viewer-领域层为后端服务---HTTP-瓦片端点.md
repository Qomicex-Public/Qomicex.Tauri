# ADR-080：世界预览：移植 world-viewer 领域层为后端服务 + HTTP 瓦片端点

| 属性 | 内容 |
|---|---|
| 状态 | 已采纳 |
| 日期 | 2026-09-15 |
| 决策者 | AI Agent |

## 背景

实例详情的「存档」tab 只有存档管理（设置/备份/重命名/删除/快速加入），用户无法看到存档里的实际地形。项目内已有同类先例：投影原理图（.litematic）通过 SchematicPreviewDialog + deepslate WebGL 提供 3D 预览，其数据来自后端 /instance/{id}/schematics/assets。

用户已在独立仓库 C:\Project\world-viewer 完成世界预览的原理实现与性能优化（Tauri + React + Leaflet，读 Anvil region 按需渲染 256x256 地图瓦片，含浮雕着色、跨版本区块格式、路径点、高度切层）。该工具用 Tauri 自定义协议 tile:// 传瓦片、Tauri AppState 持有当前世界。

启动器的架构约束与 world-viewer 不同：后端是独立进程（axum），前端经 IPC 管道（release）或 HTTP :5000（dev/CI）访问，不存在 Tauri 侧渲染状态的位置。因此不能直接复制 tile:// 协议方案。

## 决策

把 world-viewer 的 Rust 领域层（nbt/region/render/palette/world/legacy_ids，约 2800 行）移植为 src-backend/qomicex-backend/src/services/world_view/，Tauri AppState 改为后端服务 WorldViewService（Mutex<Option<WorldSession>>），tile:// 自定义协议改为 HTTP 端点：

- POST /api/instance/{id}/world/open   打开存档，返回 WorldInfo
- GET  /api/instance/{id}/world/tile/{key}/{dim}/{z}/{x}/{y}?ymax=N  渲染瓦片 PNG
- POST /api/instance/{id}/world/close  关闭会话释放缓存

移植原则：`crate::` → `super::`，领域逻辑零改动（保留上游注释与测试），只在服务层加后端特有的关注点。

关键设计点：
1. 会话全局单例 + 前端生成的 key 校验：瓦片 URL 携带存档路径哈希 key，后端比对当前会话，不匹配返回 409。避免切换存档后残留瓦片请求渲染出错误世界。
2. 瓦片渲染放 spawn_blocking：zoom 0 单瓦片最多读解析 324 个区块，必须离开 async worker。
3. 空瓦片用 X-Tile-Empty 响应头标记（与上游一致）；CorsLayer::permissive() 已把 expose-headers 设为 *，无需额外 CORS 配置。
4. ymax 用 u32 反序列化：前端沿用上游的「全高」哨兵值 4294967295（u32::MAX），i32 会反序列化失败。
5. 前端 CachedTileLayer（父瓦片缩放占位 + 并发限流 6 + 等待者订阅）原样移植，瓦片 URL 指向 API_BASE。

修复的上游缺陷：上游 ChunkKey 为 (cx, cz) 不含维度，而 render_tile 收下 _dim 却不用。后果是先渲染主世界再请求下界会命中主世界缓存，下界地图显示主世界地形。移植时改为 ChunkKey = (dim, cx, cz)，并新增回归测试 dim_cache_isolation（已实测：还原该缺陷测试 FAILED，修复后 PASSED）。

## 备选方案

### 方案 把 world-viewer 作为独立 crate 引入（submodule 或路径依赖）
- 优点：完全复用、零移植成本，上游更新可直接拉取
- 缺点：world-viewer 的 lib.rs 强依赖 Tauri（AppState/register_as_uri_scheme_protocol/tauri-plugin-dialog），无法在 axum 进程里直接调用；需要先把它重构出无 Tauri 依赖的 core crate
- 为何不选：不选：为一次功能引入跨仓库重构 + submodule 维护成本，且上游仍在快速迭代（3 个 ADR 未落），接口不稳定

### 方案 在 Tauri 侧实现（tile:// 协议照搬）
- 优点：与上游代码形态最接近，改动最小
- 缺点：启动器的世界数据在独立后端进程里（InstanceService/saves 目录解析都在后端），Tauri 侧拿不到实例上下文；且 release 下前端走 IPC 管道，tile:// 协议与现有传输层是两套东西
- 为何不选：不选：破坏现有分层，且需要把存档解析逻辑复制到 Tauri 侧形成第二份

### 方案 前端纯 JS 解析 Anvil + Canvas 渲染（无后端）
- 优点：零后端改动
- 缺点：需在前端重新实现 NBT 解析、三种区块格式、浮雕着色、并行加载；性能与正确性都无法复用已验证的实现
- 为何不选：不选：重复实现且达不到已验证的性能基线

### 方案 移植领域层到后端服务 + HTTP 瓦片端点
- 优点：复用已验证的 Rust 实现与 33 个测试；符合现有分层（后端持数据、前端消费）；零 Tauri 改动；瓦片走既有 IPC/HTTP 传输层
- 缺点：领域层代码在主仓多一份（上游仍在演进，需手工同步）
- 为何不选：采纳：改动局部、可测试、与现有架构一致

## 影响
- src-backend/qomicex-backend/src/services/world_view/{mod,nbt,region,render,palette,world,legacy_ids,testing,ported_tests}.rs：新增（领域层移植 + 服务 + 33 个测试）
- src-backend/qomicex-backend/src/endpoints/world_view.rs：新增 3 个端点
- src-backend/qomicex-backend/src/endpoints/instance_files.rs：新增 pub(crate) instance_saves_dir 供复用
- src-backend/qomicex-backend/src/{app.rs,endpoints/mod.rs,services/mod.rs,state.rs}：接线（merge router + AppState 字段）
- src-backend/qomicex-backend/Cargo.toml：新增 png = "0.17"（瓦片 PNG 编码）
- src/api/world-view.ts：新增（openWorld/closeWorld/tileUrlTemplate/worldKeyOf）
- src/lib/world-tile-layer.ts：新增 CachedTileLayer（父瓦片占位 + 并发限流）
- src/components/WorldPreviewDialog.tsx：新增（Leaflet 地图 + 维度切换 + 高度切层 + 图例 + 状态栏）
- src/components/SaveCard.tsx：hover 按钮 + 右键菜单项「世界预览」
- src/types/index.ts：新增 WorldInfo/WorldDimensionInfo/WorldPlayerInfo/WorldWaypoint
- package.json：新增 leaflet + @types/leaflet
- qomicex-tauri-i18n（submodule，分支 feat/world-preview，commit 78e44c9）：instanceDetail.worldPreview.* + dialogs.save.worldPreview（7 语言）

## 修订记录
| 日期 | 版本 | 修改内容 | 修改人 |
|---|---|---|---|
| 2026-09-15 | v1.0 | 初版创建 | AI Agent |

### 2026-09-16 更新

## 修订记录（补充）

### 2026-09-15：同步上游 world-viewer 三个提交

上游（`C:\Project\world-viewer`）在本功能移植后新增 3 个提交，全部与本项目移植版相关，故一并同步。

| 上游提交 | 类型 | 本项目是否有同样问题 | 处理 |
|---|---|---|---|
| `c9b7466` | fix: 小数 zoom 导致高度切层偶发全黑 | 有（`zoomSnap: 0.25` + `setUrlTemplate→redraw` 同路径） | 覆写 `_clampZoom` 取整 |
| `af8ec7f` | feat: 状态栏显示 Y 坐标与方块信息 | 无此能力 | 新增 `probe` 端点 + 前端 150ms 节流 |
| `fb12ca8` | feat: 高度范围动态适配 | 有（硬编码 0..255，1.20+ 的 Y>255 被截断、负 Y 无法过滤） | `DimensionInfo` 加 `minY/maxY`，`ymax` 改 `i64` |

**移植适配的差异**：上游 `probe_block` 的缓存键是 `(x>>4, z>>4)` 不含维度——这正是本项目在 ADR-080 中已修复的缺陷。移植时使用本项目的三元组 `ChunkKey = (dim, cx, cz)`，未把上游缺陷带进来。

**顺带修复的真 bug**：上游 `fb12ca8` 修掉了 `ymax` 按 `u32` 解析的问题——负值（1.18+ 的 Y=-64）解析失败并静默回退全高，导致负 Y 过滤形同失效。本项目同步采用 `i64`。

**未采纳上游的项**：无。三个提交的功能/修复全部同步，行为与上游对齐。

