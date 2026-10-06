# ADR-032：新增文件下载源：Modrinth/CurseForge 文件 CDN 域名重写到 QML Mirror

| 属性 | 内容 |
|---|---|
| 状态 | 已采纳 |
| 日期 | 2026-08-21 |
| 决策者 | AI Agent |

## 背景

用户自建 Modrinth/CurseForge 文件 CDN 镜像（QML Mirror）：modrinth.lenmei233.dpdns.org / mirror.lenmei233.dpdns.org，透传 api key、支持 HTTP/2。需求：在镜像源设置里新增独立于「游戏库下载源(download_source)」与「mod API 镜像(mod_mirror)」的第三个「文件下载源」，把 mod 文件实际下载 CDN 域名按来源重写到镜像——cdn.modrinth.com/cdn-alt.modrinth.com → modrinth.lenmei233.dpdns.org；mediafilez.forgecdn.net → mirror.lenmei233.dpdns.org。仅 Modrinth/CF 文件 CDN 需镜像，Mojang/BMCLAPI 等不受影响。

## 决策

新增设置 download/file_download_source（i32：0=官方源，1=QML Mirror），默认 0，带 serde default。后端在构建 mod 文件下载 URL 的统一点做域名重写（services/file_mirror.rs 的 rewrite_file_cdn，镜像域名作为代码常量）：resource_download /start 与 /download-to、modpack 整合包 mods 各分支（含包包体）。api-key(x-api-key) 判断仍基于重写前的原始 host（镜像透传 key）。镜像域名不在 h1_parallel_hosts 内，自然走 HTTP/2，与「按来源 H1/H2 路由」兼容。前端镜像源面板新增第三选择器「文件下载源」（官方源/QML Mirror），7 语言 i18n。因现有 modSource 中文标签已是「资源下载源」，新选择器命名为「文件下载源」避免混淆。

## 备选方案

### 方案 前端重写 URL 后再调下载接口
- 优点：改动集中在前端逻辑
- 缺点：modpack 安装的 mods/包包体 URL 是后端内部解析（mrpack/CF 反查），前端拿不到，覆盖不全
- 为何不选：选择后端统一重写以全覆盖

### 方案 下载器层通用 URL 重写
- 优点：一处生效
- 缺点：下载器为通用库，不应硬编码 Modrinth/CF 域名业务；且无法按原始 host 判断 api-key
- 为何不选：重写放后端业务层更合适

### 方案 镜像地址做成 UI 可编辑字段
- 优点：改镜像无需改代码
- 缺点：用户明确只要常量，避免多余配置面
- 为何不选：按用户 3 点反馈，域名做代码常量

## 影响
- src-backend：services/file_mirror.rs(新增 rewrite_file_cdn + 4 单测)、settings.rs(file_download_source + get_global_file_download_source)、endpoints/resource_download.rs(start/download-to)、endpoints/modpack.rs(modpack 各分支与包包体)
- 前端：settings.ts(fileDownloadSource)、Settings.tsx(镜像源面板第三选择器)、7 语言 i18n

## 修订记录
| 日期 | 版本 | 修改内容 | 修改人 |
|---|---|---|---|
| 2026-08-21 | v1.0 | 初版创建 | AI Agent |

### 2026-08-21 更新
## 增补：自动选择 + 测速（对齐其他两个源）

