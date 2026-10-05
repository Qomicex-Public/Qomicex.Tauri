# ADR-105：资源中心 Technic 源：API 模型对齐、后端代理安装与 build 参数 401 归因修正（issue #151）

| 属性 | 内容 |
|---|---|
| 状态 | 已采纳 |
| 日期 | 2026-10-05 |
| 决策者 | AI Agent |

## 背景

issue #123 期2 需在资源中心新增 Technic 平台源，支持搜索/详情/一键安装（#151）。期1 已实现 Technic SingleZip 本地导入（ADR-102），在线安装需复用其管线。

调研阶段对 Technic API（api.technicpack.net）做了实测取证，并**修正了期1 HANDOFF 中一条错误的归因**：期1 记录「必须带 User-Agent: PrismLauncher/9.2 否则 401」。本次用 7 个 build 值 × 5 种 UA（含无 UA）共 35 组单一变量矩阵复验，结论是该说法**不成立**——401 的开关是 `build` 参数首字符是否为字母（`multimc`/`xyz`/`abc95` → 200；`95`/`1`/`95abc`/空/缺失 → 401），与 User-Agent 完全无关。期1 误判原因是首次 401 时同时改了两个变量（UA 与 build=95→multimc），成功后把功劳记在了 UA 上。

其它实测结论（均以真实响应为准）：
- 搜索 `GET /search?q=&build=multimc` → 顶层键是 `modpacks`（非 `results`），**固定返回 15 条**且忽略 `sort`/`page`；`q` 为空或缺席 → 400。
- 浏览 `GET /trending?build=multimc` → 同结构，20 条（无关键词时的默认列表）。
- 详情 `GET /modpack/{slug}` → `id` 为**数字**（搜索接口的 `id` 是**字符串**）；`icon`/`logo` 为**对象**（`{"url":...}`）；`tags` 为自由文本且形态不稳定（逗号分隔 / 空格分隔 / 显式 null）；`iconUrl` 可显式为 null。
- **数字 id 不可寻址**：`GET /modpack/{数字}` 返回 404，`slug` 是唯一键。
- 分发判据：`url` 为字符串 = SingleZip 直链；`url` 为 null 且 `solder` 有值 = Solder（期3 #181）。实测 45 个候选中 32 个 SingleZip、13 个 Solder。
- 直链（如 `http://apocgaming.net/mp/AS1-4.1.0.zip`）是普通静态托管，无需 `build`/特殊 UA。

## 决策

**1) 代码归属：放 core**（用户确认）。新增 `api/expansion.rs::TechnicSource` trait + `models/expansion/technic.rs` + `services/expansion/technic/query.rs` + `GameCore::create_technic_source()`，与 modrinth/curseforge/ftb 三源形式统一。虽然 Technic 语义（slug+单直链、无分页）与现有 trait 模型并不完全贴合，但统一入口便于后续维护。

**2) 模型按实测形态建模，并用容忍性反序列化吸收上游不一致**：`id` 用自定义 deserializer 同时接受字符串与数字；`icon`/`logo` 用 untagged enum 接受字符串或对象；`iconUrl`/`url`/`tags`/`serverPackUrl`/`feed` 用 null 容忍 deserializer（`#[serde(default)]` 只覆盖「缺失」，不覆盖「显式 null」——实测 `trending` 里 arverni-le-livre-darceus 的 `iconUrl` 就是显式 null，仅靠 default 会让整个响应解析失败）。

**3) 在线安装：`install-direct` 增 `type=technic`，`projectId` 语义为 slug，且只要求 projectId（无 fileId）**。直链由**后端**调 Technic API 解析后下载（`{BaseDir}/temp/technic-imports/{uuid}/pack.zip`），再复用期1 的 `technic_import_impl` 管线。**不接受前端提交的下载 URL**——否则等于开放「下载任意 URL」的面。任务目录与解压目录**分离**（`task_dir/{pack.zip, extract/}`）。

