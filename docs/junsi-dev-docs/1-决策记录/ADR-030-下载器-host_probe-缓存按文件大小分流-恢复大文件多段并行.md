# ADR-030：下载器 host_probe 缓存按文件大小分流，恢复大文件多段并行

| 属性 | 内容 |
|---|---|
| 状态 | 已采纳 |
| 日期 | 2026-08-21 |
| 决策者 | AI Agent |

## 背景

用户反馈整合包（mrpack/zip）在线/手动导入安装时：包包体下载仅 ~100KB/s、mod 文件下载卡住报安装超时。探针实测（qomicex-downloader mock，固定每连接 1MB/s）定位根因：qomicex-downloader-rust 的 `run_once` 在 commit 5561263 引入 host_probe 缓存短路后，对同一个 CDN 主机（cdn.modrinth.com / edge.forgecdn.net）上所有「缓存命中」的文件一律走 `run_streamed` 单连接流式，丢弃 `run_ranged` 的多段并行（最多 16 段）。实测：首文件 12MB 用 10s(~1260KB/s，多段并行)，缓存命中同文件 12MB 用 24s(~530KB/s，单连接)，正好慢一倍。叠加后端 install_service.rs download_batch 的 120s 无进展看门狗，单连接大文件易触发「下载超时」。

## 决策

采用「缓存命中按文件大小分流」：host_probe 缓存命中且该主机支持 Range（range_ok=true）时，用一次轻量 HEAD 获取文件大小，若 size > split_threshold(10MB) 则仍走 `run_ranged` 多段并行，否则（小文件）保留单连接 `run_streamed` 快路径；主机不支持 Range（range_ok=false）时维持原样单连接流式（无法分片，且保持跳过 HEAD 的优化）。新增 `cached_size` 辅助方法：HEAD 拿 Content-Length 并记录跟随重定向后的真实落地地址（供分段 Range 使用，绕开纯重定向器对 Range 的 404）。不加宽 install_service 的 120s 看门狗（用户明确只改下载器并行）。

## 备选方案

### 方案 去掉 host_probe 短路，一律探测
- 优点：实现最简、语义最正确
- 缺点：完全放弃「大量小文件跳过 HEAD」的优化（Minecraft 库 5000 小文件场景可能回归）
- 为何不选：用户选择方案 A，保留小文件优化

### 方案 只放宽 120s 看门狗
- 优点：改动最小
- 缺点：治标不治本，不提升吞吐，仅降低误杀概率
- 为何不选：不解决慢的根本问题，未采用

### 方案 多连接同时下整文件竞速
- 优点：无需 Range 也能并行
- 缺点：重复浪费流量、校验/落盘复杂，且需服务器容忍多连接
- 为何不选：复杂度高、收益不确定，未采用

## 影响
- qomicex-downloader-rust/src/engine.rs run_once + 新增 cached_size
- 回归测试 tests/host_cache_parallel.rs（修复前 FAILED / 修复后 PASS）
- 同 CDN 主机缓存命中后，大文件（整合包包体/大 mod）恢复多段并行下载

## 修订记录
| 日期 | 版本 | 修改内容 | 修改人 |
|---|---|---|---|
| 2026-08-21 | v1.0 | 初版创建 | AI Agent |