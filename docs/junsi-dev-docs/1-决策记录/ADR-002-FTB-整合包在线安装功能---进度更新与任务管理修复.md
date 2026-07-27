# ADR-002：FTB 整合包在线安装功能 — 进度更新与任务管理修复

| 属性 | 内容 |
|:---|:---|
| 状态 | 已采纳 |
| 日期 | 2026-07-28 |
| 决策者 | AI Agent |

## 背景

**问题背景：**
为 Qomicex Tauri 启动器添加 FTB 整合包在线安装功能。用户从资源中心浏览 FTB 整合包，选择一个版本，通过 ModpackInstallDialog 安装。安装涉及两个阶段：1) 基础安装（版本 JSON + 加载器 + 库）；2) 整合包文件下载（mods/config via FTB API + CurseForge API）。

**核心症状：**
1. 点"后台安装"后，下载中心任务一直显示"下载中"，进度数值不更新（停留在初始值），底层实际在下载但前端看不到进度
2. 暂停/恢复按钮点击无反应（后端端点不存在）
3. 停止按钮无效（下载任务无法取消，fire-and-forget 任务无取消令牌）
4. 重启后端后，旧任务成僵尸（localStorage 持久化，instanceId 已失效），无法取消也无法删除

**架构约束：**
- SSE 每 300ms 轮询 `InstallTracker.GetAllActiveStates()`，通过 EventSource 推送到前端
- `GetAllActiveStates` 过滤掉 `status is "completed" or "failed" or "cancelled" or "not-started"` 的条目
- `InstallerTracker.Start()` 创建 InstallState 并在 `Task.Run` 中执行 `RunInstallAsync()`，完成后设置 `status = "completed"`

## 决策

**核心决策：将 modpack 文件下载作为 InstallTracker.Start() 的 postInstall 回调，与基础安装在同一 Task.Run 中执行。**

放弃 fire-and-forget 模式（`_ = DownloadModpackFilesAsync(...)`），原因是：
1. 时序竞争：RunInstallAsync 设 Status="completed" → SSE 过滤掉实例 → 前端 lost 逻辑标记任务已完成 → DownloadModpackFilesAsync 之后才设回 "downloading"，但 SSE 已失联
2. 异常静默：fire-and-forget 任务抛异常无人捕获，任务永远停在某状态
3. 取消令牌不共享：两个任务使用不同的 CTS

**替代方案已排除：**
- 方案 A（保留 fire-and-forget + 修复时序）：需在 RunInstallAsync 不设 "completed" 或在 GetAllActiveStates 加额外逻辑。太脆弱。
- 方案 B（modpack 文件走 DownloadSession）：需大幅重构下载器。工期太长。

**其他决策：**
- `SyncStateFromSession` 只在 session 状态为 "downloading" 时同步，防止已完成的基础安装会话覆盖 modpack 阶段写入的进度
- 暂停/恢复通过 InstallState.Paused 标志 + 下载循环内 `WaitPauseAsync()` 实现（非 session 级暂停）
- 前端启动时通过 SSE + REST 双重验证清理失效任务

## 备选方案


### 方案 方案A：保留 fire-and-forget，RunInstallAsync 不设 Status=completed
- 优点：改动最小
- 缺点：大量边界情况需处理；需要 GetAllActiveStates 重写过滤逻辑；两个线程间的状态转换仍有时序风险
- 为何不选：太脆弱，未采用

### 方案 方案B：modpack 文件走 DownloadSession（统一下载管线）
- 优点：最干净，充分利用下载器基础设施
- 缺点：需重构 ModpackService 生成 DownloadTask 列表；DownloadSession 无文件路径映射；工期至少 3 天
- 为何不选：工期太长，未采用

### 方案 方案C：postInstall 回调（已采用）
- 优点：消除时序竞争；统一异常处理；共享 CTS；改动范围可控
- 缺点：InstallTracker 与 ModpackService 通过回调耦合；暂停机制需在下载循环中轮询（非 session 级暂停）
- 为何不选：当前最优解

