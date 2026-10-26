# ADR-123：受限补全入口改用精确版本文件页，不写回 sidecar（issue #301）

| 属性 | 内容 |
|---|---|
| 状态 | 已采纳 |
| 日期 | 2026-10-25 |
| 决策者 | AI Agent |
| 关联 | issue #301、ADR-118（受限文件阻塞清单） |

## 背景

issue #301：ADR-118 落地后，分发受限文件进 `blocked-mods.json` 并在下载中心进入 `awaiting-files` 等待态，对话框每行只给「打开项目页」`https://www.curseforge.com/projects/{projectId}`。项目页只到项目粒度，用户要自己在 Files 列表里按版本号翻找；NAST 2.2（251 个文件，多个模组存在多版本线）实测极易把旧版下成新版或下错加载器版本。issue 建议改为打开对应版本的下载页，或新增该入口。

实测事实（2026-10-25）：

- `https://www.curseforge.com/projects/1654570/files/9274793` → **HTTP 404**，项目 ID 形式的路径无法定位文件版本（ADR-118 第 6 条的判断成立）。
- `https://www.curseforge.com/minecraft/mc-mods/modular-machinery-community-refoxed/files/9274793` → **HTTP 200**，页面显示 File ID 9274793、1.21.1-0.1.3、`mmcr-neoforge-mc1.21.1-0.1.3.jar`。精确文件页必须建立在项目的**规范网站地址**上。
- CF API `POST /v1/mods`（body `{"modIds":[...]}`）一次即返回每个项目的 `links.websiteUrl` 与 `allowModDistribution`：MMCR（1654570）返回 `websiteUrl=https://www.curseforge.com/minecraft/mc-mods/modular-machinery-community-refoxed`、`allowModDistribution=false`。**不需要**逐项目单查，也不需要维护 `classId → 分类路径` 映射。
- 受限条目本身不带 slug / classId，本地拼不出精确地址；任何方案都至少需要一次上游查询。

阻塞清单共有 6 个写入点（CF 首装、FTB 分支、原地更新、服务端安装等），但读出口只有 `GET /modpack/blocked/{instanceId}` 与两个 submit 出口——在这三处统一补全即可覆盖全部来源，含升级前落盘的旧 sidecar。

## 决策

在 `BlockedModFile` 上新增可选字段 `filePageUrl`，由项目的 `links.websiteUrl` 拼 `/files/{fileId}` 得到，**只在响应里补全，不写回 sidecar**。

1. 字段 `file_page_url: Option<String>`，`#[serde(default, skip_serializing_if = "Option::is_none")]`；**不动 `BLOCKED_SCHEMA_VERSION`**（升版会让 `load_blocked` 丢弃全部待补全项）。旧 sidecar 无该字段时读为 `None`，前端退回项目页，行为与升级前一致。
2. URL 构造抽成纯函数 `cf_file_page_url(website_url, file_id)`：去掉首尾空白与末尾 `/`，只接受 `https://www.curseforge.com/`（含不带 `www`）开头、且 `file_id > 0`。该地址会被交给系统浏览器打开，上游字段一旦被改成任意地址就等于把启动器变成跳转器，因此必须白名单。
3. 解析走 `POST /v1/mods` 批量接口（100 条一批，与 `get_files_batch` 同口径），单次请求超时压到 10 s（不用共享客户端的 30 s）——这只是给按钮补链接，不值得让对话框等半分钟。传输 / HTTP / JSON 失败只打 `tracing::warn` 并退化为空结果，手动补全不依赖 CurseForge 可用。
4. 结果进进程内缓存 `projectId → websiteUrl`；解析到空的项目（已删除 / 审核中 / 无网站地址）缓存空串，避免每次开对话框为注定拿不到的条目再付一次超时。整批失败**不写缓存**：否则一次上游抖动会把这些项目永久钉成「无链接」，此后真实网络下也拿不到。
5. 补全位置放在 `GET /modpack/blocked/{instanceId}` 与两个 submit 出口（共用一个 async helper），且**必须在 `lock_blocked_write` 之外**调用：持锁期间不允许 await。
6. 前端合并为**单按钮**：有 `filePageUrl` 用精确文件页、标签「打开对应版本」，否则退回 `pageUrl`（项目页）。不新增第三列按钮——对话框 `max-w-lg` 下每行已有「项目页 + 选择文件」两个按钮，再加一个会挤压布局。文件名本就是列表标题行，用户可直接核对版本。
7. 合规：只改浏览器导航目标，不触碰 `downloadUrl` / CDN / 分发判定，ADR-118 的红线不变。

## 备选方案

### 方案 写回 sidecar
- 优点：同一实例后续打开对话框零网络、零延迟；submit 响应自然带上字段
- 缺点：为纯展示字段引入锁内 reload + merge + save 的并发写路径；待补全清单是短生命周期状态，补完即消失，收益不抵复杂度
- 为何不选：不采纳：代价高于收益，且进程内缓存已消除重复请求

### 方案 用 slug + classId 拼分类路径
- 优点：不依赖 `links.websiteUrl` 字段是否稳定
- 缺点：受限条目没有 classId，仍需先查 API；还要维护 classId → 分类段映射，成本不低于选定方案
- 为何不选：不采纳：成本更高、维护面更大

### 方案 额外加「直接下载」按钮（`{websiteUrl}/download/{fileId}`）
- 优点：少点一次
- 缺点：该路径对 `allowModDistribution=false` 的行为未验证；文件页本身已有 Download 按钮
- 为何不选：不采纳：收益边际，引入未验证路径

### 方案 仅显示文件名 + 复制按钮（零网络）
- 优点：改动最小，无任何上游依赖
- 缺点：用户仍要自己在项目页 Files 里翻版本，正是 issue 描述的痛点
- 为何不选：不采纳：没有解决「下错版本」

### 方案 跳项目 Files 列表页（`{websiteUrl}/files/all`）
- 优点：比项目首页近一步，零额外字段
- 缺点：仍需人工在列表里找版本，且列表默认按时间排序，多版本线依然易错
- 为何不选：不采纳：只缓解不解决

## 影响
- src-backend/qomicex-backend/src/services/modpack_blocked.rs（新增 `file_page_url` 字段、`cf_file_page_url` / `apply_file_page_urls` 纯函数、`fetch_project_websites` 批量解析与进程内缓存，新增 4 个单测）
- src-backend/qomicex-backend/src/endpoints/modpack.rs（新增 `fill_file_page_urls` helper，接入 `blocked_mods` 与两个 submit 出口）
- src/types/index.ts（`BlockedModFile.filePageUrl?`）
- src/components/BlockedModsDialog.tsx（单按钮，标签随链接类型切换）
- qomicex-tauri-i18n/src/{zh-CN,zh-TW,zh-HK,en-US,en-GB,ja-JP,ru-RU}/dialogs.ts（新增 `openFilePage` 词条 + 改写 `description`，子模块需单独提交）
- docs/junsi-dev-docs/1-决策记录/ADR-118（补引用）

## 修订记录
| 日期 | 版本 | 修改内容 | 修改人 |
|---|---|---|---|
| 2026-10-25 | v1.0 | 初版创建 | AI Agent |
