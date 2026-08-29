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
| POST | `/api/plugins/log` | 插件日志写入 trace（`{pluginId, level?, message}` → 204；需 `plugin:log` 权限） |

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

**原子安装说明**：后端先解压到同分区临时目录 `.{id}.tmp-*`，再原子替换正式目录（`Directory.Move`）；替换旧目录前对瞬时 `IOException`（如目录刚被占用）自动重试，避免重装同名插件失败。

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
  log(message: string, level?: 'debug' | 'info' | 'warn' | 'error'): void

  // 通用系统能力
  getSystemInfo(): Promise<{ Os: string; Architecture: string; OsName: string; OsVersion: string; OsVersionId: string; OsDisplayName: string; GitCommit: string; Memory: number; AvailableMemory: number }>
  openUrl(url: string): Promise<void>
  listPlugins(): Promise<{ id: string; name: string; version: string; status: string }[]>

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
| proxyFetchStream | network:cors_proxy |
| registerMethod | config:write |
| callPlugin | network:fetch |
| callWasm / listWasmPlugins | wasm:execute |
| readText / readBytes | filesystem:read |
| writeText / writeBytes | filesystem:write |
| deleteFile | filesystem:write |
| execCommand | shell:execute |
| navigate | config:read |
| showToast | ui:toast |
| log | plugin:log |
| getSystemInfo | system:info |
| openUrl | system:notification |
| listPlugins | plugin:list |
| overlay.* | ui:sub_window |
| download.* | download:manage |
| download.registerInstall | instance:write |
| modpack.install | instance:write |

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

### 通用系统能力（getSystemInfo / openUrl / listPlugins）

供大多数插件使用的通用能力，可直接经插件 API 调用（权限见上方表格）：

- `getSystemInfo()`：读取系统与启动器信息（OS/架构/系统版本/启动器 Git 提交/物理内存等），可做 `minLauncherVersion` 兼容检查
- `openUrl(url)`：调用系统默认浏览器打开外部链接（`POST /api/system/open-url`）。L2 沙箱内 `window.open` 会被拦截，请使用此方法
- `listPlugins()`：返回已安装插件列表（id/name/version/status），可用于依赖检测或商店联动

```js
// 判断启动器是否满足要求
const info = await __PLUGIN_API__.call('getSystemInfo')
console.log(info.Os, info.Architecture)

// 打开外链
await __PLUGIN_API__.call('openUrl', 'https://example.com')

// 检查依赖插件是否已安装
const plugins = await __PLUGIN_API__.call('listPlugins')
const hasDep = plugins.some(p => p.id === 'top.qomicex.markdown')
```

### CORS 代理（proxyFetch）

插件网页直接 `fetch` 外部 API 可能被 CORS 拒绝，可通过 `proxyFetch` 走后端转发（`POST /api/plugins/proxy`），绕开浏览器 CORS 限制。

- 请求：`{ url, method?, headers?, body?, timeoutMs? }`，`method` 默认 `GET`，`timeoutMs` 默认 15000（范围 1000–60000）
- 响应：`{ status, headers, body, bodyBase64 }` —— 文本/JSON 响应走 `body`，二进制走 `bodyBase64`
- 安全限制（SSRF 防护）：
  - 仅允许 `http/https` 协议
  - 禁止内网/保留地址（localhost、127.x、10.x、172.16-31.x、192.168.x、169.254.x、0.0.0.0 等）
  - 不自动跟随重定向（3xx 原样返回）
- 错误：无效 URL → `PROXY_INVALID_URL`(400)；协议不符 → `PROXY_SCHEME_NOT_ALLOWED`(400)；内网地址 → `PROXY_PRIVATE_ADDRESS`(400)；上游失败 → `PROXY_UPSTREAM_FAILED`(502)

### CORS 代理流式（proxyFetchStream）

`proxyFetch` 一次性返回完整响应；若上游返回 SSE 流（如 AI 对话逐字输出），用 `proxyFetchStream` 逐块消费。

- 请求同 `proxyFetch`，额外自动带 `stream: true`（后端走 `POST /api/plugins/proxy` 的流式分支，原样转发 SSE）
- 插件侧调用形态：

