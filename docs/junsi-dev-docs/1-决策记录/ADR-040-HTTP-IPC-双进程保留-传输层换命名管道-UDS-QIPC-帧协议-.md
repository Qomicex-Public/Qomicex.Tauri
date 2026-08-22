# ADR-040：HTTP→IPC：双进程保留，传输层换命名管道/UDS（QIPC 帧协议）

| 属性 | 内容 |
|:---|:---|
| 状态 | 已采纳 |
| 日期 | 2026-08-22 |
| 决策者 | AI Agent |

## 背景

前端与插件系统全部经 localhost:5000 TCP HTTP 访问独立后端进程（axum）。稳定性问题：端口被第三方进程占用时后端绑定直接失败；且 permissive CORS 使任意本机浏览器页面可触达后端。Tauri IPC 此前近乎空壳（仅 greet 模板命令 + pick_dialog）。探查确认三条链路：①前端 205 个 api 函数单点经 client.ts API_BASE；②插件 overlay 本就 postMessage 经宿主、inline 直 fetch；③后端→Tauri 进程内 WASM 网关靠 .gateway_port 文件发现 + 回环 HTTP。外部消费者：updater :5000 端点、CI curl 冒烟、test-api-filters 脚本、Vite proxy、Playwright 浏览器调试流程。

## 决策

采用方案 B：双进程保留，传输层换 OS 管道（Windows Named Pipe / Unix UDS），自定义 QIPC 长度前缀帧协议（一连接一请求；REQ=[len][method][path][headers][body]，RESP=[status][headers]+[len|chunk]*以0结束）。后端经 Router::call(tower::Service) 直接进入现有 axum 路由——23 个 endpoint 模块零改动；响应 body 逐帧透传保住 SSE。关键实现事实：Windows 命名管道服务端先关闭会丢弃对端未读缓冲，故服务端写完哨兵后须等客户端断开再关。Tauri 注册 qomicex:// 自定义协议转发普通请求（缓冲响应+本地 CORS 预检，保住 fetch/multipart/img-URL 原生语义）；3 个流式端点统一 invoke('ipc_stream')+Channel 消费。API_BASE 改为 ESM 活绑定运行期切换：initApiTransport 探测 ipc_ping 成功后翻转（Windows origin 形态 http://qomicex.localhost，其余 qomicex://localhost），纯浏览器/探测失败回落 HTTP——CI curl、测试脚本、Playwright 调试全保留。release 由 Tauri spawn 注入管道名并设 QOMICEX_NO_TCP=1（端口消失）；dev/CI 默认 TCP-only 行为不变。插件系统因协议 URL 设计几乎零改动（活绑定自动生效），第三方插件 API 面不变。顺带修复 install_service 锚定测试的既有 QOMICEX_HOME 双读竞争（与 error_report 共用 ENV_LOCK）。不选 A（并入 Tauri 全量化）因丢崩溃隔离且工期 2-3 周；不赌自定义协议流式能力，流式统一走 Channel。附带清偿：删 greet 模板命令、updater 移除 ：5000 条目。遗留技术债：WASM 网关 .gateway_port 机制未管道化（随机 ephemeral 端口冲突概率极低）；后端 /logs-view/{id} 浏览器直连页为无消费方的遗留代码。

## 备选方案


### 方案 A: 后端并入 Tauri 进程全量 #[tauri::command]
- 优点：无端口无 CORS，安全面最优；打包简化（不再嵌入解压 backend.exe）
- 缺点：丢失进程崩溃隔离（easytier/Packet.dll 崩溃连带 UI）；205 端点重包装工期 2-3 周
- 为何不选：稳定性动机下崩溃隔离是硬约束，B 用最小 diff 达成去端口目标

### 方案 C: 不迁传输仅加固 HTTP（token/收紧 CORS）
- 优点：近零成本
- 缺点：不满足动机：端口占用仍导致后端绑定失败
- 为何不选：未解决核心问题

## 影响
- src-backend/qomicex-backend/src/ipc.rs 新增 QIPC 服务端 + main.rs env 分支
- src-tauri/src/ipc.rs 新增协议转发器/ipc_ping/ipc_stream/ipc_stream_abort + lib.rs 接线
- src/api/client.ts API_BASE 活绑定 + src/api/ipc.ts 传输选择与流式助手 + App.tsx 启动探测
- src/plugins/plugin-api.ts proxyFetchStream、useDownloadSSE、GameLogWindow 迁移到 openStream
- tauri.conf.json CSP 增加 qomicex: 与 http://qomicex.localhost、updater 删本地端点
- 行为验证：cargo test 58 全绿×3、pnpm build 通过；真实 Tauri 壳内全功能手测待做

## 修订记录
| 日期 | 版本 | 修改内容 | 修改人 |
|:---|:---|:---|:---|
| 2026-08-22 | v1.0 | 初版创建 | AI Agent |
