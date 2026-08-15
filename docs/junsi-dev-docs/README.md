# 项目文档索引

最后更新：2026-08-15 16:47

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
- [ADR-010: Puppeteer 自动化组件素材采集方案](1-决策记录/ADR-010-Puppeteer自动化组件素材采集方案.md)
- [ADR-011：模组更新检查改造：批次哈希匹配 + 独立 6h 缓存 + 自动检查](1-决策记录/ADR-011-模组更新检查改造-批次哈希匹配---独立-6h-缓存---自动检查.md)
- [ADR-012：check-updates 更新判定：Modrinth game_versions 序列化修复 + CurseForge latest_files 客户端过滤](1-决策记录/ADR-012-check-updates-更新判定-Modrinth-game_versions-序列化修复---CurseForge-latest_files-客户端过滤.md)
- [ADR-013：check-updates loader 兼容回退：非标准加载器（Cleanroom/LiteLoader）按 Forge 兼容处理](1-决策记录/ADR-013-check-updates-loader-兼容回退-非标准加载器-Cleanroom-LiteLoader-按-Forge-兼容处理.md)
- [ADR-014：模组更新流程改造：下载中心编排 + 缓存失效修复](1-决策记录/ADR-014-模组更新流程改造-下载中心编排---缓存失效修复.md)
- [Batch Plan: Full Migration C# → Rust + Axum→IPC](1-决策记录/BATCH-PLAN-CSharp到Rust迁移批次计划.md)

## 2-架构设计

*系统架构、模块设计*

- [启动流程](2-架构设计/启动流程.md)
- [Mod 名称交叉匹配设计](2-架构设计/崩溃分析-Mod名称交叉匹配设计.md)
- [技术选型](2-架构设计/技术选型.md)
- [插件系统架构](2-架构设计/插件系统.md)
- [架构设计](2-架构设计/架构设计.md)
- [模块划分](2-架构设计/模块划分.md)
- [联机故障诊断](2-架构设计/联机故障诊断-easytier中继数据面.md)
- [联机故障诊断-easytier中继数据面未打通](2-架构设计/联机故障诊断-easytier中继数据面未打通.md)
- [联机流程（Connector）](2-架构设计/联机流程.md)
- [设置管理流程](2-架构设计/设置管理流程.md)
- [账号管理流程](2-架构设计/账号管理流程.md)
- [资源中心流程](2-架构设计/资源中心流程.md)

## 3-API规范

*RESTful API 设计规范*

- [API 端点参考](3-API规范/API列表.md)
- [插件系统 API](3-API规范/插件系统API.md)

## 4-编码规范

*各语言编码规范*

- [C# 编码规范](4-编码规范/CSharp-规范.md)
- [Rust 编码规范](4-编码规范/Rust-规范.md)
- [TypeScript 编码规范](4-编码规范/TypeScript-规范.md)

## 6-UI/组件设计

*UI 控件、组件设计规范*

- [UI 组件设计规范](6-UI/组件设计/UI组件设计规范.md)
- [Qomicex Launcher — UI Design Specification](6-UI/组件设计/UI设计系统.md)
- [Qomicex Launcher 设计规范](6-UI/组件设计/UI设计规范.md)

## 7-调用规范

*服务间调用、异常处理、日志规范*

- [前端 API 调用规范](7-调用规范/前端API调用规范.md)
- [异常处理规范](7-调用规范/异常处理规范.md)

## 8-部署运维

*部署架构、环境配置*

- [构建与部署](8-部署运维/构建部署.md)
- [环境配置说明](8-部署运维/环境配置说明.md)