```js
await __PLUGIN_API__.proxyFetchStream({
  url: 'https://api.deepseek.com/v1/chat/completions',
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + key },
  body: JSON.stringify({ model, messages, stream: true }),
  timeoutMs: 120000
}, {
  onChunk(chunk) { /* chunk 为 SSE data: 行内容，按需解析 delta */ },
  onError(err) { /* 流中断时回调 */ }
})
```

- 返回的 `Promise<void>` 在流结束后 resolve，出错时 reject
- 权限 `network:cors_proxy`（同 `proxyFetch`）

---

## 插件依赖（dependencies）

插件可在 manifest 声明对其他插件的依赖，支持**必装前置**与**可选前置**。

```json
{
  "id": "top.qomicex.assistant",
  "dependencies": [
    { "id": "top.qomicex.markdown", "version": ">=1.0.0", "optional": false },
    { "id": "top.qomicex.themes", "optional": true }
  ]
}
```

| 字段 | 说明 |
|------|------|
| `id` | 被依赖插件的 manifest id |
| `version` | 版本范围（默认空 = 任意）。支持 `>=x`、`<=x`、`>x`、`<x`、`=x`、精确 `x.y.z`、空格分隔多条件（如 `">=1.0 <2.0"`） |
| `optional` | `true` = 可选前置；默认 `false` = 必装前置 |

**必装前置（optional: false，默认）：**
- 安装时检查：缺失或版本不满足 → 拒绝安装，返回 `PLUGIN_MISSING_DEPENDENCY`(400)
- 启动激活时检查：依赖插件未安装或未启用 → 跳过激活并置为 `disabled`

**可选前置（optional: true）：**
- 安装/激活不强制；仅在依赖插件存在且已启用时，调用方才能调用其提供的方法
- 缺失时调用 `callPlugin` 返回错误，插件本身可正常启用

**激活顺序：** 启动时对被依赖插件先排序激活（`sortByDependencies` 拓扑排序），保证依赖方激活时前置已就绪。

---

## 插件间方法调用（registerMethod / callPlugin）

一个插件可暴露方法供其他插件调用（如 MarkdownLib 提供 `renderMarkdown`）。

**提供方（被依赖插件）：**

```js
// 插件激活后注册方法
__PLUGIN_API__.registerMethod('renderMarkdown', function (md) {
  return marked.parse(md)
})
```

**调用方（依赖插件）：**

```js
const html = await __PLUGIN_API__.callPlugin('top.qomicex.markdown', 'renderMarkdown', '**bold**')
```

- `registerMethod(method, fn)`：注册当前插件提供的方法；插件停用时自动注销
- `callPlugin(pluginId, method, ...args)`：调用目标插件已注册的方法；目标未安装/未激活/未注册 → reject 并提示错误
- 支持跨沙箱 iframe：主窗口 `window.__pluginRegistry` 统一中转，按插件 id 路由到目标 window 本地执行
- 权限：`registerMethod` → `config:write`，`callPlugin` → `network:fetch`

### 依赖插件详细写法

**① 提供方插件 manifest（如 MarkdownLib）：**

```json
{
  "id": "top.qomicex.markdown",
  "name": "MarkdownLib",
  "version": "1.2.0",
  "minLauncherVersion": "0.1.0",
  "layers": ["l2", "l3"],
  "permissions": ["config:write"],
  "entry": { "frontend": "dist/index.html" }
}
```

**② 调用方插件 manifest（如 AI 助手）：**

```json
{
  "id": "top.qomicex.assistant",
  "name": "AI 助手",
  "version": "1.0.0",
  "minLauncherVersion": "0.1.0",
  "layers": ["l2", "l3"],
  "permissions": ["network:fetch", "config:write"],
  "dependencies": [
    { "id": "top.qomicex.markdown", "version": ">=1.0.0" },
    { "id": "top.qomicex.themes", "version": ">=1.0 <2.0", "optional": true }
  ],
  "entry": { "frontend": "dist/index.html" }
}
```

**③ 提供方脚本（dist/index.html）—— 注册方法：**

```html
<!DOCTYPE html>
<html>
<head>
  <script src="https://cdn.jsdelivr.net/npm/marked/marked.min.js"></script>
</head>
<body>
  <div id="root">MarkdownLib 已加载</div>
  <script>
    __PLUGIN_API__.registerMethod('renderMarkdown', function (md) {
      return marked.parse(md || '')
    })

    __PLUGIN_API__.registerMethod('stripHtml', function (html) {
      const div = document.createElement('div')
      div.innerHTML = html
      return div.textContent || ''
    })
  </script>
</body>
</html>
```

