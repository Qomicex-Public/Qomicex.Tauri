# ADR-079：processor 下载 URL 复用 maven_to_path（剥离 @type + 多源探测）

| 属性 | 内容 |
|---|---|
| 状态 | 已采纳 |
| 日期 | 2026-09-12 |
| 决策者 | AI Agent |

## 背景

用户要求审查下载 URL。发现 forge_base.rs 的 run_processor 中 processor jar/classpath 下载 URL 是手工 format! 拼接 `{base}/{group→/}/{artifact}/{version}/{artifact}-{version}.jar`，而本地路径走 maven_to_path。两者不一致导致：① 不剥离 `@type` 后缀（`org.ow2.asm:asm-commons:9.3@jar` → `.../9.3@jar/asm-commons-9.3@jar.jar`）；② 不处理 base_url 的 `|` 多源（NeoForge 官方 base_url 含 `|`，拼出畸形 URL → 404）。真机安装器 21.1.176/21.1.250 的 processor jar/classpath 无 `@` 后缀，故 ① 未实际触发；② 是 NeoForge 安装 404 的直接成因。

## 决策

新增 `ForgeInstallerBase::resolve_download_url(base_url, maven_coordinate)`：URL 路径部分复用 `maven_to_path`（自动剥离 `@type`、拼接 classifier），前缀 `base_url`；`base_url` 含 `|` 时逐源拼接 `{base}/{path}` 并 HEAD 探测首个可达者（与 get_miss_*_libraries 语义一致）。run_processor 的 jar 与 classpath 两处下载改用它。补回归测试断言 `@jar` 剥离、普通坐标、classifier 坐标三种情形。

## 备选方案

### 方案 仅在手工拼接中剥离 @
- 优点：改动小
- 缺点：仍留 | 多源隐患；且与本地路径逻辑重复维护
- 为何不选：舍弃

### 方案 新增 resolve_download_url 复用 maven_to_path
- 优点：路径部分与本地路径完全同源；一并处理 | 多源；可单测
- 缺点：无（自动与本地路径一致）
- 为何不选：采纳

## 影响
- qomicex-core-rust/src/services/installers/forge_base.rs

## 修订记录
| 日期 | 版本 | 修改内容 | 修改人 |
|---|---|---|---|
| 2026-09-12 | v1.0 | 初版创建 | AI Agent |