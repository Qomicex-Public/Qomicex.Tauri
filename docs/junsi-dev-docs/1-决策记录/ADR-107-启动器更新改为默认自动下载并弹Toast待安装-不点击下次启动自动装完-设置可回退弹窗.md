# ADR-107：启动器更新改为默认自动下载 + Toast 待安装，设置可回退弹窗

| 属性 | 内容 |
|---|---|
| 状态 | 已采纳 |
| 日期 | 2026-10-05 |
| 决策者 | AI Agent |

## 背景

现状（ADR-067 / ADR-081 / ADR-095 之后的链路）：App.tsx 启动 5s 后台 `GET /api/update/plan` 探测更新 → 写 `updaterStore.available`（设置页常驻提示，ADR-095）→ 弹 `UpdateDialog`，用户点「立即更新」才开始下载。下载任务经 `POST /api/plugins/download/start` 落 `<dataDir>/updates/qomicex-update-<ver>.zip`，完成轮询后 `invoke('run_updater')` 由壳侧释放内嵌 updater、spawn、`app.exit(0)` 覆盖安装。

用户诉求：每次有更新时**默认自动下载**并弹出类「已准备好安装更新。点这里重启游戏！」的 Toast；**不点击则下次打开仍会自动装完**；设置里可改回原有的弹出 Dialog。

关键缺口：「下载完成、待安装」这一刻**没有任何持久化状态**——只活在 `updaterStore` 内存里，进程一关就必须重新下载几十 MB，无法实现「下次打开自动装完」。而「内存里的状态」也不能跨进程存活。

约束：
- 强制更新（`required`）语义是"必须更新后才能继续使用"；跨通道切换（`channelSwitch`）在 ADR-081 下要求用户明确知晓自己在换发布列车。两者都不适合静默自动安装。
- `dataDir` 用户可改、缓存可被清理，因此「记录」必须与更新包**同目录**存放。
- 壳侧已启用 `tauri-plugin-single-instance`，但写入仍须原子（复用既有 notice 的「先写 .tmp 再 rename」语义）。
- 自动安装会 `app.exit(0)` 并重启启动器，不能在有游戏实例运行时执行（会把用户正在玩的游戏连启动器一起关掉）。

## 决策

采用「壳侧落盘待安装记录 + 前端独立 Toast + 设置开关」。

1. **持久化**（`src-tauri/src/updater.rs`）：新增 `{dataDir}/updates/update-auto-install.json`，内容 `AutoInstallFile { pending?: PendingUpdateInstall, abandonedVersion?: string }`；`PendingUpdateInstall { version, packagePath, signature, changelog, attempts, channel? }`。写入一律「先写 .tmp 再 rename」原子覆盖，内容为空时删除文件不留残渣。与既有 `pending-update-notice.json`（更新**完成后**的交接）方向相反、文件名不同、互不干扰。

2. **四个新 Tauri 命令**：`update_auto_install_state`（只读 peek，**不推进 attempts**）、`stage_pending_update_install`、`take_pending_update_install`（读后按结果写回）、`clear_pending_update_install`。`take` 的状态机：
   - `installed`：目标版本 == 当前运行版本（或**旧于**当前版本）→ 清记录，不重复安装（收敛点 + 防降级）
   - `missing`：包已不在 → 作废记录可重下，**不**计入抑制（可恢复）
   - `abandoned`：`attempts >= 3` → 记 `abandonedVersion` 并清 pending，该版本不再自动装、回退弹窗
   - `ready`：先递增 attempts **落盘**再交给调用方 spawn —— 顺序颠倒会让「spawn 后崩溃」不计入重试，上限形同虚设

3. **前端分流**：`updaterStore` 新增 `autoStart`（下载 → 落盘 → `phase='ready'` 弹 Toast，**不主动重启**）与 `installStaged` / `installStagedOnLaunch` / `restoreStaged` / `dismissStaged`；原 `start`（手动路径）保持「下载完立刻 run_updater」不变，仅加两处收敛：同版本已 staged → 直接装（不重复下载）；不同版本 → 先清旧记录再走手动路径（防旧记录在下次启动把用户降级回去）。