**④ 调用方脚本（dist/index.html）—— 调用方法：**

```html
<!DOCTYPE html>
<html>
<body>
  <div id="out"></div>
  <script>
    async function render() {
      try {
        const html = await __PLUGIN_API__.callPlugin('top.qomicex.markdown', 'renderMarkdown', '**加粗** 和 `代码`')
        document.getElementById('out').innerHTML = html
      } catch (e) {
        document.getElementById('out').textContent = '渲染失败: ' + e.message
      }
    }
    render()
  </script>
</body>
</html>
```

**⑤ 异步方法（提供方返回 Promise）：**

```js
// 提供方
__PLUGIN_API__.registerMethod('fetchTranslation', async (text) => {
  const res = await fetch(...)
  return res.json()
})

// 调用方 —— 直接 await
const result = await __PLUGIN_API__.callPlugin('top.qomicex.translator', 'fetchTranslation', 'hello')
```

**⑥ 错误处理：**

| 场景 | 错误信息 |
|------|---------|
| 目标插件未安装 / 未激活 / 方法未注册 | `插件 xxx 未提供方法 yyy（可能未安装或未激活）` |
| 可选前置缺失 | 同上，但插件本身正常启用 |
| 方法内部抛错 | `插件 xxx 方法 yyy 执行失败: <具体错误>` |

调用方应始终 `try/catch`，尤其是可选前置：

```js
if (await __PLUGIN_API__.callPlugin('top.qomicex.themes', 'hasTheme', 'dark')) {
  // 可选依赖存在且方法可用
}
```

**⑦ 完整流程：**

1. 安装 MarkdownLib → 成功（无依赖）
2. 安装 AI 助手 → 后端检查依赖：markdown 已装且 `1.2.0 >= 1.0.0` → 安装成功
3. 启动器启动 → `sortByDependencies` 先激活 MarkdownLib（注册 `renderMarkdown`）→ 再激活 AI 助手
4. AI 助手 `callPlugin('top.qomicex.markdown', 'renderMarkdown', md)` → 主窗口 `__pluginRegistry` 中转 → 返回渲染结果

### WASM 插件调用（callWasm / listWasmPlugins）

L3 WASM 插件由启动器 Rust 网关（wasmtime）加载执行，前端经后端代理调用：

```js
const res = await __PLUGIN_API__.callWasm('dev.example.wasmplugin', 'on_load')
const ids = await __PLUGIN_API__.listWasmPlugins()
```

- 后端代理端点：`GET /api/plugins/wasm`、`GET /api/plugins/wasm/{id}`、`POST /api/plugins/wasm/{id}/invoke`
- 权限：`wasm:execute`
- WASM 插件要求：manifest `layers` 含 `l3` + 包内含 `plugin.wasm`（wasmtime 核心模块）
- Host API（`qomicex` 模块导入）：`log` / `http_fetch` / `instance_list` / `db_set` / `db_get` / `get_plugin_id`
- 详细见对外文档 `qml-docs/plugins/wasm-plugin.md`

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
| 2026-08-01 | v1.1 | 新增插件依赖（dependencies）、插件间方法调用（registerMethod/callPlugin）及详细写法 | AI Agent |
| 2026-08-01 | v1.2 | 新增 WASM 插件调用（callWasm/listWasmPlugins）、layers 示例修正 | AI Agent |

### 2026-08-02 更新
| POST | `/api/plugins/download/start` | 创建下载任务（进入下载中心） |
| GET | `/api/plugins/download/{taskId}/progress` | 查询下载任务进度 |
| GET | `/api/plugins/download/list` | 列出全部下载会话快照 |
| POST | `/api/plugins/download/{taskId}/cancel` | 取消下载任务 |

### 下载管理（download.*）

插件可创建下载任务，任务会自动出现在启动器「下载中心」，进度由 SSE 推送驱动，用户可取消。

