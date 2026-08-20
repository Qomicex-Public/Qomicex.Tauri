# ADR-027：启动器网络设置：下载源迁移 + 代理 + 忽略SSL

| 属性 | 内容 |
|---|---|
| 状态 | 已采纳 |
| 日期 | 2026-08-20 |
| 决策者 | AI Agent |

## 背景

用户要求启动器设置新增「网络设置」栏目，把原启动器下载卡片里的下载源/Mod镜像源选择移入，并增加代理设置（使用什么代理：无/HTTP(S)/SOCKS5）与忽略SSL证书选项。经澄清确定范围：下载源与Mod镜像源都移入；代理/SLL覆盖共享HTTP客户端、下载器与核心库全量；保存后对下载即时生效（复用现有热替换机制）。

## 决策

新增设置字段 proxyMode('off'|'http'|'socks5')、proxyHost、ignoreSslCert；后端用 .proxy()+.danger_accept_invalid_certs() 构建 reqwest 客户端，并把代理/忽略SSL 传入 qomicex-downloader（DownloadOptions.proxy/.ignore_ssl_certs）与 qomicex-core（CoreOptions.proxy_url/.ignore_ssl_certs，线程化内部自建客户端）；PUT /settings 扩展热替换触发条件，保存即重建下载管理器。前端新增 network 选项卡承载。兼容性：proxy_mode/proxy_host 用 #[serde(default)] 避免老 settings.json 解析失败重置全部设置。代理URL构造 http→http://host:port，socks5→socks5://host:port。

## 备选方案

### 方案 仅存设置占位不接通
- 优点：改动最小
- 缺点：代理/忽略SSL 实际不生效，功能名不副实
- 为何不选：舍弃：用户要求真实生效

### 方案 仅覆盖共享HTTP客户端+下载器
- 优点：改动较小
- 缺点：核心库内部自建客户端不走代理/SLL
- 为何不选：舍弃：用户明确要求核心库也全量打通

### 方案 重启后生效
- 优点：实现简单
- 缺点：改代理需重启启动器，体验差
- 为何不选：舍弃：复用下载管理器热替换实现保存即生效

## 影响
- src/pages/Settings.tsx 新增 network 选项卡, 迁移下载源选择
- src/api/settings.ts AppSettings 新增 proxyMode/proxyHost/ignoreSslCert
- qomicex-tauri-i18n 各 locale settings.ts 新增 settings.category.network + settings.network.*
- src-backend/.../settings.rs 新增字段(带serde默认)
- src-backend/.../state.rs 构建带代理/SLL的共享客户端+下载器+核心库配置
- src-backend/.../system.rs 热替换触发条件扩展
- qomicex-downloader-rust DownloadOptions 新增 proxy/ignore_ssl_certs
- qomicex-core-rust CoreOptions 新增 proxy_url/ignore_ssl_certs 并线程化内部客户端

## 修订记录
| 日期 | 版本 | 修改内容 | 修改人 |
|---|---|---|---|
| 2026-08-20 | v1.0 | 初版创建 | AI Agent |

### 2026-08-20 更新


### 修订（第 2 版）
- **放置位置**：网络设置并入「启动器设置」tab 内的一个栏目（卡片），不作为独立 tab（对应原需求「在启动器设置 tab 里添加网络设置栏目」）。
- **代理模式扩展为 4 项**：`off`（不使用代理）/ `system`（使用系统代理）/ `http` / `socks5`；默认 `system`（与旧版 reqwest 默认行为一致）。
- **`no_proxy` 语义（重要修正）**：reqwest 0.12 默认 `auto_sys_proxy=true`（自动使用系统代理），`off` 必须显式调用 `.no_proxy()` 才能真正关掉代理。为此在 downloader `DownloadOptions`、core `NetworkConfig`/`CoreOptions`、后端 `build_http_client`/`proxy_client` 新增 `no_proxy: bool`；`off` → no_proxy=true、`system` → 默认、`http/socks5` → 自定义代理 URL（`.proxy()` 自动禁系统代理）。
- 子模块演进提交：downloader `1769c23`→`cfcb24a`(socks)→`3289a08`(no_proxy)；core `d094792`→`e95e166`(no_proxy)；i18n `08c70e9`→`4a2dbdc`(system 文案)。