4. **自动模式的触发条件**（`App.tsx` `resolveAutoInstallPlan`）：后台检查发现更新 && `updateAutoInstall !== false`（默认开）&& `!required` && `!channelSwitch` && 该版本未被 `abandonedVersion` 抑制 && 当前无 staged 记录 && dataDir 非空。任一查询失败都回退弹窗（宁可走原行为，也不要出现「既没弹窗也没提示」的黑洞）。

5. **启动自动安装**：`backendState==='ready' && settingsReady` 后 2s 执行。有实例运行中 → **推迟**到下次启动，并把磁盘记录 `restoreStaged` 成可点击的 Toast（否则已下好的包在本会话完全不可见）；无实例 → `installStagedOnLaunch()` 直接装完。

6. **Toast**（`src/components/UpdateReadyToast.tsx`）：底部居中横幅，左侧绿块白勾、中间文案 + 版本号、右侧 ✕。点击横幅主体 = 立即重启安装；✕ = 本次不再提示（**只隐藏，不清磁盘记录**——于是「不点击 → 下次启动自动装完」对 ✕ 同样成立）。要彻底关掉自动流程用设置开关，那是唯一持久出口。

7. **设置开关** `updateAutoInstall`（前后端 settings 字段，缺失/true = 开启）。UI 在「设置 → 关于 → 更新」区新增一行 `Switch`。关闭时**同时清掉**已 staged 的记录，否则那份记录会在下次启动被静默装完，用户会以为开关没生效。

8. **防静默降级**：`is_older_than()`（semver 比较，解析失败保守放行）——用户手动装上更新版本后，磁盘上残留的旧版本记录必须被清掉而不是照常安装。

**舍弃方案 B**（纯前端 localStorage + 新增「枚举 updates 目录」后端端点）：localStorage 与文件系统易不一致（dataDir 可改、缓存可清），多实例有竞争，且仍需动后端。
**舍弃方案 C**（不落盘，每次启动发现更新就自动下载并立即安装）：每次启动都重下几十 MB，无法「先下好、下次秒装」，且每次启动都会打断用户。

## 备选方案

### 方案 方案 B：localStorage 记录 + 后端新增枚举 updates 目录端点
- 优点：前端改动集中，无需新增 Tauri 命令（若只做「下次启动检测包是否存在」）
- 缺点：localStorage 与文件系统两套状态易漂移（dataDir 可改、缓存可清）；多实例写 localStorage 无原子性；仍需新增后端端点，实际并未少动代码
- 为何不选：不选：状态一致性与多实例安全都不如落盘同目录；且并没有真的省下改动

### 方案 方案 C：不持久化，每次启动重新探测并自动下载+自动安装
- 优点：实现最省事，无新状态、无新命令
- 缺点：每次启动都要重下几十 MB（更新包体积可观）；无法实现「先下载好、下次秒装」；每次启动都会强制重启一次，打断用户
- 为何不选：不选：与用户「下次打开自动装完」的诉求不符（那是复用已下好的包，不是重下），且体验明显更差

### 方案 强制更新/跨通道也走自动 Toast
- 优点：行为统一，所有更新一条路径
- 缺点：required 的「必须更新后才能继续使用」语义被弱化成可关闭提示；channelSwitch 绕过了 ADR-081 要求的用户知情前提
- 为何不选：不选：两者都有需要用户明确知晓/确认的语义，静默自动安装会破坏它们；最终保留原 Dialog 路径

