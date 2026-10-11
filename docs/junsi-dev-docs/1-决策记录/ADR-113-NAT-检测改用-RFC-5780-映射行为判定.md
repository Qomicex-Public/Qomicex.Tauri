# ADR-113：NAT 检测改用 RFC 5780 映射行为判定

| 属性 | 内容 |
|---|---|
| 状态 | 已采纳 |
| 日期 | 2026-10-11 |
| 决策者 | AI Agent |

## 背景

issue #198 报告 NAT 检测『速度慢、结果可信度不高，100% 返回不可穿透 TCP UDP 阻断，但其他测试手段都没出现』。

实测确认根因（均为可复现证据）：

1. **binding 请求仅 16 字节（致命）**。原实现构造 `[0,1,0,0]` + 12 字节事务 ID = 16 字节，而 STUN 固定头为 20 字节。A/B/C 对照实测：16 字节报文被全部服务器静默丢弃；补足 20 字节后 stun.miwifi.com / stun.nextcloud.com / stun.sipnet.net 均在 72–242ms 返回。三台内置服务器全部不可达 → 必然落到末尾 `blocked`。
2. **事务 ID 校验偏移写死**。原实现校验 `buf[8..20]`，旧式（无 magic cookie）服务器回显在 `4..16`，实测 miwifi/nextcloud/sipnet 三者均为 4..16，响应被全部丢弃。
3. **内置服务器列表整体不可达**。stun.qq.com RST 拒绝、stun.l.google.com 与 turn.cloudflare.com 超时，三项零可用。
4. **判定方法错误**。原实现对同一服务器发两次比较映射端口；RFC 5780 中对称 NAT 的映射按目标区分，同目标两次映射不变 → 对称 NAT 被误判为 cone。
5. **XOR-MAPPED-ADDRESS 未做 XOR 解码**，对 0x0020 直读 `value[2..4]`，实测将 29192 读成 21274。
6. **最差约 18s**（2 次串行 × 3s 超时 × 3 服务器）。
7. 类型 `NatTypeResult` 声明了 `publicIp`/`publicPort`，后端结构体缺失该两字段。
8. 『无响应』被直接当作 `blocked`，把『服务器不可达』与『UDP 被阻断』混为一谈。

## 决策

改用 **RFC 5780 映射行为测试**作为判定依据：

- **单 socket 并行探测 8 台实测可达服务器**，整体墙钟受 3s 超时约束（替代原最差 18s）。必须在同一本地 socket 上向多目标发请求，才能通过比较映射端口区分端点无关映射与对称 NAT。
- 判定：映射端口全部一致 → `cone`（端点无关映射）；IP 相同端口不同 → 地址相关映射；IP 与端口均不同 → 地址端口相关映射；后两者映射为 `symmetric`。
- 修正报文为 **20 字节 RFC 5389**（含 magic cookie）；事务 ID 校验兼容 `8..20`（RFC 5389）与 `4..16`（RFC 3489 旧式）；**修正 XOR-MAPPED-ADDRESS 解码**（端口与地址均与 magic cookie 异或），同时保留 MAPPED-ADDRESS 直读分支。
- 服务器列表换为实测可达的 8 台（miwifi / sipnet / antisip / telnyx / voip.blackberry / internetcalls / voip.eutelia / bcs2005）。
- 补回 `publicIp`/`publicPort`；新增 `reason` 字段区分『服务器全部无响应』与『仅一台响应无法判定』。
- 保留既有四值枚举 `cone/symmetric/blocked/unknown`，前端 Badge 与 API 契约不破坏；i18n 文案删掉从未测量的 TCP 结论。

**不可实现范围（已实测证伪）**：RFC 3489 的 filtering 测试可进一步区分完全锥形/受限锥形/端口受限锥形，但强制依赖服务器支持 `CHANGE-REQUEST` 属性。扫描 30 台公共 STUN（15 台存活），支持该属性的为 **0 台**，故 filtering 无法判定，6 值细分方案被否决。

## 备选方案

### 方案 引入社区 STUN crate 做编解码
- 优点：报文构造/解析复用成熟实现
- 缺点：仍需自行实现 RFC 5780 映射行为判定（crate 只做报文编解码）；引入新依赖需拉取，离线/CI 环境有风险
- 为何不选：收益有限：库不提供映射行为判定逻辑，核心工作量未减少，却新增依赖与供应链面

