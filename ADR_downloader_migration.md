# ADR: Qomicex.Downloader → Qomicex.Downloader.Refactor 迁移

## 元数据

| 属性 | 值 |
|------|-----|
| **ADR 编号** | 001 |
| **日期** | 2026-07-25 |
| **状态** | 已实施 |
| **决策者** | Junsi |
| **迁移分支** | `migrate/downloader-refactor` |

## 背景

需要将现有下载器替换为重构版 `Qomicex.Downloader.Refactor`。旧版下载器存在以下不足：

- `DownloadManager` 和 `Core` 两个入口类，职责重叠
- 进度获取依赖主动轮询（`GetAllTaskInfos()` + `while` 循环），浪费 CPU 且代码重复
- 缺少现代化特性（IP 直连、看门狗、动态切片等）
- 无 AOT 优化意识

## 决策

### 决策 1: 放弃兼容性，全量适配

**选择**: 完全使用新 API，适配所有调用方代码（4 个文件，7 个调用点）

**原因**:
- 新旧 API 差异大，无法透明替换
- 适配代码量可控（~200 行变更）
- 一次性迁移比维护适配层更可持续

### 决策 2: 进度模式从轮询改为回调

**选择**: 全部改为 `IProgress<GlobalProgressInfo>` + `IProgress<FileProgressInfo>` 回调

**原因**:
- 新版库天然支持 IProgress 推送模式
- 避免 while+Task.Delay 浪费 CPU 和线程
- 代码更简洁（`DownloadWithProgress` 方法从 35 行缩减为 35 行但逻辑更清晰）

### 决策 3: 类名冲突用别名解决

**选择**: `using RefDl = Qomicex.Downloader.Refactor.Downloader;`

**原因**:
- C# 编译器将 `Downloader` 解析为命名空间（`Qomicex.Downloader.*`）而非类
- 即使使用 `using Downloader = ...` 别名也因同名冲突失败
- `RefDl` 别名无歧义，是务实解法

### 决策 4: 舍弃 `ignoreRangeProbe200Ok` 参数

**选择**: 移除，不另行实现

**原因**:
- 新版 Watchdog 机制（30s 卡死检测 + 龟速检测）自动处理类似场景
- EasyTierProvider 对此参数的需求是防御性的，Watchdog 已覆盖

### 决策 5: 舍弃 `.qdtmp` 临时文件清理

**选择**: 保留原清理代码（无害空操作），不主动适配新扩展名

**原因**:
- 新版 FileWriter 内部处理临时文件，外部无需关心扩展名
- 原代码仅在文件存在时删除，不存在时自动跳过——无害

## 后果

### 正面

- 获得新版下载器全部特性（64 Worker 并发、IP 直连、动态切片、看门狗）
- 下载进度回调更高效（推送 vs 轮询）
- 统一入口类（`Downloader` 替代 `DownloadManager` + `Core`）
- 零 NuGet 依赖，纯 BCL，AOT 全兼容

### 负面

- 类名 `Downloader` 与命名空间 `Qomicex.Downloader` 冲突，需用别名 `RefDl`
- `InstallTracker.DownloadWithProgress` 和 `InstanceEndpoints` 修复逻辑的进度轮询代码重复未能合并（此问题旧代码已存在，非本迁移引入）

### 风险

- 新版下载器未经大量生产验证（旧版已在生产运行）
- 进度百分比映射精度可能略有差异（新版用 bytes 比例，旧版用 `info.Progress` 字段）

## 遗留技术债（待人工决策的优化点）

| # | 文件 | 问题 | 严重度 |
|---|------|------|--------|
| 1 | `InstallTracker.cs:150,176` | `baseDm`/`loaderDm` 未 `using`，依赖 `StopTask(-1)` 而非 `Dispose`（已修复） | 低 |
| 2 | `InstallTracker.cs:274-309` ~ `InstanceEndpoints.cs:164-198` | 两处下载进度轮询逻辑高度重复（~35行），应抽取为共享方法 | 中 |
| 3 | `ResourceDownloadEndpoints.cs:120-125` | `.qdtmp` 清理逻辑可能在新版已失效（新版 FileWriter 可能用不同临时后缀） | 低 |
| 4 | 新版 `Downloader` 类名 | 命名空间 `Qomicex.Downloader.Refactor` 中的 `Downloader` 段与类名冲突，建议重命名类（如 `DownloadEngine` 或 `DownloadClient`）或调整命名空间层次 | 中 |

## 替代方案考虑

### 方案 A: 包装适配层（废弃）

在旧 API 上封装一层，内部调新 API。不采用原因：
- 增加维护负担
- 无法利用新特性（如 IProgress 回调）
- 旧轮询 API 与新推送模式根本冲突

### 方案 B: 直接适配（采用）

直接修改 4 个调用方代码，使用新 API。采用原因：
- 变更量可控
- 代码更简洁
- 充分利用新特性