```js
// 方式一：指定绝对目标路径
const { taskId } = await __PLUGIN_API__.call('download.addTask', {
  url: 'https://example.com/asset.zip',
  targetPath: 'C:/games/instances/foo/mods/asset.zip',
  extract: true,             // 可选：zip 下载后自动解压并删除原包
  headers: { 'X-Token': 'abc' },  // 可选：自定义请求头
  name: '我的资源'            // 可选：下载中心显示名（默认 fileName）
})

// 方式二：实例 + 类别（自动解析隔离目录，与资源下载一致）
await __PLUGIN_API__.call('download.addTask', {
  url: 'https://.../mod.jar',
  instanceId: 'inst-uuid',
  category: 'mods',          // mods / resourcepacks / shaderpacks / datapacks / saves / screenshots
  fileName: 'mod.jar'
})

// 查询进度（taskId 不存在返回 null）
const snap = await __PLUGIN_API__.call('download.progress', taskId)
// snap: { sessionId, status, progress, speed, currentFile, totalFiles, error, ... }

// 列出全部下载会话
const list = await __PLUGIN_API__.call('download.list')

// 取消
await __PLUGIN_API__.call('download.cancel', taskId)
```

- 权限：`download:manage`
- `addTask` 内部同时写入前端 `downloadStore`（type `'file'`），任务自动出现在下载中心并可取消；完成后状态自动修正
- 后端复用 `DownloadSessionManager`（type `"resource"`），与 mod 下载同一条线

### 注册安装任务（download.registerInstall）

仅在前端下载中心登记一个「游戏安装」任务（type `'game'`），不创建真实下载。

```js
await __PLUGIN_API__.call('download.registerInstall', {
  instanceId: 'inst-uuid',
  name: '我的整合包',
  gameVersion: '1.20.1',
  loader: 'forge',
  loaderVersion: '47.1.0'
})
```
- 权限：`instance:write`
- 场景：插件发起安装后，需要任务出现在下载中心时配合使用

### 整合包一键安装（modpack.install）

直接安装整合包，走**正常整合包安装流程**（复用 `ModpackService` 与 `InstallTracker`，与前端「整合包」页同一管线）：解析来源 → 创建实例 → 下载安装 → 任务进入下载中心。

```js
// 方式一：本地整合包文件（.zip / .mrpack）
const { instanceId } = await __PLUGIN_API__.call('modpack.install', {
  id: 'MyPack',              // 实例名（会同步为版本目录名）
  path: 'C:/packs/pack.zip', // 本地整合包路径
  gameDir: 'C:/games/instances',  // 必传：实例所在根目录
  maxMemory: 8192,           // 可选：默认 4096
  versionIsolation: true     // 可选：版本隔离，默认 false
})

// 方式二：在线整合包（Modrinth / CurseForge / FTB）
const { instanceId } = await __PLUGIN_API__.call('modpack.install', {
  id: 'MyPack',
  type: 'mr',                // mr | cf | ftb（也接受 modrinth/curseforge）
  projectId: 'abc',          // 项目 id
  fileId: '123',             // 版本 id
  gameDir: 'C:/games/instances'
})
```

- 权限：`instance:write`（**警告权限**）
- 参数：`id` 必填（实例名），`gameDir` 必填；`path` 与 `type+projectId+fileId` 二选一
- 走 `POST /api/modpack/install-direct`：后端解析（本地 `ParseFileAsync` / 在线 `ResolveOnlineAsync`）→ 组装 `ModpackInstallRequest` → `InstallAsync`（内部 `InstallTracker.Start`），与前端整合包安装完全同流程
- 返回：`{ instanceId }`（安装异步进行，进度在下载中心 / SSE 查看）
- 错误码：`MODPACK_NAME_REQUIRED`(400)、`MODPACK_GAME_DIR_REQUIRED`(400)、`MODPACK_FILE_NOT_FOUND`(404)、`MODPACK_SOURCE_REQUIRED`(400)、`MODPACK_SOURCE_INVALID`(400)
- 安装任务不会自动出现在下载中心，需要下载进度可配合 `download.registerInstall` 登记




### 2026-08-02 更新
| 2026-08-02 | v1.3 | 新增插件下载管理（download.addTask/progress/cancel/list），权限 download:manage | AI Agent |
| 2026-08-02 | v1.4 | 新增整合包一键安装（modpack.install，权限 instance:write）与下载中心登记（download.registerInstall） | AI Agent |
| 2026-08-02 | v1.5 | 新增文件删除（deleteFile，权限 filesystem:write，授权制） | AI Agent |

