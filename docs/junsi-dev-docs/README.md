# 项目文档索引

最后更新：2026-08-08

## 1-决策记录

*ADR 架构决策记录*

- [ADR: Qomicex.Downloader → Qomicex.Downloader.Refactor 迁移](1-决策记录/ADR-001-Downloader-迁移.md)
- [ADR-002：FTB 整合包在线安装功能 — 进度更新与任务管理修复](1-决策记录/ADR-002-FTB-整合包在线安装功能---进度更新与任务管理修复.md)
- [ADR-004：C# ASP.NET → Rust Tauri IPC 全量迁移架构决策](1-决策记录/ADR-004--C--ASP-NET---Rust-Tauri-IPC-全量迁移架构决策.md)
- [历史参考：C# → Rust 迁移批次计划](1-决策记录/BATCH-PLAN-CSharp到Rust迁移批次计划.md)

## 2-架构设计

*系统架构、模块设计、核心流程*

- [启动流程](2-架构设计/启动流程.md)
- [技术选型](2-架构设计/技术选型.md)
- [架构设计](2-架构设计/架构设计.md)
- [模块划分](2-架构设计/模块划分.md)
- [插件系统](2-架构设计/插件系统.md)
- [联机流程（Connector）](2-架构设计/联机流程.md)
- [资源中心流程](2-架构设计/资源中心流程.md)
- [账号管理流程](2-架构设计/账号管理流程.md)
- [设置管理流程](2-架构设计/设置管理流程.md)
- [崩溃分析 — Mod 名称交叉匹配设计](2-架构设计/崩溃分析-Mod名称交叉匹配设计.md)

## 3-API规范

*RESTful API 设计规范*

- [API 端点列表](3-API规范/API列表.md)
- [插件系统 API](3-API规范/插件系统API.md)

## 4-编码规范

*各语言编码规范*

- [C# 编码规范](4-编码规范/CSharp-规范.md)
- [TypeScript 编码规范](4-编码规范/TypeScript-规范.md)

## 6-UI/组件设计

*UI 控件、组件设计规范*

- [UI 组件设计规范](6-UI/组件设计/UI组件设计规范.md)
- [Qomicex Launcher — UI Design Specification](6-UI/组件设计/UI设计系统.md)
- [UI 设计规范（中文完整版）](6-UI/组件设计/UI设计规范.md)

## 7-调用规范

*服务间调用、异常处理、日志规范*

- [前端 API 调用规范](7-调用规范/前端API调用规范.md)
- [异常处理规范](7-调用规范/异常处理规范.md)

## 8-部署运维

*部署架构、环境配置*

- [构建与部署](8-部署运维/构建部署.md)
- [环境配置说明](8-部署运维/环境配置说明.md)



### 2026-08-09 更新
# 项目文档索引

最后更新：2026-08-09

> 当前后端：**Rust Axum**（`src-backend/qomicex-backend/`，ADR-004 迁移中，插件/联机模块未移植）。C# 版 `Qomicex.Launcher.Backend.Neo` 保留在 `legacy` 分支。



### 2026-08-09 更新
- [Rust 编码规范](4-编码规范/Rust-规范.md)
- [C# 编码规范（legacy）](4-编码规范/CSharp-规范.md)
- [TypeScript 编码规范](4-编码规范/TypeScript-规范.md)



### 2026-08-09 更新
> 当前后端：**Rust Axum**（`src-backend/qomicex-backend/`，ADR-004 迁移中，仅 Connector 联机模块未移植）。C# 版 `Qomicex.Launcher.Backend.Neo` 保留在 `legacy` 分支。

