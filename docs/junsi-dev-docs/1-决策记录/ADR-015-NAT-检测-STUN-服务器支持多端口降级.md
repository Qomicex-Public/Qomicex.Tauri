# ADR-015：NAT 检测 STUN 服务器支持多端口降级

| 属性 | 内容 |
|:---|:---|
| 状态 | 已采纳 |
| 日期 | 2026-08-15 |
| 决策者 | AI Agent |

## 背景

NAT 类型检测（/connector/nat-type）仅用 stun.qq.com / stun.l.google.com 的 3478/udp 单端口。3478/udp 被防火墙阻断时（常见于办公网/运营商），检测直接落到 blocked，即使 turn.cloudflare.com 的备选端口 53/udp（DNS 端口通常放行）可达。腾讯 stun.qq.com 仅提供 UDP 通道。

## 决策

STUN 服务器列表改为 (host, 端口列表) 结构：追加 turn.cloudflare.com（3478 → 53/udp 降级）；同一服务器内当前端口两次 binding 失败时降级到下一个端口继续尝试。TCP 80 备选不用于 UDP 检测。保留 qq/google 单端口。两次 binding 仍用同一本地端口 + 同一服务器端口对比映射，结果语义（cone/symmetric/blocked）不变。

## 备选方案


### 方案 仅追加 turn.cloudflare.com:3478 到列表
- 优点：改动最小
- 缺点：3478 被挡时仍无法降级，Cloudflare 备选端口未利用
- 为何不选：不满足穿越严格防火墙的目的

### 方案 实现完整 RFC 3489 三测试 + TCP 80 通道
- 优点：可细分 cone 类型
- 缺点：代码量大，需要 TCP STUN 实现
- 为何不选：超出当前需求，cone 细分对 Easytier 联机无实际收益

## 影响
- src-backend/qomicex-backend/src/endpoints/connector.rs stun_detect_nat()
- NAT 检测在网络环境宽松时结果不变，严格防火墙下从 blocked 变为可判定
- 无 API 契约变化（NatTypeResult 结构不变）

## 修订记录
| 日期 | 版本 | 修改内容 | 修改人 |
|:---|:---|:---|:---|
| 2026-08-15 | v1.0 | 初版创建 | AI Agent |
