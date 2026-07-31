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
  setCache(key: string, value: unknown, ttlSeconds?: number): Promise<void>
  getCache(key: string): Promise<unknown>
  callBackend(endpoint: string, data?: unknown): Promise<unknown>
  proxyFetch(req: { url: string; method?: string; headers?: Record<string, string>; body?: string; timeoutMs?: number }): Promise<{ status: number; headers: Record<string, string>; body?: string | null; bodyBase64?: string | null }>
  navigate(path: string): void
  showToast(message: string, type?: 'info' | 'error' | 'success'): void

  // 悬浮窗操作
  createOverlay(opts: { title: string; html: string; x?: number; y?: number; width?: number; height?: number; minimizable?: boolean; resizable?: boolean }): string
  showOverlay(id: string): void
  hideOverlay(id: string): void
  destroyOverlay(id: string): void
  setOverlayHtml(id: string, html: string): void
  setOverlayPosition(id: string, x: number, y: number): void
  setOverlaySize(id: string, width: number, height: number): void
}
```

### 权限映射

| API Method | 所需权限 |
|-----------|---------|
| getSettings | config:read |
| setSettings | config:write |
| setCache / getCache | cache:access |
| callBackend | network:fetch |
| proxyFetch | network:cors_proxy |
| navigate | config:read |
| showToast | ui:toast |
| overlay.* | ui:sub_window |

### 插件缓存（setCache / getCache）

插件可在自己的目录下读写缓存文件（`{插件目录}/cache.json`），用于缓存外部 API 响应等，避免重复请求。

- `setCache(key, value, ttlSeconds?)`：写入缓存。`value` 可为任意 JSON 值（对象/数组/字符串/数字/布尔/null）；`ttlSeconds` 传正整数时到期自动清除，不传则为永久缓存
- `getCache(key)`：读取缓存，返回原值；key 不存在或已过期时返回 `null`

```js
// 缓存模型列表 1 小时，避免每次都请求
await __PLUGIN_API__.call('setCache', 'models', { list: [...] }, 3600)
const cached = await __PLUGIN_API__.call('getCache', 'models')
if (cached) { /* 使用缓存 */ } else { /* 重新请求并 setCache */ }
```

- 缓存按插件隔离，只能读写自己插件目录下的缓存文件
- 内部存储结构 `{ key: { v: 值, e: 过期时间戳|null } }`，无需插件关心

### CORS 代理（proxyFetch）

插件网页直接 `fetch` 外部 API 可能被 CORS 拒绝，可通过 `proxyFetch` 走后端转发（`POST /api/plugins/proxy`），绕开浏览器 CORS 限制。

- 请求：`{ url, method?, headers?, body?, timeoutMs? }`，`method` 默认 `GET`，`timeoutMs` 默认 15000（范围 1000–60000）
- 响应：`{ status, headers, body, bodyBase64 }` —— 文本/JSON 响应走 `body`，二进制走 `bodyBase64`
- 安全限制（SSRF 防护）：
  - 仅允许 `http/https` 协议
  - 禁止内网/保留地址（localhost、127.x、10.x、172.16-31.x、192.168.x、169.254.x、0.0.0.0 等）
  - 不自动跟随重定向（3xx 原样返回）
- 错误：无效 URL → `PROXY_INVALID_URL`(400)；协议不符 → `PROXY_SCHEME_NOT_ALLOWED`(400)；内网地址 → `PROXY_PRIVATE_ADDRESS`(400)；上游失败 → `PROXY_UPSTREAM_FAILED`(502)

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