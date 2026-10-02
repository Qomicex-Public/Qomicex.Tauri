# ADR-094：CurseForge 整合包可选模组安装（#129）

| 属性 | 内容 |
|---|---|
| 状态 | 已采纳 |
| 日期 | 2026-10-02 |
| 决策者 | AI Agent |

## 背景

Issue #129：CF 整合包安装时只装必需模组，用户无法选择可选模组（manifest.json 中 `required: false` 的条目），而这些条目在整合包里往往体积可观（甚至包含服务端包，如实测 88MB 的 "The Long Descent Server Pack.zip"）。

根因：`parse_curseforge_manifest`（src-backend/qomicex-backend/src/endpoints/modpack.rs）解析时直接 `if !required { continue }` 丢弃可选条目；且 `ModpackFileEntry` / `ModpackParseResult` / `ModpackInstallRequest` 三处 DTO 都没有承载"可选"的字段。

关键约束（决定方案形态）：CF 本地导入时管道会**重新解析 zip**（modpack.rs 本地分支），`modpackFiles` 入参在该分支不被读取，因此"用户选了什么"必须以**独立新字段**传进管道，无法塞进 `modpackFiles`。

CF manifest 只提供 `projectID`/`fileID`，没有名称与体积，需要额外一次 CF API 调用补全展示信息。

## 决策

采用「解析全量 + 独立字段承载 + 管道按选择过滤」：

1. **解析层**：`ParsedModpack` 新增 `optional_files`；`parse_curseforge_manifest` 不再丢弃 `required: false`，而是收入可选清单（`required` 缺省仍按必需处理）。Modrinth/Qomicex 无此语义，恒为空。
2. **契约层**：新增 `ModpackOptionalFile` DTO（projectId/fileId/name/size）；`ModpackParseResult` 新增 `optionalFiles`（**`files` 语义不变**，避免破坏在线解析中「files = 包体自身」的双重用途）；`ModpackInstallRequest` 新增 `optionalFileIds`。
3. **向后兼容**：`optionalFileIds` 不传 / 空数组 = 全部不安装，与引入本功能前的行为完全一致。
4. **补全展示信息**：`/modpack/parse`、`/modpack/parse-path` 经 core 的 `cf.get_files_batch`（每批 100）批量补全名称与体积；失败降级为 `projectID:fileID` 占位并 `size=None`，**不阻断解析**。
5. **管道**：在 `parsed` 就绪后、进入文件下载分支前，按选择把命中的可选条目并入 `files`（与必需项同为 `projectID:fileID` 占位），使 CF/QML 两条下载分支**零改动**。
6. **UI**：`ImportDialog` 预览步新增可选模组列表（复选框 + 全选/全不选 + 体积/数量摘要），默认全不勾选。

范围：仅本地导入入口（ImportDialog）、仅 CurseForge、默认全不勾选。

舍弃方案 B（新增独立的懒加载端点 `/modpack/parse-optional`）：多一个端点与一次往返，但 `install` 仍需新增同名字段，"响应零变更"只兑现一半，且解析逻辑分裂两处，净值低于方案 A。

另舍弃「把选择塞进 `modpackFiles` 回传」：CF 本地导入分支不读该字段，物理上不可行。

## 备选方案

### 方案 方案 A：解析全量 + 独立字段 + 管道按选择过滤（已采纳）
- 优点：单一事实来源（以包内 manifest 为准）；本地/在线共用同一套过滤；CF/QML 下载分支零改动；不传参数时行为与改动前逐字一致（向后兼容）；改动集中在 modpack.rs + ImportDialog.tsx
- 缺点：前后端契约新增两个字段；parse 多一次 CF 批量调用（每 100 个 1 次）
- 为何不选：在满足 issue 需求的同时把改动面与回归风险压到最小

### 方案 方案 B：新增独立懒加载端点 /modpack/parse-optional
- 优点：parse 响应零变更；可选清单按需加载，不勾选时无额外开销
- 缺点：多一个端点与一次往返；install 仍须新增 optionalFileIds 字段，"响应零变更"只兑现一半；解析逻辑分裂到两处
- 为何不选：净值低于方案 A

### 方案 把选择塞进既有 modpackFiles 回传
- 优点：无需新增 install 字段
- 缺点：CF 本地导入分支不读取 modpackFiles，选择根本无法到达管道
- 为何不选：物理上不可行

## 影响
- src-backend/qomicex-backend/src/endpoints/modpack.rs：ParsedModpack.optional_files、parse_curseforge_manifest、ModpackOptionalFile、ModpackParseResult.optionalFiles、ModpackInstallRequest.optionalFileIds、enrich_optional_files、apply_optional_selection、run_modpack_pipeline 新增参数、parse/parse_path 注入 State
- src/types/index.ts：ModpackOptionalFile、ModpackParseResult.optionalFiles、ModpackInstallRequest.optionalFileIds
- src/components/ImportDialog.tsx：预览步可选模组列表（全选/全不选/摘要）、选择回传
- qomicex-tauri-i18n/src/*/dialogs.ts：7 语言新增 optionalMods/selectAll/selectNone/optionalSummary 四个键（需在 i18n 子模块单独提交推送）
- API：POST /modpack/parse 与 /modpack/parse-path 响应新增 optionalFiles；POST /modpack/install 请求新增 optionalFileIds（均可选，向后兼容）

## 修订记录
| 日期 | 版本 | 修改内容 | 修改人 |
|---|---|---|---|
| 2026-10-02 | v1.0 | 初版创建 | AI Agent |