# 桥 API 签名速查

插件脚本通过全局 `window.__PLUGIN_API__` 与启动器交互。L2 iframe 沙箱 / 内联渲染均可用；独立 `pnpm dev`（浏览器直开）时优雅降级为 `null`。

完整文档见 `D:\docs\docs\plugins\plugin-api.md`（启动器公开文档，内容更全含完整示例与错误码）。

## 全局变量

| 变量 | 说明 |
|------|------|
| `window.__PLUGIN_API__` | 桥 API 对象（`null` = 浏览器直开，优雅降级） |
| `window.__PLUGIN_API_BASE__` | L2 沙箱内自动注入，值为 `http://localhost:5000/api/plugins/{id}/files`，用于拼包内资源地址 |
| `window.__PLUGIN_ID__` | 当前插件 id |

## 调用方式

```ts
const api = window.__PLUGIN_API__

// ① 通用 call（绝大多数方法）
const data = await api.call('getSettings')

// ② 3 个专用快捷方式
api.registerMethod('name', fn)                          // 注册方法
await api.callPlugin('id', 'method', ...args)            // 调用其他插件方法
await api.proxyFetchStream(req, { onChunk, onError })   // 流式请求
```

## 方法签名速查

| 方法 | 签名 | 所需权限 |
|------|------|----------|
| **getSettings** | `call('getSettings') → Record<string, unknown>` | `config:read` |
| **setSettings** | `call('setSettings', key, value)` | `config:write` |
| **setCache** | `call('setCache', key, value, ttlSeconds?)` | `cache:access` |
| **getCache** | `call('getCache', key) → any \| null` | `cache:access` |
| **callBackend** | `call('callBackend', endpoint, data?) → any` | `network:fetch` |
| | 有 data → POST；无 data → GET。data 可传 `_method` 覆盖 HTTP 方法 | |
| **proxyFetch** | `call('proxyFetch', { url, method?, headers?, body?, timeoutMs? }) → { status, headers, body?, bodyBase64? }` | `network:cors_proxy` |
| | SSRF 防护：仅 http/https，禁止内网地址 | |
| **proxyFetchStream** | `proxyFetchStream(req, { onChunk, onError })` | `network:cors_proxy` |
| | 消费 SSE 流，逐块回调。`req.signal` 可传 AbortSignal 中断 | |
| **registerMethod** | `registerMethod(name, fn)` | `config:write` |
| | 注册方法到全局注册表，供其他插件 `callPlugin` 调用。插件停用时自动注销 | |
| **callPlugin** | `callPlugin(pluginId, method, ...args) → any` | `network:fetch` |
| | 目标未安装/未激活/未注册方法 → reject | |
| **callWasm** | `call('callWasm', pluginId, exportName?) → { ok, result }` | `wasm:execute` |
| | 调用 L3 WASM 插件导出函数，缺省 `on_load` | |
| **listWasmPlugins** | `call('listWasmPlugins') → string[]` | `wasm:execute` |
| **readText** | `call('readText', path, options?) → { path, content }` | `filesystem:read` |
| | `options: { start?, length? }`。授权制（首次访问用户弹窗确认） | |
| **readBytes** | `call('readBytes', path, options?) → { path, contentBase64 }` | `filesystem:read` |
| | 同 readText 授权制 | |
| **writeText** | `call('writeText', path, content) → { path }` | `filesystem:write` |
| | 授权制，自动创建父目录 | |
| **writeBytes** | `call('writeBytes', path, bytes: Uint8Array) → { path }` | `filesystem:write` |
| | 授权制，自动创建父目录 | |
| **deleteFile** | `call('deleteFile', path) → { path }` | `filesystem:write` |
| | 仅文件不支持目录；授权制 | |
| **execCommand** | `call('execCommand', command, timeoutMs?) → { exitCode, stdout, stderr }` | `shell:execute` |
| | Windows → powershell，Unix → /bin/sh。默认超时 15s，范围 1-120s | |
| **getSystemInfo** | `call('getSystemInfo') → { Os, Architecture, LauncherVersion, ... }` | `system:info` |
| **openUrl** | `call('openUrl', url)` | `system:notification` |
| | 仅 http/https，沙箱内 window.open 被拦时应使用 | |
| **listPlugins** | `call('listPlugins') → [{ id, name, version, status }]` | `plugin:list` |
| **uploadPlugin** | `call('uploadPlugin', fileData: number[], fileName)` | `plugin:install` |
| | 安装 .qplugin 包 | |
| **navigate** | `call('navigate', path)` | `config:read` |
| | 跳转启动器内部路由，勿用外部 URL | |
| **showToast** | `call('showToast', message, type?)` | `ui:toast` |
| | `type: 'info' \| 'error' \| 'success'`，默认 info | |
| **log** | `call('log', message, level?)` | `plugin:log` |
| | 写日志到启动器 trace 体系（`qomicex debug` 实时可见，诊断导出含）；`level: 'debug' \| 'info' \| 'warn' \| 'error'` 默认 info | |
| **overlay.create** | `call('overlay.create', { title?, html, x?, y?, width?, height?, minimizable?, resizable? }) → overlayId` | `ui:sub_window` |
| **overlay.show/hide/destroy** | `call('overlay.show/hide/destroy', overlayId)` | `ui:sub_window` |
| **overlay.setHtml** | `call('overlay.setHtml', overlayId, html)` | `ui:sub_window` |
| **overlay.setPosition** | `call('overlay.setPosition', overlayId, x, y)` | `ui:sub_window` |
| **download.addTask** | `call('download.addTask', { url, targetPath \| (instanceId, category, fileName), ... }) → { taskId }` | `download:manage` |
| | 支持实例+类别自动解析隔离目录。`extract: true` 下载后自动解压 zip | |
| **download.progress** | `call('download.progress', taskId) → snapshot \| null` | `download:manage` |
| **download.cancel** | `call('download.cancel', taskId)` | `download:manage` |
| **download.list** | `call('download.list') → snapshot[]` | `download:manage` |
| **download.registerInstall** | `call('download.registerInstall', { instanceId, name, gameVersion, loader, loaderVersion })` | `instance:write` |
| | 仅登记安装任务到下载中心，不创建真实下载 | |
| **modpack.install** | `call('modpack.install', { id, gameDir, path | (type, projectId, fileId), ... }) → { instanceId }` | `instance:write` |
| | 一键安装整合包（本地 zip / mrpack 或在线 Modrinth/CurseForge/FTB） | |
| **addMenuItem** | `addMenuItem(item: PluginMenuItem)` | 无需权限 |
| | 运行时动态注册侧边栏菜单项，停用时自动移除 | |

## error 处理

```ts
try {
  await api.call('getSettings')
} catch (e) {
  console.error(e.message)
  // 常见错误:
  // "Permission denied: requires xxx" —— manifest 权限未包含
  // "Backend error: 404" —— callBackend 端点不存在
  // "Proxy failed: 400" —— proxyFetch 参数错误（含 SSRF 拦截）
  // "插件 xxx 未提供方法 yyy" —— callPlugin 目标不可用
}
```

## 文件拖放事件

主窗口广播 `file-drop` 事件（`DragDrop::Drop` 触发），payload = 文件绝对路径数组。沙箱插件需经主界面中转：主界面监听后 `callPlugin(pluginId, method, paths)` 转发。

## 模板 api.ts

模板项目 `src/api.ts` 提供了 `getApi()` 和 `getPluginId()` 辅助函数（使用 `window.__PLUGIN_API__` / `window.__PLUGIN_ID__`）：
```ts
import { getApi, getPluginId } from './api.ts'
const api = getApi()  // null if browser direct
```