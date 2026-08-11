

## 追加：join 前端"请求超时"根因与超时语义（2026-08-12）

### 现象

用户加入房间显示"访问/connect(后端api)超时"（前端 `请求超时（15s）（/connector/join）`），房间码真实有效但 join 无响应。

### 根因（已实测）

- 前端全局请求超时 15s（`src/api/client.ts` `REQUEST_TIMEOUT_MS`），而 join 后端最坏耗时远超 15s：
  - easytier 启动 ≤30s（`easytier/manager.rs` `STARTUP_TIMEOUT`）
  - P2P 打洞端口转发重试 10×(3s+2s) ≈ 50s（`guest/scaffolding_guest.rs` `try_connect_with_retry`）
  - 实测（假房间码）：后端 **42s** 才返回 `UPSTREAM_ERROR: 未在 EasyTier 网络中发现联机中心（超时 30s）` —— 旧前端 15s 必断，真实错误被"请求超时"掩盖
- 前端 abort 不取消后端任务：后端继续 join（可能成功但前端已报失败），用户重试 → `CONNECTOR_BUSY`；残留 easytier 同名节点会让后续 discover 超时

### 修复（超时语义）

- **前端**（`src/api/connector.ts`）：`joinRoom`/`hostByPort` 用 120s 长超时 signal 绕过全局 15s（对齐 `instance-files.ts` enrichMods 先例）；AbortError 转友好错误 `CONNECTOR_TIMEOUT`
- **后端**（`src-backend/.../endpoints/connector.rs`）：`run_with_connector_timeout` —— 建房/加入房间包 75s 整体超时：
  1. 超时触发局部 `CancellationToken.cancel()`（discover/重试循环协作退出）
  2. 等待子任务完成清理（easytier 启动 30s 兜底；75s+30s < 前端 120s）
  3. `close_all` 回收托管实例 + `mode` 复位 `Idle`
  - 返回明确错误：`CONNECTOR_JOIN_TIMEOUT` / `CONNECTOR_HOST_TIMEOUT`
- 失败后状态复位已验证：join 失败 → status idle → 可重试

### 备注

- `host_instance` 是后台任务（秒回），不受影响
- 75s 超时兜底路径（端口转发重试卡死场景）无法本机复现（需两台真实机器），代码路径为协作取消 + 兜底清理


### 2026-08-12 更新


## 追加：VPN 虚拟网卡抢默认路由导致 join 失败 → 自动绑定物理网卡（2026-08-12）

### 现象

host 建房后 guest 无法加入；排查发现 host 端 easytier 出站 UDP 走了 Radmin VPN 网卡——**有发送无接收**（出站包从 radmin 网卡发出，回包进不来）→ 中继不可达 → host 在虚拟网中孤立 → guest discover 超时。

### 根因

- 多网卡机器上，VPN 软件（Radmin 等）虚拟网卡抢系统默认路由（metric 更小）→ easytier 连中继的出站 socket 源地址/出口被系统选到虚拟网卡
- easytier 4QML fork **无"出站绑定网卡"选项**（SocketContext 只有 Linux 的 socket_mark/netns）
- 但 easytier **监听器绑定指定 IP 时，出站 socket 复用 listener 的本地地址** → 源地址固定在物理网卡 → 回包走源地址路由，绕过被劫持的默认路由

### 修复（qomicex-connector-rust）

- `NetworkConfig` 新增 `bind_ip: Option<String>`；`build_toml_config` 的 listeners 从 `0.0.0.0:0` 改为 `{bind_ip}:0`
- `util::resolve_bind_ip()`：枚举网卡（network-interface crate）→ 排除虚拟网卡（radmin/hamachi/zerotier/wintun/tailscale/wireguard/openvpn/vmware/virtualbox/loopback/easytier/vpn/tun/tap 关键词）+ 回环 + APIPA（169.254.x）→ 有线优先（Ethernet/以太网）→ 无线（WLAN/Wi-Fi/无线）
- host（ScaffoldingCenter::start）与 guest（ScaffoldingGuest::connect）构建配置时自动设置 bind_ip；所有调用方（launcher/CLI）自动生效，无参数改动

### 实测（本机）

- 网卡枚举：以太网未插线（仅 APIPA 169.254.177.30）、WLAN 已连接（192.168.1.6）→ 正确选中 WLAN 192.168.1.6（正是"LAN 未连接时用 WLAN"需求）
- 37 个库测试通过（含新增虚拟网卡检测/排序测试），clippy 无新增警告
- 本机 APIPA 全部被排除；无 radmin 网卡活跃时枚举不到（未连接网卡不出现）

### 备注

- 绑定物理网卡 IP 后，easytier 只从该网卡收发——若中继仅能经其他网卡可达会受限（可接受，正常多网卡环境物理网卡即主出口）
- 数据面（P2P/中继转发）仍需真实双机验证；本机可验证监听地址绑定（建房后 netstat 看 qomicex-backend 的 easytier 监听端口绑定物理 IP 而非 0.0.0.0）

