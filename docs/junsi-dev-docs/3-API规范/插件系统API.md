# 插件系统 API

> 生成时间：2026-07-31 02:58

# 插件系统 API

> 后端端点前缀: `/api/plugins`，由 `PluginEndpoints.cs` 注册。

---

## 后端 API

| 方法 | 路径 | 用途 |
|:---|:---|:---|
| GET | `/api/plugins` | 列出所有插件及其状态 |
| GET | `/api/plugins/{id}` | 获取单个插件详情 |
| POST | `/api/plugins/upload` | 上传并安装 `.qplugin` 文件（multipart/form-data） |
| DELETE | `/api/plugins/{id}` | 卸载插件 |
| PUT | `/api/plugins/{id}/state` | 设置插件状态（"installed" / "active" / "disabled"） |
| GET | `/api/plugins/{id}/files/{path}` | 提供插件文件（静态资源） |
| GET | `/api/plugins/settings/{id}` | 获取插件设置 |
| POST | `/api/plugins/settings/{id}` | 保存插件设置 |
| POST | `/api/plugins/rescan` | 重新扫描 plugins/ 目录并刷新插件列表 |

### 上传安装

```
POST /api/plugins/upload
Content-Type: multipart/form-data
Body: plugin=@plugin.qplugin

Response 200:
{
  "manifest": { ... },
  "dir": "plugins/com.qomicex.example",
  "state": "installed",
  "installedAt": "2026-07-31T02:22:00Z"
}
```

### 设置状态

```
PUT /api/plugins/{id}/state
Content-Type: application/json
Body: "active"

Response 200:
{
  "id": "com.qomicex.example",
  "state": "active"
}
```

状态设置会持久化到 `{BaseDir}/plugin-states.json`。

---

## 插件 API 桥接（前端）

插件内页通过 `window.__PLUGIN_API__` 调用主程序功能。详见 `src/plugins/plugin-api.ts`。

### 方法签名

```ts
interface PluginBridge {
  getSettings(): Promise<Record<string, unknown>>
  setSettings(key: string, value: unknown): Promise<void>
  callBackend(endpoint: string, data?: unknown): Promise<unknown>
  navigate(path: string): void
  showToast(message: string, type?: 'info' | 'error' | 'success'): void

  // 悬浮窗操作
  createOverlay(opts: { title: string; html: string; x?: number; y?: number; width?: number; height?: number }): string
  showOverlay(id: string): void
  hideOverlay(id: string): void
  destroyOverlay(id: string): void
  setOverlayHtml(id: string, html: string): void
  setOverlayPosition(id: string, x: number, y: number): void
}
```

### 权限映射

| API Method | 所需权限 |
|-----------|---------|
| getSettings | config:read |
| setSettings | config:write |
| callBackend | network:fetch |
| navigate | config:read |
| showToast | ui:toast |
| overlay.* | ui:sub_window |

---

## Plugin States API（前端 client）

`src/api/plugins.ts` 导出以下函数：

```ts
import { fetchPlugins, setPluginState } from '../api/plugins.ts'

const plugins = await fetchPlugins()                // GET /api/plugins
await setPluginState(id, 'active')                  // PUT /api/plugins/{id}/state
```

---

## Slot API

插件可通过 `registerSlot()` 向侧边栏等固定位置注入 UI。

```ts
// src/plugins/slots.tsx
registerSlot(pluginId, 'sidebar:bottom', () => <ReactNode>)
```

当前支持的 slot 位置：`sidebar:bottom`


## 修订记录
| 日期 | 版本 | 修改内容 | 修改人 |
| 2026-07-31 | v1.0 | 初版创建 | AI Agent |