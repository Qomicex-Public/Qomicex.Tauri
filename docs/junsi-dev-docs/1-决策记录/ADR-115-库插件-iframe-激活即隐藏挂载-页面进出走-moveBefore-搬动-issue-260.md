# ADR-115：库插件 iframe 激活即隐藏挂载，页面进出走 moveBefore 搬动（含 l4 注册表桥）

| 属性 | 内容 |
|:---|:---|
| 状态 | 已采纳 |
| 日期 | 2026-10-17 |
| 决策者 | AI Agent |
| 相关 issue | #260 |

## 背景

`createSandbox()` 只创建 `<iframe srcdoc>` 并写进实例表，从不把它插进文档；唯一的挂载点是 `PluginPage` 的 `el.appendChild(inst.iframe)`，即用户手动导航到 `/plugins/p/:id` 才会挂载。

浏览器的行为：**脱离文档的 `srcdoc` iframe 不执行脚本**。因此库插件（只声明 `entry.frontend`、不贡献 `menuItems`，靠 `registerMethod` 对外提供方法）在启动后：

1. `activatePlugin()` 成功，`plugin-states.json` 里是 `active`
2. 但 iframe 从未入文档 → `srcdoc` 里的 `registerMethod` 从不执行
3. `window.__pluginSources` 里没有该插件 → 任何 `callPlugin(该插件, ...)` 都 reject

实测（Chrome 155 + harness，`plugins-dev/zz-lib-probe` 只有 `registerMethod('echo')`）：

| 状态 | `__pluginSources` | `callPlugin` |
|:---|:---|:---|
| 修复前 | `{}` | reject「插件 zz-lib-probe 未提供方法 echo」 |
| 修复后 | `{ "zz-lib-probe": { "echo": {} } }` | `echo:hi` |

失效是静默的：宿主状态显示 `active`，调用方只看到「未提供方法」。受影响的是 MarkdownLib（`top.qomicex.markdown`）、MarkItDown（`top.qomicex.markitdown`）这类被依赖的库插件，以及所有依赖它们的插件。

## 决策

### 1. 库插件激活即隐藏挂载

`activatePlugin()` 判定是否「发布页面入口」（`menuItems[].action !== 'overlay'`）：

- **无页面入口（库插件）** → `createSandbox(plugin, hiddenMount: true)`，创建后立即把 iframe 放进挂在 `document.body` 上的隐藏宿主（`position:fixed;left:-99999px`，`visibility:hidden`，`pointer-events:none`，`aria-hidden="true"`，尺寸 1024×768 让插件首屏不按 0×0 布局）。
- **有页面入口** → 保持原语义：等 `PluginPage` 打开时再挂载。

理由：库插件用户永远导航不到它的页面，没有宿主容器可用；有页面的插件启动即执行前端会显著抬高启动开销，而这个范围之外的懒加载没有正确性问题。

### 2. 宿主常驻文档，页面进出搬动而不是丢挂

`PluginPage` 不再 `appendChild(inst.iframe)`，改为把整个宿主迁入页面容器；`useLayoutEffect` 清理时把宿主退回 body 的隐藏位置，**不销毁**。否则用户离开插件页就等于把插件脚本连同已注册方法一起卸载，依赖它的 `callPlugin` 在离开页面后全部失败 —— 同一类静默失效换了个触发条件。

这条对两类插件都成立：库插件本就常驻；有页面入口的插件首次被打开后也进入常驻状态（未打开过的仍不加载）。代价是打开过一次的插件会一直持有 iframe 直到停用，收益是「激活后可调用」的语义不随导航漂移。

搬动优先用 `Element.moveBefore`：它不重建浏览上下文，iframe 不重新加载。实测同一 iframe 用 `appendChild` 搬动会重跑脚本（`contentWindow` 变新、脚本二次执行），而 `moveBefore` 保持同一 `contentWindow`、只执行一次。

WebKit（Safari 与 macOS/iOS 的 WKWebView，MDN 至今标记为不支持）没有 `moveBefore`，只能降级为 `appendChild`，**这条降级并不等价**：

