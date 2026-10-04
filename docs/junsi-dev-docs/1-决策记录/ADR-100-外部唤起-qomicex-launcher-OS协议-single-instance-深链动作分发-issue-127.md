# ADR-100：Issue #127 外部唤起：qomicex-launcher:// OS 协议 + single-instance + 深链动作分发

| 属性 | 内容 |
|---|---|
| 状态 | 已采纳 |
| 日期 | 2026-10-04 |
| 决策者 | AI Agent |

## 背景

Issue #127（[Improvement] 添加 qomicex:// 协议支持）诉求：浏览器等外部程序无法直接拉起启动器，希望支持 URL 协议与命令行参数，实现快捷启动实例、快速安装插件/整合包、快速进联机房间。

现状取证：
- `qomicex://` 已被 webview **内部**自定义协议占用（`register_asynchronous_uri_scheme_protocol("qomicex")`，ADR-040 的 QIPC 管道传输；前端 `API_BASE` 探测成功后翻转为 `http://qomicex.localhost/api` 或 `qomicex://localhost/api`）。
- 启动器无任何 OS 级协议注册：`src-tauri/Cargo.toml` 无 `tauri-plugin-deep-link` / `tauri-plugin-single-instance`。
- 已有的 argv 解析先例：`--debug <port>`（lib.rs `parse_debug_port`）。
- 插件安装入口只有「本地目录」「multipart 上传」，**没有按 URL 下载安装**。
- `origin/main`(3b33ba91) 与全部 PR 均无 deep-link 相关改动 → 上游未实现，需自研。

## 决策

采用 Tauri 官方 `tauri-plugin-deep-link` + `tauri-plugin-single-instance`（后者开 `deep-link` feature），协议名取 **`qomicex-launcher`**。

1. **协议名不用 issue 标题里的 `qomicex`**：`qomicex` 已是 webview 内部伪协议，同名注册 OS 协议会在 macOS（CFBundleURLTypes vs WKURLSchemeHandler）、Linux（xdg-mime vs webkit custom scheme）产生真实歧义，且对第三方开发者而言「内部伪协议」与「OS 协议」同名会造成文档与排障混乱。改用 `qomicex-launcher` 后内部 IPC 零改动、无破坏性变更。
2. **single-instance 必须是第一个注册的插件**：插件按注册顺序执行，第二次启动若先跑完 setup 会再 spawn 一个后端；`deep-link` feature 使插件在回调前先把 argv 转交给 deep-link 插件，于是「运行中被二次唤起」与「冷启动」两条路径汇合到同一处。
3. **接收分两条路径**：冷启动用 `get_current()`（`.setup()` 里注册的 `on_open_url` 此刻尚未挂上，插件在自身 setup 阶段已消费过 argv，必须主动取）；热路径靠 `on_open_url`。两者统一写入 `PendingDeepLink` 队列并向主窗口 emit `deep-link://action`，前端挂载后经 `take_pending_deep_link` 取走——纯 emit 会丢冷启动那次。
4. **URL 语法**（动作在 host、参数在 path，host 会被 URL 解析器小写化）：
   - `qomicex-launcher://launch/<实例名或ID>`
   - `qomicex-launcher://open/<route>`（仅白名单内部路由）
   - `qomicex-launcher://join/<房间码>`
   - `qomicex-launcher://install/plugin?slug=<slug>&version=<v>`（商店，带签名校验）
   - `qomicex-launcher://install/plugin?url=<https://….qplugin>`
   - `qomicex-launcher://install/modpack?type=modrinth|curseforge|ftb&projectId=<p>&fileId=<f>[&name=<实例名>]`
5. **`install/modpack` 必须带 projectId+fileId**：后端 `/modpack/install-direct` 在线分支两者缺一即 400 `MODPACK_SOURCE_REQUIRED`（`id` 字段语义是「目标实例名」而非项目 id）。不支持 `path=`，那条分支等于让网页指定本地磁盘文件。
6. **安全模型**：深链可被任意网页触发。可落地代码的动作一律先确认，仅当 URL 来源主机命中官方白名单（`AUTO_INSTALL_HOSTS`，**精确匹配 host 且必须 https**）时免确认；商店 `slug=` 无来源域可判，恒需确认；确认后放行无签名包的口径与设置页「本地上传 + 风险确认后重试」一致。`open` 只接受白名单路由前缀。
7. **新增后端端点 `POST /api/plugins/install-url`**（body `{url}`，query `allowUnsigned`）：与 `/plugins/upload` 只差「字节从哪来」，校验与安装复用同一条 `install_from_package`；SSRF 复用 `/plugins/proxy` 的 `validate_target`（DNS 解析后逐 IP 拒内网/保留地址），不另写一套以免规则漂移；下载上限 64 MiB。

