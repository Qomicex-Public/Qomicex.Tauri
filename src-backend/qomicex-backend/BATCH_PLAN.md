# Batch Plan — Rust 后端逐模块移植

> 策略：共享服务（Instance/Account/JavaRuntime 等）由各子代理写独立文件，主控统一
> 接线(app.rs/state.rs/main.rs) + 编译 + 审查 + conventional commit。已完成的 System 切片为基线。

## 依赖图（共享服务 → 端点）

```
services/instance.rs        → Version(scan), Instance, Launch, Modpack, InstanceFiles, ResourceDownload
services/account.rs         → Auth, Account
services/skin.rs            → Skin
services/java_runtime.rs    → Java
services/install_tracker.rs → Launch, Modpack, ProgressSSE
services/modpack.rs         → Modpack
services/plugin_store.rs    → Plugin
services/connector(待定)     → Connector（他人负责，跳过）
middleware/trace            → Log, diagnostics/trace
```

## 批次

| Batch | 单元（子代理） | 产出文件 | 依赖 |
|:--|:--|:--|:--|
| 1 | a) InstanceService + GameInstance | `services/instance.rs` `models/game_instance.rs` | 无 core 依赖 |
| 1 | b) AccountService | `services/account.rs` | core auth + CryptHelper |
| 1 | c) System 收尾：diagnostics/trace + 404 兜底 | `middleware/trace.rs` `middleware/not_found.rs` | 无 |
| 2 | Version / Loader / Java 端点 | `endpoints/version.rs` `loader.rs` `java.rs` | Batch1 services + core api/version,installer,java |
| 3 | Instance / Launch / ProgressSSE | `endpoints/instance.rs` `launch.rs` `progress_sse.rs` | Batch1(a) + core + install_tracker |
| 4 | ResourceCenter / ResourceDownload / Resource / InstanceFiles | `endpoints/*.rs` | core expansion + curseforge |
| 5 | Account / Skin / Auth / Mcmod | `endpoints/*.rs` | Batch1(b) + services |
| 6 | Modpack / Plugin / Announcement / Update / License | `endpoints/*.rs` | Batch1 + services |
| 7 | Log / (Connector 待定) | `endpoints/*.rs` | middleware/trace |

## 并行度
每 Batch 并发 ≤3 子代理；子代理只写独立文件、不跑 cargo；主控编译把关。

## 验证
每 Batch 提交后运行 `scripts/test-api-filters.sh` + 手工快照比对（忽略 timestamp/traceId/latency）。