**4) UI 口径**：technic 仅 `category=modpack`；`categories`/`loaders`/`dependencies` 返回空；`versions` 把「包本身」建模为唯一版本条目（前端无需特判即可复用选版本+安装流程）；Solder 包列表照常显示、点击安装时明确返回 `TECHNIC_SOLDER_UNSUPPORTED`（不静默隐藏真实存在的包）。technic 纳入聚合源（用户确认），如实回报 total 且不伪造分页。

**5) deep-link 支持 `install/modpack?type=technic&projectId=<slug>`**：`ModpackSource` 联合类型扩展 + 新增 `sourceNeedsFileId()` 判定（仅 technic 免 fileId）。

**6) Technic 实例标记为不可原地更新**：`is_updatable_origin` 白名单维持 `modrinth|curseforge`（technic 与 ftb 同待遇）——其平台无「版本 id」可作更新判据。

**7) `build=multimc` 为硬要求，UA 用自标识** `Qomicex.Launcher/{version}`（对齐 ADR-025）。

## 备选方案

### 方案 Technic 客户端放 backend（不新增 core trait）
- 优点：改动集中在一个仓；无需为不匹配的语义（无 fileId/无分页）造抽象；少一个 submodule PR
- 缺点：与 modrinth/cf/ftb 三源的既有形式不统一
- 为何不选：用户选择放 core 以保持形式统一，故未采用

### 方案 前端把 API 解析出的直链传给后端下载
- 优点：实现更直白，后端不用再调一次详情接口
- 缺点：后端将下载前端指定的任意 URL，等于新增 SSRF/任意下载面
- 为何不选：安全性不可接受，拒绝

### 方案 新增独立端点 /modpack/technic/install-online
- 优点：语义最清晰，与期1 的 /modpack/technic/import 并列
- 缺点：重复一套「创建实例 + 注册 tracker + 回滚」样板代码
- 为何不选：复用 install-direct 的既有骨架更省且行为一致

### 方案 列表过滤掉 Solder 包
- 优点：UI 干净，用户不会点到不支持的东西
- 缺点：静默隐藏 13/45 的真实候选，用户以为搜不到该整合包
- 为何不选：改为照常显示 + 安装时明确提示不支持

### 方案 把 technic 的 tags 建模为 String
- 优点：简单
- 缺点：实测 tekkit-legends 的 tags 是显式 null，会整体解析失败
- 为何不选：改为 Option<String> + 尽力拆分

## 影响
- qomicex-core-rust/src/models/expansion/technic.rs（新增：模型 + 分发形态判定 + null/数字容忍 deserializer，18 单测）
- qomicex-core-rust/src/api/expansion.rs（新增 TechnicSource trait）
- qomicex-core-rust/src/services/expansion/technic/query.rs（新增：HTTP 客户端 + build 参数 + env-gated live 测试）
- qomicex-core-rust/src/core.rs（新增 create_technic_source 工厂）
- src-backend/qomicex-backend/src/endpoints/resource_center.rs（technic 源 7 处分支 + platforms_for_type + 聚合源清单）
- src-backend/qomicex-backend/src/endpoints/modpack.rs（install_direct 的 technic 在线分支 + run_technic_import 的 download 段与元数据回写）
- src-backend/qomicex-backend/src/services/install_service.rs（DownloadTarget 类型改 pub(crate)）
- src/pages/ResourceCenter.tsx、src/pages/ResourceDetail.tsx、src/components/ModpackInstallDialog.tsx、src/components/ModpackQuickInstallDialog.tsx、src/components/DeepLinkHandler.tsx、src/lib/deepLink.ts（前端源与安装链路）
- qomicex-tauri-i18n/src/*/dialogs.ts（7 语言新增 technicNoVersion）
- docs/junsi-dev-docs/3-API规范/API列表.md（technic 源与错误码）

## 修订记录
| 日期 | 版本 | 修改内容 | 修改人 |
|---|---|---|---|
| 2026-10-05 | v1.0 | 初版创建 | AI Agent |