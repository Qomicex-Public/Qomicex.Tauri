### Task 6 Report: InstallTask 并行化

**状态**: 完成
**提交**: `d8fa48d` — `feat(install): parallel Group B downloads, parallel mod resolution`

#### 变更概要

| 变更类型 | 内容 |
|----------|------|
| 新增字段 | `_libsProgress`、`_assetsProgress`、`_mainJarProgress`、`_loaderJarProgress` |
| 新增方法 | `GroupBWeightedProgress()`、`RunDownloadTaskWithCallback()`、`HandleLoaderInstall()`、`DownloadAddonsParallel()` |
| 移除方法 | `RunDownloadStage()`、`RunDownloadManagerStage()` |
| 重写方法 | `StartAsync()` — 从串行 8 阶段改为并行 Group 架构 |
| Usings | 移除未使用的 `System.Collections.Concurrent`，新增 `System.Threading`（SemaphoreSlim） |

#### 架构变更

```
OLD（串行）: Stage1→Stage2→Stage3→...→Stage8
NEW（并行）:
  Group A (JSON, 3%) → 扫描缺失文件
  Group B (3%-53%): libs + assets + mainJar + loaderJar 并行下载 + 加权进度轮询
  Group C (Forge/NeoForge): loaderLibs → install → merged jar
  或 Fabric/Quilt/LiteLoader: install → libs → merged jar
  Group D: Mod URL 解析(SemaphoreSlim(12)) + 下载，与 A/B 并行
```

#### 构建结果

- **0 错误**, 7 警告（均为项目中预先存在的警告，非本次引入）

#### 自检清单

- [x] RunDownloadStage / RunDownloadManagerStage 已移除且无残留引用
- [x] 新字段 / 方法全部按 brief 实现
- [x] StartAsync 完整替换为并行版本
- [x] HandleLoaderInstall 正确处理 forge/neoforge 和 fabric/quilt/liteloader 分支
- [x] DownloadAddonsParallel 使用 SemaphoreSlim(12) 并行解析 + lock object 线程安全
- [x] InstallModLoader、ResolveVersionJsonUrl 等现有方法保持不变
- [x] Core 使用完全限定名 `Qomicex.Downloader.Core` 解决命名空间冲突

#### 注意事项

- `lock (addonTid)` 在 brief 中直接锁 int 值类型，已修正为 `lock (addonLock)`（object 引用类型锁）
- 原 brief 中 `new Core(...)` 与命名空间 `Qomicex.Downloader.Core` 冲突，已改为完全限定名 `new Qomicex.Downloader.Core(...)`