## 备选方案

### 方案 方案 B：手写 OS 注册（注册表 / .desktop / Info.plist）+ 自研单实例
- 优点：零新增依赖；不引入官方插件的行为面
- 缺点：三平台三套实现；macOS 的 CFBundleURLTypes 必须在 bundle 期由 bundler 生成，手写要改打包配置且易漏；单实例需自研跨平台 IPC 唤醒，官方正是为此提供 deep-link feature 集成；维护成本与漏改风险显著更高
- 为何不选：舍弃。官方插件已把三平台注册与单实例转发做全，自研只是重复承担平台差异。

### 方案 方案 C：OS 协议直接沿用 qomicex（按 issue 字面）
- 优点：与 issue 标题一致，第三方文档里就是 qomicex://
- 缺点：与内部 IPC 伪协议同名；macOS/Linux 存在注册机制歧义风险；排障时难以区分「这是 OS 协议还是内部管道协议」
- 为何不选：舍弃（用户裁定）。用 qomicex-launcher 一次性消除冲突类风险，内部协议零改动。

### 方案 方案 D：仅做 OS 协议注册，不引入 single-instance
- 优点：改动更小
- 缺点：启动器已开着时点网页链接会再开一个实例，重复 spawn 后端/抢管道名，行为不可预期
- 为何不选：舍弃。Windows/Linux 上深链本质是「新进程带 URL 参数启动」，没有单实例就无法唤醒已有窗口。

## 影响
- src-tauri/Cargo.toml：新增 tauri-plugin-deep-link、tauri-plugin-single-instance(deep-link)
- src-tauri/tauri.conf.json：plugins.deep-link.desktop.schemes=["qomicex-launcher"]
- src-tauri/capabilities/default.json：新增 deep-link:default
- src-tauri/src/deep_link.rs（新）：协议注册、冷/热两条接收路径、PendingDeepLink 队列、take_pending_deep_link 命令
- src-tauri/src/lib.rs：single-instance 首位注册 + deep-link 插件 + manage(PendingDeepLink) + setup 里 deep_link::init
- src/lib/deepLink.ts（新）：纯解析（动作联合类型、路由白名单、官方域白名单）
- src/components/DeepLinkHandler.tsx（新）：事件/队列两入口 + 动作分发 + 短窗去重
- src/App.tsx：BrowserRouter 内挂载 DeepLinkHandler
- src/api/plugins.ts：新增 installPluginFromUrl
- src-backend/qomicex-backend/src/endpoints/plugin.rs：新增 POST /plugins/install-url + install_url handler + INSTALL_URL_MAX_BYTES
- qomicex-tauri-i18n：新增 deepLink 命名空间（7 语言同步，submodule 需单独提交）

## 修订记录
| 日期 | 版本 | 修改内容 | 修改人 |
|---|---|---|---|
| 2026-10-04 | v1.0 | 初版创建 | AI Agent |

### 2026-10-04 更新

## 补充决策（VERIFY 阶段发现）：`--debug <port>` 时跳过 single-instance

**问题**：`packages/qomicex-cli` 的 `qomicex debug` 与 ADR-063 的约定是「每次用 `--debug <port>` 启动一个新进程来暴露 CDP 端口」。CDP 端口由**进程启动时**的环境变量（`WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS` / `WEBKIT_INSPECTOR_*`）决定，无法转交给已在跑的实例。若无条件注册 single-instance，启动器已在运行时再执行 `qomicex debug`，新进程会被拦截并退出、CDP 端口永远不会打开——调试链路静默失效。

**决策**：`parse_debug_port()` 返回 `Some` 时**不注册** `tauri-plugin-single-instance`，其余情况照常注册。

```rust
let debug_port = parse_debug_port();
#[cfg(desktop)]
if debug_port.is_none() {
    builder = builder.plugin(tauri_plugin_single_instance::init(
        |app, argv, _cwd| deep_link::handle_second_instance(app, &argv),
    ));
}
```

