# hello-plugin · Qomicex 插件开发示范包

一个最小但完整的插件示例，演示 **l2 iframe 沙箱** 渲染、**侧边栏注入**、**悬浮窗 (overlay)**、**主题注入**，以及常用的插件 API 调用与 `@qomicex/plugin-ui` 组件用法。

## 目录结构

```
hello-plugin/
├── manifest.json        # 插件清单（发布时打包进 .qplugin 根目录）
├── overlay.html         # 悬浮窗页面（被拷贝到 dist/overlay.html）
├── theme.css            # 全局主题注入（被拷贝到 dist/theme.css）
├── index.html           # Vite 入口
├── vite.config.ts       # 必须 base: './'
├── tailwind.config.js   # 使用 @qomicex/plugin-ui/tailwind-preset
├── src/
│   ├── main.tsx         # React 入口，挂载 #root
│   ├── api.ts           # window.__PLUGIN_API__ 的类型化封装
│   ├── App.tsx          # API 演示 + 组件库展示
│   └── index.css        # Tailwind 指令
└── scripts/
    ├── build.sh         # bash 打包（含版本号参数）
    └── build.ps1        # PowerShell 打包（Windows）
```

## manifest.json 字段

| 字段 | 值 | 说明 |
|------|----|------|
| `id` | `hello-plugin` | 唯一 ID，决定安装目录名 |
| `layers` | `["l2"]` | 含 `l2` → iframe 沙箱渲染，脚本自动执行；不含 `l2` → 内联渲染 |
| `permissions` | `[...]` | 声明所需权限，调用 API 时后端会校验 |
| `entry.frontend` | `dist/index.html` | 前端入口，相对插件安装根目录 |
| `entry.theme` | `dist/theme.css` | 注入启动器全局的主题 CSS |
| `contributes.menuItems` | 侧边栏菜单 | `action: "page"` 跳转插件页；`action: "overlay"` 打开悬浮窗 |
| `contributes.overlay` | 悬浮窗配置 | `file` 指向悬浮窗 HTML |

> `entry.frontend` / `contributes.overlay.file` 是**相对插件安装根目录**的路径。`.qplugin` 里 `manifest.json` 在 zip 根，其余文件平铺；本项目 Vite 输出到 `dist/`，打包时 `index.html`/`overlay.html`/`theme.css` 都提升到 zip 根，故路径写作 `dist/...`。

## 开发

```bash
cd plugins-dev/hello-plugin
pnpm install            # 或 npm install
pnpm dev                # 本地预览页面（仅看 UI，无插件 API 桥）
pnpm build              # tsc --noEmit && vite build → dist/
```

## 打包

```bash
bash scripts/build.sh              # → release/hello-plugin-0.1.0.qplugin
bash scripts/build.sh 0.2.0        # 指定版本
# Windows
pwsh ./scripts/build.ps1 0.2.0
```

`*.qplugin` 即 zip 包，根目录含 `manifest.json`。可通过启动器插件中心的“上传插件”安装，或直接解压到 `{数据目录}/plugins/hello-plugin/`。

## 权限对照

插件 API 在调用时会校验 `manifest.permissions` 是否包含对应权限（`src/plugins/sandbox.ts` 的 `METHOD_PERMISSIONS`）：

| API | 需要权限 |
|-----|---------|
| getSettings / navigate | `config:read` |
| setSettings / registerMethod | `config:write` |
| getSystemInfo | `system:info` |
| showToast | `ui:toast` |
| callBackend / callPlugin | `network:fetch` |
| proxyFetch / proxyFetchStream | `network:cors_proxy` |
| createOverlay / showOverlay / hideOverlay | `ui:sub_window` |
| execCommand | `shell:execute` |
| readText / readBytes | `filesystem:read` |
| writeText / writeBytes / deleteFile | `filesystem:write` |
| download.* | `download:manage` |
| listPlugins | `plugin:list` |

## 常见问题

- **页面空白**：确认 `vite.config.ts` 的 `base: './'`，否则产物的 `/assets/...` 会解析到站点根。
- **侧边栏按钮未出现**：确认插件处于 `active` 状态；含 `l2` 的插件激活即执行，纯 `["l3"]` 的 installed 插件不会自动激活。
- **资源 404**：检查 `entry.frontend` 与打包后的实际目录层级是否一致。
