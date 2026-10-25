# ADR-120：分享页接入：深链 open 透传查询参数、官方域免确认与启动器分享入口

| 属性 | 内容 |
|---|---|
| 状态 | 已采纳 |
| 日期 | 2026-10-25 |
| 决策者 | AI Agent |

## 背景

分享页 share.qomicex.cn 已能唤起 qomicex-launcher:// 深链，但接入启动器时有三处缺口：

1. 资源页「在资源中心打开」只发 qomicex-launcher://open/resource-center，启动器 `parseDeepLink` 的 open 分支只取 pathname，查询参数被丢弃，因此只能落到列表页，无法进入 /resource-center/:resourceId 详情。
2. 整合包一键安装深链不带来源信息，`DeepLinkHandler` 对 install/modpack 无条件弹确认窗（与插件 URL 安装不同，后者可用 URL 主机判来源）。
3. 启动器没有为资源 / 联机房间生成分享链接的入口，用户只能手写分享页 URL。

冷启动深链在 0.1.4-beta5.0 实测可复现成功（日志 cold start with 1 url(s)，ShellExecute 冷启动 open/install 均生效），但用户报告偶发「只打开启动器不执行动作」，需要可自愈的兜底与可诊断日志。

## 决策

1. `open` 动作在白名单路由之外增加查询参数白名单（source/category/gameVersion/loader/keyword/sort/tags/instanceId/from/fromCategory/fromSource，单值 ≤200 字符），由 `buildOpenQuery` 重新编码后拼到 navigate 目标。分享页改为 open/resource-center/{projectId}?source=&category=，直接进详情。
2. install/modpack 深链新增可选 `from=<来源页>`；`isTrustedOrigin` 要求 https 且主机精确命中官方域白名单（新增 share.qomicex.cn），命中时跳过确认，其余仍确认。该字段由链接自报、可伪造，免确认只作为体验优化，安全边界仍是安装内容来自官方平台 API。
3. 启动器新增 `src/lib/share.ts`（与分享页 /r、/room 参数一一对应）与 `ShareLinkDialog`；资源详情页顶部提供「分享」（分享项目），版本列表每条提供「分享此版本」（带 fileId，分享页可一键安装该版本）；联机页房主卡片提供「分享房间」。
4. 冷启动兜底：DeepLinkHandler 在窗口重新获得焦点时重读 take_pending_deep_link；Rust 侧为 take/complete 增加条数与未命中回执的日志（不含 URL 原文，避免房间码落盘）。

## 备选方案

### 方案 签名深链（HMAC）
- 优点：不可伪造，免确认可成为真正的安全边界
- 缺点：分享页与启动器需共享密钥并处理轮换、泄露与多版本兼容
- 为何不选：收益仅是省一次确认，成本远高于风险；安装内容本身来自官方平台 API。

### 方案 保持所有外部安装都确认
- 优点：口径最简单，完全不依赖自报字段
- 缺点：官方分享页的一键安装每次都要多点一次确认，与用户预期不符
- 为何不选：用户明确要求官方分享页免确认，采用受控白名单 + 明确说明该标记可伪造。

### 方案 只改分享页、不改启动器 open 解析
- 优点：改动面更小
- 缺点：查询参数在启动器侧被丢弃，source/category 丢失后详情页会按默认 modrinth/mod 拉取错误条目
- 为何不选：必须让启动器保留受控查询参数，详情才能定位到同一条目。

## 影响
- src/lib/deepLink.ts：open 查询白名单、install/modpack from、AUTO_INSTALL_HOSTS 增加 share.qomicex.cn
- src/components/DeepLinkHandler.tsx：open 带查询跳转、官方域免确认、窗口聚焦重读待处理集合
- src/lib/share.ts、src/components/ShareLinkDialog.tsx：分享链接构造与弹窗（新增）
- src/pages/ResourceDetail.tsx、src/pages/Connect.tsx：分享入口
- src-tauri/src/deep_link.rs：take/complete 诊断日志
- qomicex-tauri-i18n：common 命名空间新增 share / copyLink / openInBrowser 等 7 语言文案
- qomicex-share-page：openPageLink 支持查询参数、resourceDetailLink、install 深链带 name+from

## 修订记录
| 日期 | 版本 | 修改内容 | 修改人 |
|---|---|---|---|
| 2026-10-25 | v1.0 | 初版创建 | AI Agent |