- 设置新增 `auto_select_file_download_source: Option<bool>`（默认 None/关闭）。
- 后端新增：
  - `FILE_DOWNLOAD_SOURCES` 常量：(0,官方源,https://cdn.modrinth.com) / (1,QML Mirror,https://modrinth.lenmei233.dpdns.org)。
  - `GET /settings/file-download-sources/ping`（HEAD 测速，返回 `DownloadSourcePing[]`）。
  - `GET /settings/file-download-source/auto-select`（选延迟最低可用源，写 `file_download_source`）。
- 前端：文件下载源选择器与「游戏库下载源 / mod 源」一致——显示测速延迟、刷新按钮、自动选择开关；说明文案面向用户精简为「选择 mod 文件下载用的 CDN：官方源直连原站，QML Mirror 走你的镜像」。7 语言 i18n 同步。
- 说明：官方源 ping 目标用 `cdn.modrinth.com` 根 HEAD；若该站根路径 HEAD 非 2xx 会显示 `--`/不可用，可在真机验证后改用一个真实存在的 CDN 文件路径做 ping。

### 2026-08-21 增补：QML Mirror HK（file_download_source = 2）

新增第二个自建镜像「QML Mirror HK」，行为与源 1 完全一致（仅域名不同）：
- `cdn.modrinth.com`/`cdn-alt.modrinth.com` → `modrinth.qomicex.dpdns.org`
- `mediafilez.forgecdn.net` → `mirror.qomicex.dpdns.org`
- `file_mirror.rs` 的 `rewrite_file_cdn` 按 `file_download_source` 匹配 1→lenmei233 域名、2→qomicex HK 域名，其余值原样返回（新增 1 条单测）。
- `FILE_DOWNLOAD_SOURCES` 新增 `(2, "QML Mirror HK", "https://modrinth.qomicex.dpdns.org")`，自动选择/测速自动覆盖。
- 前端选择器 `[0, 1, 2]`；7 语言 i18n 增加 `resourceDownloadSourceName.2 = 'QML Mirror HK'`。


### 2026-10-06 增补：镜像源 = MCIM 优先 + QML 回退 + 官方兜底，国内默认镜像源

| 属性 | 内容 |
|---|---|
| 状态 | 已采纳 |
| 决策者 | 用户确认（一次性迁移 + 聚合测速两个选项均按推荐执行） |

#### 背景

MCIM（公共镜像）提供 Modrinth/CurseForge 文件镜像。按其官方文档
(mcimirror.top/guide/platform/{files,modrinth,curseforge}) 的覆盖边界与限制：
`cdn.modrinth.com` 与 `edge.forgecdn.net` 可重写到 `mod.mcimirror.top`；
**明确禁止**替换 `mediafilez.forgecdn.net`；文件下载是 302 重定向且「不保证稳定，
优先官方源、失败回退镜像」。实测（reqwest 探针）MCIM 所有路径 HEAD 均 404、
GET 才 200；QML 节点根路径 400/403/超时、真实数据路径 HEAD 200。

#### 决策

- **选项合并**：移除「QML Mirror / QML Mirror HK」两个选项，`file_download_source`
  收敛为两值：0=官方源，1=镜像源（MCIM 优先）。
- **重写规则（rewrite_file_cdn，source=1）**：`cdn.modrinth.com`→MCIM、
  `edge.forgecdn.net`→MCIM；`cdn-alt.modrinth.com`（不在 MCIM 文档覆盖）→QML
  Mirror、`mediafilez.forgecdn.net`（MCIM 禁止）→QML Mirror。
- **运行期容错**：下载器 `mirror_urls` 回退链补 MCIM 主源分支——MCIM 未命中时按
  路径首段区分回退组（`/data/` → QML Modrinth 节点 → 官方 `cdn(-alt).modrinth.com`；
  `/files/` → QML CF 节点 → 官方 `mediafilez`），每个文件独立走完链路才失败。
- **国内默认镜像源**：`default_file_download_source()` 按系统时区偏移 UTC+8 判定，
  serde default 与全新安装共用；无网络探测、不做指纹。
- **一次性迁移**：`apply_file_download_source_migration`（load_settings 内执行，
  纯函数可单测）——旧值 2→1；旧默认 0 且 UTC+8→1；显式标记
  `file_download_source_migrated` 防止用户改回官方源后被反复覆盖。海外用户保持 0。
- **测速/自动选择**：「镜像源」聚合 ping MCIM + QML 全节点（任一可用即可用、
  延迟取最快节点），官方源 ping `cdn.modrinth.com/robots.txt`（根路径恒 404，
  实测 robots.txt HEAD 200）；MCIM 节点用 GET 测速（HEAD 恒 404）。
  auto-select 并行测两源、取延迟最低可用者。

#### 舍弃方案

- **运行时探测选源**：下载前 HEAD 判活再定重写目标——每任务多一次探测、有竞态，
  且静态回退链已由下载器重试机制天然承载，舍弃。
- **只测 MCIM 主源**：MCIM 挂但 QML 活时按钮显示不可用，与故障转移链语义矛盾，舍弃。

#### 影响

- `services/file_mirror.rs`：重写规则 + `mirror_fallback_urls` MCIM 分支（按路径分段）+ 7 单测
- `settings.rs`：时区默认 + 一次性迁移 + `file_download_source_migrated` 字段 + 4 单测
- `endpoints/system.rs`：`FILE_DOWNLOAD_SOURCES` 两值 + 镜像源聚合 ping + auto-select 重写
- 前端 `Settings.tsx` 选择器 `[0,1]`、`api/settings.ts` 注释与默认值
- i18n 子模块 7 语言 `resourceDownloadSourceName`（删索引 2）+ `resourceDownloadSourceDesc`（i18n 仓单独提交 a823e97）
- 调用方（modpack / modpack_update / resource_download / instance）只透传 i32，无需改动