**代价与边界**：显式调试模式下没有单实例，深链的「运行中二次唤起」也无法转发（冷启动深链仍工作）。该模式本就是开发者手动触发的短时状态，且退化为与本次改动之前完全一致的行为，可接受。

## 验证证据（本机实测）

| 项 | 命令 | 结果 |
|---|---|---|
| 前端类型 | `npx tsc --noEmit` | `EXIT=0` |
| 前端构建 | `pnpm run build` | `BUILD_EXIT=0`（`✓ built in 8.96s`） |
| Rust 格式 | `cargo fmt -- --check`（backend + tauri） | 均 `0` |
| Rust 编译 | `cargo check`（backend + tauri） | 均 `EXIT=0` |
| 后端测试 | `cargo test -p qomicex-backend` | `361 passed; 0 failed; 2 ignored` |
| Tauri 网关测试 | `cargo test --lib plugin_gateway` | `2 passed` |
| i18n 结构 | 7 语言 key/占位符奇偶校验 | 均 `keys=12`、占位符集合一致（此后随迭代增长：审计修复 +5 → 17，同名实例歧义 +1 → **18**） |

**新端点 `POST /api/plugins/install-url` 端到端实测**（真实后端 + 临时 `QOMICEX_HOME`，`:5099`）：

| 用例 | 输入 | 结果 |
|---|---|---|
| 空 url | `{"url":""}` | 400 `INSTALL_URL_REQUIRED` |
| 非 http(s) | `ftp://example.com/a.qplugin` | 400 `INSTALL_URL_SCHEME_NOT_ALLOWED` |
| SSRF-回环 | `http://127.0.0.1:1/a.qplugin` | 400 `PROXY_PRIVATE_ADDRESS` |
| SSRF-hostname | `http://localhost/a.qplugin` | 400 `PROXY_PRIVATE_ADDRESS` |
| 下载成功但非 zip | `https://www.baidu.com/` | 400 `INVALID_PLUGIN_PACKAGE`（**证明 fetch 真的执行**） |
| DNS 失败 | `https://no-such-host-….invalid/a.qplugin` | 400 `PROXY_DNS_FAILED` |
| **完整成功路径** | 商店真实包 `https://cdn.qomicex.top/plugins/top.qomicex.mctiers/1.0.0.qplugin` | **200 + PluginInfo**，落盘到临时 home，`GET /api/plugins` 可见 |
| `allowUnsigned` 接线 | 同上 + `?allowUnsigned=true` | 200（覆盖安装，`hasRollback:true`） |

**未在本机验证（需真机）**：OS 协议注册本身（Windows 注册表 `HKCU\Software\Classes\qomicex-launcher` 写入、从浏览器点击链接唤起、二次唤起转发到已有窗口）——需要安装/运行构建后的启动器并点击链接，属环境依赖项。



### 2026-10-04 更新

## 补充决策：PR #172 审计评论处理（2026-10-04）

CodeRabbit 提了 13 条 inline 意见。逐条按「证据优先」裁定后的处理如下。

### 安全三条（全修）

**① 路径穿越绕过 `open` 白名单**（评论 #13）—— 探针实测可利用

`open/settings/%2F..%2F..%2Fplugins%2Fp%2Fx`：`URL` 只折叠字面量 `.`/`..`，`%2F`/`%2E` 会原样留在 pathname。解码拼成 `/settings//../../plugins/p/x` 后凭 `/settings/` 前缀通过白名单；`BrowserRouter` 按 WHATWG 规则规范化成 `/plugins/p/x`，跳到白名单外的插件路由。探针输出 `escapesWhitelist: true`。

