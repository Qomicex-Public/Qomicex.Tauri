# ADR-038：下载器传输模型改为 aria2 式独立 TCP 分段并修复 total timeout 杀请求

| 属性 | 内容 |
|---|---|
| 状态 | 已采纳 |
| 日期 | 2026-08-22 |
| 决策者 | AI Agent |

## 背景

用户自建 Modrinth 镜像（mirror.qomicex.dpdns.org，openresty+腾讯EdgeOne）实测：curl 单连接 Range 仅 ~125KB/s；aria2 16 连接跑 13MB/s——源按连接限速。原下载器默认走 HTTP/2 多路复用，16 个分段全部挤在同一条 TCP 流上，「并行」退化为单流吞吐。更致命的是 reqwest per-request `.timeout(60s)` 从建连一直计时到响应体读完：8MB 分段在 <136KB/s 的慢流上必然超 60s 被杀掉重试，日志表现为 16 段×5 次重试全灭「error decoding response body」→ 降级整文件 → 流式同样超时死循环，实际体验几百 KB/s 甚至不如浏览器单线程。另发现 engine.rs 的 speeds SpeedMap 每 chunk 抢 tokio Mutex 写入但全库无读者，纯锁开销。

## 决策

对齐 aria2 传输模型（-x 独立连接）：①run_ranged 全部分段请求一律改走 HTTP/1.1 客户端（hyper 连接池为并发段自动建立多条 TCP），不再依赖 use_h1 主机路由；②移除分段/流式 GET 的 per-request total timeout，改为仅用 tokio::time::timeout 包裹 send() 保护响应头阶段（TTFB=options.timeout），body 传输不限时、断流/龟速由既有看门狗（idle_timeout/slow_factor）负责；③删除 speeds 写锁死代码（SpeedMap 类型+字段+每chunk写入）。真机验证：202MB 文件 32.6s 完成，平均 5.92MB/s、峰值 13MB/s 与 aria2 持平，零重试零断流（修复前该 URL 分段全灭）。cargo test 33 通过、clippy --all-targets 0 警告。

## 备选方案

### 方案 自适应 H1/H2 按主机测速选路
- 优点：兼顾低延迟与高延迟网络
- 缺点：复杂度高、测速样本噪声大、首次下载额外开销
- 为何不选：真机证据已充分证明独立 TCP 在目标网络（国内高RTT/按连接限速CDN）压倒性优势，无需自适应

### 方案 仅修复 total timeout
- 优点：改动最小
- 缺点：单连接限速下吞吐仍是 ~125KB/s 量级，无法达到 aria2 水平
- 为何不选：只消除重试灾难，不解决带宽聚合问题

## 影响
- qomicex-downloader-rust/src/engine.rs（传输核心路径重写）
- qomicex-downloader-rust/src/manager.rs（RunContext 构造去 speeds 字段）
- backend 经 path 依赖下次构建自动生效，无 API 变化
- use_h1/h1_parallel_hosts 路由语义弱化：仅流式小文件路径生效
- 已知既有行为：动态拆分时进度计数可超过 total（重复字节计入 downloaded），未在本次修改

## 修订记录
| 日期 | 版本 | 修改内容 | 修改人 |
|---|---|---|---|
| 2026-08-22 | v1.0 | 初版创建 | AI Agent |

### 2026-08-22 更新
## 真机验证补充（2026-08-22 第二轮）

### 追加修复：动态拆分下限 64KB → 2MB
首轮真机测试暴露尾段碎片化：剩余几百 KB 的段仍被一分为二，每次拆分付出 abort 在途连接 + 新建 TCP/TLS 握手 + 在途数据重下的代价，尾段吞吐从 ~10MB/s 掉到 <1MB/s，计数器超 total 达 20%（abort 重下浪费）。对齐 aria2 `--min-split-size` 思路，`MIN_SPLIT_REMAINING` 提到 2MB 后：拆分次数 8+ → 3，浪费字节 40MB → 10MB。

### 基准数据（同机同源）
| 场景 | 结果 |
|---|---|
| 单文件 202MB（用户镜像，单连接限速 125KB/s） | 51.2s/3.77MB/s → **29.9s/6.44MB/s**，峰值 ~15MB/s，零失败零重试 |
| 多文件 89 个（cdn.modrinth.com，全局并发 64，小文件流式路径） | **6.5s 完成，聚合 14.01MB/s，峰值 24.4MB/s，89/89 成功** |

### 已知既有行为（未在本次修改）
- 动态拆分 abort 时在途字节会计入 downloaded 但需重下，进度计数可短暂超过 total（幂等写盘保证文件正确性，最终以磁盘大小校验）。
- 小文件流式路径仍按 use_h1 路由（默认 H2 复用）：Modrinth CDN 实测不受限，14MB/s+ 无压力；若其他源海量小文件偏慢可再评估切独立 TCP。


### 2026-09-12 更新

### 2026-09-12 补完：client 级 total timeout 遗漏（本 ADR 未竟事项）

**问题复现**：用户反馈「下载文件太慢会超时（不是连接失败，是规定时间内没下完）」。本 ADR 当时只移除了 `engine.rs` 的 **per-request** `.timeout(60s)`，但 `manager.rs::build_clients` 给 h1/h2/h3 三个 `reqwest::Client` 仍设了 `.timeout(options.timeout)`。reqwest 的 `ClientBuilder::timeout` 是**整包总超时**（`TotalTimeoutBody`：从建连计时到 body 读完），per-request 移除对它无效——慢源上稍大的文件仍会在 60s 被杀。注释「body 不限时」与实现不符，属遗漏。

**探针实测**（96KB @ 16KB/s，故意把 timeout 压到 1s，idle watchdog 默认 30s）：
```
CASE ranged:   state=Failed   ← 分片路径被杀
CASE streamed: state=Failed   ← 流式路径被杀
```
（对照：96KB@48KB/s 传输 2.6s 时侥幸 Completed，说明旧行为是「传输时长 > timeout 即失败」的硬杀。）

**修复**：`manager.rs::build_clients` 三个 client 全部删掉 `.timeout()`，保留 `.connect_timeout()`。TTFB 由 `engine.rs` 每请求的 `tokio::time::timeout(..., send)` 守卫（`try_segment_once` / `try_streamed_once`），body 传输由 idle watchdog 守卫——正是本 ADR 声明的设计意图。

**回归测试**：`download_core.rs::slow_but_progressing_body_not_killed_by_timeout`（no_range=false/true 两路径）。验证「没修复时会失败」：stash 掉 `manager.rs` 修复后该用例 FAILED（Failed vs Completed），还原后 PASS。全量 22 测试通过、clippy 0 警告。

**验证方法**：`cd qomicex-downloader-rust && cargo test slow_but_progressing && cargo test && cargo clippy --all-targets`。

**影响**：`qomicex-downloader-rust/src/manager.rs`（3 行删除）。backend 经 path 依赖自动生效，无 API 变化。

