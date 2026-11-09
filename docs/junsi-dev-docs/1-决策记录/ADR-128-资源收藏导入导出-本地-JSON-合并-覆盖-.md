# ADR-128：资源收藏导入导出（本地 JSON，合并/覆盖）

| 属性 | 内容 |
|---|---|
| 状态 | 已采纳 |
| 日期 | 2026-11-09 |
| 决策者 | AI Agent |

## 背景

issue #293 需要把收藏/收藏夹分享或备份到网盘、gist。当前只有 CRUD（resource_favorites.json + resource_favorite_folders.json），没有导入导出。分享站 share.qomicex.cn 只有单资源 /r/{source}/{projectId} 与房间链接，没有列表路由，跨仓库扩展不可控。

## 决策

导出为本地自描述 JSON（format=qomicex-resource-favorites，version=1，folders 只含被引用项），由系统保存对话框选路径，用户自行上传。导入由系统打开对话框选文件，对话框里选合并或覆盖：合并按 source+id+category 去重且保留本地版本，收藏夹按 id→名称（大小写不敏感）复用/新建并重映射 folderIds；覆盖先把两个 JSON 备份为 .bak，再整体替换（收藏夹 id 重新生成、createdAt 回填）。逻辑集中在 services/resource_favorite_transfer.rs（纯函数 + 单测），端点只做文件 IO 与服务调用，新增 POST /resource-favorites/export 与 /import。

## 备选方案

### 方案 生成 share.qomicex.cn 列表链接
- 优点：一键分享
- 缺点：分享站需新路由与存储，跨仓库排期不可控
- 为何不选：本次只做启动器侧，issue 的 gist/网盘场景用文件即可覆盖

### 方案 前端逐条调用现有 CRUD
- 优点：后端零改动
- 缺点：导入 N 条=N 次请求，覆盖模式无法原子替换，逻辑无单测
- 为何不选：Rust 侧纯函数可测，且能一次落盘

## 影响
- src-backend/qomicex-backend/src/services/resource_favorite_transfer.rs（新增）
- src-backend/qomicex-backend/src/endpoints/resource_center.rs（新增两个端点）
- src-backend/qomicex-backend/src/services/resource_favorite.rs / resource_favorite_folder.rs（bulk 方法）
- src/pages/ResourceCenter.tsx + src/components/FavoriteImportDialog.tsx
- qomicex-tauri-i18n（7 语言文案）

## 修订记录
| 日期 | 版本 | 修改内容 | 修改人 |
|---|---|---|---|
| 2026-11-09 | v1.0 | 初版创建 | AI Agent |