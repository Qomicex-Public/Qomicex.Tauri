# ADR-102：Forge 加载器版本获取：Maven 元数据主路径 + 官方源失败回退 BMCLAPI + 缓存非空校验（issue #176）

| 属性 | 内容 |
|---|---|
| 状态 | 已采纳 |
| 日期 | 2026-10-04 |
| 决策者 | AI Agent |

## 背景

## 问题

issue #176：用户报「无法安装 1.12.2-Forge 版本」（QML 0.1.1-beta3.0 / Win11），报错「启动器找不到 Forge 安装器」。

**实测取证**（非推测）：

- 用户日志决定性证据：`2026-10-04T05:48:01.956014Z ERROR install: failed instance=f9cb6445-c04 kind=modpack error=找不到 forge 14.23.5.2860 的安装器`
- 截图交叉印证：整合包卡片「5/10 步完成 / 找不到 forge 14.23.5.2860 的安装器」；手动建实例选 Forge 1.12.2 后版本下拉为空、底部红字「暂无可加载器版本，无法下载」
- 2026-10-04 上游 HTML 实测正常：HTTP 200 / 2,265,186 B / 含 `download-list`
- 复刻 4 条解析正则跑真实 HTML：**355 行 → 355 条解析成功、0 跳过**，含 14.23.5.2860 → 解析器本身无缺陷
- `14.23.5.2860` 三处俱在：HTML 出现 22 次、BMCLAPI 有、maven-metadata 有 → **并非版本不存在**

## 现状缺陷（代码事实）

`qomicex-core-rust/src/services/installers/provider_forge.rs` 中：

1. **官方源无回退**：`get_forge_versions` 的 Official 分支只调 HTML 抓取，失败/解析为空即 `Ok(Vec::new())` 返回空。对比 `get_neoforge_versions` 已有「官方空 → 回退 BMCLAPI」。这解释了社区反馈「把下载源换成 BMCLAPI 可以临时解决」——绕过而非修复。
2. **故障不可观测**：整条链路失败走 `eprintln!` + `Ok(空)`，而 core crate 无 `tracing` 依赖（迁移纪律禁止改其 Cargo.toml），`eprintln` 不进 launcher 日志文件。500 行用户日志里 `找到 N 个版本行` / `未找到版本表格` 一条都没有，等于线上盲区。
3. **缓存可续命坏数据**：命中 24h 内缓存即无条件采信解析结果；一份残缺 HTML / 中断写入会在 24h 内持续把用户锁在「无可用版本」。
4. **数据源本身脆弱**：HTML 抓取依赖页面表格 class、单页 2.27 MB、行内混有 `adfoc.us` 跳转链。

## 未坐实项（诚实边界）

究竟「HTTP 抓取失败/超时」还是「解析为空」触发本次故障，**未能定论**：该 launcher 日志仅 500 行且恰好切掉关键窗口，`eprintln` 又不落盘。故本次修复按「消除整类不稳定 + 可回退 + 可观测」设计，而非修补单一触发点。

## 决策

## 三层修复

### 1. 数据源替换（主路径）

新增 `get_forge_versions_from_maven_metadata`，走 `https://maven.minecraftforge.net/net/minecraftforge/forge/maven-metadata.xml` 解析 `<version>` 列表，按 `{mc_version}-{forge_version}` 严格前缀过滤（故 `1.12.2` 不会误吃 `1.12.20-*`），再拼安装器直链：

```
{base}/{mc}-{ver}/forge-{mc}-{ver}-installer.jar
```

推荐标记由 `promotions_slim.json`（约 4 KB）补齐，取代「在 HTML 行里匹配 `promo-latest`/`promo-recommended` class」的脆弱做法。

官方源策略改为：**Maven 元数据 → HTML 末位回退**（保留旧路径兜底，不删代码）。

**实测支撑**：

| 项 | 结果 |
|---|---|
| 体积 | metadata 211,875 B vs HTML 2,265,186 B（小 **10.7 倍**） |
| 覆盖度 | 1.12.2 / 1.16.5 / 1.20.1 / 1.21 / 1.6.4 与 HTML 分页**逐条相同**（差 0）；1.7.10 为超集（多出 `1.7.10_pre4-*`，旧 HTML 需另一页才可见） |
| 耗时 | 1.2–1.8 s，与 HTML 1.0–1.7 s 相当 |
| 命名健壮性 | `installer.jar` HEAD 全 200，含 `1.7.10-10.13.4.1614-1.7.10`、`1.7.10_pre4-10.12.2.1149-prerelease` 等古怪 artifact |

> 注：初版方案曾假设 `forge-<ver>.jar`，实测 **404**，已修正为 `-installer.jar`。

### 2. 回退链（治本）

`get_forge_versions` 的 Official 分支：元数据与 HTML 双双拿不到非空列表时，回退 BMCLAPI。用 `match` 吞 `Err` 而非 `?`，确保官方链路自身错误（含缓存元数据读取失败）同样不阻断回退。