1. iframe 被重新加载，新文档要重新执行前端、重新注册方法；
2. 在这段窗口内，主窗口注册表里存的仍是**旧文档的 window**，它已 `closed === true`；
3. 向它 `postMessage` 既不报错也没人接收，调用方 Promise 会**永久挂起**。

实测（把 `Element.prototype.moveBefore` 删掉以模拟 WebKit，插件延迟 1500ms 注册）：

| 时点 | 加固前 | 加固后 |
|:---|:---|:---|
| 切走页面 500ms 后调用 | `PENDING(>6s 无任何回执)` | `REJECT: 插件 ... 的界面已重新加载，方法 probe 暂不可用` |
| 新文档注册完成后 | `OK: 4anqg1:1` | `OK: hijpcn:1` |
| Chromium/WebView2（有 `moveBefore`） | `OK` | `OK` |

因此 `plugin-registry.ts` 在转发调用前检查来源 window 是否已销毁，直接以可读错误 reject，不让调用方无限等待。这是**兜底**，不是修复：WebKit 上「打开过插件页再切走」仍会重建一次 iframe（最多一次，之后宿主退回 body 隐藏位、稳定不再搬动），期间对该插件的调用会短暂失败。

宿主状态判据：

| 位置 | 样式 | `aria-hidden` | 语义 |
|:---|:---|:---|:---|
| body 隐藏位 | `HIDDEN_HOST_STYLE`（移出视口 + `visibility:hidden`） | `true` | 插件已激活，方法可调用，UI 不可见 |
| 插件页面容器 | `MOUNTED_HOST_STYLE`（`width/height:100%`） | 移除 | 插件 UI 可见 |
| 停用/销毁 | 宿主 `remove()` | —— | 实例与已注册方法一并清理 |

### 3. 槽位 / 设置页沙箱不常驻

`createSlotSandbox()`（`contributes.slots`、`contributes.settingsPages`）由 `PluginSlot` 挂进自己的容器；卸载即脱离文档，由 `destroySlotSandboxes()` 在停用时销毁。它们只服务当前可见 UI，不承担「启动后随时可调用」的契约。

## 备选方案

- **所有插件一律启动即挂载**：语义最统一（激活 = 前端已加载），但启用中的每个 UI 插件启动时都会执行前端并渲染 React 根，启动开销与不启用插件时的差距拉大。否决。
- **只在被依赖时挂载**：需在激活前算依赖图，且 `dependencies` 全为 `optional` 时仍应可用，判定条件比「是否有页面入口」更绕，收益只是少挂载几个无人依赖的库插件。否决。
- **保留仅在 `PluginPage` 挂载，库插件另走 inline 渲染**：`renderInline` 已经用「临时隐藏宿主同步执行脚本」规避了同一问题（`loadInlineContent`），但它把插件放在主窗口同一 DOM，失去 iframe 的 `allow-scripts` 隔离，且要求插件是自包含非 ES module 产物。否决。

## 影响

- 库插件（无页面入口）在启动时多执行一次前端脚本；无 UI 页面，代价是脚本解析与执行。
- 有页面入口的插件行为不变：仍是首次导航到插件页时加载。
- `SandboxInstance` 增加 `host` 与 `persistent` 字段；`PluginPage` / `PluginSlot` 改用 `mountSandbox` / `unmountSandbox`，不再直接操作 `inst.iframe`。
- 回归测试 `scripts/test-plugin-sandbox-host.mjs`（`pnpm run test:plugin-sandbox-host`）钉住宿主生命周期：常驻不入页面容器也不脱离文档、进出页面走 `moveBefore`、20 次启用/停用循环后 body 无宿主残留、无 `moveBefore` 时降级仍可用。该测试改前失败（`attachHost` 空实现 → 宿主不入文档），改后 26 项断言通过。

## 同批修复的相邻缺口：l4 插件的方法注册