## 影响
- InstallerTracker.Start() 新增可为 null 的 postInstall 回调参数，基础安装后同步执行
- 暂停/恢复端点新增 POST /instance/{id}/install/pause 和 /resume
- InstallState 新增 Token/Paused/Pause/Resume 成员
- 下载中心启动时自动验证失效安装任务并标记为 failed
- 取消按钮始终移除任务（即使 API 调用失败）

## 修订记录
| 日期 | 版本 | 修改内容 | 修改人 |
|:---|:---|:---|:---|
| 2026-07-28 | v1.0 | 初版创建 | AI Agent |


### 2026-07-28 更新
# ADR-002: FTB 整合包在线安装 — 进度更新与任务管理修复

## 一、背景

为 Qomicex Tauri 启动器添加 FTB 整合包在线安装功能。用户从资源中心浏览 FTB 整合包，选择一个版本，通过 ModpackInstallDialog 安装。

安装涉及两个阶段：
1. **基础安装**：版本 JSON + 加载器 + 库（由 InstallTracker.RunInstallAsync 完成）
2. **整合包文件下载**：mods/config 文件（通过 FTB API + CurseForge API 获取）

框架：后端 ASP.NET Core 10，前端 React 19 + Vite。SSE 每 300ms 通过 EventSource 推送进度。

---

## 二、已修复的问题

### 1. ModpackEndpoints 路由前缀错误
- **文件**: `ModpackEndpoints.cs`
- **问题**: 路由前缀 `/modpack` 缺少 `/api/`，导致 404
- **修复**: 改为 `/api/modpack`

### 2. 基础安装阶段文件下载（`RunInstallAsync` 在 InstallTracker 内）
- **文件**: `Core.AOT/CurseForgeBase.cs`
- **新增**: `GetDownloadUrlsAsync(List<int>)` — CF 批量 API，去重、分批（50/批）、`try-catch(HttpRequestException)` 防中断
- **新增**: `FTBModpackInstaller.cs` — 重写（修复 `_cfApiKety` 拼写、`.Result`→`async/await`、路径拼接 `TrimStart('.','/','\\')`、过滤 `FileId≤0` 的 mod）
- **新增**: `IInstallerFactory.cs` / `DefaultInstallerFactory.cs` — `CreateFtbModpack`

### 3. 后端 InstallAsync 不阻塞（立即返回 instanceId）
- **文件**: `ModpackService.cs`
- **原行为**: `InstallAsync` 等待全流程结束才返回（基础安装 + 文件下载），期间前端请求被阻塞
- **修复**: 立即返回 `instanceId`，后台继续。下载阶段作为 `postInstall` 回调传入 `InstallTracker.Start()`

### 4. SSE 进度不更新（核心 Bug）
- **根因**: fire-and-forget `_ = DownloadModpackFilesAsync(...)` 与基础安装在不同 Task.Run 中。RunInstallAsync 设 `Status="completed"` → SSE 过滤掉实例 → 前端 lost 逻辑标记已完成 → 下载任务之后才设回 "downloading"，SSE 已失联
- **修复**: 传入 `postInstall` 回调，在同一个 Task.Run 中连续执行：`RunInstallAsync → postInstall(state, ct) → state.Status="completed"`
- **关键改动**:
  - `InstallTracker.Start()` 新增 `Func<InstallState, CancellationToken, Task>? postInstall = null` 参数
  - `ModpackService.InstallAsync` 传 `postInstall` 回调，不再 fire-and-forget
  - 删除了 `DownloadModpackFilesAsync` 方法

### 5. SyncStateFromSession 覆盖进度
- **文件**: `InstallTracker.cs` 的 `GetState()`
- **问题**: 每次调用 `GetState()` 时，已完成的 DownloadSession 快照（Progress=100, Stage="completed", TotalFiles=0）覆盖 modpack 下载阶段写入的真实进度
- **修复**: 只在 session 状态为 "downloading" 时才同步：`if (snap.Status == "downloading") SyncStateFromSession(...)`

