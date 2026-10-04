

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

## 追加：中继列表全灭导致 join 失败 + 真实报错被 UPSTREAM_ERROR 覆盖（issue #182，2026-10-04）

### 现象

WLAN 多网卡两台设备联机，guest join 失败且固定显示「上游服务请求失败」。报障当日（10-04）3 台机器全部复现。

### 根因（两级）

**A. host 端中继列表全灭（联机失败主因）**

1. host 日志 `16:10:07.034 WARN 获取中继节点失败，回退到内置默认节点`（`relay/provider.rs::fetch_nodes` 网络层失败）
2. `DEFAULT_NODES` 兜底全灭：`cgk1.clusters.zeabur.com:22171` TCP 通但 easytier 握手被服务端 reset（host 日志 10054 ×2.5 分钟，易逝免费部署已废）；`tcp.ap-northeast-1.clawcloudrun.com:45146` TCP 不通
3. → host 在 EasyTier 网络孤立（guest 日志 `sync_route_info failed dst_peer_id=10000001`）→ guest `discover` 30s 超时 → join 失败
4. 报障次日存活普查：官方 ET-Public `public.easytier.cn` DNS 已无记录（本地/1.1.1.1/223.5.5.5 三处确认）；私有列表内 QML-Main/QML-Fork-2/QML-Edge/ECL/HMCL×2 存活，QML-Fork/ECL2/ECL2.1 死亡
5. 节点 API 与 UA 门控本身正常：带 `QML/` UA 返回 15 节点，无 UA 仅返回 ET-Public

**B. 真实报错被覆盖（可见性缺陷）**

- 后端 `map_connector_error`（connector.rs）→ 502 `UPSTREAM_ERROR`，真实原因挂在 message
- 前端 `src/i18n/errors.ts` 把 `UPSTREAM_ERROR` 翻译成通用文案并丢弃 message（`client.ts` `displayMessage` 优先取翻译）→ 用户只见「上游服务请求失败」

### 修复（经用户确认的范围）

- **B**（主仓 `fix/issue-182-connector-error-code`）：`map_connector_error` 改用专属码 `CONNECTOR_FAILED`（502）——不在前端映射表中，`displayMessage` 回退后端 message，真实原因透出；`ApiError::upstream` 其余调用方语义不变。守护测试 ×2（`error.rs` tests）
- **Retry**（qomicex-connector-rust `58d26cc`，分支 `fix/relay-fetch-retry`）：`fetch_from` 失败重试一次再回退；3 测试守护（重试成功→恰 2 次请求采用重试结果 / 双失败→恰 2 次回退默认 / 首次成功→恰 1 次不重试）
- **明确不做**：`DEFAULT_NODES` 硬编码私有节点——私有节点靠 UA 门控保护，硬编码进开源仓库等于废掉门禁（用户否决）

### E2E 实测（修复后）

`POST /api/connector/join`（假房间码，自建实例 5117 端口）→ `502 CONNECTOR_FAILED`，message `联机失败: 未在 EasyTier 网络中发现联机中心（超时 30s）`（修复前为 `UPSTREAM_ERROR` + 前端通用文案）。

### 遗留（未修）

- `DEFAULT_NODES` 两个易逝部署已死：正确解法在服务端（如 UA 门控的 fallback 端点），非客户端硬编码
- guest 端 faketcp PnetTun `Network interface 'WLAN' not found`（easytier fork 按名称匹配接口失败，非阻塞缺陷，wss/tcp 正常）
- 「3 台机器拉取列表失败」的底层网络诱因未定位（需出问题机器的当日后端日志核对是否同 WARN）

