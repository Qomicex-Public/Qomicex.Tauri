# ADR-031：下载传输按来源自动路由：Modrinth 走 HTTP/1.1 并行，其余源走 HTTP/2

| 属性 | 内容 |
|---|---|
| 状态 | 已采纳 |
| 日期 | 2026-08-21 |
| 决策者 | AI Agent |

## 背景

整合包 mod 下载仅 ~100KB/s、观感「多线程串行」，300 个 mod 需数小时。真机 A/B（qomicex-downloader-rust/examples/modpack_ab.rs，同一批 89 个 Modrinth 文件、并发 16）实测：H2 多路复用 90.9MB 用 122s（779 KB/s），H1 并行连接 90.9MB 用 33s（2899 KB/s），H1 快 3.72 倍。根因：Modrinth CDN 按连接限速，reqwest HTTP/2 把同主机并发请求多路复用到单条物理连接，被压到单连接吞吐。用户确认仅 Modrinth 按连接限速，Mojang/BMCLAPI/CurseForge 等不限速（这些源 H2 多路复用更快）。

## 决策

下载传输改为「按来源自动路由」：下载管理器同时构造 HTTP/1.1 并行客户端与 HTTP/2 客户端，worker 按 URL 主机判定——命中 h1_parallel_hosts（恒含 cdn.modrinth.com）的走 HTTP/1.1 并行连接（每个文件独立 TCP 连接，规避按连接限速 CDN 的 H2 多路复用瓶颈），其余源（Mojang/BMCLAPI/CF 等）走 HTTP/2 多路复用。新增下载设置「强制 HTTP/1.1 并行」（http1_parallel，默认 false）作为全局覆盖开关；默认即按来源自动，无需用户手动选。签名变化：build_clients 现返回 (h2, h1, Option<h3>)；RunContext 增加 h1 与 use_h1 原子旗标。

## 备选方案

### 方案 全局强制 HTTP/1.1 并行（此前初版默认）
- 优点：实现简单，对限速 CDN 全部生效
- 缺点：会牺牲 Mojang/BMCLAPI 等非限速源在 HTTP/2 多路复用下的速度
- 为何不选：用户明确只有 Modrinth 限速，故改为按来源路由以保留其余源 H2 速度

### 方案 批次计时启发式自动检测限速
- 优点：无需预知限速主机
- 缺点：阈值难定、小文件/慢网络易误判、批次中途切换复杂且丢进度
- 为何不选：用户已确认仅 Modrinth 限速，按来源静态路由更稳，无需脆弱计时启发式

### 方案 axis HTTP/2 多连接（同主机开多条 H2 连接）
- 优点：保留 H2 帧效率又并行
- 缺点：reqwest/hyper 无「同主机强制 N 条 H2 连接」的公开开关，实现复杂
- 为何不选：H1 并行已达目的，避免深改 hyper

## 影响
- qomicex-downloader-rust：task.rs(DownloadOptions.h1_parallel_hosts)、manager.rs(build_clients 三元组 + host_needs_h1 + worker 路由)、engine.rs(RunContext.h1/use_h1 + client() 路由)
- src-backend：settings.rs(http1_parallel 语义改强制，默认 false)、state.rs(H1_PARALLEL_HOSTS + 透传 h1_parallel_hosts)、system.rs(热替换条件)
- 前端：settings.ts(http1Parallel 类型/默认 false)、Settings.tsx(勾选项)、7 语言 i18n 文案
- 回归测试 tests/host_cache_parallel.rs 与单测 host_routing_defaults_to_h2_except_listed_cdns

## 修订记录
| 日期 | 版本 | 修改内容 | 修改人 |
|---|---|---|---|
| 2026-08-21 | v1.0 | 初版创建 | AI Agent |