修法：新增 `hasPathEscape(segments)`，在**拼路由之前**拒绝解码后含 `/`、`\`、`.`、`..` 的段。

**② 重定向绕开 SSRF 校验**（评论 #2）

`validate_target` 只校验初始主机，而共享 `http_client` 用 reqwest 默认策略（≤10 跳，不重校验）→ 公网 URL 可 302 到回环地址。新增 `AppState::plugin_download_client`，`redirect(Policy::none())`，UA / 60s 超时 / 代理沿用共享设置；3xx 报新错误码 `INSTALL_URL_REDIRECT_NOT_ALLOWED`。

**选「禁用」而非「逐跳重校验」的依据**：实测官方 `.qplugin` 分发不依赖重定向（`cdn.qomicex.top/plugins/…` 以 `redirect=manual` 请求得 200 直出、无 `Location`）。

> **⚠️ 该客户端后来还有第二处刻意差异**：它**不再继承 `ignore_ssl_cert`**（始终校验证书）。此处初版写的是「参数与共享客户端一致」，那是错的 —— 见文末「补充决策：不继承 ignore_ssl_cert」。

**③ 64 MiB 上限在整读之后才检查**（评论 #3）

无 `Content-Length`（chunked）时 `resp.bytes()` 先全量入内存。改为 `bytes_stream()` 逐块累加、越限立即返回；头部预检保留为快速路径。

### 时序重构（评论 #4/#7/#8/#11 同一根因）

原设计是「`take` 读取即清空 + emit 事件」：清空太早会**丢链接**（后端未就绪、组件重挂、监听未注册完成三个缝隙），只 emit 不清理又会**重复执行**。

改为**待处理集合 + 逐条回执**：

- Rust `PendingDeepLink`：`push` 去重、`take_pending` 返回全部**不清空**、`complete` 按 URL 移除；新增 `complete_deep_link` 命令。
- 前端等 `listen` 注册落地后再取集合（否则「读走」与「事件投递」之间到达的 URL 两边都捞不到）。
- 前端消费门控在 `backendReady` 之后（冷启动时后端可能还在解压/spawn，此时发 `launch` 必然失败而链接已被当成处理过）。
- 已取出但未处理完的存模块级 `pendingBuffer`，跨 `StrictMode` 双挂载不丢。
- 非法编码（`%FF`）的 `decodeURIComponent` 抛错纳入 `try/catch` 返回 `null`（评论 #12），且这类 URL 也回执，避免永久滞留。

### 协议注册改为 OOBE 引导（评论 #6，用户裁定）

无条件 `register_all()` 会让**后运行的任意构建**（含临时目录里的 dev 产物）抢走系统协议关联，该文件一删链接即失效。改为 `is_registered()` 门控 + **不自动写入**：未关联时置 `DeepLinkRegistration` 标记，由前端在 OOBE 阶段/启动时弹窗征询，用户同意后才调 `register_deep_link`；拒绝记 localStorage，不再反复打扰。

### 小修

- `handle_second_instance` 只记 `argv.len()`：argv 就是深链原文（含房间码），而 `tauri_log!` 会落盘 `{BaseDir}/logs/qomicex-tauri.log` 并回显 stderr（评论 #5）。
- `launch` 改为**先按 ID 再按名字**：实例 ID 是后端 `short_id()` 生成的短串，与用户自定义名字存在撞车可能，ID 是精确标识应优先（评论 #9）。
- ADR 标签索引里 ADR-100 的链接指向重命名前的旧文件名（评论 #1）——`create_adr` 生成索引时文件尚未改名；已修链接并用 `index_docs` 刷新索引（计数 105 与实际一致）。

### 不采纳

- **评论 #10**（`from './ui'` 缺扩展名）：AGENTS.md 明确「目录 barrel 如 `src/components/ui`（其 `index.ts`）无需扩展名」，仓库内同写法 **122 处**，CI `frontend-lint` 通过。按仓库规范保持原样。
- **评论 #4 的「消费后清理」在其原方案下**已由回执机制覆盖，无需额外的「消费确认」层。

### 验证证据

| 项 | 结果 |
| :--- | :--- |
| `npx tsc --noEmit` / `pnpm run build` | 0 / 0 |
| `cargo fmt -- --check`（backend/tauri） | 0 / 0 |
| `cargo test`（后端全量） | **376 passed; 0 failed; 2 ignored** |
| `node scripts/test-deep-link-parse.mjs`（新增，27 例） | 27 passed |
| 解析测试反向探针（抽掉修复） | 路径穿越 4 例 FAIL；`%FF` 直接抛 URIError → 证明测试非空绿 |
| 重定向对比（同一 URL `http://github.com/…`） | 修复前 502（跟到 github 后 406，**证明跳转发生**）→ 修复后 **400 `INSTALL_URL_REDIRECT_NOT_ALLOWED`** |
| 逐块限流反向探针（抽掉头部预检 + 上限压至 1 KiB） | 仍 **400 `INSTALL_URL_TOO_LARGE`** → 拦截来自逐块累加本身 |
| 官方包回归 | 200，安装落盘，`GET /api/plugins` 可见 |
| 既有错误路径回归 | 空 url / ftp / 回环 / 非 zip 四项错误码不变 |

