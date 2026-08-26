# manifest.json 字段全解

`manifest.json` 位于 `.qplugin` 包**根目录**，是插件唯一身份文件。本册字段以 `src/plugins/types.ts` 的 `PluginManifest` 与 CLI 校验器（`packages/qomicex-cli/src/lib/manifest.ts`）为准，与启动器 store 上传校验一致。

## 完整示例

```json
{
  "id": "com.example.demo",
  "name": "示例插件",
  "version": "0.1.0",
  "minLauncherVersion": "0.1.0",
  "layers": ["l2"],
  "permissions": ["config:read", "ui:toast", "network:cors_proxy"],
  "dependencies": [
    { "id": "top.qomicex.markdown", "version": ">=1.0.0", "optional": false }
  ],
  "entry": {
    "frontend": "dist/index.html",
    "theme": "dist/theme.css"
  },
  "render": "iframe",
  "contributes": {
    "menuItems": [
      { "path": "/plugins/p/com.example.demo", "label": "示例插件", "icon": "🧩", "action": "page" }
    ],
    "overlay": {
      "file": "dist/overlay.html",
      "title": "示例悬浮窗",
      "width": 380,
      "height": 500,
      "minimizable": true,
      "resizable": true
    }
  },
  "icon": "fa-solid fa-puzzle-piece"
}
```

## 字段总表

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `id` | string | ✅ | 插件唯一 ID。格式 `^[a-z0-9]+([.-][a-z0-9]+)*$`，3-128 字符，**必须含至少一个点**（反向域名，如 `com.example.demo`）。含点但非法字符 → error；不含点 → warning。一经发布不要更改（用作安装目录 `plugins/{id}/`） |
| `name` | string | ✅ | 显示名，非空 |
| `version` | string | ✅ | 严格 semver：`^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$`，如 `1.2.0`、`0.1.0-beta.1` |
| `minLauncherVersion` | string | ✅（CLI 校验） | 最低启动器版本。CLI 校验必填；运行时行为以启动器为准 |
| `layers` | string[] | ✅ | 图层声明，至少一项，值 ∈ `l0`/`l1`/`l2`/`l3`。声明 frontend 但无 `l2`/`l3` → 无法渲染 UI（warning） |
| `permissions` | string[] | ✅ | 权限声明，值必须是权限目录中的 id（见 `permissions.md`）。未知权限 → warning |
| `dependencies` | PluginDependency[] | 可选 | 前置插件依赖，见下 |
| `entry` | object | ✅ | 入口声明，`frontend`/`backend`/`theme` **至少一个** |
| `render` | 'inline' \| 'iframe' | 可选 | **默认 `iframe`**（沙箱）。仅显式 `"inline"` 走内联渲染（与主界面同 window） |
| `contributes` | object | 可选 | 扩展点 |
| `icon` | string | 可选 | 顶层图标（插件管理/列表显示；库插件建议用顶层 icon 而非 menuItems） |

## entry 对象

| 字段 | 类型 | 说明 |
|------|------|------|
| `frontend` | string | 插件页面入口，`.qplugin` 内相对路径，应指向 `.html`（如 `dist/index.html`）。声明了 frontend 的插件才会被激活并渲染到 `/plugins/p/:id` |
| `theme` | string | 主题 CSS 路径（如 `dist/theme.css`），激活时注入。引用 `dist/` 下文件但源码在根目录时，`qomicex pack` 会自动拷入 dist |
| `backend` | string | 保留字段，当前未使用（以代码为准） |

## layers 图层语义

| 层级 | 技术 | 说明 |
|------|------|------|
| `l0` | 静态声明 | 主题 / 声明式内容，纯声明无执行能力 |
| `l1` | 声明式 | 新增下载源 / 镜像 / 端点等声明（当前为预留层级） |
| `l2` | JS 前端沙箱 | **UI 插件默认层级**。iframe 沙箱（`sandbox="allow-scripts"`，opaque origin，与主界面 DOM/CSS 隔离），经 postMessage 桥做权限检查，`__PLUGIN_API__` 全量可用，`registerMethod`/`callPlugin` 跨窗口中转 |
| `l3` | WASM（wasmtime） | 后端沙箱执行 `plugin.wasm`，Host API 权限门控。包内含 `plugin.wasm` + 声明 `l3` 即被加载 |

- **render 默认 iframe**：带 `entry.frontend` 的插件默认走 iframe 沙箱。内联渲染（`"render":"inline"`）与主界面同 window，仅适合需要访问主界面 DOM 的轻量插件。
- `layers` 可声明多个（如 `["l2","l3"]`）。
- 纯 `["l3"]` 且无 `entry.frontend` 的插件不会自动激活渲染 UI。

## dependencies 依赖语法

```json
"dependencies": [
  { "id": "top.qomicex.markdown", "version": ">=1.0.0", "optional": false }
]
```

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | string | 被依赖插件 id |
| `version` | string | 可选，版本约束 |
| `optional` | boolean | 可选，是否非必装（缺省 false） |

- 安装时检查必装前置，缺失拒绝安装（`PLUGIN_MISSING_DEPENDENCY`）。
- 激活时检查前置已启用，缺失则本插件禁用。
- 激活顺序由依赖拓扑排序保证。
- `version` 约束写法（以代码 / 公开文档为准）：`>=1.0.0`、`<=2.0.0`、`>1.0`、`<2.0`、`=1.2.0`、裸版本 `1.2.0`、空格分隔多约束 `">=1.0 <2.0"`。不支持 `^`/`~`/`*`/`||`。

## contributes 扩展点

| 字段 | 类型 | 说明 |
|------|------|------|
| `downloadSources` | string[] | 保留（当前未使用，以代码为准） |
| `commands` | string[] | 保留（当前未使用，以代码为准） |
| `settingsPages` | string[] | 保留（当前未使用，以代码为准） |
| `menuItems` | PluginMenuItem[] | 侧边栏入口列表 |
| `overlay` | object | 悬浮窗配置 |

### menuItems 数组元素

```ts
{ path: string; label: string; icon?: string; action?: 'page' | 'overlay' }
```

- `path`：入口目标路由（如 `/plugins/p/:id`）。
- `icon`：emoji / 文本 / 绝对 URL / 包内相对路径（`dist/icon.svg`，启动器自动解析为 `http://localhost:5000/api/plugins/{id}/files/dist/icon.svg`）。
- `action`：`"page"`（跳转页面，默认）或 `"overlay"`（打开悬浮窗，需配合 `contributes.overlay`）。

### overlay 对象

```ts
{ file: string; title?: string; width?: number; height?: number; minimizable?: boolean; resizable?: boolean }
```

- `file`：悬浮窗 HTML 文件路径（必填，指向 `.html`，如 `dist/overlay.html`）。
- `title` / `width` / `height` / `minimizable` / `resizable`：可选，视觉/行为参数（具体默认值以启动器代码为准）。

## CLI 校验行为（`qomicex verify` 目录模式）

- manifest 合法性：id / name / version(semver) / minLauncherVersion / layers / permissions / entry / contributes。
- 权限最小化：对比 `permissions` 与源码实际调用的桥方法（`METHOD_PERMISSIONS` 表），**声明未用 / 用了未声明都会报错**。
- 长循环告警：`while(true)`、`for(;;)`、无界 `setInterval`。
- 校验通过标准：**0 error**（warning 可接受但建议消除）。
