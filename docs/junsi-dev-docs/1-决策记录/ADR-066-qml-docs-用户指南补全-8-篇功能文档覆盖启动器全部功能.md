# ADR-066：qml-docs 用户指南补全：8 篇功能文档覆盖启动器全部功能

| 属性 | 内容 |
|---|---|
| 状态 | 已采纳 |
| 日期 | 2026-09-04 |
| 决策者 | AI Agent |

## 背景

qml-docs 的使用指南分区（docs/guide/）此前仅 3 篇（index/getting-started/mirror），启动器大部分功能（实例/资源/下载/账户/联机/日志/设置）无用户文档。用户要求参考 LauncherX 指南（kb.corona.studio）的分区结构补全。

## 决策

新增 8 篇用户文档（内容全部从启动器实际代码与 i18n 枚举，零杜撰）：instances（实例管理：列表/安装/详情 11 分区/版本隔离/删除）、resource-center（搜索/安装到实例/整合包/Mod 更新）、downloads（下载中心/加速设置/文件命名）、accounts（5 种登录方式/默认账户/皮肤披风/FAQ）、connect（P2P 联机：房主/玩家流程/Mod 一致性三态/房主管理含踢人与审核/故障排查表）、log-analysis（两入口/手动分析/崩溃分析/mclo.gs/实时日志）、plugins（安装三途径/能力表/权限/管理/依赖，链到开发分区）、running（运行状态/实时日志窗口/崩溃处理）+ settings（13 分类全表：基础/启动内存 Java/下载/缓存/网络代理/Java 运行时/外观材质/工具箱/关于）。侧边栏重组为三组（开始/功能/设置与网络）对齐 LX 的「开始/设置/功能」分区法。风格：面向终端用户零代码、步骤表+tip/warning 容器、与站内 getting-started/mirror 一致。所有文档与 dashboard-widget/镜像源互相链接成网。docs:build 通过无死链，dist 18 页全部生成。

## 备选方案

### 方案 翻译引入 kb.corona.studio 全套结构（多语言目录 zhCN/enUS）
- 优点：国际化架构一步到位
- 缺点：内容与启动器实际功能脱节风险，且多语言维护成本高
- 为何不选：站内现有文档均为纯中文单语言目录结构（guide/plugins/libraries/store），引入多语言需全站重构，超出本次范围；保持单语言与站内一致

## 影响
- docs/guide/instances.md 新增
- docs/guide/resource-center.md 新增
- docs/guide/downloads.md 新增
- docs/guide/accounts.md 新增
- docs/guide/connect.md 新增
- docs/guide/running.md 新增
- docs/guide/log-analysis.md 新增
- docs/guide/plugins.md 新增
- docs/guide/settings.md 新增
- docs/guide/index.md 重写目录
- docs/.vitepress/config.mts 侧边栏三组

## 修订记录
| 日期 | 版本 | 修改内容 | 修改人 |
|---|---|---|---|
| 2026-09-04 | v1.0 | 初版创建 | AI Agent |