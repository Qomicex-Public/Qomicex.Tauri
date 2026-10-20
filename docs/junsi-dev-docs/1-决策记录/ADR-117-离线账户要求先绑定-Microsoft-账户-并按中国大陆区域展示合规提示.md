# ADR-117：离线账户要求先绑定 Microsoft 账户，并按中国大陆区域展示合规提示

| 属性 | 内容 |
|---|---|
| 状态 | 已采纳 |
| 日期 | 2026-10-20 |
| 决策者 | AI Agent |

## 背景

2026-10-20，两个主流第三方启动器先后对 Minecraft 下载与账户链路做了收紧：

- **PCL** 发布 `2.99.0.0`（2026-10-20T07:01Z），发布说明写明「为遵守相关法律法规，PCL 不再提供 MC 下载功能」。
- **HMCL** 合并 PR #7017（2026-10-20T08:37Z，20 文件 +177/−50），新增 `RegionUtils`
  按网络所在区域判定，命中中国大陆时**整体禁用下载页**（`root.setDisable(true)`），
  没有按账户类型区分的分支。外部流传的「只禁用离线玩家」与合并代码不符。

同期还出现「网信办 2026-10-19 发布公告」「未成年充值举报导致下架」等说法，**均未能核实**
（检索无结果），本 ADR 不以其为依据。

Qomicex Launcher 的暴露面与上述两者不同：**不托管游戏文件**（从 Mojang 官方源及其公开
镜像下载）、**无站内支付**（仅在设置页展示只读的赞助名单）、联机走 P2P 中继、不开设付费房间。
因此不复制「关闭下载功能」的做法，只做两处与「未授权获取」直接相关的收敛。

## 决策

### 1. 新增账户前必须先有 Microsoft 账户（P0）

规则：账户库中**不存在**任何 `loginMethod == "Microsoft"` 的账户时，拒绝新增
离线 / Yggdrasil / 统一通行证账户。

- 权威实现落在 `AccountService::auto_set_default_on_save`
  （`src-backend/qomicex-backend/src/services/account.rs`），这是 `POST /api/account`
  与 `POST /api/auth/offline` 两条新增路径的公共落库口，前端无法绕过。
- 只拦**新增**（`is_new`）。更新既有账户（改默认、刷新令牌、启动前续期）一律放行，
  存量离线玩家照常游戏与联机。
- 首个账户可以是 Microsoft 账户本身；Microsoft 账户的创建永不因本规则被拦。
- 错误码：`OFFICIAL_ACCOUNT_REQUIRED`（403）。
- 前端 `src/pages/Accounts.tsx` 的 `needOfficial` 去掉原先的 `lang !== 'zh-CN'` 豁免，
  所有语言一致，并把非 Microsoft 页签提前置灰。前端只是体验层，规则以后端为准。

Yggdrasil（LittleSkin）与统一通行证一并纳入限制：这两者同样是「不拥有正版即可进入游戏」
的入口，只拦离线会留下等价绕过路径。限制在「新增」这一层，已存在的第三方账户不受影响。

### 2. 中国大陆离线登录开关（预留，默认关闭）

`account.rs` 内保留常量：

```rust
const RESTRICT_OFFLINE_LOGIN_IN_CN: bool = false;
```

置 `true` 后，中国大陆机器上**任何**离线账户新增都会被拒绝（错误码
`OFFLINE_DISABLED_IN_CN`），即使已有 Microsoft 账户。开关只针对离线登录：
Microsoft 账户任何时候都能新增，Yggdrasil / 统一通行证不受该开关影响——否则新用户
在开关打开后将无法登录正版账户。默认关闭的原因：监管口径尚未明确，
过早关闭会误伤存量离线玩家；需要收紧时只改这一行，判定点与测试无需改动。

### 3. 区域判定只看系统时区（P1）

`services/region.rs::machine_is_china_mainland()` 用 `iana-time-zone` 读取本机时区，
命中 `Asia/Shanghai`、`Asia/Chongqing`、`Asia/Harbin`、`Asia/Urumqi`、`PRC` 即视为
中国大陆。**不做 IP 探测、不发任何网络请求**——判定区域不需要把用户出口 IP 交给第三方。
读取失败按「不在中国大陆」处理（fail-open），避免因环境异常改变默认行为。

`GET /api/system/region` 返回 `{ "chinaMainland": bool }`，供前端决定是否展示提示条。

### 4. 中国大陆常驻合规提示条

`src/components/ComplianceBanner.tsx` 在 `Layout` 内、标题栏下方渲染一条不可关闭的细条，
仅在 `chinaMainland == true` 时出现；境外不渲染，也不占布局。文案说明三件事：游戏文件来自
Mojang 官方源及其公开镜像、本软件不托管游戏本体、与 Mojang / Microsoft / 网易无关，
离线账户仅用于离线游戏与自建服务器。

区域接口失败时不展示（fail-open 的展示侧对应实现）。

## 备选方案

### 方案 复制 PCL/HMCL，直接关闭下载功能
- 优点：姿态最保守
- 缺点：Qomicex 不托管文件、不收费，关闭下载直接切断主功能，且与「未授权获取」无直接
  因果关系；用户会转向其它启动器，风险并未降低
- 为何不选：与自身暴露面不匹配

### 方案 按 IP 判定区域
- 优点：能识别使用代理/伪时区的场景
- 缺点：需把用户 IP 交给第三方地理库，引入外部依赖与隐私成本，且判定结果仍可被代理绕过
- 为何不选：时区判定零网络请求，足够支撑「是否展示提示条」这一非安全决策

### 方案 只在前端拦截新增离线账户
- 优点：改动最小
- 缺点：直接调 `POST /api/account` 即可绕过，规则形同虚设
- 为何不选：合规规则必须在落库点执行

### 方案 把开关写成注释掉的代码
- 优点：意图明显
- 缺点：注释代码不参与编译，容易腐烂，也无法被测试覆盖
- 为何不选：用 `const bool` + 已覆盖两种取值的单元测试，保持可编译、可验证

## 影响

- 后端：新增 `services/region.rs`、`GET /api/system/region`；`services/account.rs` 增加
  `account_creation_blocked` 与落库前置判定；`Cargo.toml` 增加 `iana-time-zone`
- 前端：新增 `ComplianceBanner`，`Layout` 挂载；`Accounts.tsx` 去掉语言豁免；
  `src/api/system.ts` 增加 `getRegion()`；`src/i18n/errors.ts` 增加两个错误码映射
- i18n（submodule）：7 种语言各新增 `compliance.banner`、
  `errors.officialAccountRequired`、`errors.offlineDisabledInCn`
- **行为变化**：全新用户（无任何 Microsoft 账户）无法再直接新增离线账户，需先登录一次
  正版账户；已有离线账户的用户不受任何影响
- 不涉及启动期的授权校验：离线账户启动、联机、模组安装均不检查正版

## 修订记录

| 日期 | 版本 | 修改内容 | 修改人 |
|---|---|---|---|
| 2026-10-20 | v1.0 | 初版创建 | AI Agent |