### 方案 仅最小修复（补 20 字节 + tx 双偏移 + 换服务器列表）
- 优点：改动最小，立刻从『必然 blocked』恢复
- 缺点：对称 NAT 会继续被判为 cone（漏判），不满足 issue 的『高精度』诉求
- 为何不选：治标不治本：判定方法本身错误，无法识别对称 NAT

### 方案 RFC 3489 三测试细分 cone 类型（完全锥形/受限锥形/端口受限锥形）
- 优点：可细分 cone 类型
- 缺点：实测 15 台可达公共 STUN 无一支持 CHANGE-REQUEST，6 值细分在现有服务器生态下不可能实现
- 为何不选：依赖服务器支持 CHANGE-REQUEST 属性，实测无一台支持，方案不可行

## 评审后修订（v1.1）

PR #246 评审提出 5 条，逐条实测核验后修复 4 条、驳回 1 条：

1. **缓存竞态（成立）**：并发探测乱序完成时，较早的探测会覆盖较新的结果并重置 5 分钟缓存。
   现在 `nat_cache` 携带单调探测序号，只有序号更大的结果可写入；发现已有更新的结果时直接返回它。
2. **DNS 超出探测预算（成立）**：原实现用 `send_to(&str)` 隐式解析，串行解析发生在 deadline 计时之前。
   现改为 `lookup_host` 并行解析，且解析与请求收发共用同一 3s 预算（`timeout_at`）。
3. **IPv6 优先解析导致跳过服务器（成立，实测印证）**：候选 8 台里 `stun.antisip.com` 与
   `stun.bcs2005.net` 首个解析地址为 IPv6，而检测 socket 绑定 IPv4，直接按主机名发送必然失败。
   这解释了修复前的端到端观测「8 台仅 6 台响应」。现只取解析出的 IPv4 地址发送；
   复测该两台已稳定参与判定。
4. **`reason` 忽略语言（成立）**：原实现下发英文散文，非英语用户看到英文。
   现改为结构化 `NatReason { code, ...参数 }`，前端按 `connect.natReasons.*` 翻译（7 语言 9 个 code）。
5. **旧式 16 字节事务 ID 响应被忽略（误报，驳回）**：用生产字节（cookie@4..8 + tx@8..20）
   实测打 4 台服务器，响应**全部在 8..20 回显并被现有 `parse_stun_response` 正确识别**；
   服务器按请求格式回显，故 `4..16` 分支在真实流量中不会命中。该分支保留为防御性兼容，
   已在注释说明其真实作用。

另修复收割循环的一处健壮性缺陷：原 `_ => break` 会在任一次读错误（如某目标不可达触发 ICMP
端口不可达，Windows 表现为 ConnectionReset）时中断全部剩余响应的收割；现改为跳过单次错误
继续等待（设连续错误上限避免忙等）。

> **残余观测**：端到端复测响应台数在 6–8 台间波动，且每轮缺失的服务器不同，属公共 STUN
> 服务器的丢包/限速，非判定逻辑缺陷。映射行为判定只需 ≥2 台一致即可成立。

## 影响
- src-backend/qomicex-backend/src/endpoints/connector.rs：stun_detect_nat 重写、resolve_ipv4 / parse_stun_response / classify_nat / build_binding_request 新增，nat_cache 加探测序号，NatTypeResult 扩展 reason/publicIp/publicPort，新增 14 条单测
- src/types/index.ts：NatTypeResult 补 reason（结构化 NatReason 类型；publicIp/publicPort 此前已声明但后端缺失，现已对齐）
- src/pages/Connect.tsx：NAT Badge tooltip 展示公网映射地址与按语言翻译的判定依据
- qomicex-tauri-i18n：7 语言 connect.ts 删掉未测量的 TCP 结论、新增 natPublicAddr 与 natReasons.*（需在 i18n 仓库单独提交推送）
- docs/junsi-dev-docs/3-API规范/API列表.md：补充响应字段与判定语义表
- 性能：最差 18s → 约 3s；精度：可正确识别对称 NAT（原实现必然漏判）

## 修订记录
| 日期 | 版本 | 修改内容 | 修改人 |
|---|---|---|---|
| 2026-10-11 | v1.0 | 初版创建 | AI Agent |
| 2026-10-11 | v1.1 | PR #246 评审修复：缓存序号保护、DNS/IPv4 解析与探测预算、reason 结构化本地化、收割循环健壮性；驳回旧式事务 ID 一条（实测误报） | AI Agent |