## 影响
- src-tauri/src/updater.rs：新增 AutoInstallFile/PendingUpdateInstall/AutoInstallStateView/AutoInstallTake、stage/take/clear/state 四个函数与四个 #[tauri::command]，新增 12 个单测（含跨三次进程启动的生命周期端到端用例）
- src-tauri/src/lib.rs：invoke_handler 注册 4 个新命令
- src-backend/qomicex-backend/src/settings.rs：SettingsResponse 新增 update_auto_install: Option<bool>（默认 Some(true)）
- src/api/update.ts：PendingUpdateInstall / AutoInstallState / AutoInstallTake 类型 + fetchAutoInstallState / stagePendingInstall / takePendingInstall / clearPendingInstall
- src/api/settings.ts：AppSettings.updateAutoInstall 与 DEFAULT_SETTINGS 默认 true
- src/stores/updaterStore.ts：UpdaterPhase 增 'ready'；新增 staged/toastDismissed 与 autoStart/installStaged/installStagedOnLaunch/restoreStaged/dismissStaged；downloadToUpdates 抽出共用下载；start 增加同版本收敛与异版本清记录
- src/components/UpdateReadyToast.tsx（新增）：底部居中可点击横幅，复用 plugin-ui Tooltip/portal 与 glass-surface
- src/components/UpdateDialog.tsx：phase==='ready' 时补出「下次再说」与「安装并重启」按钮（原先该 phase 下 footer 为空）
- src/App.tsx：resolveAutoInstallPlan 分流函数、启动自动安装 effect（含运行中实例推迟 + restoreStaged）、后台检查接 autoStart、渲染 UpdateReadyToast
- src/pages/Settings.tsx：AboutTab 新增「自动下载并安装更新」Switch（含关闭时清记录、onSettingsChange 同步）
- qomicex-tauri-i18n/src/{zh-CN,zh-TW,zh-HK,en-US,en-GB,ja-JP,ru-RU}/：dialogs 新增 updateReady.{message,installNow,dismiss}，settings 新增 about.updateAutoInstall(+Desc)

## 修订记录
| 日期 | 版本 | 修改内容 | 修改人 |
|---|---|---|---|
| 2026-10-05 | v1.0 | 初版创建 | AI Agent |

### 2026-10-05 更新

## 评审修正（PR #193 review，2026-10-05）

初版实现经 CodeRabbit 与安全架构审查后，修正以下 6 项。它们的共性是**同一条
「状态跨边界存活」链路上的边界没封严**：记录一旦持久化，就有多个不同的"失效条件"
需要在不同位置被拦。

### 1. ADR 重编号 105 → 107，并删除错误的 issue 归属

初版把 ADR 编成 105、文件名带 `issue-190`，并在文档/README 中大量引用 `#190`。
**这些关联是我编造的，未核实**：`#190` 实际是一个**已合并的 PR**（Technic 古董包
JarMod 注入，关联 issue **#180**），与启动器自动更新毫无关系；「自动更新」在本仓库
根本没有对应 issue。同期 `origin/main` 已占用 ADR-105（Technic 源）、ADR-106
（JarMod），我的编号与之冲突（PR 一度显示 CONFLICTING）。

修正：ADR 重编号为 **107**、文件名去掉 `issue-190`、README 索引与标签索引同步更新
（计数 112 → 113）、代码与文档注释中的 `#190` 全部删除。

> 教训：**issue/PR 编号必须核实后再写**（本仓库 `gh issue view <n>` 对 PR 编号同样
> 返回内容，会把 PR 误当成 issue）。不确定就不写编号。

### 2. `fetchAutoInstallState` 不得把 IPC 失败吞成「空状态」

初版 `catch { return EMPTY_AUTO_STATE }`。调用方 `resolveAutoInstallPlan` 依赖
「查询失败 → 回退更新对话框」兜底；把失败伪装成「没有待安装记录」会让它认为可以
安全走自动下载（随后 `autoStart` 静默失败），结果是**既没有对话框也没有 Toast**。

修正：查询错误**抛出**给调用方，由那条 catch 回退到对话框；只有空 `dataDir`
（设置未加载完、连 updates 目录都拼不出来）按无记录处理。

