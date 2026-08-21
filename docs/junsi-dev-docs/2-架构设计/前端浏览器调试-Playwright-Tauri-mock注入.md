# 前端浏览器调试：Playwright Tauri mock 注入与挂载

> 生成时间：2026-08-21 19:22

# 前端浏览器调试：Playwright 注入 Tauri mock 并挂载 App

## 背景 / 为什么需要

启动器前端在**纯浏览器**（`pnpm run dev` 的 Vite）里不能直接挂载：

- `src/components/TitleBar.tsx:1,5` 在**模块顶层**调用 `getCurrentWindow()`（来自 `@tauri-apps/api/window`），
  它读取 `window.__TAURI_INTERNALS__.metadata.currentWindow.label`。
- 没有 Tauri 外壳时 `window.__TAURI_INTERNALS__` 为 `undefined` → `getCurrentWindow()` 抛异常 → React 根本无法挂载（`#root` 一直为空）。

因此要在浏览器里跑起前端做检查/自动化，必须**在页面脚本执行前注入一套 Tauri API mock**。

## 前置条件

1. **后端运行在 :5000**——前端 `src/api/client.ts` 的 `API_BASE` 直连 `http://localhost:5000`，`SplashScreen` 轮询 `/api/health` 通过后才渲染主界面。
   - 若你已有一个后端占着 5000，别干扰；用 `QOMICEX_PORT=<其它端口>` 起第二个实例，并相应改 mock 或代理目标。
2. **前端 dev server**：`pnpm run dev`（Vite，端口 1420，`vite.config.ts` 已把 `/api` 代理到 5000 作为兜底）。
3. **Playwright/浏览器工具**：用能执行 `addInitScript` 的自动化（如 Playwright MCP 的 `browser_run_code_unsafe`）。

## Playwright 注入 Tauri mock（核心方法）

用 `page.addInitScript` 注入，**必须在 `goto` 之前**，保证先于前端模块执行。脚本内容：

```js
(async (page) => {
  const mock = `
  (() => {
    let cid = 0; const cbs = new Map();
    const internals = {
      //① getCurrentWindow() 依赖它
      metadata: { currentWindow: { label: 'main' }, currentWebview: { label: 'main' } },
      //② 事件回调注册：给 handler 分配 id
      transformCallback: (cb) => { const id = ++cid; cbs.set(id, cb); return id; },
      unregisterCallback: (id) => { cbs.delete(id); },
      //③ IPC 调用：让 window/event 插件命令返回合理值
      invoke: (cmd) => new Promise((res) => {
        const bools = ['is_maximized','is_minimized','is_focused','is_decorated',
                       'is_resizable','is_maximizable','is_minimizable','is_closable',
                       'is_fullscreen','is_visible','is_always_on_top'];
        if (bools.some(b => cmd && cmd.indexOf(b) >= 0)) return res(false);
        if (cmd && cmd.indexOf('plugin:event|listen') >= 0) return res(1);
        return res(undefined);
      }),
      //④ 事件总线：TitleBar onResized 等不抛错
      event: { listen: async () => () => {}, once: async () => () => {},
               emit: async () => {}, emitTo: async () => {} },
      convertFileSrc: (p) => p,
    };
    Object.defineProperty(window, '__TAURI_INTERNALS__',
      { value: internals, configurable: true });
    //⑤ 各插件 internals（事件/应用/系统等），按需补齐
    window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { registerListener: () => {}, unregisterListener: () => {} };
    window.__TAURI_APP_PLUGIN_INTERNALS__ = { transformCallback: internals.transformCallback };
    window.__TAURI_OS_PLUGIN_INTERNALS__ = {};
    window.__TAURI_WINDOW_PLUGIN_INTERNALS__ = {};
    if (!window.__DEBUG__) window.__DEBUG__ = { unlocked: true, disableAnimations: false, showComponentBoundaries: false };
  })();
  `;
  await page.addInitScript({ content: mock });
  await page.goto('http://127.0.0.1:1420/<路由>', { waitUntil: 'domcontentloaded' });
  // 挂载等待（见下）
})();
```

关键点：
- `addInitScript` 面向 `Page` 实例，**跨导航保留**；只需注入一次。
- mock 是**运行时临时注入**，不写入源码，仅用于检查/自动化。
- 若页面还用到 dialog/opener/updater 等插件且启动路径会触发，需补充对应 `__TAURI_*_PLUGIN_INTERNALS__` 或让 `invoke` 默认 resolve（上面默认 `res(undefined)` 已能覆盖多数）。

## App 挂载判断与等待

前端启动顺序：`src/main.tsx` → `App` → `SplashScreen`（轮询 `/api/health` 直到 OK）→ `Layout` 渲染 `main`。

- **"已挂载"可用 `document.querySelector('main')` 是否存在来判断**（SplashScreen 阶段没有 `main`）。
- 等待方法（`goto domcontentloaded` 后轮询，勿依赖 `load` 事件，payload 请求可能拖住它）：

```js
for (let i = 0; i < 20; i++) {
  if (await page.evaluate(() => !!document.querySelector('main'))) break;
  await page.waitForTimeout(500);
}
```

- 挂载后：`document.documentElement.dataset.material`（`frosted/acrylic/aero/liquid`）、`getComputedStyle('.glass-surface').backdropFilter` 等都可直接检查。
- 数据来自 :5000 后端，加载的是**真实**设置/背景图，属只读检查，不改用户数据。

## 注意事项 / 已知差异

- **浏览器(Chromium) ≠ WebView2 保真**：引擎大体一致，但复合/堆叠行为可能有差异（例如本项目 `backdrop-filter` 在浏览器滚动容器内可采样 `position:fixed` 背景图，而部分 WebView2 版本不行）。**web 检查结论需在真实 Tauri/WebView2 里再复核**，不要仅凭浏览器下结论。
- 别在浏览器里触发会写数据/启动实例的动作（如 Dashboard 的自动启动），尽量导航到只读页面（`/resource-center`、`/settings` 等）。
- 用完后停掉 dev server、删除临时截图/探针，不遗留。

## 参考位置

- 崩源点：`src/components/TitleBar.tsx:5`（模块顶层 `getCurrentWindow()`）
- 后端地址：`src/api/client.ts` 的 `API_BASE`
- 启动壳：`src/main.tsx`、`src/App.tsx`（SplashScreen 逻辑）、`src/components/Layout.tsx`


## 修订记录
| 日期 | 版本 | 修改内容 | 修改人 |
| 2026-08-21 | v1.0 | 初版创建 | AI Agent |