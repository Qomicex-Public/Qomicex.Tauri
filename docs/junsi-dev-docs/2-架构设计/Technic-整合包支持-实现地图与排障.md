# Technic 整合包支持：实现地图与排障

> 最后更新：2026-10-05（期2 合入后）。本文是 Technic 相关开发的**入口文档**：先读本文定位文件与锚点，再按需读 ADR。
> 关联 ADR：[ADR-102（期1 SingleZip 本地导入）](../1-决策记录/ADR-102-Technic-SingleZip-整合包本地导入-issue-123期1.md)、[ADR-105（期2 资源中心 Technic 源 + 401 归因修正）](../1-决策记录/ADR-105-资源中心-Technic-源-API-模型对齐-后端代理安装与-build-参数-401-归因修正-issue-151.md)、[ADR-106（期2 JarMod）](../1-决策记录/ADR-106-JarMod-支持-非破坏性派生-jar-注入古董包-modpack-jar-issue-180.md)
> 相关 issue：#123（本体，OPEN）、#151（资源中心源，已实现）、#180（JarMod，已实现）、#181（Solder，**未实现 = 期3**）

---

## 0. 一句话现状

| 期 | 内容 | 状态 | 合入提交 |
|---|---|---|---|
| 期1 | SingleZip **本地**导入（zip 含 `bin/modpack.jar`，jar 内**有** version.json） | ✅ 已合入 | 主仓 `20b63d53`(#186) / core `dbd8b70`(#4) |
| 期2-A | 资源中心 **Technic 源**（搜索/详情/一键在线安装） | ✅ 已合入 | 主仓 `732bb176`(#187) / core `4857539`(#5) / i18n #18 |
| 期2-B | **JarMod**（古董包 jar 内**无** version.json） | ✅ 已合入 | 主仓 `a63bf400`(#190) / core `fd1e982`(#6) |
| 期3 | **Solder** 在线分发格式（`url=null` + `solder` 有值） | ❌ **未实现** | 材料已备（见 §9） |

main 当前：`878dc2f5`（#194 ADR 重编号）。**#123/#151/#180/#181 均仍 OPEN**。

---

## 1. 两种 Technic 包形态（先分清这个，否则必走错分支）

判据来自 Technic 详情接口的 `url` 字段：

| 形态 | 判据 | 处理路径 |
|---|---|---|
| **SingleZip（标准）** | `url` 是字符串直链；且 `bin/modpack.jar` 内**有** `version.json` | 期1 管线：读 version.json 定 MC+loader，jar 本体**不注入** |
| **SingleZip（古董）** | `url` 是字符串直链；但 `bin/modpack.jar` 内**无** `version.json` | 期2-B **JarMod** 路径：jar 落盘为 jarmod + 派生 jar |
| **Solder** | `url` 为 `null` 且 `solder` 有值 | **期3 #181，未实现** → 请求安装时返回 `TECHNIC_SOLDER_UNSUPPORTED` |

实测比例（45 个候选）：32 个 SingleZip、13 个 Solder。1.4.7 时代的知名包（tekkit-classic / hexxit / tekkit-legends）**已全部转为 Solder**。

---

## 2. ⚠️ Technic API 实测事实（全部为实测，勿凭印象改）

### 2.1 `build` 参数是硬要求；**401 与 User-Agent 无关**

**期1 报告曾把它错归因到 UA（「必须带 PrismLauncher/9.2」），已推翻。**

- 35 组单一变量矩阵（7 个 build 值 × 5 种 UA 含无 UA）结论：
  - `build` = `multimc` / `xyz` / `abc95`（**字母开头**）→ **200**（任意 UA，含无 UA）
  - `build` = `95` / `1` / `95abc`（数字开头）/ 空 / 缺失 → **401**（任意 UA 都一样）
- 即：**401 的开关是 `build` 参数首字符是否为字母**。实现固定 `build=multimc`（沿用 Prism 同值），UA 用自标识 `Qomicex.Launcher/{version}`（礼貌，非必须；对齐 ADR-025）。

### 2.2 端点形态

| 端点 | 实测行为 |
|---|---|
| `GET /search?q={kw}&build=multimc` | 顶层键是 **`modpacks`**（**不是** `results`）；元素仅 `id`/`name`/`slug`/`url`/`iconUrl`；**固定返回 15 条**，**忽略 `sort`/`page`**；`q` 为空或缺失 → **400** |
| `GET /trending?build=multimc` | 同结构，**20 条**；无关键词时的默认列表（后端自动改走它） |
| `GET /modpack/{slug}?build=multimc` | 完整字段（见 §2.3）；**不存在的 slug → 404**（body `{"error":"Modpack does not exist"}`） |
| `GET /modpack/{数字 id}` | **404** —— 数字 id **不可寻址**，**`slug` 是唯一键** |

`sort`/`page` 传了也不报错，但要清楚**服务端不生效**——这正是不能给用户「排序/翻页」错觉的原因。

### 2.3 详情接口的坑（模型层已吸收，改动前必读）

| 字段 | 实测形态 | 处理 |
|---|---|---|
| `id` | 详情是**数字**、搜索是**字符串** | 自定义 deserializer 归一为 String（`de_string_or_number`） |
| `icon` / `logo` | **对象** `{"url":"..."}` | `TechnicArt` untagged enum，兼容字符串形态 |
| `iconUrl`（列表项） | **可为显式 `null`**（如 arverni-le-livre-darceus） | **必须** null 容忍；`#[serde(default)]` 只覆盖「缺失」不覆盖「null」——live 测试就是抓到这个 |
| `tags` | 形态不稳定：逗号分隔 / 空格分隔 / 显式 `null` | `Option<String>` + `split_tags` 尽力拆分 |
| `serverPackUrl` / `feed` | 可为显式 null | null 容忍 |
| `installs` / `runs` / `ratings` | 数字 | 直接映射 |
| `minecraft` | 字符串，**可能与包内元数据不一致** | 仅作初始提示，真实值以 zip 内元数据为准（在线安装会回写覆盖） |

### 2.4 Solder 端点（期3 用）
`https://solder.technicpack.net/api/` —— **无需 UA、无需 build 参数**（期1 实测）。

---

## 3. 代码地图（三仓 + 锚点行号）

> 行号基于 main `878dc2f5`，改动后会漂移；用**函数名**检索更稳。

### 3.1 core（`qomicex-core-rust`）

| 文件 | 关键项 |
|---|---|
| `src/models/expansion/technic.rs` | `TechnicSearchResponse`:83、`TechnicPackSummary`:91、`TechnicPackDetail`:111、`TechnicArt`:182、`TechnicFeedEntry`:202、`split_tags`:219、`TechnicDistribution`:232、`impl TechnicPackDetail`:241（`distribution()` / `single_zip_url()` / `instance_name()` / `web_url()`） |
| `src/api/expansion.rs` | `trait TechnicSource`（约 :233 起）：`search` / `trending` / `get_pack_detail` |
| `src/services/expansion/technic/query.rs` | `DEFAULT_BASE_URL`:36、**`BUILD_PARAM="multimc"`:39**、`url()`:64、`get_text`:72、`get_json_opt`:100（404→Ok(None)）、`fetch_list`:122、`search`:133、`trending`:146、`get_pack_detail`:150；live 测试 `technic_live_search_and_detail`:243（`#[ignore]`，靠 `QOMICEX_TEST_TECHNIC_API=1` 开） |
| `src/services/jarmod.rs` | `JARMOD_KEYS=["jarmods","jarMods"]`:52、`jarmods_from_json`:67、`derived_jar_path`:93、`resolve_jarmod_path`:101、`ensure_derived_jar`:118、`merge_jars`:159、`copy_entries`:230 |
| `src/services/launch/jvm_args.rs` | `ParsedConfig.jarmods` 字段:69、**派生 jar 选用逻辑**:199-220（`ensure_derived_jar` 调用点）、`parse_game_json` 里 `jarmods_from_json` 解析 |
| `src/core.rs` | `create_technic_source()`（工厂） |

### 3.2 backend（`src-backend/qomicex-backend`）

| 文件 | 关键项 |
|---|---|
| `src/services/technic.rs` | `JARMOD_UNSUPPORTED` 常量:28（**仅留作历史日志识别**，新代码不再产生）、`is_technic_zip`:52、`parse_technic_zip`:100（**分流总入口**）、`read_forge_version`:185（四字段必须全数字）、`read_fml_mcversion`:228、`meta_from_version_json`:251、`detect_loader`:295、`forge_version_from`:363 |
| `src/endpoints/resource_center.rs` | technic 分支：`categories`:701、`loaders`:845、`search_one`:1530、`detail`:1701、`versions`:1938、`version_downloads`:2082；`aggregate_window`:1063、`aggregate_honest_total`:1089、`platforms_for_type`:1098（modpack 含 technic:1101）、`technic_summary_to_item`:2381 |
| `src/endpoints/modpack.rs` | `technic_parse_error`:895、`parse_technic_or_api_error`:909（**三处解析调用统一走它**）、`technic_import`:962、**`technic_import_impl`**:969（本地/在线双路径）、`copy_technic_content`:1372、**`install_technic_jarmod`**:1427、`technic_imports_dir`:1501、`install_direct` 的 `Some("technic")` 分支:2524 |
| `src/endpoints/resource_download.rs` | `classify_zip` 的 `bin/modpack.jar`\|`bin/version.json` 特征 + `technic_pack_meta`（拖拽预览） |
| `src/endpoints/system.rs` | `clear_modpack_temp` / `cache_stats` 纳入 `technic-imports` |

**`TechnicImportRequest` 的安全约束（勿回退）**：`download_url` / `game_version_hint` / `slug` 三字段带 **`#[serde(skip_deserializing)]`**。它们只能由后端填入——`install_direct` 解析直链后交给导入管线。**注释挡不住伪造请求体，必须靠 serde 属性**（这是 CodeRabbit finding，已实测伪造 URL 被丢弃）。

### 3.3 前端

| 文件 | 关键项 |
|---|---|
| `src/pages/ResourceCenter.tsx` | `SOURCES` 含 technic:92、`MODPACK_ONLY_SOURCES=['ftb','technic']`:102、`isModpackOnlySource`:104、`getSourceLabel`:219、`gameVersionSupported`:291（technic 不支持版本筛选）、category Tabs disabled:1479 |
| `src/pages/ResourceDetail.tsx` | `getSourceLabel` 含 technic |
| `src/components/ModpackQuickInstallDialog.tsx` | `isTechnic`:32、跳过版本拉取:66、安装分支:86、UI 文案:199、按钮 disabled:247 |
| `src/components/ModpackInstallDialog.tsx` | `isTechnic`:19 + 同构分支 |
| `src/lib/deepLink.ts` | `ModpackSource`:184（含 technic）、`normalizeModpackSource`:186、**`sourceNeedsFileId`**:210（仅 technic 免 fileId）、install/modpack 解析:275-281 |
| `src/components/DeepLinkHandler.tsx` | `sourceNeedsFileId` 用法:234/254（technic 跳过 resolveModpack） |
| `qomicex-tauri-i18n/src/*/dialogs.ts` | `dialogs.modpackInstall.technicNoVersion`（7 语言；zh-CN:146）——**改文案必须改 submodule** |

---

## 4. 端到端数据流

### 4.1 本地导入（期1 + 期2-B）
```
拖入/选择 zip
 → classify_zip 或 /modpack/parse-path 探测（bin/modpack.jar | bin/version.json）
 → parse_technic_or_api_error（专门错误码）
 → technic_import_impl → 后台任务
     extract → install-game（run_install_pipeline 装 MC+loader）
     → copy-files（剔除 bin/，libraries 落共享目录）
     → 【古董包】install_technic_jarmod：jar→versions/{VDN}/jarmods/modpack.jar
                                    + 版本 JSON 追加 "jarmods":["jarmods/modpack.jar"]
     → finalize
 → 启动时 jvm_args 检测到 jarmods → 合并出 {VDN}-jarmod.jar → 顶替主 jar 进 classpath
```

### 4.2 资源中心在线安装（期2-A）
```
资源中心选 Technic 源 → search（无关键词自动走 /trending）
 → 点安装 → 前端只传 {type:'technic', projectId:slug}（无 fileId）
 → 后端 install_direct：create_technic_source().get_pack_detail(slug)
     url 为字符串 → download_url 交给 technic_import_impl（新增 download 步骤）
     url 为 null + solder → 400 TECHNIC_SOLDER_UNSUPPORTED
 → 下载完成后重新解析 zip 元数据 → 回写实例 gameVersion/loader/modpackSource
```

---

## 5. 「我要改 X → 动哪些文件」（常见任务导航）

| 需求 | 改动点 |
|---|---|
| 新增 Technic 端点字段 | `models/expansion/technic.rs`（模型 + null/类型容忍）→ `query.rs`（如需新请求） |
| 改搜索/详情口径 | `resource_center.rs` 对应分支 + `technic_summary_to_item`；注意 `total` 与分页语义 |
| 新增 Technic 支持的资源类型 | **不支持**——Technic 只有整合包；`platforms_for_type` 只放 modpack 一行 |
| 改错误码 | `modpack.rs::technic_parse_error`（前缀识别表）+ API 文档 `3-API规范/API列表.md` |
| 支持 Solder（期3） | 见 §9 |
| 支持 MultiMC 原生 `jarMods` | `jarmod.rs` 需补「库对象 → maven 落盘路径」解析（**当前只支持字符串数组**，遇到对象会告警） |
| 改导入管线步骤 | `technic_import_impl`（步骤权重表）；**注意本地/在线两路径都要看** |
| 改文案 | `qomicex-tauri-i18n/src/*/dialogs.ts`（submodule，需单独提交推送） |

---

## 6. 已验证的验收方法（可复现）

### 6.1 单测 / 门禁
```bash
# backend（含 technic 20+ 用例、aggregate_window 分页回归）
cargo test --manifest-path src-backend/qomicex-backend/Cargo.toml --bin qomicex-backend
# core（含 technic 18 用例 + jarmod 12 用例）
cargo test --manifest-path qomicex-core-rust/Cargo.toml --lib
# 前端
pnpm run typecheck

# 真实 API 测试（需要外网，默认 #[ignore]）
#   core：QOMICEX_TEST_TECHNIC_API=1 cargo test --manifest-path qomicex-core-rust/Cargo.toml --lib -- --ignored technic_live
```

### 6.2 起后端做行为验证
```powershell
$env:QOMICEX_PORT='5190'; $env:QOMICEX_HOME='<临时目录>'
cargo run --manifest-path src-backend/qomicex-backend/Cargo.toml
# 健康检查
Invoke-WebRequest http://127.0.0.1:5190/api/health
```
**注意**：`QOMICEX_HOME` 必须指向**空的临时目录**，否则会污染真实实例数据。

### 6.3 关键 API 断言（实测通过的样子）
```
GET  /api/resources/search?source=technic&category=modpack&keyword=tekkit
     → total=15、items[0].id 是 slug（如 tekkit-legends）
GET  /api/resources/agrarian-skies?source=technic
     → id="agrarian-skies"（= slug，**不是**数字 id）、source="technic"
POST /api/modpack/install-direct  {type:"technic", projectId:"tekkit-legends"}
     → 400 TECHNIC_SOLDER_UNSUPPORTED
POST /api/modpack/install-direct  {type:"technic", projectId:"no-such-xyz"}
     → 404 MODPACK_NOT_FOUND
POST /api/modpack/install-direct  {type:"technic"}           # 缺 projectId
     → 400 MODPACK_SOURCE_REQUIRED
POST /api/modpack/parse-path  {path:"...f1a-ancient-jarmod-pack.zip"}
     → packType=technic、gameVersion=1.6.4、loader=forge、loaderVersion=9.11.1.965
POST /api/modpack/parse-path  {path:"<无 version.json 且无 fmlversion 的包>"}
     → 400 TECHNIC_ANCIENT_PACK_NO_VERSION
```

### 6.4 真实包端到端（期2 实测记录）
`agrarian-skies` 在线安装（59.8MB，直链 `http://apocgaming.net/mp/AS1-4.1.0.zip`）：
- 结果 `completed` 100%
- `versions/AgrarianSkies/` 落 72 个 mods、`mainClass=net.minecraft.launchwrapper.Launch`
- 实例元数据回写 `1.6.4` / `forge 9.11.1.965` / `modpackSource=technic`
- `bin/` 残壳剔除、**无 pack.zip 泄漏**、`temp/` 清理干净
- 注意：直链主机很慢（实测数百 KB/s，59.8MB 约 8~10 分钟），E2E 要有耐心

---

## 7. 已知限制与陷阱（踩过的坑，别重踩）

1. **Technic 无分页**（固定 15/20 条）→ 聚合的 `total` 收敛到 `MAX_AGGREGATE_FETCH`(200)；**不要**给 Technic 加「排序/翻页」控件。
2. **数字 id 不可寻址** → 一切寻址用 slug；DTO 的 `id` 也必须是 slug（否则详情页收藏写入数字 id、按钮永远显示未收藏——这是修过的真实缺陷）。
3. **列表接口不返回 MC 版本/加载器** → Technic 下**隐藏** `gameVersion` 与 `loader` 筛选控件（后端也不过滤），否则出现「界面显示已筛选、结果却是全量」。
4. **`#[serde(default)]` 不覆盖显式 `null`** → 新增 Technic 字段时若上游可能给 null，必须额外 null 容忍。
5. **serialize default 不能当安全边界** → 后端专用字段必须 `skip_deserializing`。
6. **`Path::starts_with("")` 恒为 true** → `unwrap_or_default()` 当路径前缀会让「清理上传文件」误删用户自己的 zip（已修）。
7. **`cargo fmt` 会重排** → 手改后立刻 fmt，否则 CI `cargo fmt -- --check` 挂。
8. **ADR 编号会被抢** → 分支期间其他人可能占用同号（本次 ADR-104 就撞了）。合并前**重新确认**最高编号；新增从当前最大 +1 起。
9. **submodule 提交顺序** → core/i18n 的 PR 必须先合，主仓 PR 才能把子模块指针指向已合并提交；未合时只能 pin 分支提交（会显示 CONFLICTING）。

---

## 8. JarMod 设计要点（期2-B，改动前必读）

- **绝不改主 jar**：`locator.rs::get_miss_main_jar` 按 `downloads.client.sha1` 强校验，启动前与装完后各跑一次 → 改动会被静默覆盖。
- **派生 jar**：`versions/{VDN}/{VDN}-jarmod.jar`；主 jar 字节不变（有单测断言）。
- **合并顺序**（对齐 Prism `MMCZip`）：jarmod 条目**在先** → 同名取先出现者（jarmod 覆盖原版）→ 原版条目在后且**过滤 `META-INF/`**（签名与老 Forge MANIFEST 冲突）。
- **失败不阻断启动**：合并失败回退原主 jar + 打印原因。
- **新鲜度**：派生 jar 不比任一输入旧时跳过重建。
- **版本 JSON 契约**：`{"jarmods": ["jarmods/modpack.jar"]}`（相对**版本目录**；绝对路径也接受）；键名兼容 MMC 的 `jarMods`。
- **缺失/null/空数组 = 无 jarmod** → 期1 标准包行为逐字不变（关键保证点）。

---

## 9. 期3 #181 Solder 入手点（材料已备齐）

**判据**：`get_pack_detail(slug)` 的 `url == null && solder.is_some()`。当前代码在该处直接返回 `TECHNIC_SOLDER_UNSUPPORTED`（`modpack.rs` 的 `install_direct` technic 分支）。

**现成夹具**（`C:\Project\Qomicex.TestPacks\`，详见其 README）：
- `solder-tekkit-312/mods/`：Tekkit 3.1.2 全部 **30 个 mod zip**（MD5 **全部验证通过**）
- `tekkit.solder-pack.json`：`GET {solder}/modpack/tekkit` 响应 → `builds` 9 个、`recommended=3.1.2`、`latest=3.1.3`
- `tekkit.solder-build.json`：`GET {solder}/modpack/tekkit/3.1.2` 响应 → `minecraft=1.2.5`、`forge=164`、`mods[]` 每项 `name/version/md5/url/filesize`
- 另有 `tekkit-server-3.1.2.zip`（负样本：根为 Tekkit.jar 无 `bin/`，不识别为 SingleZip）

**Solder 端点**：`{solder}/modpack/{slug}` 与 `{solder}/modpack/{slug}/{build}`；**无需 UA / build 参数**。

**已知关键点**：Solder 包是 `minecraft 1.2.5` + `forge 164`（极老），落地要靠 jarmod 机制（期2-B 已就绪）；且 mod 是逐文件下载（30 个 zip，非单个打包）。**注意 Solder URL 里含 `mirror-mods.technicpack.net` CDN**。

---

## 10. 快速自检清单（改 Technic 相关代码后）

- [ ] `cargo fmt`（backend + core 两条）
- [ ] `cargo test --bin qomicex-backend`（technic 用例 + aggregate_window 回归）
- [ ] `cargo test --manifest-path qomicex-core-rust/Cargo.toml --lib`
- [ ] `pnpm run typecheck`
- [ ] 若改了 API/错误码 → 同步 `3-API规范/API列表.md`
- [ ] 若改了文案 → 改 i18n submodule 并单独提交
- [ ] 若改了 core → 主仓子模块指针需指向**已合并**的 core 提交


## 修订记录
| 日期 | 版本 | 修改内容 | 修改人 |
| 2026-10-05 | v1.0 | 初版创建 | AI Agent |

### 2026-10-05 更新
# Technic 整合包支持：实现地图与排障

> 最后更新：2026-10-05（期3 Solder 实现后，feature 分支）。本文是 Technic 相关开发的**入口文档**：先读本文定位文件与锚点，再按需读 ADR。
> 关联 ADR：[ADR-102（期1 SingleZip 本地导入）](../1-决策记录/ADR-102-Technic-SingleZip-整合包本地导入-issue-123期1.md)、[ADR-105（期2 资源中心 Technic 源 + 401 归因修正）](../1-决策记录/ADR-105-资源中心-Technic-源-API-模型对齐-后端代理安装与-build-参数-401-归因修正-issue-151.md)、[ADR-106（期2 JarMod）](../1-决策记录/ADR-106-JarMod-支持-非破坏性派生-jar-注入古董包-modpack-jar-issue-180.md)、[ADR-107（期3 Solder）](../1-决策记录/ADR-107-Technic-Solder-在线分发支持-逐文件下载管线与-jarmod-落地-issue-181.md)
> 相关 issue：#123（本体，OPEN）、#151（资源中心源，已实现）、#180（JarMod，已实现）、#181（Solder，已实现 = 期3）

---

## 0. 一句话现状

| 期 | 内容 | 状态 | 合入提交 |
|---|---|---|---|
| 期1 | SingleZip **本地**导入（zip 含 `bin/modpack.jar`，jar 内**有** version.json） | ✅ 已合入 | 主仓 `20b63d53`(#186) / core `dbd8b70`(#4) |
| 期2-A | 资源中心 **Technic 源**（搜索/详情/一键在线安装） | ✅ 已合入 | 主仓 `732bb176`(#187) / core `4857539`(#5) / i18n #18 |
| 期2-B | **JarMod**（古董包 jar 内**无** version.json） | ✅ 已合入 | 主仓 `a63bf400`(#190) / core `fd1e982`(#6) |
| 期3 | **Solder** 在线分发格式（`url=null` + `solder` 有值） | ✅ **已实现**（ADR-107，feature 分支） | 待 PR |

---

## 1. 三种 Technic 包形态（先分清这个，否则必走错分支）

判据来自 Technic 详情接口的 `url` 字段：

| 形态 | 判据 | 处理路径 |
|---|---|---|
| **SingleZip（标准）** | `url` 是字符串直链；且 `bin/modpack.jar` 内**有** `version.json` | 期1 管线：读 version.json 定 MC+loader，jar 本体**不注入** |
| **SingleZip（古董）** | `url` 是字符串直链；但 `bin/modpack.jar` 内**无** `version.json` | 期2-B **JarMod** 路径：jar 落盘为 jarmod + 派生 jar |
| **Solder** | `url` 为 `null` 且 `solder` 有值 | 期3 **Solder 管线**（ADR-107）：逐文件下载 + jarmod 落地 |

实测比例（45 个候选）：32 个 SingleZip、13 个 Solder。1.4.7 时代的知名包（tekkit-classic / hexxit / tekkit-legends）**已全部转为 Solder**。

---

## 2. ⚠️ Technic API 实测事实（全部为实测，勿凭印象改）

### 2.1 `build` 参数是硬要求；**401 与 User-Agent 无关**

**期1 报告曾把它错归因到 UA（「必须 PrismLauncher/9.2」），已推翻。**

- 35 组单一变量矩阵（7 个 build 值 × 5 种 UA 含无 UA）结论：
  - `build` = `multimc` / `xyz` / `abc95`（**字母开头**）→ **200**（任意 UA，含无 UA）
  - `build` = `95` / `1` / `95abc`（数字开头）/ 空 / 缺失 → **401**（任意 UA 都一样）
- 即：**401 的开关是 `build` 参数首字符是否为字母**。实现固定 `build=multimc`（沿用 Prism 同值），UA 用自标识 `Qomicex.Launcher/{version}`（礼貌，非必须；对齐 ADR-025）。

### 2.2 端点形态

| 端点 | 实测行为 |
|---|---|
| `GET /search?q={kw}&build=multimc` | 顶层键是 **`modpacks`**（**不是** `results`）；元素仅 `id`/`name`/`slug`/`url`/`iconUrl`；**固定返回 15 条**，**忽略 `sort`/`page`**；`q` 为空或缺失 → **400** |
| `GET /trending?build=multimc` | 同结构，**20 条**；无关键词时的默认列表（后端自动改走它） |
| `GET /modpack/{slug}?build=multimc` | 完整字段（见 §2.3）；**不存在的 slug → 404**（body `{"error":"Modpack does not exist"}`） |
| `GET /modpack/{数字 id}` | **404** —— 数字 id **不可寻址**，**`slug` 是唯一键** |

`sort`/`page` 传了也不报错，但要清楚**服务端不生效**——这正是不能给用户「排序/翻页」错觉的原因。

### 2.3 详情接口的坑（模型层已吸收，改动前必读）

| 字段 | 实测形态 | 处理 |
|---|---|---|
| `id` | 详情是**数字**、搜索是**字符串** | 自定义 deserializer 归一为 String（`de_string_or_number`） |
| `icon` / `logo` | **对象** `{"url":"..."}` | `TechnicArt` untagged enum，兼容字符串形态 |
| `iconUrl`（列表项） | **可为显式 `null`**（如 arverni-le-livre-darceus） | **必须** null 容忍；`#[serde(default)]` 只覆盖「缺失」不覆盖「null」——live 测试就是抓到这个 |
| `tags` | 形态不稳定：逗号分隔 / 空格分隔 / 显式 `null` | `Option<String>` + `split_tags` 尽力拆分 |
| `serverPackUrl` / `feed` | 可为显式 null | null 容忍 |
| `installs` / `runs` / `ratings` | 数字 | 直接映射 |
| `minecraft` | 字符串，**可能与包内元数据不一致** | 仅作初始提示，真实值以 zip 内元数据为准（在线安装会回写覆盖） |

### 2.4 Solder 端点（期3 已实现，实测事实保留）

`https://solder.technicpack.net/api/` —— **无需 UA、无需 build 参数**（期1 实测）。

| 端点 | 响应 |
|---|---|
| `GET {solder}/modpack/{slug}` | `{name, display_name, recommended, latest, builds[]}`（builds 降序） |
| `GET {solder}/modpack/{slug}/{build}` | `{minecraft, forge, java, memory, mods[]}`；`mods[]` 每项 `{name, version, md5, url, filesize}` |

**期3 实测补充（Tekkit Classic 3.1.2 真机安装验证）**：
- mod zip 是 **mini minecraft 目录覆盖包**（`mods/*.zip`、`bin/modpack.jar`、`config/`），按 `mods[]` 顺序解压叠加，**后者覆盖前者**（`z-` 前缀配置包排末尾最后覆盖是 Technic 约定）；
- `basemods-*.zip` 内含 `bin/modpack.jar`（1.2.5 时代 Forge/FML 本体分发载体，492 项，`mod_MinecraftForge.class` 在根）；
- `forge=164` 是裸 build 号（1.2.5 无 installer.jar），**Forge 安装器路径不可用**，Forge 本体经 modpack.jar + jarmod 注入。

---

## 3. 代码地图（三仓 + 锚点行号）

> 行号基于 main `878dc2f5` + 期3 改动，改动后会漂移；用**函数名**检索更稳。

### 3.1 core（`qomicex-core-rust`）

| 文件 | 关键项 |
|---|---|
| `src/models/expansion/technic.rs` | `TechnicSearchResponse`:83、`TechnicPackSummary`:91、`TechnicPackDetail`:111、`TechnicArt`:182、`TechnicFeedEntry`:202、`split_tags`:219、`TechnicDistribution`:232、**`TechnicSolderPack`（`selected_build`）/ `TechnicSolderBuild` / `TechnicSolderMod`（期3）**、`impl TechnicPackDetail`（`distribution()` / `single_zip_url()` / `instance_name()` / `web_url()`） |
| `src/api/expansion.rs` | `trait TechnicSource`（约 :233 起）：`search` / `trending` / `get_pack_detail` / **`get_solder_pack` / `get_solder_build`（期3）** |
| `src/services/expansion/technic/query.rs` | `DEFAULT_BASE_URL`:36、**`BUILD_PARAM="multimc"`:39**、`url()`:64、`get_text`:72、`get_json_opt`:100（404→Ok(None)）、`fetch_list`:122、`search`:133、`trending`:146、`get_pack_detail`:150、**`get_solder_pack` / `get_solder_build`（期3，裸 GET 无 build 参数）**；live 测试 `technic_live_search_and_detail` + **`technic_live_solder_endpoints`（期3）** |
| `src/services/jarmod.rs` | `JARMOD_KEYS=["jarmods","jarMods"]`:52、`jarmods_from_json`:67、`derived_jar_path`:93、`resolve_jarmod_path`:101、`ensure_derived_jar`:118、`merge_jars`:159、`copy_entries`:230 |
| `src/services/launch/jvm_args.rs` | `ParsedConfig.jarmods` 字段:69、**派生 jar 选用逻辑**:199-220（`ensure_derived_jar` 调用点）、`parse_game_json` 里 `jarmods_from_json` 解析 |
| `src/core.rs` | `create_technic_source()`（工厂） |

### 3.2 backend（`src-backend/qomicex-backend`）

| 文件 | 关键项 |
|---|---|
| `src/services/technic.rs` | `JARMOD_UNSUPPORTED` 常量:28（**仅留作历史日志识别**，新代码不再产生）、`is_technic_zip`:52、`parse_technic_zip`:100（**分流总入口**）、`read_forge_version`:185（四字段必须全数字）、`read_fml_mcversion`:228、`meta_from_version_json`:251、`detect_loader`:295、`forge_version_from`:363 |
| `src/endpoints/resource_center.rs` | technic 分支：`categories`:701、`loaders`:845、`search_one`:1530、`detail`:1701、`versions`:1938、`version_downloads`:2082；`aggregate_window`:1063、`aggregate_honest_total`:1089、`platforms_for_type`:1098（modpack 含 technic:1101）、`technic_summary_to_item`:2381 |
| `src/endpoints/modpack.rs` | `technic_parse_error`:895、`parse_technic_or_api_error`:909（**三处解析调用统一走它**）、`technic_import`:962、**`technic_import_impl`**:969（本地/在线双路径）、`copy_technic_content`:1372、**`install_technic_jarmod`**:1427、`technic_imports_dir`:1501、**`SolderImportRequest` / `solder_import_impl` / `run_solder_import` / `solder_mod_zip_path`（期3，install_direct technic 分支判 distribution()==Solder 进入）**、install_direct 的 `Some("technic")` 分支 |
| `src/endpoints/resource_download.rs` | `classify_zip` 的 `bin/modpack.jar`\|`bin/version.json` 特征 + `technic_pack_meta`（拖拽预览） |
| `src/endpoints/system.rs` | `clear_modpack_temp` / `cache_stats` 纳入 `technic-imports` |

**`TechnicImportRequest` 的安全约束（勿回退）**：`download_url` / `game_version_hint` / `slug` 三字段带 **`#[serde(skip_deserializing)]`**。它们只能由后端填入——`install_direct` 解析直链后交给导入管线。**注释挡不住伪造请求体，必须靠 serde 属性**（这是 CodeRabbit finding，已实测伪造 URL 被丢弃）。期3 的 `SolderImportRequest` 同一约束：结构体**不经 serde Deserialize**（非 endpoint 请求体），solder 基地址/清单全部后端解析。

### 3.3 前端

| 文件 | 关键项 |
|---|---|
| `src/pages/ResourceCenter.tsx` | `SOURCES` 含 technic:92、`MODPACK_ONLY_SOURCES=['ftb','technic']`:102、`isModpackOnlySource`:104、`getSourceLabel`:219、`gameVersionSupported`:291（technic 不支持版本筛选）、category Tabs disabled:1479 |
| `src/pages/ResourceDetail.tsx` | `getSourceLabel` 含 technic |
| `src/components/ModpackQuickInstallDialog.tsx` | `isTechnic`:32、跳过版本拉取:66、安装分支:86、UI 文案:199、按钮 disabled:247 |
| `src/components/ModpackInstallDialog.tsx` | `isTechnic`:19 + 同构分支 |
| `src/lib/deepLink.ts` | `ModpackSource`:184（含 technic）、`normalizeModpackSource`:186、**`sourceNeedsFileId`**:210（仅 technic 免 fileId）、install/modpack 解析:275-281 |
| `src/components/DeepLinkHandler.tsx` | `sourceNeedsFileId` 用法:234/254（technic 跳过 resolveModpack） |
| `qomicex-tauri-i18n/src/*/dialogs.ts` | `dialogs.modpackInstall.technicNoVersion`（7 语言；zh-CN:146）——**改文案必须改 submodule** |

期3 **前端零改动**：Solder 包安装走同一 `{type:'technic', projectId:slug}` 请求，错误码路径 `TECHNIC_SOLDER_UNSUPPORTED` 自然消失。

---

## 4. 端到端数据流

### 4.1 本地导入（期1 + 期2-B）
```
拖入/选择 zip
 → classify_zip 或 /modpack/parse-path 探测（bin/modpack.jar | bin/version.json）
 → parse_technic_or_api_error（专门错误码）
 → technic_import_impl → 后台任务
     extract → install-game（run_install_pipeline 装 MC+loader）
     → copy-files（剔除 bin/，libraries 落共享目录）
     → 【古董包】install_technic_jarmod：jar→versions/{VDN}/jarmods/modpack.jar
                                    + 版本 JSON 追加 "jarmods":["jarmods/modpack.jar"]
     → finalize
 → 启动时 jvm_args 检测到 jarmods → 合并出 {VDN}-jarmod.jar → 顶替主 jar 进 classpath
```

### 4.2 资源中心在线安装——SingleZip（期2-A）
```
资源中心选 Technic 源 → search（无关键词自动走 /trending）
 → 点安装 → 前端只传 {type:'technic', projectId:slug}（无 fileId）
 → 后端 install_direct：create_technic_source().get_pack_detail(slug)
     url 为字符串 → download_url 交给 technic_import_impl（新增 download 步骤）
 → 下载完成后重新解析 zip 元数据 → 回写实例 gameVersion/loader/modpackSource
```

### 4.3 资源中心在线安装——Solder（期3，ADR-107）
```
install_direct {type:technic, projectId:slug}
 → get_pack_detail(slug).distribution() == Solder
 → solder_import_impl：
     GET {solder}/modpack/{slug}         → selected_build（recommended→latest→末位）
     GET {solder}/modpack/{slug}/{build} → minecraft/forge/mods[]
     建实例（gameVersion=minecraft、loader=forge/164 仅标注、modpackVersion=build）
 → 后台 run_solder_import（6 步，权重 25/5/10/40/15/5）：
     download-mods：download_batch 并行下 30 个 zip（{序号:04}-{清洗名}.zip 保序）
     verify       ：逐文件 MD5（TECHNIC_SOLDER_MD5_MISMATCH 硬失败）
     extract-merge：按清单顺序解压叠加（后者覆盖前者；bin/ 也解出供 jarmod 消费）
     install-game ：run_install_pipeline 装 vanilla MC（loader=None！1.2.5 无 installer）
     copy-files   ：copy_technic_content（顶层 bin/ 不拷）
     jarmod       ：bin/modpack.jar 存在 → install_technic_jarmod（Forge/FML 注入）
```

---

## 5. 「我要改 X → 动哪些文件」（常见任务导航）

| 需求 | 改动点 |
|---|---|
| 新增 Technic 端点字段 | `models/expansion/technic.rs`（模型 + null/类型容忍）→ `query.rs`（如需新请求） |
| 改搜索/详情口径 | `resource_center.rs` 对应分支 + `technic_summary_to_item`；注意 `total` 与分页语义 |
| 新增 Technic 支持的资源类型 | **不支持**——Technic 只有整合包；`platforms_for_type` 只放 modpack 一行 |
| 改错误码 | `modpack.rs::technic_parse_error`（前缀识别表）+ API 文档 `3-API规范/API列表.md` |
| 支持 Solder | **已实现**（ADR-107）：改 build 选择语义 → `TechnicSolderPack::selected_build`；改管线 → `run_solder_import` |
| 支持 MultiMC 原生 `jarMods` | `jarmod.rs` 需补「库对象 → maven 落盘路径」解析（**当前只支持字符串数组**，遇到对象会告警） |
| 改导入管线步骤 | `technic_import_impl`（步骤权重表）；**注意本地/在线两路径都要看** |
| 改文案 | `qomicex-tauri-i18n/src/*/dialogs.ts`（submodule，需单独提交推送） |

---

## 6. 已验证的验收方法（可复现）

### 6.1 单测 / 门禁
```bash
# backend（含 technic 25 用例 + solder 3 用例 + aggregate_window 分页回归）
cargo test --manifest-path src-backend/qomicex-backend/Cargo.toml --bin qomicex-backend
# core（含 technic/solder 12 用例 + jarmod 12 用例）
cargo test --manifest-path qomicex-core-rust/Cargo.toml --lib
# 前端
pnpm run typecheck

# 真实 API 测试（需要外网，默认 #[ignore]）
#   core：QOMICEX_TEST_TECHNIC_API=1 cargo test --manifest-path qomicex-core-rust/Cargo.toml --lib -- --ignored technic
#   （technic_live_search_and_detail + technic_live_solder_endpoints 两条）
```

### 6.2 起后端做行为验证
```powershell
$env:QOMICEX_PORT='5190'; $env:QOMICEX_HOME='<临时目录>'
cargo run --manifest-path src-backend/qomicex-backend/Cargo.toml
# 健康检查
Invoke-WebRequest http://127.0.0.1:5190/api/health
```
**注意**：`QOMICEX_HOME` 必须指向**空的临时目录**，否则会污染真实实例数据。

### 6.3 关键 API 断言（实测通过的样子）
```
GET  /api/resources/search?source=technic&category=modpack&keyword=tekkit
     → total=15、items[0].id 是 slug（如 tekkit-legends）
GET  /api/resources/agrarian-skies?source=technic
     → id="agrarian-skies"（= slug，**不是**数字 id）、source="technic"
POST /api/modpack/install-direct  {type:"technic", projectId:"tekkit", id, gameDir}
     → 200 {instanceId}（Solder 管线受理，后台任务 completed）
POST /api/modpack/install-direct  {type:"technic", projectId:"agrarian-skies", ...}
     → 200 {instanceId}（SingleZip 管线受理，开始下载）
POST /api/modpack/install-direct  {type:"technic", projectId:"no-such-xyz", id, gameDir}
     → 404 MODPACK_NOT_FOUND
POST /api/modpack/install-direct  {type:"technic", id, gameDir}   # 缺 projectId
     → 400 MODPACK_SOURCE_REQUIRED
POST /api/modpack/parse-path  {path:"...f1a-ancient-jarmod-pack.zip"}
     → packType=technic、gameVersion=1.6.4、loader=forge、loaderVersion=9.11.1.965
POST /api/modpack/parse-path  {path:"<无 version.json 且无 fmlversion 的包>"}
     → 400 TECHNIC_ANCIENT_PACK_NO_VERSION
```

### 6.4 真实包端到端记录
**期2（agrarian-skies 59.8MB，SingleZip）**：completed 100%、72 mods、`mainClass=net.minecraft.launchwrapper.Launch`、实例回写 `1.6.4`/`forge 9.11.1.965`/`modpackSource=technic`；`bin/` 残壳剔除、无 pack.zip 泄漏、temp 清理干净。直链主机慢（数百 KB/s，约 8~10 分钟）。

**期3（Tekkit Classic 3.1.2，Solder 真机安装，ADR-107 验收）**：
- 请求受理 200 → 任务 completed 100%（478 files，约 2 分钟：30 zip 并行下载 + MD5 全过 + vanilla 1.2.5 安装 + jarmod 注入）
- 版本隔离目录：`mods/` 548 文件、`config/` 含 `z-tekkit-configs` 覆盖结果（IC2.cfg 等）、`resources/`、`jarmods/modpack.jar`（1285906 字节，与分发 zip 内条目精确一致）
- 版本 JSON 声明 `"jarmods": ["jarmods/modpack.jar"]`；派生 jar 未预生成（启动时才合并，符合期2-B 设计）
- 实例元数据：`gameVersion=1.2.5`、`loader=forge`、`loaderVersion=164`、`modpackVersion=3.1.2`（=recommended）、`modpackSource=technic`、`modpackProjectId=tekkit`
- 负样本全过：无 `bin/` 残壳拷入、无 pack.zip 泄漏、`temp/technic-imports` 清空、坏 slug 仍 404、SingleZip 路径不受影响

---

## 7. 已知限制与陷阱（踩过的坑，别重踩）

1. **Technic 无分页**（固定 15/20 条）→ 聚合的 `total` 收敛到 `MAX_AGGREGATE_FETCH`(200)；**不要**给 Technic 加「排序/翻页」控件。
2. **数字 id 不可寻址** → 一切寻址用 slug；DTO 的 `id` 也必须是 slug（否则详情页收藏写入数字 id、按钮永远显示未收藏——这是修过的真实缺陷）。
3. **列表接口不返回 MC 版本/加载器** → Technic 下**隐藏** `gameVersion` 与 `loader` 筛选控件（后端也不过滤），否则出现「界面显示已筛选、结果却是全量」。
4. **`#[serde(default)]` 不覆盖显式 `null`** → 新增 Technic 字段时若上游可能给 null，必须额外 null 容忍。**期3 又踩一次**：`TechnicSolderMod.md5/url` 首版用 `String + default` 被测试抓到，已改 `Option + de_opt_string_or_number`。
5. **serialize default 不能当安全边界** → 后端专用字段必须 `skip_deserializing`。
6. **`Path::starts_with("")` 恒为 true** → `unwrap_or_default()` 当路径前缀会让「清理上传文件」误删用户自己的 zip（已修）。
7. **`cargo fmt` 会重排** → 手改后立刻 fmt，否则 CI `cargo fmt -- --check` 挂。
8. **ADR 编号会被抢** → 分支期间其他人可能占用同号（本次 ADR-104 就撞了）。合并前**重新确认**最高编号；新增从当前最大 +1 起。
9. **submodule 提交顺序** → core/i18n 的 PR 必须先合，主仓 PR 才能把子模块指针指向已合并提交；未合时只能 pin 分支提交（会显示 CONFLICTING）。
10. **Solder 下载目录可能返回 `0 0`（空 body）** → 管线以实际完成与 MD5 为准，不依赖 filesize 字段（它仅展示用）。

---

## 8. JarMod 设计要点（期2-B，改动前必读）

- **绝不改主 jar**：`locator.rs::get_miss_main_jar` 按 `downloads.client.sha1` 强校验，启动前与装完后各跑一次 → 改动会被静默覆盖。
- **派生 jar**：`versions/{VDN}/{VDN}-jarmod.jar`；主 jar 字节不变（有单测断言）。
- **合并顺序**（对齐 Prism `MMCZip`）：jarmod 条目**在先** → 同名取先出现者（jarmod 覆盖原版）→ 原版条目在后且**过滤 `META-INF/`**（签名与老 Forge MANIFEST 冲突）。
- **失败不阻断启动**：合并失败回退原主 jar + 打印原因。
- **新鲜度**：派生 jar 不比任一输入旧时跳过重建。
- **版本 JSON 契约**：`{"jarmods": ["jarmods/modpack.jar"]}`（相对**版本目录**；绝对路径也接受）；键名兼容 MMC 的 `jarMods`。
- **缺失/null/空数组 = 无 jarmod** → 期1 标准包行为逐字不变（关键保证点）。

---

## 9. Solder 实现要点（期3，ADR-107）

**判据与入口**：`get_pack_detail(slug).distribution() == Solder` → `install_direct` 的 technic 分支进入 `solder_import_impl`。

**Solder 端点**：`{solder}/modpack/{slug}`（build 列表）与 `{solder}/modpack/{slug}/{build}`（build 详情）；**无需 UA / build 参数**。

**关键设计决策**（详见 ADR-107）：
1. **build 选择**：`recommended` → `latest` → builds 末位（降序列表的最旧兜底）；MVP 不露 UI，后续增强。
2. **Forge 落地**：1.2.5 时代 Forge 本体在 basemods zip 的 `bin/modpack.jar`（实测验证），安装管线装 vanilla，jarmod 机制注入；`forge=164` 仅元数据标注。
3. **解压覆盖语义**：按 `mods[]` 数组顺序、**后者覆盖前者**（`z-` 前缀配置包排末尾最后覆盖是 Technic 约定）。
4. **MD5 硬失败**：`TECHNIC_SOLDER_MD5_MISMATCH`，不静默使用损坏分发。
5. **安全**：`SolderImportRequest` 非 serde 请求体；清单/URL/基地址全部后端解析。

**夹具**（`C:\Project\Qomicex.TestPacks\`，详见其 README）：
- `solder-tekkit-312/mods/`：Tekkit 3.1.2 全部 **30 个 mod zip**（MD5 **全部验证通过**）
- `tekkit.solder-pack.json` / `tekkit.solder-build.json`：本地复现 Solder 响应
- `tekkit-server-3.1.2.zip`（负样本：根为 Tekkit.jar 无 `bin/`，不识别为 SingleZip）

---

## 10. 快速自检清单（改 Technic 相关代码后）

- [ ] `cargo fmt`（backend + core 两条）
- [ ] `cargo test --bin qomicex-backend`（technic 用例 + solder 用例 + aggregate_window 回归）
- [ ] `cargo test --manifest-path qomicex-core-rust/Cargo.toml --lib`
- [ ] `pnpm run typecheck`
- [ ] 若改了 API/错误码 → 同步 `3-API规范/API列表.md`
- [ ] 若改了文案 → 改 i18n submodule 并单独提交
- [ ] 若改了 core → 主仓子模块指针需指向**已合并**的 core 提交


## 修订记录
| 日期 | 版本 | 修改内容 | 修改人 |
| 2026-10-05 | v1.0 | 初版创建 | AI Agent |
| 2026-10-05 | v1.1 | 期3 Solder 实现：状态表/端点实测补充/代码地图/数据流 4.3/§9 落地记录/E2E 记录 | AI Agent |

