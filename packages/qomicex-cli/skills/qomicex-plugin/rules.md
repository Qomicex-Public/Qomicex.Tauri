# AI 生成插件硬性规则

AI agent 生成/修改插件时必须逐条遵守。违反任何一条都可能导致 `qomicex verify` 不通过或运行时错误。

## manifest 校验

1. **id 格式**：`^[a-z0-9]+([.-][a-z0-9]+)*$`，3-128 字符，**必须含至少一个点**（反向域名，如 `com.example.demo`）。大写字母、空格、连续双点 → error。
2. **version**：严格 semver `数字.数字.数字`（可带 `-预发布` / `+构建号`），如 `0.1.0`、`1.2.0-beta.1`。
3. **minLauncherVersion**：必填字符串。
4. **layers**：至少一项，值 ∈ `l0`/`l1`/`l2`/`l3`。声明了 `entry.frontend` 但 layers 无 `l2`/`l3` → UI 无法渲染。
5. **permissions**：值是权限目录 id。未知权限 → warning。
6. **entry**：`frontend`/`backend`/`theme` 至少一个。`frontend` 应指向 `.html`（如 `dist/index.html`）。
7. **render**：默认 `iframe`（沙箱），仅显式 `"inline"` 走内联渲染。对 UI 插件建议不做修改，保持 iframe 默认。

## 权限

8. **最小权限原则**：只声明真正用到的权限。`qomicex verify` 会扫描源码，声明未用 / 用了未声明**都会报错**。按"最终调用了哪些 API 方法"反推权限集合，从 `permissions.md` 的 `METHOD_PERMISSIONS` 表查对应的权限 id。
9. **danger 权限**：`shell:execute`、`filesystem:write`、`plugin:install` 安装时红色提示，非必要不声明。
10. **addMenuItem 无需权限**：`addMenuItem` 不要求 manifest 声明任何权限。

## 代码

11. **TS import 带扩展名**：Vite 强制要求，`import { foo } from './bar.ts'`，不得省略 `.ts`/`.tsx`。例外：目录 barrel（`index.ts`）可省略。
12. **vite.config.ts 必须设 `base: './'`**：否则产物 `/assets/...` 被解析为站点根路径，插件白屏。
13. **不使用 `<a>` 做内部导航**：内部路由用 `<Link>`（React Router），`<a>` 触发整页刷新丢失持久状态。外部链接用 `openUrl` / `callBackend('/system/open-url', { url })`。
14. **沙箱内不用 `window.open`**：L2 iframe 的 `sandbox` 属性不含 `allow-popups`，`window.open` 被拦截。用 `openUrl` 方法或 `callBackend('/system/open-url', { url })`。
15. **不用 `fetch` 请求外部 URL**：用 `proxyFetch`（非流式）或 `proxyFetchStream`（流式，SSE），两者自带 SSRF 防护（禁止内网）和 CORS 代理。
16. **不虚构 API**：权限目录里有但桥 API 没有对应方法的能力（如 `clipboard:read`/`clipboard:write`、`network:websocket` 等当前无对应 `__PLUGIN_API__` 方法）不要臆造调用方式。以 `plugin-api.md` 列出的方法为准，不确定就标注「以代码为准」。

## 主题

17. **CSS 全用 `var(--*)`**：禁止 `#hex` / `rgb()` / `hsl()` 字面量。插件主题文件（`theme.css`）也只覆盖 `var()` token。
18. **Tailwind 用语义类名**：`bg-primary`、`text-foreground`、`text-muted-foreground`、`bg-muted`、`border-border` 等（`@qomicex/plugin-ui/tailwind-preset` 已映射）。

## 安全

19. **禁止硬编码密钥**：插件源码 / manifest / package.json 不得包含 API key、token、密码。用户配置经 `setSettings`/`getSettings` 存取。
20. **不滥用 `shell:execute`**：系统命令调用有 15s 超时（范围 1-120s），仅用于纯本地工具链，不传用户输入到 shell。
21. **文件读写经授权制**：`filesystem:read`/`write` 首次访问未授权路径时用户弹窗确认，按路径前缀持久化。插件不能假设用户一定会授权。

## 开发流程

22. **生成项目用 `qomicex create`**：不要手写 `manifest.json` 和项目结构，从模板起步。
23. **打包前必须 `qomicex verify`**：0 error 才算通过。warning 可接受但建议消除。
24. **不触碰启动器核心代码**：插件只修改自己目录内的文件，不动 `src/`、`src-tauri/`、`src-backend/` 等。
25. **不 git commit**：插件开发阶段不提交改动到仓库。