**回退时必须显式传 `DownloadMirror::Bmclapi`**——该分支用 `mirror` 拼安装器直链，透传 `Official` 会拼出 build 号当版本号的坏链 `.../forge-1.12.2-2860/...`（列表非空但下载必败，比不回退更糟）。此坑由故障注入端到端测试实测捕获。

### 3. 可观测性 + 缓存校验

- 抽出 `read_usable_cached_versions`：命中缓存还须**解析非空**才采信（元数据 / HTML / promotions 三处共用）。
- **不违反迁移纪律**：不往 core 加 `tracing` 依赖，而是在 backend 侧补日志——`endpoints/loader.rs` 列表为空时 `tracing::warn!`（带 gameVersion/loader），`services/install_service.rs` 版本未命中时 `tracing::warn!`（带候选数量、是否换源重试），从而区分「列表为空」与「列表非空但缺该版本」。

## 验证

- core `cargo test --lib`：**51 passed / 0 failed**（新增 8 个用例），连跑 2 遍稳定
- 回归有效性：临时抽掉「解析非空才采信」→ 用例 `cache_with_unparseable_content_is_rejected` **FAILED**（失败点正是该断言）→ 还原后全绿
- backend `cargo test`：**376 passed / 0 failed**
- 端到端（独立端口 5099 + 独立 `QOMICEX_HOME`，不碰用户实例）：
  - 原始场景 `gameVersion=1.12.2&loader=Forge` → 355 个版本，含 14.23.5.2860，链接为 Maven 直链
  - 回归场景 1.20.1 / 1.7.10 / 1.16.5 / `loader=All` 全部 ✅
  - 推荐标记实测精确命中 1.12.2 的 2864(latest) / 2859(recommended)
  - 故障注入（官方源指黑洞）→ 仍返回 355 个版本且链接为 `bmclapi2.bangbang93.com/forge/download/2860`；修复前同一注入下为坏链
- `cargo fmt --check`（core / backend / tauri）全部 exit 0

## 备选方案

### 方案 只做 BMCLAPI 回退（最小改动）
- 优点：改动最小、风险最低，立即消除「官方源抽风即卡死」
- 缺点：未消除脆弱依赖本身：HTML 抓取仍受页面改版影响，会持续触发无谓回退且伴随额外延迟
- 为何不选：未采纳：用户明确要求连带消除不稳定依赖；但该回退仍作为本次的第 2 层保留

### 方案 只换 maven-metadata 主路径
- 优点：按初版方案落地，解决体积与解析脆弱性
- 缺点：保留「官方源失败即空」隐患——若 maven 仓库与 HTML 同时不可达，用户依旧卡死；且缺少可观测性，复发时仍无法定位
- 为何不选：未采纳：问题的一半是「单点失败没有兜底」，只换源不补兜底等于把鸡蛋换了个篮子

### 方案 继续调优 HTML 解析正则
- 优点：不改数据源，改动面局限在解析层
- 缺点：复刻正则跑真实 HTML 得 355/355 全解析成功，解析器并无缺陷，调优属无的放矢
- 为何不选：未采纳：有实证反证——解析器已被证明正确，改它解决不了 HTTP 抓取层的不稳定

### 方案 往 qomicex-core-rust 加 tracing 依赖
- 优点：core 内部失败可直接进日志体系，可观测性最彻底
- 缺点：违反该 crate 的迁移纪律（禁止改 Cargo.toml）
- 为何不选：未采纳：改为在 backend 调用侧补 tracing::warn，在不动 core 依赖的前提下恢复可定位性

## 影响
- qomicex-core-rust/src/services/installers/provider_forge.rs：新增 Maven 元数据抓取/解析、promotions_slim 推荐标记、缓存非空校验（read_usable_cached_versions 三处共用）、官方源三级链；新增 8 个单元测试；模块头登记 3 项「有意偏离源逻辑」
- qomicex-core-rust/src/services/installers/provider.rs：get_forge_versions 文档补回退语义说明
- src-backend/qomicex-backend/src/endpoints/loader.rs：/loader/versions 返回空列表时 tracing::warn（带 gameVersion/loader）
- src-backend/qomicex-backend/src/services/install_service.rs：加载器版本未命中时 tracing::warn（带候选数量、是否换源重试）+ 空链接分支补告警
- 两仓需分别提交：core 为 submodule（qomicex-core-rust），backend 在主仓；主仓需同步 core 子模块指针
- 新增缓存文件（%TEMP%/ForgeVersionCache/）：{mc}_forge_metadata.xml、{mc}_forge_promotions.json（与既有 {mc}_forge.html 并存）
- 行为变更：Forge 版本列表来源由 HTML 抓取改为 Maven 元数据（对外 API 契约不变，仍为 /api/loaders/versions）；1.7.10 会多出 1.7.10_pre4-* 预发布条目（超集）
- 未修复同类风险：其他 8 个加载器（Fabric/Quilt/OptiFine/LiteLoader/Cleanroom/LegacyFabric/Babric）的失败回退策略本次未审计，建议后续单独排查

## 修订记录
| 日期 | 版本 | 修改内容 | 修改人 |
|---|---|---|---|
| 2026-10-04 | v1.0 | 初版创建 | AI Agent |