**踩坑记录**：`Copy-Item` 还原探针会保留**旧 mtime**，cargo 因此判定「已是最新」不重编，导致复测跑的还是探针二进制（一度误得 406）。已在还原后显式 `touch` 源文件强制重建；这也是「确认测的是哪个二进制」这条实测纪律的实际价值。



### 2026-10-04 更新

## 补充决策：`launch` 目标规范化 —— 消除同名实例歧义（2026-10-04）

### 问题（已实测，非推测）

原实现用 `list.find(i => i.name === target)` **静默取第一个匹配**。但跨目录同名实例是**合法存在**的：`InstanceService::dedup_instances` 的去重键是 `(game_dir, name)` 而非 `name`，且 `create_instance` 只做 `short_id()` + 赋值 name，**没有任何重名校验**（对比分组有 `GROUP_NAME_EXISTS`）。

更糟的是顺序**不稳定**。真实后端实测（3 个同名实例、3 个不同 game_dir）：

```
GET /api/instance（无扫描缓存）      → name 匹配 = idAAA（instances.json 顺序）
触发 3 次 sync-scan 后（有缓存）     → name 匹配 = idCCC
```

根因：`list_existing()` 有扫描缓存时走

```rust
let all_scanned = cache.values().flat_map(|v| v.iter().cloned()).collect();
```

而 `scan_cache` 是 `HashMap<String, Vec<..>>`——`HashMap` 用随机种子，**每次进程启动迭代顺序都不同**。独立探针（200 次试验、3 个同名实例）分布 `73/67/60`，确认无偏向的随机命中。

后果：用户点同一个书签，可能今天启动 A、明天启动 B，**且没有任何提示**。

### 决策

1. **保留名字写法**，新增 `launch/<游戏目录>:<实例名>`；**从右往左**按 `lastIndexOf(':')` 切分。Windows 盘符自带 `C:`，从左切会把盘符当目录、把剩余路径当实例名。
2. **匹配顺序**：① 实例 ID 精确命中（全局唯一，一并解决「用户把实例命名成别的实例 ID」）→ ② 带目录时按 `(gameDir, name)` → ③ 退化按**原始串**匹配名字（让「名字里真带冒号」的旧链接仍可用）。
3. **同名多命中一律 `ambiguous` 并拒绝启动**，提示改用 `目录:实例名` 且给出可照抄的示例。**绝不静默取第一个**——这正是要修的缺陷。
4. **路径/名字比较「精确优先、大小写不敏感次之且宽松必须唯一」**：Windows 大小写不敏感、Linux 敏感，一律折叠会制造新歧义（`DirA` 与 `dira` 在 Linux 上是两个真实目录）。
5. **目录形式的兜底边界**：目录命中或歧义都直接返回，只有「完全找不到」才回退按原串找名字——否则目录笔误会静默落到同名的另一实例上。

### 实现中发现并修掉的额外缺陷

写测试时发现裸路径 `launch/C:\mc\inst`（只给目录、没给实例名）会被切成 `dir="C"` + `name="\mc\inst"`——**正是本决策要防的盘符误切，只是从另一个方向发生**。加兜底判定并收紧条件到「单个字母 + 后半以路径分隔符开头」，以免误伤 `C:MyPack` 这类合法的「盘符 + 名字」写法。

### 已知限制

实例名**本身含冒号**时（name 即版本目录名，Windows 文件系统不允许冒号；Linux 上理论上可能）会被切错——此时请改用实例 ID。已在用户文档标注。

### 验证证据

| 项 | 结果 |
| :--- | :--- |
| `node scripts/test-deep-link-parse.mjs` | **43 passed, 0 failed**（新增反序解析与歧义共 16 例；后改为 tsc 编译真实源码并补 1 例，现为 **44 条断言**，见文末补充决策） |
| 反向探针 A（抽掉盘符兜底） | `只有盘符、无实例名分隔` **FAIL** |
| 反向探针 B（多命中退回静默取首） | `单靠名字命中多个 → ambiguous` **FAIL** |
| 边界手测 | `C:\mc\inst:MyPack` → 正确切分；`C:\mc\inst` → 不切；`C:MyPack` → 切出 `dir=C`；`/home/u/mc:Name` → 正确 |

