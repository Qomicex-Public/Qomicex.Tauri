# settings-pages-demo

插件设置页的演示 / 验证 fixture。自身没有菜单入口，贡献两个 `contributes.settingsPages`：

| 页面 | 用途 |
|---|---|
| `src/settings-long.html` | 40 个设置项 + 底部标记 `#settings-bottom-marker`，内容远高于 iframe 高度 |
| `src/settings-short.html` | 两项内容，低于 iframe 高度 |

## 为什么需要它

插件设置页是 `srcdoc` iframe，滚动由注入的 `src/plugins/plugin-css.ts` 决定。这里的长页面
能在真实浏览器里复现 / 回归 issue #269（`body{overflow:hidden}` 让设置页对用户不可滚动，
内容被直接裁掉，而 `window.scrollTo` 仍然有效，肉眼与 DOM 尺寸都看不出来）。

## 构建

`manifest.json` 按仓库约定把路径写成 `dist/`（同 `hello-plugin`），而 `dist/` 被 .gitignore，
因此源码在 `src/`、需要一步复制：

```bash
node build.mjs          # 或：pnpm run build
```

## 用法

自动校验（起 stub + Vite dev + Tauri mock，真实滚轮断言，退出码即结果）：

```bash
pnpm run harness:verify-settings-scroll          # 加 --headed 看过程
```

交互调试（浏览器里手动改、热重载）：

```bash
pnpm run harness -- settings-pages-demo
```

两个入口都由 `scripts/harness/lib.mjs` 提供 stub/Vite/mock 设施，断言细节见
`scripts/harness/verify-settings-scroll.mjs`；注入 CSS 的静态断言另见
`scripts/test-plugin-settings-scroll.mjs`。