### 6. 暂停/恢复功能
- **文件**: `InstallTracker.cs`, `InstanceEndpoints.cs`
- **问题**: 后端无 `/install/pause` 和 `/install/resume` 端点
- **修复**:
  - `InstallState` 新增 `Paused`/`Pause()`/`Resume()` 成员
  - `InstallTracker` 新增 `Pause(instanceId)`/`Resume(instanceId)` 方法
  - `InstanceEndpoints` 新增两个 POST 端点
  - 下载循环中 `WaitPauseAsync(state, ct)` 在暂停时轮询等待

### 7. 下载循环取消支持
- **文件**: `ModpackService.cs` 的 `DownloadFtbFilesAsync` / `DownloadGenericFilesAsync`
- **修复**: 传入 `CancellationToken`，传递到 `http.GetAsync(url, ct)` 和 `content.CopyToAsync(fs, ct)`
- 捕获 `OperationCanceledException` → 记录日志 → clean return

### 8. FTB API 无进度反馈
- **修复**: 在 `GetMissLibrariesAsync` 调用前设置 `state.CurrentFile = "正在获取FTB整合包文件列表..."`

### 9. 前端 lost 逻辑不处理 "not-started"
- **文件**: `DownloadCenter.tsx`
- **修复**: `p.status === 'not-started'` → 标记为 `cancelled`

### 10. 启动时僵尸任务自动清理
- **文件**: `DownloadCenter.tsx`
- **问题**: 重启后端后，localStorage 中旧任务的 instanceId 已失效，前端不做验证
- **修复**: SSE 首次到达时，install 任务匹配不到 SSE 数据 → 调 REST 验证 → 返回 "not-started" 或 null → 标记为 failed（"任务已过期（后端已重启）"）

### 11. 取消按钮容错
- **文件**: `DownloadCenter.tsx`
- **修复**: `cancelInstall(task.instanceId)` 失败时（如 404），仍然 `removeTask(task.id)`，不留下僵尸

### 12. 清理按钮增强
- **文件**: `DownloadCenter.tsx`
- **原**: 只在有 completed 任务时显示「清除已完成」
- **修复**: 改为始终显示「清除已完成/失败」，清除所有 completed/failed/cancelled 任务

---

## 三、TODO / 未完成事项

### 🔴 高优先级
- **[ ] 验证 FTB 安装流程**：在真实环境（有网、FTB API 可达）完整走一遍：浏览 FTB 整合包 → 选择版本 → 安装 → 观察下载中心进度更新 → 确认暂停/取消工作
- **[ ] 暂停/恢复需针对 session 下载实现**：当前暂停只是停止 modpack 文件下载循环。基础安装阶段（RunInstallAsync 内的 session 下载）不支持暂停

### 🟡 中优先级
- **[ ] FTB API 超时设置**：`FTBModpackInstaller.GetMissLibrariesAsync` 中的 `_ftb.GetVersionDetailAsync()` 和 `_ftb.GetModDetailAsync()` 无超时配置。如果 FTB API 不可达，整个任务 hang 在「准备下载整合包文件...」状态。**需要给 `_httpClient` 设置 Timeout**
- **[ ] InstallState 线程安全**：多个线程并发读写 InstallState 字段（后台下载线程、REST 请求线程、SSE 请求线程），无同步保护。x64 上基本类型读写原子但不保证内存可见性
- **[ ] stop 按钮无效**：用户报告点停止不停止。可能是 `CancellationToken` 未正确传递或 session 级 cancel 未生效。**需实际测试重现**

### 🟢 低优先级
- **[ ] 基础安装阶段 0% 进度反馈**：ModpackInstallDialog 的 REST 轮询在基础安装阶段看到的进度数据来自 `SyncStateFromSession`。需验证修复后 REST 轮询是否正常工作
- **[ ] CF 批量 API `GetDownloadUrlsAsync` 容错**：部分 fileId 可能返回 404，当前 `try-catch` 跳到下一批，但该批其他文件也丢失了。应改为单文件容错
- **[ ] 下载循环暂停间隔可配置**：当前 `WaitPauseAsync` 硬编码 200ms