## 补充决策：不继承 `ignore_ssl_cert` + 一次 CodeQL 误判的纠正（2026-10-04，PR #173）

### 先纠正一个错误判断

PR #172 合并时，我判定「CodeQL 失败属存量告警、与本 PR 无关」并据此放行。**该判断是错的**：PR #172 实际引入了 1 条 **high** 告警。

**错因（方法论）**：我用 `GET /code-scanning/alerts`（**不加 `ref=` 参数**）去统计「非默认分支的告警数」，得到 0 便当作证据。而该接口不加 `ref=` 时**本来就只返回默认分支的告警** —— 那个 0 是逻辑上必然成立的恒真式，不构成任何证据。

补上 `ref=refs/pull/172/merge` 后真相反转：

```
118 [rust/disabled-certificate-check] severity=high
    src-backend/qomicex-backend/src/state.rs:209   ref=refs/pull/172/merge
```

`state.rs:209` 正是本 ADR 新增的 `plugin_download_client` 中的 `danger_accept_invalid_certs`。

**可复用的检查方法**：统计某分支/PR 的告警**必须显式传 `ref=refs/pull/<N>/merge` 或 `ref=refs/heads/<branch>`**；判断「是否本 PR 引入」应对比 PR ref 与 base ref 的告警集差异，不能依赖任何默认过滤。

（附注：同批那两条 `rust/command-line-injection` @ `plugin.rs:1472/1476` 经同样方法复查确为存量 —— PR ref 下 0 条、main 上 `created=2026-09-09`。**同一个错误方法正好对了一半，反而更易让人信以为真**。）

### 技术根因与修复

`plugin_download_client` 初版为「与共享客户端参数一致」而继承了 `ignore_ssl_cert`。这是**设计取舍错误**：`danger_accept_invalid_certs` 让 TLS 校验完全失效，而这条链路下载的是**马上要被当成代码安装的 `.qplugin`** —— 继承用户的「忽略 SSL」设置（本意是给自签名/内网镜像放行）等于允许中间人替换正在安装的插件，与本端点其余防护（SSRF 校验 / 禁重定向 / 体积上限）自相矛盾。

修复（PR #173，main `55a0be04`）：该客户端**不再继承 `ignore_ssl_cert`**，始终校验证书。**代理与 `no_proxy` 仍然继承** —— 它们不降低安全边界，且不继承会破坏企业内网环境。

代价：官方分发（`cdn.qomicex.top`）用有效证书，正常路径不受影响（已实测真实商店包经该端点安装返回 200 并落盘）。确需自签名源的场景应走「本地上传」，那条路用户能看到实际文件。

### 验证证据

| 项 | 结果 |
| :--- | :--- |
| PR #173 的 `CodeQL` 检查结论 | **success — "No new alerts in code changed by this pull request"**（#172 为 `failure — 1 new alert including 1 high severity`） |
| `ref=refs/pull/173/merge` 查该规则 | **0 条**（#172 的 ref 下为 1 条） |
| `cargo check` / `cargo fmt --check` / `cargo test` | 0 / 0 / 376 passed, 0 failed, 2 ignored |
| 端到端 | 官方 https 包 → **200 安装落盘**（证书校验未破坏正常路径）；`github.com` 301 → 400 `INSTALL_URL_REDIRECT_NOT_ALLOWED`；`127.0.0.1` → 400 `PROXY_PRIVATE_ADDRESS`；非 zip → 400 `INVALID_PLUGIN_PACKAGE`；空 url → 400 `INSTALL_URL_REQUIRED` |

### 测试脚本的另一处调整

`scripts/test-deep-link-parse.mjs` 从「直接 `node xx.ts` 依赖类型剥离」改为**用仓库自带 tsc 把真实源码编译到临时目录再断言**（对齐既有 `test-update-channel.mjs` 范式）。原因：`package.json` 声明 `engines.node >= 22`，而 Node 的类型剥离 **22.18.0 才默认开启**，22.0~22.17 会在断言执行前就失败。同时该测试已接入 CI（`frontend-lint` 作业）。

