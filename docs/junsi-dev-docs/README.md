# 项目文档索引
最后更新：2026-10-05 23:08

## 1-决策记录

*ADR 架构决策记录*

- [ADR: Qomicex.Downloader → Qomicex.Downloader.Refactor 迁移](1-决策记录/ADR-001-Downloader-迁移.md)
- [ADR-002：FTB 整合包在线安装功能 — 进度更新与任务管理修复](1-决策记录/ADR-002-FTB-整合包在线安装功能---进度更新与任务管理修复.md)
- [ADR-004： C# ASP.NET → Rust/Tauri IPC 全量迁移架构决策](1-决策记录/ADR-004--C--ASP-NET---Rust-Tauri-IPC-全量迁移架构决策.md)
- [ADR-005：mod 远程 id 匹配两段式：metadata light + enrich 端点](1-决策记录/ADR-005-mod-远程-id-匹配两段式-metadata-light---enrich-端点.md)
- [ADR-006：winreg 依赖平台作用域修正（target.windows）](1-决策记录/ADR-006-winreg-依赖平台作用域修正-target-windows-.md)
- [ADR-007：LocalResourcesFactory.create_server_manager 工厂方法（ServerManager 移植）](1-决策记录/ADR-007-LocalResourcesFactory-create_server_manager-工厂方法-ServerManager-移植-.md)
- [ADR-008：服务器管理端点移植（CSAOT-legacy C# → Rust core + axum）](1-决策记录/ADR-008-服务器管理端点移植-CSAOT-legacy-C----Rust-core---axum-.md)
- [ADR-009：Windows ARM64 联机 FakeTCP 仅依赖 npcap，WinDivert 不支持 aarch64](1-决策记录/ADR-009-Windows-ARM64-联机-FakeTCP-仅依赖-npcap-WinDivert-不支持-aarch64.md)
- [ADR-010：Puppeteer 自动化组件素材采集方案](1-决策记录/ADR-010-Puppeteer-自动化组件素材采集方案.md)
- [ADR-011：模组更新检查改造：批次哈希匹配 + 独立 6h 缓存 + 自动检查](1-决策记录/ADR-011-模组更新检查改造-批次哈希匹配---独立-6h-缓存---自动检查.md)
- [ADR-012：check-updates 更新判定：Modrinth game_versions 序列化修复 + CurseForge latest_files 客户端过滤](1-决策记录/ADR-012-check-updates-更新判定-Modrinth-game_versions-序列化修复---CurseForge-latest_files-客户端过滤.md)
- [ADR-013：check-updates loader 兼容回退：非标准加载器（Cleanroom/LiteLoader）按 Forge 兼容处理](1-决策记录/ADR-013-check-updates-loader-兼容回退-非标准加载器-Cleanroom-LiteLoader-按-Forge-兼容处理.md)
- [ADR-014：模组更新流程改造：下载中心编排 + 缓存失效修复](1-决策记录/ADR-014-模组更新流程改造-下载中心编排---缓存失效修复.md)
- [ADR-015：NAT 检测 STUN 服务器支持多端口降级](1-决策记录/ADR-015-NAT-检测-STUN-服务器支持多端口降级.md)
- [ADR-015：启动器内置版权与隐私协议入口](1-决策记录/ADR-015-启动器内置版权与隐私协议入口.md)
- [ADR-016：启动器 I18N 国际化支持（轻量自研 + 全量迁移 + 错误码前端映射）](1-决策记录/ADR-016-启动器I18N国际化支持.md)
- [ADR-017：首次启动初始化向导（快速/自定义双模式）](1-决策记录/ADR-017-首次启动初始化向导-快速-自定义双模式.md)
- [ADR-018：外观设置自定义字体（fontdb 枚举系统字体 + 全局应用）](1-决策记录/ADR-018-外观设置自定义字体-fontdb-枚举系统字体-全局应用.md)
- [ADR-019：实例自定义分组（独立 groups.json + 实例多对多引用）](1-决策记录/ADR-019-实例自定义分组-独立-groups-json-实例多对多引用.md)
- [ADR-020：日志体系完善（关请求噪音 + 简洁格式 + 业务日志 + 持续落盘 + 查看器）](1-决策记录/ADR-020-日志体系完善-关请求噪音-简洁格式-业务日志-持续落盘-查看器.md)
- [ADR-021：整合包本地导入（zip/mrpack）与实例导出（CF zip / MR mrpack）](1-决策记录/ADR-021-整合包本地导入与实例导出.md)
- [ADR-022：存档设置管理（level.dat NBT 编辑，core-rust 实现）](1-决策记录/ADR-022-存档设置管理-level-dat-NBT-编辑-core-rust-实现.md)
- [ADR-023：i18n 语言集扩展：7 语言 BCP 47 全码 + 全量翻译](1-决策记录/ADR-023-i18n-语言集扩展-7-语言-BCP-47-全码---全量翻译.md)
- [ADR-024：实例管理新增「投影原理图」管理与 Deepslate 3D 预览](1-决策记录/ADR-024-实例管理新增-投影原理图-管理与-Deepslate-3D-预览.md)
- [ADR-025：出站 HTTP UA 统一 + 目录管理默认「当前目录」占位入口](1-决策记录/ADR-025-出站HTTP-UA统一与目录管理默认当前目录.md)
- [ADR-026：NeoForge 版本列表官方源失败时自动回退 BMCLAPI 镜像](1-决策记录/ADR-026-NeoForge-版本列表官方源失败时自动回退-BMCLAPI-镜像.md)
- [ADR-027：启动器网络设置：下载源迁移 + 代理 + 忽略SSL](1-决策记录/ADR-027-启动器网络设置-下载源迁移---代理---忽略SSL.md)
- [ADR-028：Forge/NeoForge 主 jar 落到版本隔离目录，消除孤儿原版实例](1-决策记录/ADR-028-Forge-NeoForge-主-jar-落到版本隔离目录-消除孤儿原版实例.md)
- [ADR-029：实例「测试游戏」实时日志：stdout 直推 + SSE + 独立浏览器窗口](1-决策记录/ADR-029-实例-测试游戏-实时日志-stdout-直推---SSE---独立浏览器窗口.md)
- [ADR-030：下载器 host_probe 缓存按文件大小分流，恢复大文件多段并行](1-决策记录/ADR-030-下载器-host_probe-缓存按文件大小分流-恢复大文件多段并行.md)
- [ADR-031：下载传输按来源自动路由：Modrinth 走 HTTP/1.1 并行，其余源走 HTTP/2](1-决策记录/ADR-031-下载传输按来源自动路由-Modrinth-走-HTTP-1-1-并行-其余源走-HTTP-2.md)
- [ADR-032：新增文件下载源：Modrinth/CurseForge 文件 CDN 域名重写到 QML Mirror](1-决策记录/ADR-032-新增文件下载源-Modrinth-CurseForge-文件-CDN-域名重写到-QML-Mirror.md)
- [ADR-033：个性化设置支持自定义主题色（Accent Color）](1-决策记录/ADR-033-个性化设置支持自定义主题色-Accent-Color-.md)
- [ADR-034：主题色「跟随背景」莫奈式取色模式](1-决策记录/ADR-034-主题色-跟随背景-莫奈式取色模式.md)
- [ADR-035：毛玻璃材质设置（glassEffect + glassBlur）](1-决策记录/ADR-035-毛玻璃材质设置-glassEffect---glassBlur-.md)
- [ADR-036：组件材质下拉（默认/毛玻璃/液态玻璃）：液态玻璃参考liquid-glass-react](1-决策记录/ADR-036-组件材质下拉-默认-毛玻璃-液态玻璃--液态玻璃参考liquid-glass-react.md)
- [ADR-037：玻璃材质与滚动渐隐遮罩互斥：材质激活时禁用 scroll-fade-mask](1-决策记录/ADR-037-玻璃材质与滚动渐隐遮罩互斥-材质激活时禁用-scroll-fade-mask.md)
- [ADR-038：下载器传输模型改为 aria2 式独立 TCP 分段并修复 total timeout 杀请求](1-决策记录/ADR-038-下载器传输模型改为-aria2-式独立-TCP-分段并修复-total-timeout-杀请求.md)
- [ADR-039：macOS Java 扫描停用全盘 BFS,改用标准路径+java_home 官方枚举](1-决策记录/ADR-039-macOS-Java-扫描停用全盘-BFS-改用标准路径-java_home-官方枚举.md)
- [ADR-040：HTTP→IPC：双进程保留，传输层换命名管道/UDS（QIPC 帧协议）](1-决策记录/ADR-040-HTTP-IPC-双进程保留-传输层换命名管道-UDS-QIPC-帧协议-.md)
- [ADR-042：组件材质一致性修复：plugin-ui 依赖断链恢复 + 裸 div 卡片接入 glass-surface](1-决策记录/ADR-042-组件材质一致性修复-plugin-ui-依赖断链恢复---裸-div-卡片接入-glass-surface.md)
- [ADR-043：液态玻璃标注预览功能并加性能警告与启用确认](1-决策记录/ADR-043-液态玻璃标注预览功能并加性能警告与启用确认.md)
- [ADR-044：ADR-044：初始化引导页窗口拖动——顶部品牌栏拖动条](1-决策记录/ADR-044-ADR-044-初始化引导页窗口拖动--顶部品牌栏拖动条.md)
- [ADR-045：IPC 迁移遗留 3 项已知限制的处理决策（不修复，记录为已知限制）](1-决策记录/ADR-045-IPC-迁移遗留-3-项已知限制的处理决策-不修复-记录为已知限制-.md)
- [ADR-046：ADR-046: 安装处理器参数 quoting 所有权归一组装层，数据层存裸路径](1-决策记录/ADR-046-ADR-046--安装处理器参数-quoting-所有权归一组装层-数据层存裸路径.md)
- [ADR-047：ADR-047: 安装管线 DAG 并行化——三分支编排、权重合成进度与快速失败](1-决策记录/ADR-047-ADR-047--安装管线-DAG-并行化--三分支编排-权重合成进度与快速失败.md)
- [ADR-048：启动前强制刷新微软账户 token 并按失败类型分流](1-决策记录/ADR-048-启动前强制刷新微软账户-token-并按失败类型分流.md)
- [ADR-049 插件生态战略——进程隔离/主题语义化/签名验证/DX 工具链](1-决策记录/ADR-049-ADR-049-插件生态战略--进程隔离-主题语义化-签名验证-DX-工具链.md)
- [ADR-050：插件包签名验证（Ed25519 三级信任链）](1-决策记录/ADR-050-插件包签名验证-Ed25519-三级信任链-.md)
- [ADR-051：ADR-051: qomicex CLI 脚手架（零依赖 Node 实现 + ADR-050 签名对齐）](1-决策记录/ADR-051-ADR-051--qomicex-CLI-脚手架-零依赖-Node-实现---ADR-050-签名对齐-.md)
- [ADR-052：目录管理弹窗交互设计：拖拽排序 + 右键菜单 + 图标改名](1-决策记录/ADR-052-目录管理弹窗交互设计-拖拽排序---右键菜单---图标改名.md)
- [ADR-053：插件错误遥测上报 + 灰度自动暂停](1-决策记录/ADR-053-插件错误遥测上报---灰度自动暂停.md)
- [ADR-054：ADR-054: l4 远程 WebView 隔离层跨窗口桥设计](1-决策记录/ADR-054-ADR-054--l4-远程-WebView-隔离层跨窗口桥设计.md)
- [ADR-055：SPD 协议文档拆分：规范/接入/实现三分离](1-决策记录/ADR-055-SPD-协议文档拆分-规范-接入-实现三分离.md)
- [ADR-059：FA→Lucide 全量图标迁移](1-决策记录/ADR-059-FA-Lucide-全量图标迁移.md)
- [ADR-060：icon ternary → MorphIcon 动画迁移](1-决策记录/ADR-060-icon-ternary---MorphIcon-动画迁移.md)
- [ADR-061：Settings 页重构为 Split View + List + Switch](1-决策记录/ADR-061-Settings-页重构为-Split-View---List---Switch.md)
- [ADR-062：InstanceDetail 设置页重构为 List + Switch](1-决策记录/ADR-062-InstanceDetail-设置页重构为-List---Switch.md)
- [ADR-063：qomicex CLI 优化与插件 log API](1-决策记录/ADR-063-qomicex-CLI-优化与插件-log-API.md)
- [ADR-064：通用插件 Hook 系统：Koa 洋葱管道 + 前端方法层 hook（v1）](1-决策记录/ADR-064-通用插件-Hook-系统-Koa-洋葱管道---前端方法层-hook-v1-.md)
- [ADR-065：主页小组件化：react-grid-layout 编辑模式网格](1-决策记录/ADR-065-主页小组件化-react-grid-layout-编辑模式网格.md)
- [ADR-066：qml-docs 用户指南补全：8 篇功能文档覆盖启动器全部功能](1-决策记录/ADR-066-qml-docs-用户指南补全-8-篇功能文档覆盖启动器全部功能.md)
- [ADR-067：启动器自更新改为独立 Updater + zip 覆盖式更新](1-决策记录/ADR-067-启动器自更新改为独立-Updater---zip-覆盖式更新.md)
- [ADR-068：plugin-ui 动画改为 preset 自含，不引入 tailwindcss-animate](1-决策记录/ADR-068-plugin-ui-动画改为-preset-自含-不引入-tailwindcss-animate.md)
- [ADR-069：plugin-ui 动画速度口径统一与组件细节动效增强](1-决策记录/ADR-069-plugin-ui-动画速度口径统一与组件细节动效增强.md)
- [ADR-070：实例详情列表内边距统一与概况页重构为 SettingSection](1-决策记录/ADR-070-实例详情列表内边距统一与概况页重构为-SettingSection.md)
- [ADR-071：个性化增强：视频/动图背景、默认材质细化参数、主题跟随系统](1-决策记录/ADR-071-个性化增强-视频-动图背景-默认材质细化参数-主题跟随系统.md)
- [ADR-072：非中文语言需先登录微软正版账户才能添加离线/第三方账户](1-决策记录/ADR-072-非中文语言需先登录微软正版账户才能添加离线-第三方账户.md)
- [ADR-073：插件扫描跳过升级快照与临时目录](1-决策记录/ADR-073-插件扫描跳过升级快照与临时目录.md)
- [ADR-074：Switch 开关圆点位置对称修正](1-决策记录/ADR-074-Switch-开关圆点位置对称修正.md)
- [ADR-075：亮色模式液态玻璃底色改为中性灰低透明度](1-决策记录/ADR-075-亮色模式液态玻璃底色改为中性灰低透明度.md)
- [ADR-076：裸 glass-surface 表面强化液态玻璃观感（不引入 JS 位移）](1-决策记录/ADR-076-裸-glass-surface-表面强化液态玻璃观感-不引入-JS-位移-.md)
- [ADR-077：新增独立 Dialog 透明度设置](1-决策记录/ADR-077-新增独立-Dialog-透明度设置.md)
- [ADR-078：安装期库去重改为按完整坐标保留所有版本（修复 NeoForge 安装 404）](1-决策记录/ADR-078-安装期库去重改为按完整坐标保留所有版本-修复-NeoForge-安装-404-.md)
- [ADR-079：processor 下载 URL 复用 maven_to_path（剥离 @type + 多源探测）](1-决策记录/ADR-079-processor-下载-URL-复用-maven_to_path-剥离--type---多源探测-.md)
- [ADR-080：世界预览：移植 world-viewer 领域层为后端服务 + HTTP 瓦片端点](1-决策记录/ADR-080-世界预览-移植-world-viewer-领域层为后端服务---HTTP-瓦片端点.md)
- [ADR-081：世界预览同步上游 8828130：1.13-1.17 区块格式与旧版方块名配色](1-决策记录/ADR-081-世界预览同步上游-8828130-1-13-1-17-区块格式与旧版方块名配色.md)
- [ADR-082：世界预览同步上游 4e6f71d + 1dc33cf：生物群系染色/水面透视 + 瓦片缓存并发优化](1-决策记录/ADR-082-世界预览同步上游-4e6f71d---1dc33cf-生物群系染色-水面透视---瓦片缓存并发优化.md)
- [ADR-083：世界预览第三次同步上游：LZ4 区块解压 / 渲染内颜色记忆表 / 瓦片队列中心排序](1-决策记录/ADR-083-世界预览第三次同步上游-LZ4-区块解压---渲染内颜色记忆表---瓦片队列中心排序.md)
- [ADR-084 多实例扫描慢的根因与修复：版本扫描指纹缓存 + 非阻塞 + 两段式扫描](1-决策记录/ADR-084-多实例扫描改指纹缓存与非阻塞两段式-解决73实例1分钟.md)
- [ADR-085 启动器更新检测改为通道（train）模型：跨通道不降级、开发版不提示](1-决策记录/ADR-085-启动器更新检测改为通道模型.md)
- [ADR-086：触控板拖动优化——拖动区改为位移阈值 + `data-qomicex-drag-region`](1-决策记录/ADR-086-触控板拖动优化-拖动区改位移阈值与data-qomicex-drag-region.md)
- [ADR-087：双指触摸板滑动 = 滚轮滚动（窗口框架固定）——拖动区边界判定、手势分类与内容位移计算](1-决策记录/ADR-087-双指触摸板滑动等于滚轮滚动-窗口框架固定与拖动区边界判定.md)
- [ADR-088：模组删除一致性与错误上报：失效后重载 + 请求序号保护 + 后端 IO 错误传播](1-决策记录/ADR-088-模组删除一致性与错误上报-失效后重载-请求序号保护-后端-IO-错误传播.md)
- [ADR-089：下载中心按资源类型分组与折叠](1-决策记录/ADR-089-下载中心按资源类型分组与折叠.md)
- [ADR-090：补齐 mod 换版本/安装端点并接通可配置的全局请求超时（issue #117 + #133）](1-决策记录/ADR-090-补齐-mod-换版本与安装端点并接通可配置的全局请求超时-issue-117-133.md)
- [ADR-091：资源收藏功能（#132）后端 JSON 持久化 + 资源中心视图切换](1-决策记录/ADR-091-资源收藏功能-132-后端-JSON-持久化与资源中心视图切换.md)
- [ADR-092：修复 Windows 拖入 Yggdrasil 卡片失效（Rust 侧解析 .url）+ 补齐资源校验/补全三端点（issue #136 + #138）](1-决策记录/ADR-092-修复-Windows-拖入-Yggdrasil-失效并补齐资源校验补全端点-issue-136-138.md)
- [ADR-093：取代 ADR-092 — 自实现 Windows IDropTarget，同时接文件与文本拖拽（修正 issue #136）](1-决策记录/ADR-093-取代-ADR-092-自实现-Windows-IDropTarget-同时接文件与文本拖拽-issue-136.md)
- [ADR-094：CurseForge 整合包可选模组安装（#129）](1-决策记录/ADR-094-CurseForge-整合包可选模组安装.md)
- [ADR-095：更新可用性提升为会话级共享状态，设置页常驻「发现新版本」提示（issue #147）](1-决策记录/ADR-095-更新可用性提升为会话级共享状态-设置页常驻发现新版本提示-issue-147.md)
- [ADR-096：资源收藏 P2（#132）收藏夹分组 / 备注 / 自定义标签](1-决策记录/ADR-096-资源收藏P2-收藏夹分组-备注-自定义标签.md)
- [ADR-097：资源中心整合包原地更新（issue #118）——索引+清单双基线、journal 回滚、绝不删除实例](1-决策记录/ADR-097-资源中心整合包原地更新-索引清单双基线与-journal-回滚-issue-118.md)
- [ADR-098：LittleSkin 改用 OAuth 设备代码流登录（issue #145）](1-决策记录/ADR-098-LittleSkin-改用-OAuth-设备代码流登录-issue-145.md)
- [ADR-099：修复 #116：存档卡片选中态丢失基础内边距导致内容上浮](1-决策记录/ADR-099-修复-116-存档卡片选中态丢失基础内边距导致内容上浮.md)
- [ADR-100：Issue #127 外部唤起：qomicex-launcher:// OS 协议 + single-instance + 深链动作分发](1-决策记录/ADR-100-外部唤起-qomicex-launcher-OS协议-single-instance-深链动作分发-issue-127.md)
- [ADR-101：模组依赖检测在 core 解析、前端判定（issue #165）](1-决策记录/ADR-101-模组依赖检测在-core-解析与前端判定-issue-165.md)
- [ADR-102：Forge 加载器版本获取：Maven 元数据主路径 + 官方源失败回退 BMCLAPI + 缓存非空校验（issue #176）](1-决策记录/ADR-102-Forge-加载器版本获取改用-Maven-元数据并补官方源回退与缓存校验-issue-176.md)
- [ADR-102：Technic SingleZip 整合包本地导入（issue #123 期1）——探测/转换对齐 Prism，古董包 JarMod 拒绝并转 #180](1-决策记录/ADR-102-Technic-SingleZip-整合包本地导入-issue-123期1.md)
- [ADR-103：资源详情页 MC百科跳转与复制名称 / 资源中心改无限滚动（issue #188）](1-决策记录/ADR-103-资源详情MC百科跳转与复制名称-资源中心改无限滚动.md)
- [ADR-104：复制按钮统一 CopyActionIcon，并修复其定时器被 cleanup 清掉的缺陷（issue #191）](1-决策记录/ADR-104-复制按钮统一CopyActionIcon并修复定时器缺陷-issue-191.md)
- [ADR-105：资源中心 Technic 源：API 模型对齐、后端代理安装与 build 参数 401 归因修正（issue #151）](1-决策记录/ADR-105-资源中心-Technic-源-API-模型对齐-后端代理安装与-build-参数-401-归因修正-issue-151.md)
- [ADR-106：JarMod 支持：非破坏性派生 jar 注入古董包 modpack.jar（issue #180）](1-决策记录/ADR-106-JarMod-支持-非破坏性派生-jar-注入古董包-modpack-jar-issue-180.md)
- [ADR-107：Technic Solder 在线分发支持：逐文件下载管线 + jarmod 落地（issue #181，#123 期3）](1-决策记录/ADR-107-Technic-Solder-在线分发支持-逐文件下载管线与-jarmod-落地-issue-181.md)
- [Batch Plan: Full Migration C# → Rust + Axum→IPC](1-决策记录/BATCH-PLAN-CSharp到Rust迁移批次计划.md)
- [复测记录：connector 房主身份解析修复 + host_port game_info/game_mods 增强](1-决策记录/VERIFICATION_LOG-联机房主解析复测.md)

## 2-架构设计

*系统架构、模块设计*

- [I18N 国际化设计](2-架构设计/I18N国际化设计.md)
- [LittleSkin OAuth 登录接入方案](2-架构设计/LittleSkin-OAuth-登录接入方案.md)
- [PHASE1 插件生态 — 任务派发提示词包](2-架构设计/PHASE1-插件生态-任务派发提示词.md)
- [Technic 整合包支持：实现地图与排障](2-架构设计/Technic-整合包支持-实现地图与排障.md)
- [下载器全局选项：HTTP 代理与忽略 TLS 证书校验](2-架构设计/下载器-代理与忽略TLS证书选项.md)
- [主题语义 Token 规范 v1 + .qtheme（颜色主题）](2-架构设计/主题语义Token规范v1.md)
- [前端浏览器调试：Playwright Tauri mock 注入与挂载](2-架构设计/前端浏览器调试-Playwright-Tauri-mock注入.md)
- [动画系统](2-架构设计/动画系统.md)
- [启动流程](2-架构设计/启动前Java检查与自动下载.md)
- [启动器自更新一键链路（独立 Updater + zip 覆盖）](2-架构设计/启动器自更新一键链路-独立-Updater.md)
- [启动流程](2-架构设计/启动流程.md)
- [启动进度](2-架构设计/启动进度分步显示.md)
- [项目架构](2-架构设计/完整项目架构图.md)
- [Mod 名称交叉匹配设计](2-架构设计/崩溃分析-Mod名称交叉匹配设计.md)
- [技术选型](2-架构设计/技术选型.md)
- [拖拽安装管线](2-架构设计/拖拽安装管线.md)
- [插件 Hook 系统](2-架构设计/插件Hook系统.md)
- [功能设计](2-架构设计/插件商店集成.md)
- [插件生态技术提案](2-架构设计/插件生态技术提案.md)
- [插件签名验证（ADR-050）兼容与降级策略](2-架构设计/插件签名兼容与降级策略.md)
- [插件系统架构](2-架构设计/插件系统.md)
- [插件调试 harness（Playwright + Tauri mock 注入 + 热重载）](2-架构设计/插件调试harness.md)
- [整合包快捷安装对话框](2-架构设计/整合包快捷安装对话框.md)
- [架构设计](2-架构设计/架构设计.md)
- [模块划分](2-架构设计/模块划分.md)
- [模组快捷安装管线](2-架构设计/模组快捷安装管线.md)
- [目录树状图](2-架构设计/目录树状图.md)
- [联机故障诊断](2-架构设计/联机故障诊断-easytier中继数据面.md)
- [联机故障诊断-easytier中继数据面未打通](2-架构设计/联机故障诊断-easytier中继数据面未打通.md)
- [联机流程（Connector）](2-架构设计/联机流程.md)
- [设置管理流程](2-架构设计/设置管理流程.md)
- [账号管理流程](2-架构设计/账号管理流程.md)
- [资源中心流程](2-架构设计/资源中心流程.md)

## 3-API规范

*RESTful API 设计规范*

- [API 端点参考](3-API规范/API列表.md)
- [Forge / NeoForge 安装器 — 缺失库下载 URL 决策](3-API规范/Forge-NeoForge-安装器缺失库URL决策.md)
- [Qomicex Launcher 联机（SCF）扩展协议规范 v2.0](3-API规范/SCF联机扩展协议规范.md)
- [实例删除与安装失败回滚](3-API规范/实例删除与安装失败回滚.md)
- [插件系统 API](3-API规范/插件系统API.md)
- [API规范](3-API规范/设置-缓存清理端点.md)

## 4-编码规范

*各语言编码规范*

- [C# 编码规范（已废止）](4-编码规范/CSharp-规范.md)
- [Rust 编码规范](4-编码规范/Rust-规范.md)
- [TypeScript 编码规范](4-编码规范/TypeScript-规范.md)

## 5-数据库设计

*表结构、ER 图*

（暂无文档）

## 6-UI/组件设计

*UI 控件、组件设计规范*

- [UI 组件设计规范](6-UI/组件设计/UI组件设计规范.md)
- [Qomicex Launcher — UI Design Specification](6-UI/组件设计/UI设计系统.md)
- [Qomicex Launcher 设计规范](6-UI/组件设计/UI设计规范.md)
- [关于页鸣谢列表](6-UI/组件设计/关于页鸣谢列表.md)

## 7-调用规范

*服务间调用、异常处理、日志规范*

- [前端 API 调用规范](7-调用规范/前端API调用规范.md)
- [异常处理规范](7-调用规范/异常处理规范.md)
- [调用规范/HTTP/3 启用指南](7-调用规范/调用规范-HTTP-3 启用指南.md)

## 8-部署运维

*部署架构、环境配置*

- [GitHub Issue / PR 自动 Type 分类（标签体系 + 自动打标 + opencode 兜底 triage）](8-部署运维/GitHub-Issue-模板与自动分类.md)
- [PHASE1 端到端联调记录](8-部署运维/PHASE1-联调记录.md)
- [待办清单](8-部署运维/TODO.md)
- [Windows DLL 打包与运行时解压机制](8-部署运维/Windows-DLL打包与运行时解压机制.md)
- [构建与部署](8-部署运维/构建部署.md)
- [环境配置说明](8-部署运维/环境配置说明.md)

## 9-系统要求

*功能需求、非功能需求*

- [项目规模统计报告](9-系统要求/项目规模统计报告.md)

## 标签索引

- **1-决策记录** (113): [ADR-001-Downloader-迁移](1-决策记录/ADR-001-Downloader-迁移.md), [ADR-002-FTB-整合包在线安装功能---进度更新与任务管理修复](1-决策记录/ADR-002-FTB-整合包在线安装功能---进度更新与任务管理修复.md), [ADR-004--C--ASP-NET---Rust-Tauri-IPC-全量迁移架构决策](1-决策记录/ADR-004--C--ASP-NET---Rust-Tauri-IPC-全量迁移架构决策.md), [ADR-005-mod-远程-id-匹配两段式-metadata-light---enrich-端点](1-决策记录/ADR-005-mod-远程-id-匹配两段式-metadata-light---enrich-端点.md), [ADR-006-winreg-依赖平台作用域修正-target-windows-](1-决策记录/ADR-006-winreg-依赖平台作用域修正-target-windows-.md), [ADR-007-LocalResourcesFactory-create_server_manager-工厂方法-ServerManager-移植-](1-决策记录/ADR-007-LocalResourcesFactory-create_server_manager-工厂方法-ServerManager-移植-.md), [ADR-008-服务器管理端点移植-CSAOT-legacy-C----Rust-core---axum-](1-决策记录/ADR-008-服务器管理端点移植-CSAOT-legacy-C----Rust-core---axum-.md), [ADR-009-Windows-ARM64-联机-FakeTCP-仅依赖-npcap-WinDivert-不支持-aarch64](1-决策记录/ADR-009-Windows-ARM64-联机-FakeTCP-仅依赖-npcap-WinDivert-不支持-aarch64.md), [ADR-010-Puppeteer-自动化组件素材采集方案](1-决策记录/ADR-010-Puppeteer-自动化组件素材采集方案.md), [ADR-011-模组更新检查改造-批次哈希匹配---独立-6h-缓存---自动检查](1-决策记录/ADR-011-模组更新检查改造-批次哈希匹配---独立-6h-缓存---自动检查.md), [ADR-012-check-updates-更新判定-Modrinth-game_versions-序列化修复---CurseForge-latest_files-客户端过滤](1-决策记录/ADR-012-check-updates-更新判定-Modrinth-game_versions-序列化修复---CurseForge-latest_files-客户端过滤.md), [ADR-013-check-updates-loader-兼容回退-非标准加载器-Cleanroom-LiteLoader-按-Forge-兼容处理](1-决策记录/ADR-013-check-updates-loader-兼容回退-非标准加载器-Cleanroom-LiteLoader-按-Forge-兼容处理.md), [ADR-014-模组更新流程改造-下载中心编排---缓存失效修复](1-决策记录/ADR-014-模组更新流程改造-下载中心编排---缓存失效修复.md), [ADR-015-启动器内置版权与隐私协议入口](1-决策记录/ADR-015-启动器内置版权与隐私协议入口.md), [ADR-015-NAT-检测-STUN-服务器支持多端口降级](1-决策记录/ADR-015-NAT-检测-STUN-服务器支持多端口降级.md), [ADR-016-启动器I18N国际化支持](1-决策记录/ADR-016-启动器I18N国际化支持.md), [ADR-017-首次启动初始化向导-快速-自定义双模式](1-决策记录/ADR-017-首次启动初始化向导-快速-自定义双模式.md), [ADR-018-外观设置自定义字体-fontdb-枚举系统字体-全局应用](1-决策记录/ADR-018-外观设置自定义字体-fontdb-枚举系统字体-全局应用.md), [ADR-019-实例自定义分组-独立-groups-json-实例多对多引用](1-决策记录/ADR-019-实例自定义分组-独立-groups-json-实例多对多引用.md), [ADR-020-日志体系完善-关请求噪音-简洁格式-业务日志-持续落盘-查看器](1-决策记录/ADR-020-日志体系完善-关请求噪音-简洁格式-业务日志-持续落盘-查看器.md), [ADR-021-整合包本地导入与实例导出](1-决策记录/ADR-021-整合包本地导入与实例导出.md), [ADR-022-存档设置管理-level-dat-NBT-编辑-core-rust-实现](1-决策记录/ADR-022-存档设置管理-level-dat-NBT-编辑-core-rust-实现.md), [ADR-023-i18n-语言集扩展-7-语言-BCP-47-全码---全量翻译](1-决策记录/ADR-023-i18n-语言集扩展-7-语言-BCP-47-全码---全量翻译.md), [ADR-024-实例管理新增-投影原理图-管理与-Deepslate-3D-预览](1-决策记录/ADR-024-实例管理新增-投影原理图-管理与-Deepslate-3D-预览.md), [ADR-025-出站HTTP-UA统一与目录管理默认当前目录](1-决策记录/ADR-025-出站HTTP-UA统一与目录管理默认当前目录.md), [ADR-026-NeoForge-版本列表官方源失败时自动回退-BMCLAPI-镜像](1-决策记录/ADR-026-NeoForge-版本列表官方源失败时自动回退-BMCLAPI-镜像.md), [ADR-027-启动器网络设置-下载源迁移---代理---忽略SSL](1-决策记录/ADR-027-启动器网络设置-下载源迁移---代理---忽略SSL.md), [ADR-028-Forge-NeoForge-主-jar-落到版本隔离目录-消除孤儿原版实例](1-决策记录/ADR-028-Forge-NeoForge-主-jar-落到版本隔离目录-消除孤儿原版实例.md), [ADR-029-实例-测试游戏-实时日志-stdout-直推---SSE---独立浏览器窗口](1-决策记录/ADR-029-实例-测试游戏-实时日志-stdout-直推---SSE---独立浏览器窗口.md), [ADR-030-下载器-host_probe-缓存按文件大小分流-恢复大文件多段并行](1-决策记录/ADR-030-下载器-host_probe-缓存按文件大小分流-恢复大文件多段并行.md), [ADR-031-下载传输按来源自动路由-Modrinth-走-HTTP-1-1-并行-其余源走-HTTP-2](1-决策记录/ADR-031-下载传输按来源自动路由-Modrinth-走-HTTP-1-1-并行-其余源走-HTTP-2.md), [ADR-032-新增文件下载源-Modrinth-CurseForge-文件-CDN-域名重写到-QML-Mirror](1-决策记录/ADR-032-新增文件下载源-Modrinth-CurseForge-文件-CDN-域名重写到-QML-Mirror.md), [ADR-033-个性化设置支持自定义主题色-Accent-Color-](1-决策记录/ADR-033-个性化设置支持自定义主题色-Accent-Color-.md), [ADR-034-主题色-跟随背景-莫奈式取色模式](1-决策记录/ADR-034-主题色-跟随背景-莫奈式取色模式.md), [ADR-035-毛玻璃材质设置-glassEffect---glassBlur-](1-决策记录/ADR-035-毛玻璃材质设置-glassEffect---glassBlur-.md), [ADR-036-组件材质下拉-默认-毛玻璃-液态玻璃--液态玻璃参考liquid-glass-react](1-决策记录/ADR-036-组件材质下拉-默认-毛玻璃-液态玻璃--液态玻璃参考liquid-glass-react.md), [ADR-037-玻璃材质与滚动渐隐遮罩互斥-材质激活时禁用-scroll-fade-mask](1-决策记录/ADR-037-玻璃材质与滚动渐隐遮罩互斥-材质激活时禁用-scroll-fade-mask.md), [ADR-038-下载器传输模型改为-aria2-式独立-TCP-分段并修复-total-timeout-杀请求](1-决策记录/ADR-038-下载器传输模型改为-aria2-式独立-TCP-分段并修复-total-timeout-杀请求.md), [ADR-039-macOS-Java-扫描停用全盘-BFS-改用标准路径-java_home-官方枚举](1-决策记录/ADR-039-macOS-Java-扫描停用全盘-BFS-改用标准路径-java_home-官方枚举.md), [ADR-040-HTTP-IPC-双进程保留-传输层换命名管道-UDS-QIPC-帧协议-](1-决策记录/ADR-040-HTTP-IPC-双进程保留-传输层换命名管道-UDS-QIPC-帧协议-.md), [ADR-042-组件材质一致性修复-plugin-ui-依赖断链恢复---裸-div-卡片接入-glass-surface](1-决策记录/ADR-042-组件材质一致性修复-plugin-ui-依赖断链恢复---裸-div-卡片接入-glass-surface.md), [ADR-043-液态玻璃标注预览功能并加性能警告与启用确认](1-决策记录/ADR-043-液态玻璃标注预览功能并加性能警告与启用确认.md), [ADR-044-ADR-044-初始化引导页窗口拖动--顶部品牌栏拖动条](1-决策记录/ADR-044-ADR-044-初始化引导页窗口拖动--顶部品牌栏拖动条.md), [ADR-045-IPC-迁移遗留-3-项已知限制的处理决策-不修复-记录为已知限制-](1-决策记录/ADR-045-IPC-迁移遗留-3-项已知限制的处理决策-不修复-记录为已知限制-.md), [ADR-046-ADR-046--安装处理器参数-quoting-所有权归一组装层-数据层存裸路径](1-决策记录/ADR-046-ADR-046--安装处理器参数-quoting-所有权归一组装层-数据层存裸路径.md), [ADR-047-ADR-047--安装管线-DAG-并行化--三分支编排-权重合成进度与快速失败](1-决策记录/ADR-047-ADR-047--安装管线-DAG-并行化--三分支编排-权重合成进度与快速失败.md), [ADR-048-启动前强制刷新微软账户-token-并按失败类型分流](1-决策记录/ADR-048-启动前强制刷新微软账户-token-并按失败类型分流.md), [ADR-049-ADR-049-插件生态战略--进程隔离-主题语义化-签名验证-DX-工具链](1-决策记录/ADR-049-ADR-049-插件生态战略--进程隔离-主题语义化-签名验证-DX-工具链.md), [ADR-050-插件包签名验证-Ed25519-三级信任链-](1-决策记录/ADR-050-插件包签名验证-Ed25519-三级信任链-.md), [ADR-051-ADR-051--qomicex-CLI-脚手架-零依赖-Node-实现---ADR-050-签名对齐-](1-决策记录/ADR-051-ADR-051--qomicex-CLI-脚手架-零依赖-Node-实现---ADR-050-签名对齐-.md), [ADR-052-目录管理弹窗交互设计-拖拽排序---右键菜单---图标改名](1-决策记录/ADR-052-目录管理弹窗交互设计-拖拽排序---右键菜单---图标改名.md), [ADR-053-插件错误遥测上报---灰度自动暂停](1-决策记录/ADR-053-插件错误遥测上报---灰度自动暂停.md), [ADR-054-ADR-054--l4-远程-WebView-隔离层跨窗口桥设计](1-决策记录/ADR-054-ADR-054--l4-远程-WebView-隔离层跨窗口桥设计.md), [ADR-055-SPD-协议文档拆分-规范-接入-实现三分离](1-决策记录/ADR-055-SPD-协议文档拆分-规范-接入-实现三分离.md), [ADR-059-FA-Lucide-全量图标迁移](1-决策记录/ADR-059-FA-Lucide-全量图标迁移.md), [ADR-060-icon-ternary---MorphIcon-动画迁移](1-决策记录/ADR-060-icon-ternary---MorphIcon-动画迁移.md), [ADR-061-Settings-页重构为-Split-View---List---Switch](1-决策记录/ADR-061-Settings-页重构为-Split-View---List---Switch.md), [ADR-062-InstanceDetail-设置页重构为-List---Switch](1-决策记录/ADR-062-InstanceDetail-设置页重构为-List---Switch.md), [ADR-063-qomicex-CLI-优化与插件-log-API](1-决策记录/ADR-063-qomicex-CLI-优化与插件-log-API.md), [ADR-064-通用插件-Hook-系统-Koa-洋葱管道---前端方法层-hook-v1-](1-决策记录/ADR-064-通用插件-Hook-系统-Koa-洋葱管道---前端方法层-hook-v1-.md), [ADR-065-主页小组件化-react-grid-layout-编辑模式网格](1-决策记录/ADR-065-主页小组件化-react-grid-layout-编辑模式网格.md), [ADR-066-qml-docs-用户指南补全-8-篇功能文档覆盖启动器全部功能](1-决策记录/ADR-066-qml-docs-用户指南补全-8-篇功能文档覆盖启动器全部功能.md), [ADR-067-启动器自更新改为独立-Updater---zip-覆盖式更新](1-决策记录/ADR-067-启动器自更新改为独立-Updater---zip-覆盖式更新.md), [ADR-068-plugin-ui-动画改为-preset-自含-不引入-tailwindcss-animate](1-决策记录/ADR-068-plugin-ui-动画改为-preset-自含-不引入-tailwindcss-animate.md), [ADR-069-plugin-ui-动画速度口径统一与组件细节动效增强](1-决策记录/ADR-069-plugin-ui-动画速度口径统一与组件细节动效增强.md), [ADR-070-实例详情列表内边距统一与概况页重构为-SettingSection](1-决策记录/ADR-070-实例详情列表内边距统一与概况页重构为-SettingSection.md), [ADR-071-个性化增强-视频-动图背景-默认材质细化参数-主题跟随系统](1-决策记录/ADR-071-个性化增强-视频-动图背景-默认材质细化参数-主题跟随系统.md), [ADR-072-非中文语言需先登录微软正版账户才能添加离线-第三方账户](1-决策记录/ADR-072-非中文语言需先登录微软正版账户才能添加离线-第三方账户.md), [ADR-073-插件扫描跳过升级快照与临时目录](1-决策记录/ADR-073-插件扫描跳过升级快照与临时目录.md), [ADR-074-Switch-开关圆点位置对称修正](1-决策记录/ADR-074-Switch-开关圆点位置对称修正.md), [ADR-075-亮色模式液态玻璃底色改为中性灰低透明度](1-决策记录/ADR-075-亮色模式液态玻璃底色改为中性灰低透明度.md), [ADR-076-裸-glass-surface-表面强化液态玻璃观感-不引入-JS-位移-](1-决策记录/ADR-076-裸-glass-surface-表面强化液态玻璃观感-不引入-JS-位移-.md), [ADR-077-新增独立-Dialog-透明度设置](1-决策记录/ADR-077-新增独立-Dialog-透明度设置.md), [ADR-078-安装期库去重改为按完整坐标保留所有版本-修复-NeoForge-安装-404-](1-决策记录/ADR-078-安装期库去重改为按完整坐标保留所有版本-修复-NeoForge-安装-404-.md), [ADR-079-processor-下载-URL-复用-maven_to_path-剥离--type---多源探测-](1-决策记录/ADR-079-processor-下载-URL-复用-maven_to_path-剥离--type---多源探测-.md), [ADR-080-世界预览-移植-world-viewer-领域层为后端服务---HTTP-瓦片端点](1-决策记录/ADR-080-世界预览-移植-world-viewer-领域层为后端服务---HTTP-瓦片端点.md), [ADR-081-世界预览同步上游-8828130-1-13-1-17-区块格式与旧版方块名配色](1-决策记录/ADR-081-世界预览同步上游-8828130-1-13-1-17-区块格式与旧版方块名配色.md), [ADR-082-世界预览同步上游-4e6f71d---1dc33cf-生物群系染色-水面透视---瓦片缓存并发优化](1-决策记录/ADR-082-世界预览同步上游-4e6f71d---1dc33cf-生物群系染色-水面透视---瓦片缓存并发优化.md), [ADR-083-世界预览第三次同步上游-LZ4-区块解压---渲染内颜色记忆表---瓦片队列中心排序](1-决策记录/ADR-083-世界预览第三次同步上游-LZ4-区块解压---渲染内颜色记忆表---瓦片队列中心排序.md), [ADR-084-多实例扫描改指纹缓存与非阻塞两段式-解决73实例1分钟](1-决策记录/ADR-084-多实例扫描改指纹缓存与非阻塞两段式-解决73实例1分钟.md), [ADR-085-启动器更新检测改为通道模型](1-决策记录/ADR-085-启动器更新检测改为通道模型.md), [ADR-086-触控板拖动优化-拖动区改位移阈值与data-qomicex-drag-region](1-决策记录/ADR-086-触控板拖动优化-拖动区改位移阈值与data-qomicex-drag-region.md), [ADR-087-双指触摸板滑动等于滚轮滚动-窗口框架固定与拖动区边界判定](1-决策记录/ADR-087-双指触摸板滑动等于滚轮滚动-窗口框架固定与拖动区边界判定.md), [ADR-088-模组删除一致性与错误上报-失效后重载-请求序号保护-后端-IO-错误传播](1-决策记录/ADR-088-模组删除一致性与错误上报-失效后重载-请求序号保护-后端-IO-错误传播.md), [ADR-089-下载中心按资源类型分组与折叠](1-决策记录/ADR-089-下载中心按资源类型分组与折叠.md), [ADR-090-补齐-mod-换版本与安装端点并接通可配置的全局请求超时-issue-117-133](1-决策记录/ADR-090-补齐-mod-换版本与安装端点并接通可配置的全局请求超时-issue-117-133.md), [ADR-091-资源收藏功能-132-后端-JSON-持久化与资源中心视图切换](1-决策记录/ADR-091-资源收藏功能-132-后端-JSON-持久化与资源中心视图切换.md), [ADR-092-修复-Windows-拖入-Yggdrasil-失效并补齐资源校验补全端点-issue-136-138](1-决策记录/ADR-092-修复-Windows-拖入-Yggdrasil-失效并补齐资源校验补全端点-issue-136-138.md), [ADR-093-取代-ADR-092-自实现-Windows-IDropTarget-同时接文件与文本拖拽-issue-136](1-决策记录/ADR-093-取代-ADR-092-自实现-Windows-IDropTarget-同时接文件与文本拖拽-issue-136.md), [ADR-094-CurseForge-整合包可选模组安装](1-决策记录/ADR-094-CurseForge-整合包可选模组安装.md), [ADR-095-更新可用性提升为会话级共享状态-设置页常驻发现新版本提示-issue-147](1-决策记录/ADR-095-更新可用性提升为会话级共享状态-设置页常驻发现新版本提示-issue-147.md), [ADR-096-资源收藏P2-收藏夹分组-备注-自定义标签](1-决策记录/ADR-096-资源收藏P2-收藏夹分组-备注-自定义标签.md), [ADR-097-资源中心整合包原地更新-索引清单双基线与-journal-回滚-issue-118](1-决策记录/ADR-097-资源中心整合包原地更新-索引清单双基线与-journal-回滚-issue-118.md), [ADR-098-LittleSkin-改用-OAuth-设备代码流登录-issue-145](1-决策记录/ADR-098-LittleSkin-改用-OAuth-设备代码流登录-issue-145.md), [ADR-099-修复-116-存档卡片选中态丢失基础内边距导致内容上浮](1-决策记录/ADR-099-修复-116-存档卡片选中态丢失基础内边距导致内容上浮.md), [ADR-100-外部唤起-qomicex-launcher-OS协议-single-instance-深链动作分发-issue-127](1-决策记录/ADR-100-外部唤起-qomicex-launcher-OS协议-single-instance-深链动作分发-issue-127.md), [ADR-101-模组依赖检测在-core-解析与前端判定-issue-165](1-决策记录/ADR-101-模组依赖检测在-core-解析与前端判定-issue-165.md), [ADR-102-Forge-加载器版本获取改用-Maven-元数据并补官方源回退与缓存校验-issue-176](1-决策记录/ADR-102-Forge-加载器版本获取改用-Maven-元数据并补官方源回退与缓存校验-issue-176.md), [ADR-102-Technic-SingleZip-整合包本地导入-issue-123期1](1-决策记录/ADR-102-Technic-SingleZip-整合包本地导入-issue-123期1.md), [ADR-103-资源详情MC百科跳转与复制名称-资源中心改无限滚动](1-决策记录/ADR-103-资源详情MC百科跳转与复制名称-资源中心改无限滚动.md), [ADR-104-复制按钮统一CopyActionIcon并修复定时器缺陷-issue-191](1-决策记录/ADR-104-复制按钮统一CopyActionIcon并修复定时器缺陷-issue-191.md), [ADR-105-资源中心-Technic-源-API-模型对齐-后端代理安装与-build-参数-401-归因修正-issue-151](1-决策记录/ADR-105-资源中心-Technic-源-API-模型对齐-后端代理安装与-build-参数-401-归因修正-issue-151.md), [ADR-106-JarMod-支持-非破坏性派生-jar-注入古董包-modpack-jar-issue-180](1-决策记录/ADR-106-JarMod-支持-非破坏性派生-jar-注入古董包-modpack-jar-issue-180.md), [ADR-107-Technic-Solder-在线分发支持-逐文件下载管线与-jarmod-落地-issue-181](1-决策记录/ADR-107-Technic-Solder-在线分发支持-逐文件下载管线与-jarmod-落地-issue-181.md), [BATCH-PLAN-CSharp到Rust迁移批次计划](1-决策记录/BATCH-PLAN-CSharp到Rust迁移批次计划.md), [CHECKPOINT_BATCH_1-FA-to-Lucide](1-决策记录/checkpoints/CHECKPOINT_BATCH_1-FA-to-Lucide.md), [CHECKPOINT_BATCH_1](1-决策记录/checkpoints/CHECKPOINT_BATCH_1.md), [CHECKPOINT_BATCH_2](1-决策记录/checkpoints/CHECKPOINT_BATCH_2.md), [CHECKPOINT_BATCH_3](1-决策记录/checkpoints/CHECKPOINT_BATCH_3.md), [CHECKPOINT_BATCH_4](1-决策记录/checkpoints/CHECKPOINT_BATCH_4.md), [CHECKPOINT_BATCH_5](1-决策记录/checkpoints/CHECKPOINT_BATCH_5.md), [CHECKPOINT_BATCH_6](1-决策记录/checkpoints/CHECKPOINT_BATCH_6.md), [VERIFICATION_LOG-联机房主解析复测](1-决策记录/VERIFICATION_LOG-联机房主解析复测.md)
- **2-架构设计** (33): [崩溃分析-Mod名称交叉匹配设计](2-架构设计/崩溃分析-Mod名称交叉匹配设计.md), [插件调试harness](2-架构设计/插件调试harness.md), [插件签名兼容与降级策略](2-架构设计/插件签名兼容与降级策略.md), [插件商店集成](2-架构设计/插件商店集成.md), [插件生态技术提案](2-架构设计/插件生态技术提案.md), [插件系统](2-架构设计/插件系统.md), [插件Hook系统](2-架构设计/插件Hook系统.md), [动画系统](2-架构设计/动画系统.md), [技术选型](2-架构设计/技术选型.md), [架构设计](2-架构设计/架构设计.md), [联机故障诊断-easytier中继数据面](2-架构设计/联机故障诊断-easytier中继数据面.md), [联机故障诊断-easytier中继数据面未打通](2-架构设计/联机故障诊断-easytier中继数据面未打通.md), [联机流程](2-架构设计/联机流程.md), [模块划分](2-架构设计/模块划分.md), [模组快捷安装管线](2-架构设计/模组快捷安装管线.md), [目录树状图](2-架构设计/目录树状图.md), [启动进度分步显示](2-架构设计/启动进度分步显示.md), [启动流程](2-架构设计/启动流程.md), [启动器自更新一键链路-独立-Updater](2-架构设计/启动器自更新一键链路-独立-Updater.md), [启动前Java检查与自动下载](2-架构设计/启动前Java检查与自动下载.md), [前端浏览器调试-Playwright-Tauri-mock注入](2-架构设计/前端浏览器调试-Playwright-Tauri-mock注入.md), [设置管理流程](2-架构设计/设置管理流程.md), [拖拽安装管线](2-架构设计/拖拽安装管线.md), [完整项目架构图](2-架构设计/完整项目架构图.md), [下载器-代理与忽略TLS证书选项](2-架构设计/下载器-代理与忽略TLS证书选项.md), [账号管理流程](2-架构设计/账号管理流程.md), [整合包快捷安装对话框](2-架构设计/整合包快捷安装对话框.md), [主题语义Token规范v1](2-架构设计/主题语义Token规范v1.md), [资源中心流程](2-架构设计/资源中心流程.md), [I18N国际化设计](2-架构设计/I18N国际化设计.md), [LittleSkin-OAuth-登录接入方案](2-架构设计/LittleSkin-OAuth-登录接入方案.md), [PHASE1-插件生态-任务派发提示词](2-架构设计/PHASE1-插件生态-任务派发提示词.md), [Technic-整合包支持-实现地图与排障](2-架构设计/Technic-整合包支持-实现地图与排障.md)
- **checkpoints** (7): [CHECKPOINT_BATCH_1-FA-to-Lucide](1-决策记录/checkpoints/CHECKPOINT_BATCH_1-FA-to-Lucide.md), [CHECKPOINT_BATCH_1](1-决策记录/checkpoints/CHECKPOINT_BATCH_1.md), [CHECKPOINT_BATCH_2](1-决策记录/checkpoints/CHECKPOINT_BATCH_2.md), [CHECKPOINT_BATCH_3](1-决策记录/checkpoints/CHECKPOINT_BATCH_3.md), [CHECKPOINT_BATCH_4](1-决策记录/checkpoints/CHECKPOINT_BATCH_4.md), [CHECKPOINT_BATCH_5](1-决策记录/checkpoints/CHECKPOINT_BATCH_5.md), [CHECKPOINT_BATCH_6](1-决策记录/checkpoints/CHECKPOINT_BATCH_6.md)
- **3-api规范** (6): [插件系统API](3-API规范/插件系统API.md), [设置-缓存清理端点](3-API规范/设置-缓存清理端点.md), [实例删除与安装失败回滚](3-API规范/实例删除与安装失败回滚.md), [API列表](3-API规范/API列表.md), [Forge-NeoForge-安装器缺失库URL决策](3-API规范/Forge-NeoForge-安装器缺失库URL决策.md), [SCF联机扩展协议规范](3-API规范/SCF联机扩展协议规范.md)
- **6-ui** (6): [下载中心UI规范](6-UI/组件/下载中心UI规范.md), [关于页鸣谢列表](6-UI/组件设计/关于页鸣谢列表.md), [README](6-UI/组件设计/README.md), [UI设计规范](6-UI/组件设计/UI设计规范.md), [UI设计系统](6-UI/组件设计/UI设计系统.md), [UI组件设计规范](6-UI/组件设计/UI组件设计规范.md)
- **8-部署运维** (6): [构建部署](8-部署运维/构建部署.md), [环境配置说明](8-部署运维/环境配置说明.md), [GitHub-Issue-模板与自动分类](8-部署运维/GitHub-Issue-模板与自动分类.md), [PHASE1-联调记录](8-部署运维/PHASE1-联调记录.md), [TODO](8-部署运维/TODO.md), [Windows-DLL打包与运行时解压机制](8-部署运维/Windows-DLL打包与运行时解压机制.md)
- **组件设计** (5): [关于页鸣谢列表](6-UI/组件设计/关于页鸣谢列表.md), [README](6-UI/组件设计/README.md), [UI设计规范](6-UI/组件设计/UI设计规范.md), [UI设计系统](6-UI/组件设计/UI设计系统.md), [UI组件设计规范](6-UI/组件设计/UI组件设计规范.md)
- **4-编码规范** (3): [CSharp-规范](4-编码规范/CSharp-规范.md), [Rust-规范](4-编码规范/Rust-规范.md), [TypeScript-规范](4-编码规范/TypeScript-规范.md)
- **7-调用规范** (3): [调用规范-HTTP-3 启用指南](7-调用规范/调用规范-HTTP-3 启用指南.md), [前端API调用规范](7-调用规范/前端API调用规范.md), [异常处理规范](7-调用规范/异常处理规范.md)
- **9-系统要求** (1): [项目规模统计报告](9-系统要求/项目规模统计报告.md)
- **排障** (1): [Technic-整合包支持-实现地图与排障](2-架构设计/Technic-整合包支持-实现地图与排障.md)
- **实现地图** (1): [Technic-整合包支持-实现地图与排障](2-架构设计/Technic-整合包支持-实现地图与排障.md)
- **统计报告** (1): [项目规模统计报告](9-系统要求/项目规模统计报告.md)
- **项目规模** (1): [项目规模统计报告](9-系统要求/项目规模统计报告.md)
- **整合包** (1): [Technic-整合包支持-实现地图与排障](2-架构设计/Technic-整合包支持-实现地图与排障.md)
- **子模块** (1): [项目规模统计报告](9-系统要求/项目规模统计报告.md)
- **组件** (1): [下载中心UI规范](6-UI/组件/下载中心UI规范.md)
- **jarmod** (1): [Technic-整合包支持-实现地图与排障](2-架构设计/Technic-整合包支持-实现地图与排障.md)
- **sloc** (1): [项目规模统计报告](9-系统要求/项目规模统计报告.md)
- **solder** (1): [Technic-整合包支持-实现地图与排障](2-架构设计/Technic-整合包支持-实现地图与排障.md)
- **technic** (1): [Technic-整合包支持-实现地图与排障](2-架构设计/Technic-整合包支持-实现地图与排障.md)
