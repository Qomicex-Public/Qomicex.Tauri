# ADR-039：macOS Java 扫描停用全盘 BFS,改用标准路径+java_home 官方枚举

| 属性 | 内容 |
|---|---|
| 状态 | 已采纳 |
| 日期 | 2026-08-22 |
| 决策者 | AI Agent |

## 背景

macOS TCC 机制对 Desktop/Documents/Pictures/Music/Movies、~/Library 下部分子目录(Mail/Messages/Safari/Containers/Group Containers 等)、外接卷宗按"应用×类别"粒度授权:进程首次 read_dir 未授权类别时系统弹出授权窗。Qomicex 的 Java 深度扫描(search_deep → get_valid_drives 在 macOS 返回 / /home /opt /usr → breadth_first_search 全盘 BFS)在首次启动向导(InitialSetupWizard 自动触发)即触碰数十个受保护目录,每个类别各弹一次授权窗,形成弹窗轰炸;用户拒绝后 BFS 静默失败(mac 端日志全部"读取目录失败"),扫描结果与快速扫描几乎无差异。同时发现:MACOS_PATHS 中的 /usr/libexec/java_home 是可执行文件而非目录,is_dir() 检查使其成为无效条目——官方 JVM 枚举 API 实际未被利用;用户级标准安装位 ~/Library/Java/JavaVirtualMachines 缺失;BFS 甚至入队了 /dev/fd/34(进程自身文件描述符)。

## 决策

1) get_valid_drives() macOS 分支返回空集:深度扫描在 macOS 不再做全盘 BFS,退化为高优先级路径表扫描;2) MACOS_PATHS 增补 ~/Library/Java/JavaVirtualMachines;3) 新增 search_macos_java_home(cfg target_os=macos):调用官方 /usr/libexec/java_home -V(输出在 stderr)解析行尾 Home 路径并探测 bin/java,discoveredBy=JavaHome,能发现注册在非标准位置的 JVM,发现能力不降反升;4) should_exclude 增加 Unix 虚拟文件系统前缀排除(/dev /proc /sys /run,strip_prefix 精确匹配,/devtools 不误伤),Linux 全盘 BFS 同步受益(不再空转虚拟目录);Linux/Android 保留原有根列表不变。

## 备选方案

### 方案 仅增加排除规则(Desktop/Documents/Library 等)
- 优点：保留全盘发现能力;改动最小
- 缺点：无法根治:TCC 保护类别不可穷尽,第三方 App 数据目录仍会触发弹窗;全盘扫描耗时依旧;拒绝弹窗后 BFS 静默失败浪费大量 IO
- 为何不选：TCC 保护位置随系统版本/用户安装的 App 变化,黑名单式排除永远追不完

### 方案 引导用户授予完全磁盘访问权限(Full Disk Access)
- 优点：一次授权后全盘扫描无弹窗
- 缺点：要求用户手动授权体验差;权限过大引发隐私顾虑
- 为何不选：把平台摩擦转嫁给用户,且 FDA 授权对启动器类应用属于过度索权

## 影响
- qomicex-core-rust/src/services/java/scanner.rs:get_valid_drives/MACOS_PATHS/should_exclude/search_quick
- macOS:深度扫描不再触发 TCC 权限弹窗,结果集与标准安装位完全覆盖等价
- Linux:全盘 BFS 跳过 /dev /proc /sys /run,减少无意义遍历
- Windows:行为零变化(所有新增逻辑均被 cfg!(unix)/cfg(target_os) 门控)

## 修订记录
| 日期 | 版本 | 修改内容 | 修改人 |
|---|---|---|---|
| 2026-08-22 | v1.0 | 初版创建 | AI Agent |