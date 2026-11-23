# ADR-137：启动期硬件策略：Windows 独显偏好、macOS 游戏模式与进程优先级

| 属性 | 内容 |
|---|---|
| 状态 | 已采纳 |
| 日期 | 2026-11-19 |
| 决策者 | AI Agent |

## 背景

启动器原先只设置 JVM 内存与参数，不干预系统级硬件调度。用户在双显卡 Windows 设备上经常发现游戏跑在核显上；macOS 14+ 的系统游戏模式又不会作用于第三方启动器拉起的 java 子进程。经核实：Windows 的 GPU 偏好存放在 HKCU\Software\Microsoft\DirectX\UserGpuPreferences（按 exe 路径生效，值形如 GpuPreference=2;）；macOS 无公开 API 为子进程开启 Game Mode，Apple DTS 明确 Info.plist 属性不继承给 java 子进程，唯一可编程路径是 Xcode 自带的私有工具 gamepolicyctl（全局生效，需退出后 set auto 还原）。

## 决策

在设置页「启动」分区新增一个开关（默认开）与一个独立的进程优先级下拉（默认正常）。Windows：启动前把本次解析出的 java.exe 写入 UserGpuPreferences，仅替换 GpuPreference token，保留 AutoHDREnable 等其它 token；首次写入前把原值备份到 QML/gpu-pref-backup.json，关闭开关或启动器检测到「已关闭但仍有备份」时还原。macOS：若 /Applications/Xcode.app/Contents/Developer/usr/bin/gamepolicyctl 存在，启动前 game-mode set on 并写标记文件，游戏退出（crash-watcher 统一消费退出事件）、启动失败、关开关、启动器启动自愈时 game-mode set auto。进程优先级：Windows 用 SetPriorityClass，Unix 用 setpriority；非 Windows 只提供「正常/低于正常」，因为负 nice 需要 root，UI 隐藏提升档位且后端对脏配置降级为 normal。平台不支持的开关保持常驻但置灰，悬浮显示原因。

## 备选方案

### 方案 macOS 用 Info.plist 标记自身为游戏 / 改 bundle id 伪装官方启动器
- 优点：实现成本低
- 缺点：属性不继承给 java 子进程，实测无效；改 bundle id 会破坏签名、公证与自动更新
- 为何不选：无效且副作用大，放弃

### 方案 构建带游戏标记的外壳 .app 并 execv 顶替 java
- 优点：实测能真正触发 Game Mode
- 缺点：需要额外的嵌套 .app 打包与签名链，必须真机 Mac 验证，维护成本高
- 为何不选：当前版本不做，留作后续备选

### 方案 整份覆盖 UserGpuPreferences 值（直接写 GpuPreference=2;）
- 优点：实现最简单
- 缺点：会丢掉用户原有的 AutoHDREnable 等设置
- 为何不选：改为只替换 GpuPreference token 并备份还原

### 方案 把优先级提升并进硬件开关
- 优点：少一个设置项
- 缺点：两件事风险不同，用户可能只想提优先级而不改注册表
- 为何不选：按用户要求拆成独立设置

## 影响
- src-backend/qomicex-backend/src/services/hardware.rs（新增）：全部硬件策略与降级/自愈逻辑
- 两条 launch 路径接入：endpoints/instance.rs 与 endpoints/connector.rs（联机启动）
- services/crash_watcher.rs 消费退出事件时复位 macOS 游戏模式
- endpoints/system.rs 在 PUT /api/settings 时检测开关关闭并还原系统状态
- settings.rs 新增 launchHardwareBoost / processPriority 字段；前端 Settings 页与 7 语言文案同步
- 系统副作用：Windows 会写入 HKCU 注册表（按 exe 生效，影响同一 java.exe 的其它用法），macOS 会临时改变全局游戏模式

## 修订：2026-11-23（v1.1，macOS 游戏模式失效）

用户反馈「装了 Xcode 仍吃不到游戏模式」。复核代码后确认两处确定缺陷：

1. 只认 `/Applications/Xcode.app/Contents/Developer/usr/bin/gamepolicyctl` 一条路径。
   Xcode-beta、非默认安装位置、只装 Command Line Tools 的用户全部被 `is_file()`
   挡掉，且只打 `debug` 级日志，用户和我们都看不到。
2. `status()` 的 stderr 被丢进 `Stdio::null()`，`set on` 之后也从不回读状态，
   无法区分「工具没跑起来」和「跑了但策略没生效」。

改法：

- 定位顺序改为 `xcrun --find gamepolicyctl` → `xcode-select -p` + `usr/bin/gamepolicyctl`
  → `/Applications/Xcode.app` / `Xcode-beta.app` 兜底；结果进程内缓存。
- 捕获 stderr 并归类（Xcode 版本不匹配的 dyld 符号缺失 / Xcode 许可未接受 / 权限不足），
  以 `warn` 落日志；`set on` 成功后用 `game-mode status` 回读，未出现
  `forced always on` 即告警。
- Intel Mac（`target_arch != aarch64`）直接跳过并记日志：Game Mode 只在 Apple Silicon 上存在。
- 新增 `src-tauri/Info.plist`（Tauri 构建期合并进 bundle）：`LSApplicationCategoryType`
  = `public.app-category.games`、`GCSupportsGameMode`、`LSSupportsGameMode`。

依据与边界：

- Apple 工程师确认 Info.plist 属性本身不继承给 java 子进程；但 Steam 与官方启动器靠
  launcher 身份让 `gamepolicyd` 把其拉起的 java 记为 `labelReason=launcher` 的游戏候选
  （PrismLauncher#1644 实测）。这套标记因此是「让子进程进入候选」的路径，能否命中仍取决于
  系统版本与全屏状态，故保留 gamepolicyctl 作为强制开关。
- macOS 26 上 gamepolicyctl 常因 `GamePolicy.framework` 符号缺失直接 abort；此时只能依赖
  上面的 plist 标记，日志会写明原因。
- 前置条件不变：游戏必须全屏且前台，Game Mode 才会真正启用。

## 修订记录
| 日期 | 版本 | 修改内容 | 修改人 |
|---|---|---|---|
| 2026-11-19 | v1.0 | 初版创建 | AI Agent |
| 2026-11-23 | v1.1 | macOS 游戏模式：工具定位改为 xcrun/xcode-select 链、补 stderr 与状态回读、Intel 跳过、新增 Info.plist 游戏标记 | AI Agent |