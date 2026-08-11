# 联机故障诊断

> 生成时间：2026-08-10 23:14

# 联机 join 失败诊断：easytier 中继数据面未打通

## 现象

- guest join 房间报错：`Internal server error(流提前结束:期望读取1字节,实际读取 0字节)`
- 但 easytier-cli peer 显示 guest 已加入虚拟网络（host 10.144.144.1 可见，relay(2)）

## 证据链（2026-08-10 双机实测）

| 证据 | 结果 | 结论 |
|------|------|------|
| host 本机 127.0.0.1:1025 发 c:ping 帧 | 返回 `00-00`（status 0 成功） | host TCP server + SCF 协议正常 |
| host acl stats | 规则 pkts 全 0 | host 从未收到入站 TCP 包（SYN 未到） |
| host stats show | traffic_bytes_rx/tx = 0、forwarded = 0 | host 数据面全零 |
| host peer | **无 guest 节点** | 路由单向：host 无 guest 路由 |
| guest acl stats | 规则 pkts 全 0 | 无入站 TCP 包到达 guest（含 SYN-ACK） |
| guest stats show | traffic_bytes_rx/tx = 0 | guest 数据面全零 |
| guest peer（两次） | host lat 149ms → 1000ms | host 路由为幽灵路由（链路已死） |
| host whitelist | tcp_whitelist=["0","1025","11656"] | 配置正确（tcp_port=1025 + MC 11656） |

## 根因

**guest↔host 的 easytier 中继数据面未打通**：
- 控制面（路由公告）经中继单向传播 → guest 学到 host 的幽灵路由（relay(2)，lat 到 1000ms 上限）
- host 侧无 guest 路由 → 数据包无法双向转发（guest 发不出、host 收不到）
- 中继链（两个公共节点之间）数据转发失败或节点未互联/防火墙拦截

**已排除**：SCF 协议实现、launcher guest 代码（connect 内部吞错、错误只能来自 map_minecraft_port 读响应）、ACL/whitelist 配置、序列化帧格式（golden tests 通过）。

## 修复方向

1. **排查 api.qomicex.top 节点服务的中继节点**：公共节点间互联、数据面转发配置、防火墙 UDP 放行
2. **或用单一直达中继验证**：手动 easytier-cli 只连一个节点，看 relay(1) 是否通
3. launcher 代码无需修改（协议层正常）

## 备注

- 错误消息"流提前结束"来自 `protocol_serializer.rs` 异步版 `read_exact_async`（读响应帧 status 字节时 UnexpectedEof）；生产代码只用异步版（同步版仅测试用）
- "期望读取 1 字节" = 读响应第一字节（status）即 EOF，发生在 join_room → map_minecraft_port → get_server_port 阶段（connect() 内部协议错误全被 is_ok() 吞掉，EOF 只能从该路径传出）


## 修订记录
| 日期 | 版本 | 修改内容 | 修改人 |
| 2026-08-10 | v1.0 | 初版创建 | AI Agent |

### 2026-08-10 更新

## 追加：双问题确认（2026-08-10 第二次实测，guest 机）

### 关键实验（手动 easytier-core 进程对照）

| 实验 | 结果 | 结论 |
|------|------|------|
| 杀光本机手动 easytier-core 进程后 join | 错误从"discover 30s 超时"变为稳定复现"流提前结束: 期望读取1字节" | **手动进程干扰导致 discover 失败**；清理后 join 能发现 host、connect() 成功（ping/negotiate 通过），在 get_server_port 读响应时 EOF |
| probe3（easytier-core 手动实例，单中继） | 发现 host（udp6 p2p 直连，66ms，有流量） | 手动实例网络正常；**probe3 连 host 1025 被 RST、11656 超时** |
| probe4（完整复刻 launcher 配置：whitelist=0+latency-first+kcp+zstd+multi-thread） | DHCP 成功（10.144.144.x）、发现 host | **launcher 的 easytier 配置不是 discover 失败原因** |
| probe5（+完整 8 节点 relay 列表：QML-Main+ET-Public+HMCL+pysio） | 同样正常 | **relay 列表不是原因** |

### 确认的两个独立问题

**A. 手动 easytier-core 进程 / 残留实例干扰**（已修代码）
- 本机曾存在 6+ 个 easytier-core 进程：手动启动的占 15888 RPC、加入不同网络、同名节点（scaffolding-mc-guest-1CC69A04 ×N）→ 干扰 launcher join 实例的路由学习 → discover 超时
- **代码 bug**：`ScaffoldingClient::join_room` 在 `connect()` 失败时不清理 EasyTier 实例 → 每次失败残留一个实例（launcher 库内嵌，无法从外部清理）
- **修复**：`client.rs` join_room 失败路径调用 `guest.leave()`（已提交，cargo check 通过）

**B. host 端协议层关闭连接**（需 host 端排查）
- join 稳定走到 `map_minecraft_port → get_server_port`：TCP 已建立（ping/negotiate 通过、数据面通），发 c:server_port 后读响应第 1 字节 EOF
- host 端 `handle_client` 读请求失败或写响应失败都会关闭连接 → guest 读 EOF
- **host 端待办**：确认房间仍开着（launcher 联机页）；运行页日志查"客户端 XXX 处理异常"/"收到请求: c:server_port"；重启 launcher 重开房间；**私有节点 RainYun 2.5.0 升级到 2.6.4**（与全网版本不一致，中继数据面不可靠）

### 排查经验
- launcher 库内嵌 easytier 不启用 RPC（15888 无服务）——之前 easytier-cli 能连的 15888 都是手动 easytier-core 进程，勿混淆
- 用户本机 manual easytier-core 进程会与 launcher 实例同网共存并干扰，测试时先清理
- 节点 API `https://api.qomicex.top/api/nodes`：UA 含 `QML/` 返回私有节点列表（QML-Main tcp://jviy0lmx.qomicex-connector.junsi233.top:11010 + ET-Public + HMCL 共享节点），否则只返回官方 ET-Public