l4 插件（`render: "webview"` 或 `layers: ["l4"]`）跑在独立 WebviewWindow 里，那个窗口本身就是 `window.top`，`plugin-registry.ts` 会把它当 host，方法只登记进该窗口自己的 `__pluginSources`。主窗口查不到 → 同样是「插件 X 未提供方法 Y」，与 iframe 宿主不挂载属于同一类静默失效。

`src/plugins/l4-registry-bridge.ts` 用 Tauri 事件在两个窗口间补登记与转发，协议与状态机不依赖 Tauri（`RegistryBus` 由调用方注入），因此可以脱离运行时验证：

| 方向 | 事件 | 语义 |
|:---|:---|:---|
| l4 → main | `plugin-l4-registry-register` / `-unregister` | 该插件在本窗口提供哪些方法 |
| main → l4 | `plugin-l4-registry-call` | 在主窗口 `callPlugin` 落到 l4 窗口执行 |
| l4 → main | `plugin-l4-registry-result` | 结果或错误 |
| l4 → main | `plugin-l4-registry-proxy-call` | l4 插件调第三方插件（本窗口看不到主窗口注册表） |
| main → l4 | `plugin-l4-registry-proxy-result` | 代调用结果，按发起方 pluginId 定向回对应窗口 |

三处必须同时成立，缺一处就退化成「挂起」而不是「报错」：

1. **回执必须发**：`Promise.resolve().then(() => invoke(...))` 起链。插件方法是同步函数时直接 `invoke(...).then(...)`，同步异常会跳过 `then`，回执永远不发，调用方只能等超时。
2. **调用要按窗口转发**：l4 窗口收到插件 iframe 的 `__plugin_registry_call` 时，目标不在本窗口就必须经 `proxy-call` 交给主窗口，并在拿到回执后回 `postMessage` 给 iframe。
3. **超时兜底**：l4 窗口被用户直接关闭时不会有任何回执，`callPlugin` 在 30s 后以「调用超时（独立窗口无响应）」reject。

端到端实测（两个浏览器页模拟主窗口与 l4 窗口，Tauri 事件总线经 Node 转发）：

| 场景 | 结果 |
|:---|:---|
| 主窗口 `callPlugin(l4, 'echo', 'hi')` | `OK: l4:dgbhwz:hi` |
| 主窗口调用 l4 里同步抛错的方法 | `REJECT: l4 内部错误`（修复前 `PENDING`，等满超时） |
| l4 插件反向 `callPlugin('zz-main-probe', 'ping')` | `OK: main:from-l4` |
| 直接关掉 l4 窗口后调用 | `REJECT: 插件 … 的调用超时（独立窗口无响应）` |

顺带修掉一个使 l4 窗口根本加载不出插件页的既有缺陷：`createRemoteWebview` 生成的 URL 只有 `?pluginWebview=1`，而 `App.tsx` 用 `pluginWebview=1&pluginId=<id>` 判定窗口模式并把 id 传给 `PluginWebviewPage`，缺 `pluginId` 时该参数为空串，`fetchPlugin('')` 必然失败。现在 URL 显式带上 `pluginId`。

回归测试 `scripts/test-plugin-l4-registry.mjs`（`pnpm run test:plugin-l4-registry`）覆盖 17 项断言：往返、反向调用、异步/同步抛错、未注册方法与未登记插件、窗口无响应超时、重复注册不叠加、dispose 让在途调用失败。把 `register` 改成空实现后该测试失败（`host.has` 期望 `true` 实际 `false`），改后通过。

## 参考

- issue #260
- `src/plugins/sandbox-host.ts`、`src/plugins/sandbox.ts`、`src/plugins/plugin-registry.ts`、`src/plugins/l4-registry-bridge.ts`、`src/plugins/l4-registry.ts`、`src/plugins/webview-bridge.ts`、`src/pages/PluginPage.tsx`、`src/pages/PluginWebviewPage.tsx`、`src/plugins/plugin-loader.tsx`、`src/plugins/PluginSlot.tsx`
- ADR-049：插件激活的全局副作用必须与停用成对清理
- ADR-054：l4 远程 WebView 独立窗口
