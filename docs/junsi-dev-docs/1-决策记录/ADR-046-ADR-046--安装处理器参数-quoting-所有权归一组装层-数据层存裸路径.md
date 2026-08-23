# ADR-046：ADR-046: 安装处理器参数 quoting 所有权归一组装层，数据层存裸路径

| 属性 | 内容 |
|---|---|
| 状态 | 已采纳 |
| 日期 | 2026-08-23 |
| 决策者 | AI Agent |

## 背景

qomicex-core-rust 的 Forge/NeoForge 安装器自 C# Qomicex.Core 移植，processor 执行原经 cmd /c 整串命令行（数据层 BINPATCH.client 预埋双引号是必要保护）。commit 73dda6e/bafc018 将执行改为 split_command_line 切词后逐参传 java（修 binarypatcher JVM 无法启动），但未同步移除数据层预埋引号：build_processor_args 对含空格参数二次加引号 → ""path"" 在切词时被从空格处劈裂 → jopt-simple invalid params → exit 1。VersionDirName 含空格（QML 整合包以包名命名版本目录）必现；普通安装 versionId 无空格恰好掩盖。实测复现：DeceasedCraft - Urban Zombie Apocalypse 整合包装 Forge 47.4.0 失败。

## 决策

quoting 职责唯一归组装层 build_processor_args：install 层（forge/install.rs 与 neoforge/install.rs 的 BINPATCH 写入）改为存裸路径，注释显式记录偏离 C# 源的原因（argv 切词语境 vs cmd /c 语境）。新增回归测试断言含空格 VersionDir 下 --apply 值切词后为完整单 token 裸路径；该测试在修复前 FAILED、修复后通过，防止回归。NeoForge 同模式同批修复。

## 备选方案

### 方案 组装层 trim 引号兼容
- 优点：改动面最小
- 缺点：治症不治本：数据层雷仍在，未来其他 data 值若同样预埋引号照样炸；掩盖移植语义漂移
- 为何不选：违反「唯一持有者」原则，多点补丁是漏网温床

### 方案 恢复整串交 cmd /c 执行
- 优点：与 C# 源完全一致
- 缺点：正是 commit 73dda6e 修掉的旧 bug（java 把整串当单参 → JVM 无法启动）；cmd 元字符注入面更大
- 为何不选：开历史倒车

## 影响
- 所有 Forge/NeoForge processor 安装的 BINPATCH 参数形态（契约变更：data 值一律裸路径）
- 整合包 VersionDirName 含空格场景从必败转为正常
- 后续移植 C# 安装器代码时凡遇 "值预埋引号" 模式必须重新评估其 cmd /c 语境假设

## 修订记录
| 日期 | 版本 | 修改内容 | 修改人 |
|---|---|---|---|
| 2026-08-23 | v1.0 | 初版创建 | AI Agent |