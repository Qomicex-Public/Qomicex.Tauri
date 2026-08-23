# ADR-045：IPC 迁移遗留 3 项已知限制的处理决策（不修复，记录为已知限制）

| 属性 | 内容 |
|---|---|
| 状态 | 已采纳 |
| 日期 | 2026-08-23 |
| 决策者 | AI Agent |

## 背景

后端从 TCP 切换到 IPC（QIPC 管道）后，诊断发现并修复了 2 个 P0 bug（multipart 上传 body 丢失、UTF-8 跨块乱码）和 2 个防御性改进（截断帧超时、StreamRegistry 竞态）。剩余 3 个问题经分析确认：BUG-3（Tauri IPC custom protocol 失败警告）、BUG-6（forward() 整体缓冲大响应）、BUG-7（ipc_stream body JSON 数组膨胀）。用户决定不修复，记录为已知限制。

## 决策

3 个遗留问题均不修复，记录为已知限制：
1. BUG-3（Tauri IPC custom protocol 失败警告）：Tauri v2 内部机制，WebView2 环境对 custom protocol 支持不完整时自动回退 postMessage 并打印警告。无应用层配置项可禁用，功能正常（invoke 10/10 成功），仅控制台噪音 + 每次 invoke 多一次失败请求。接受现状。
2. BUG-6（forward() 整体缓冲大响应）：custom protocol 响应必须 Cow<'static, [u8]> 整体在内存（架构硬限制，无法流式）。大响应下载点（exportDiagnostics、downloadExportTask、getSchematicBytes）为低频用户主动操作，几百 MB 内存缓冲在现代机器可接受。接受现状。
3. BUG-7（ipc_stream body JSON 数组膨胀）：Tauri invoke 用 JSON 序列化，二进制只能转数组（膨胀 ~4 倍）或 base64（膨胀 33%）。实测 Uint8Array 直接传是对象格式更糟，Array.from 数组格式相对最优。上传为低频操作，功能正确，接受现状。

## 备选方案

### 方案 BUG-3 升级 Tauri 版本
- 优点：可能包含上游 IPC 修复
- 缺点：升级有回归风险，且警告是回退机制本身非 bug
- 为何不选：Tauri 2.11.3 已包含相关修复（#10582 等），警告是正常回退设计

### 方案 BUG-6 加 2GB 缓冲上限防御
- 优点：防 OOM
- 缺点：导出 zip 通常几十到几百 MB，上限防御收益低
- 为何不选：低频操作 + 现代机器内存充足

### 方案 BUG-7 改 base64
- 优点：上传膨胀从 4 倍降到 33%
- 缺点：需改后端 StreamRequest.body 协议类型，影响 ipc.ts 内 2 个调用方
- 为何不选：上传为低频操作，功能正确，改动有协议变更风险

## 影响
- docs/junsi-dev-docs/1-决策记录/ADR-045
- 无代码改动
- 后续若用户反馈大文件上传慢或导出 OOM，再按备选方案处理

## 修订记录
| 日期 | 版本 | 修改内容 | 修改人 |
|---|---|---|---|
| 2026-08-23 | v1.0 | 初版创建 | AI Agent |