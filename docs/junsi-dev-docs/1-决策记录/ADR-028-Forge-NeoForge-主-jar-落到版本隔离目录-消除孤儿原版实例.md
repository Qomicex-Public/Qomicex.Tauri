# ADR-028：Forge/NeoForge 主 jar 落到版本隔离目录，消除孤儿原版实例

| 属性 | 内容 |
|---|---|
| 状态 | 已采纳 |
| 日期 | 2026-08-20 |
| 决策者 | AI Agent |

## 背景

安装 Forge/NeoForge（如 1.21.11-NeoForge-21.11.45）时，实例列表会多出一个损坏的"原版"实例。根因：Forge/NeoForge 安装器的 processor {MINECRAFT_JAR} 占位符被硬编码指向共享的 versions/{gameVersion}/{gameVersion}.jar（coreforge_base/forge/install.rs 与 neoforge/install.rs），而 previous fix（commit 51e9cfb）为迁就这个错误路径，把 backend Phase3/5 的主 jar 扫描改为用「原版 id（game_version）」，把 vanilla 客户端 jar 下载到 versions/{game_version}/，并额外写了一版 vanilla JSON 避免目录被标 Corrupted —— 于是 versions/{game_version}/ 成为一个"孤儿"目录出现在实例列表。实际启动器 launch（jvm_args.rs 用 options.version=版本目录名）与 AGENTS.md 路径系统都以 version_dir_name 为基准，正确的做法是让 {MINECRAFT_JAR} 指向版本隔离目录。

## 决策

令 Forge/NeoForge 的主 jar 落在**版本隔离目录** versions/{version_dir_name}/{version_dir_name}.jar：(1) core 侧新增 main_jar_relative_path(version_dir_name)，forge/neoforge 的 install 不再用 game_version 构造 main_jar_path，改用 version_id(=version_dir_name)；(2) backend 撤销 51e9cfb 的 base_json_content 重定向，Phase3/5 用 version_dir_name 的 JSON 扫描，使 vanilla 客户端 jar 落在版本隔离目录；(3) 删除向 versions/{game_version}/ 补写 vanilla JSON 的 hack。效果：不再产生孤儿 vanilla 目录，实例列表不再多出损坏原版实例，且与 launch 及 AGENTS.md 路径系统一致。回归测试 main_jar_relative_path_is_version_isolated_not_vanilla_shared 守护该路径形状（旧实现会 FAIL）。

## 备选方案

### 方案 维持线上游，但补全 versions/{gameVersion} 的 vanilla JSON
- 优点：旧 forge launch 依赖 inheritsFrom 父版本时仍可用
- 缺点：产生孤儿原版实例（正是本次报告的 bug）；与 launch/版本隔离路径系统不一致
- 为何不选：被否：保留 bug 现象

### 方案 让 main_jar_path 继续指向共享 vanilla 目录（现状）
- 优点：改动最小
- 缺点：需在共享目录写 vanilla JSON，实例列表多出损坏原版实例
- 为何不选：被否：保留 bug 现象

### 方案 改 launch 与处理器都绕到别处
- 优点：概念上单一
- 缺点：改动面更大，且与 AGENTS.md 版本隔离约定冲突
- 为何不选：被否：launch 已用 version_dir_name，只需处理器与下载对齐

## 影响
- qomicex-core-rust/src/services/installers/forge_base.rs（新增 main_jar_relative_path + 回归测试）
- qomicex-core-rust/src/services/installers/forge/install.rs、neoforge/install.rs（main_jar_path 改用 version_id）
- src-backend/qomicex-backend/src/services/install_service.rs（回退 base_json_content 到 version_dir_name、删除孤儿 vanilla JSON hack）
- 安装产物：versions/{version_dir_name}/{version_dir_name}.jar 而非 versions/{game_version}/；实例列表不再出现损坏的原版实例

## 修订记录
| 日期 | 版本 | 修改内容 | 修改人 |
|---|---|---|---|
| 2026-08-20 | v1.0 | 初版创建 | AI Agent |