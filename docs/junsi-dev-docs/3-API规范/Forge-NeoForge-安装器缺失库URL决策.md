# Forge / NeoForge 安装器 — 缺失库下载 URL 决策

## Forge（`qomicex-core-rust/src/services/installers/forge/install.rs`）

`get_miss_forge_libraries` 逐库 URL 决策（1.16.5 Forge 安装 404 修复后行为）：

1. **权威 URL 优先（2026-09 修复，偏离 C# 源）**：install_profile.json 库条目带 `downloads.artifact.{url,sha1}` 时（1.16.5+ 新版安装器）直接采用。根因：C# 源恒丢弃该字段（LibInfo.url/hash 死代码），逐源 HEAD 探测在网络抖动全失败时回退「最后基地址」libraries.minecraft.net，而该源不含 Forge 专属依赖（如 error_prone_annotations 2.1.3）→ 404。sha1 同时供下载后完整性校验。
2. 无 `downloads` 字段（旧版安装器）→ 保持源行为：BaseUrl 含 `|` 时逐源 HEAD 探测（Official 双源：maven.minecraftforge.net → libraries.minecraft.net），全失败取最后基地址。
3. BMCLAPI 模式（sourceId=1）：权威 URL 直连上游（一般可达）；探测分支经 source_mappings 映射。

⚠️ 已知限制（未改）：`ForgeInstallerBase::resolve_url` 为整串精确匹配，权威 URL 带 Maven 路径不会命中映射（NeoForge 侧同构，存量行为）。

## NeoForge（`neoforge/install.rs`）

`get_libraries_from_json` 一直解析 `downloads.artifact.{url,sha1}`（与 Forge 修复后行为同构），无 `downloads` 时逐源探测。

## 回归测试

`forge::install::tests::miss_forge_libraries_uses_authoritative_url_and_sha1`：构造含 downloads 字段的 install_profile.json，断言 errorprone 条目携带权威 URL+sha1（断言选 sha1——无修复时恒空，必失败）；无 downloads 的库保持探测行为。已验证「没修复时会失败」。