---

## 四、已知未解决 Bug

### Bug 1: 取消失效（需实际测试重现）
- **现象**: 在下载中心点停止按钮，任务不变
- **可能原因**:
  - `Cancel()` 调用 `_states.TryRemove` 移除状态 → fire-and-forget 任务可能还在运行但无法获取状态
  - 修复后统一在 Task.Run 内，`cts.Cancel()` 应传播到下载循环。需确认
- **排查步骤**: 1) 检查后端日志 `[Install]` 是否输出取消信息；2) 检查 `cts.Token` 是否被正确传递到 `http.GetAsync()`

### Bug 2: 基础安装阶段无暂停
- **现象**: 基础安装（版本 JSON/加载器/库下载）阶段暂停按钮无效
- **根因**: 基础安装阶段通过 DownloadSession.Ru​​nBatchAsync 下载，不使用 InstallState.Paused。暂停端点只设置了 Paused 标志，没有暂停 session
- **需要**: 在 Pause 时调用 `_sessionManager.GetSession($"install-{id}")?.Cancel()` 或类似机制

---

## 五、变更文件清单

| 文件 | 改动类型 | 说明 |
|------|---------|------|
| `src-backend/Qomicex.Core.AOT/.../FTBModpackInstaller.cs` | 重写 | FTB 文件发现逻辑，修复异步/拼写/路径/过滤 |
| `src-backend/Qomicex.Core.AOT/.../CurseForgeBase.cs` | 新增 | `GetDownloadUrlsAsync` 批量 CF API |
| `src-backend/Qomicex.Core.AOT/.../IInstallerFactory.cs` | 新增 | `CreateFtbModpack` 接口 |
| `src-backend/Qomicex.Core.AOT/.../DefaultInstallerFactory.cs` | 新增 | 工厂实现 |
| `src-backend/.../InstallTracker.cs` | 修改 | `Start(postInstall)` 回调; `Pause`/`Resume`; `SyncStateFromSession` 条件同步 |
| `src-backend/.../ModpackService.cs` | 重写 | `InstallAsync` 用 postInstall 取代 fire-and-forget; 下载方法加 CT/暂停 |
| `src-backend/.../InstanceEndpoints.cs` | 新增 | `/install/pause` `/install/resume` 端点 |
| `src-backend/.../ModpackEndpoints.cs` | 修复 | 路由 `/modpack` → `/api/modpack` |
| `src-backend/.../ApiJsonContext.cs` | 修改 | `ModpackInstallRequest` DTO 加 Source/ProjectId/VersionId |
| `src/components/ModpackInstallDialog.tsx` | 修改 | 安装流程：先建任务 → 调 API（不阻塞）→ 更新任务 |
| `src/pages/DownloadCenter.tsx` | 修改 | SSE 启动时验证失效安装任务; 取消容错; 附加清理按钮 |
| `src/types/index.ts` | 修改 | `ModpackInstallRequest` 前端类型加字段 |

---

## 六、分支信息

- **分支**: `fix/ftb-install-progress`
- **基于**: `main`
- **未合并**: 需要测试通过后合并

---

## 七、测试步骤

1. 启动后端：`cd src-backend/Qomicex.Launcher.Backend.Neo && dotnet run`
2. 启动前端：`npm run tauri dev` 或 `npm run dev`
3. 进入资源中心 → FTB 标签 → 选择一个整合包 → 点击版本 → ModpackInstallDialog 弹出
4. 配置游戏目录、版本隔离 → 点击「开始安装」→ 对话框显示安装进度
5. 点击「后台安装」→ 导航到下载中心 → 观察 FTB 任务进度是否实时更新
6. 测试暂停 → 点击暂停按钮 → 确认进度停止 → 点击继续 → 确认恢复
7. 测试取消 → 点击停止按钮 → 确认任务移除
8. 重启后端 → 确认旧任务自动标记为「任务已过期（后端已重启）」
9. 点「清除已完成/失败」→ 确认僵尸任务被清除