### 3. 关闭设置开关必须同时复位 store，而不只是删磁盘记录

初版只 `clearPendingInstall`（删磁盘）。但 Toast 渲染自 store 的 `staged`，磁盘清掉
后**Toast 仍在屏幕上且仍能点击立即安装**，与「已关闭自动更新」直接矛盾。

修正：新增 `updaterStore.discardStaged()`（清 `staged`/`phase` 并停轮询），开关关闭时
与磁盘清理一起调用。

### 4. `autoStart` 必须在暂存边界复检开关

下载可能耗时几十秒，用户完全可能在这期间去设置里关掉自动更新。初版下载完成后不回
检查开关，仍会落盘并进入 `ready`，重新冒出一个可点击的安装入口。

修正：`downloadToUpdates` 返回后、写记录前复检 `updateAutoInstall === false`；
若已关闭则清掉刚下的记录、回 idle，不进入 ready。

### 5. 通道随记录落盘，跨列车不得自动安装（安全审查：策略漂移）

安全审查指出：**待安装记录的生命周期长于更新策略**。用户可能在下好包之后又切换了
发布通道，此时这份包已不属于当前想要的列车，而启动时的无人值守安装**不会查询当前
通道**就直接装上——等于一次静默的跨列车更新，绕过了 ADR-081「通道切换由用户显式
决定」的前提。

修正：
- `PendingUpdateInstall` 增 `channel`（可空：旧记录没带通道 → 视为无法判定、不拦，
  否则老记录永远装不上）；`stage_pending_update_install` 增加 `channel` 参数。
- 新增 `lib/updateChannel.ts` 的 `stagedChannelMatchesCurrent()`，**自动安装与
  恢复 Toast 两条路径共用同一判定**，结论必须一致（否则会出现"启动时不装、但给了
  一个点了就装的入口"）。
- 不一致时丢弃记录并交回正常流程（下次检查会按当前列车重新发现更新）。

### 6. 尝试计数写不进盘时必须拒绝无人值守安装（安全审查：可靠性）

初版在 `write_auto_install` 失败时**只记日志仍返回 `ready`**。安全审查指出：计数存
不下去时重试上限就不再是可靠的失败遏制边界——每次启动都读到那个没被递增过的旧计数，
于是一个始终失败的包会被**无限次自动重装**，永远到不了「作废 + 回退弹窗」。

修正：新增 `unpersisted` 状态，落盘失败即拒绝本次无人值守安装并回退弹窗（**保留
显式的手动恢复路径**：用户仍可通过更新对话框手动安装）。这条只影响启动时的无人值守
安装——用户点 Toast 走 `installStaged`，不经过这里。

> 这两条（5、6）都是**自动流程独有**的风险：手动路径由用户点击驱动，天然有边界；
> 无人值守路径没有用户在场，所有"该不该动手"的判断都必须由代码显式给出，且失败时
> 必须**退回**到有人值守的路径，而不是默默继续。

### 新增测试（updater 22 → 25 例）

- `staged_channel_round_trips_and_absent_channel_stays_none`：通道写读一致；空串/
  空白按未提供处理（不写出 `Some("")` 让前端误比对）。
- `legacy_record_without_channel_deserializes`：旧版无 `channel` 键的记录仍可读（升级兼容）。
- `take_refuses_unattended_install_when_attempt_cannot_be_persisted`：占用 `.tmp`
  路径注入写失败 → 必须返回 `unpersisted` 而非 `ready`；解除注入后恢复正常，证明
  记录未被破坏性改动。

> 测试注入踩坑：最初把**记录路径本身**造成目录，结果 `read_auto_install` 读不出内容、
> 被当成「无记录」返回 `none`，根本走不到目标分支。正确注入点是 `write_auto_install`
> 实际写入的 `.tmp` 路径——要求「记录可读、写入失败」。

