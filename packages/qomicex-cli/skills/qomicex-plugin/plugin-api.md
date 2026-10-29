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
| | **特权路由需额外权限**（见下方「callBackend 特权路由」） | |
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
| **getSystemInfo** | `call('getSystemInfo') → { Os, Architecture, LauncherVersion, dataDir, ... }` | `system:info` |
| | `dataDir` = 启动器数据目录（插件默认工作区定位用，等价 `callBackend('/settings/data-dir')`） | |
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
| **download.addBatch** | `call('download.addBatch', { files: [{ url, destPath, headers? }], taskId?, stepId?, title? }) → { taskId, totalFiles }` | `download:manage` |
| | 批量下载：一次调用下多个文件、**只占一张卡片**。省略 `taskId` 时自建单步任务（返回 `taskId`）；传 `taskId`+`stepId` 则进度写进已有任务的该步骤。底层与安装管线同一套下载器（并发、去重、镜像回退、`.part` 原子改名） | |
| **task.register** | `call('task.register', { taskId?, title, steps: [{ id, weight?, label? }] }) → { taskId }` | `download:manage` |
| | 注册**由插件自己推进**的分步任务，自动出现在下载中心（与安装任务同款卡片）。`weight` 只影响合成总进度 | |
| **task.update** | `call('task.update', taskId, { stepId?, stepStatus?, stepPercent?, stepLabel?, currentFile?, status?, error?, blockedFiles? })` | `download:manage` |
| | 推进步骤/状态。`stepStatus`: pending \| active \| done \| failed | |
| **task.complete** | `call('task.complete', taskId, error?)` | `download:manage` |
| | 收尾：省略 `error` → completed；传字符串 → failed。`blockedFiles > 0` 时自动转 `awaiting-files` | |
| **task.progress** | `call('task.progress', taskId) → InstallProgress \| null` | `download:manage` |
| **curseforge.files** | `call('curseforge.files', [{ projectId?, fileId }]) → [{ projectId, fileId, fileName, downloadUrl \| null, fileLength, blockedReason? }]` | `network:fetch` |
| | 批量把 CurseForge `projectID:fileID` 换成下载直链。API key 始终留在启动器进程内，插件拿不到。`downloadUrl === null` 表示作者关闭第三方分发（受限文件） | |
| **readArchiveEntry** | `call('readArchiveEntry', archivePath, entryPath, { maxBytes? }) → { content, size } \| null` | `filesystem:read` |
| | 不解压整包，直接读 zip 内单个条目的文本。条目不存在返回 `null`。用于读 `fabric.mod.json` / `META-INF/mods.toml` / `modrinth.index.json` 等元数据 | |
| **modpack.install** | `call('modpack.install', { id, gameDir, path | (type, projectId, fileId), ... }) → { instanceId }` | `instance:write` |
| | 一键安装整合包（本地 zip / mrpack 或在线 Modrinth/CurseForge/FTB） | |
| **（参考实现）整合包一键开服** | 无专用端点——由插件用 `download.addBatch` + `task.*` + `curseforge.files` + `readArchiveEntry` + `extractArchive(prefix)` + `renamePath` + `process.spawn` 自行编排 | 见各方法 |
| | 官方 `top.qomicex.server-manager` 插件是完整范例：解析 mrpack/manifest → 装 vanilla/fabric/forge/neoforge 运行时 → 批量下载 mods（CF 走 `curseforge.files` 换直链，取不到直链的记入受限清单）→ `extractArchive(packPath, dir, { prefix:'overrides', stripPrefix:true })` 释放覆盖 → 扫 jar 元数据把 client-only 移入 `mods-client-only/` → 写 eula/server.properties 与 `{dir}/.qml-server/launch.json`（`{ mode:'argfile'\|'jar', windowsArgfile?, unixArgfile?, jar?, gameVersion, loader }`） | |
| **process.spawn** | `call('process.spawn', { command, args?, cwd?, env? }) → { pid, startedAtMs }` | `process:manage` |
| | 拉起常驻进程（piped stdio、CREATE_NO_WINDOW）。插件只能管理自己 spawn 的进程；stdout/stderr 逐行进环形缓冲（2000 行），按 seq 游标增量拉取 | |
| **process.stdin** | `call('process.stdin', pid, text, { appendNewline? }?)` | `process:manage` |
| | 向进程标准输入写入（默认补 `\n`，交互式控制台命令用） | |
| **process.kill** | `call('process.kill', pid) → { message }` | `process:manage` |
| | 终止整个进程树（taskkill /T /F）；对已退出进程幂等返回 | |
| **process.alive** | `call('process.alive', pid) → { pid, alive, exitCode, ... }` | `process:manage` |
| **process.logs** | `call('process.logs', pid, afterSeq?) → { lines: [{ seq, stream, text }], nextSeq, oldestSeq, alive, exitCode }` | `process:manage` |
| | 游标式增量日志。轮询示例：保存 `nextSeq` 作为下次 `afterSeq`；进程退出后日志保留 10 分钟 | |
| **process.list** | `call('process.list') → snapshot[]` | `process:manage` |
| | 本插件的全部受管进程（插件页重载后凭此找回 pid） | |
| **pickFile** | `call('pickFile', { title?, defaultPath?, filters?: [{ name, extensions }], multiple? }?) → path \| null` | `dialog:open` |
| | 系统文件选择对话框（主窗口 Tauri 中转）；取消/浏览器环境返回 null | |
| **pickDirectory** | `call('pickDirectory', { title?, defaultPath? }?) → path \| null` | `dialog:open` |
| **extractArchive** | `call('extractArchive', archivePath, destPath) → { destPath }` | `filesystem:write` |
| | 本地 zip 解压到目标目录（zip-slip 防护 + 条目/体积上限，复用整合包同款解压器）；压缩包路径需读授权、目标需写授权（一次确认同时授权两个前缀） | |
| **listDir** | `call('listDir', path, { recursive?, maxEntries? }?) → [{ name, path, isDir, size, modifiedMs }]` | `filesystem:read` |
| | 目录列举（目录优先、名称排序）；maxEntries 默认 1000、上限 10000 | |
| **sendNotification** | `call('sendNotification', { title, body? }) → boolean` | `system:notification` |
| | 系统级通知（WebView Notification API，首次触发授权询问）；失败/被拒返回 false，可降级 showToast | |
| **openPluginSettings** | `call('openPluginSettings', targetPluginId?)` | `config:read` |
| | 打开「设置 → 插件 → 插件设置」并定位目标插件 | |
| **registerHook** | `registerHook(method, handler)` | `hook:register` |
| | 洋葱式拦截启动器方法（launchInstance/syncScan/scanVersions/launchInstanceFlow）；manifest 需 `contributes.hooks` 声明 | |
| **onLauncherExit** | `onLauncherExit(callback)` | 无需权限（被动事件） |
| | 启动器关窗前广播（尽力而为、同步、不等待插件）。回调里只做同步快速收尾（保存状态等），不能发新请求 | |
| **getPluginStrings** | `call('getPluginStrings') → Record<string, string>` | 无需权限（自持有数据） |
| | 插件自持 i18n：返回 `l10n/` 目录合并后的字符串包（`bundle.json` 打底、当前 locale 覆盖）。插件运行时 UI 用它渲染自己的文案，不依赖启动器 i18n | |
| **getLocale** | `call('getLocale') → string`（如 `'zh-CN'`） | 无需权限 |
| **getIconSvg** | `call('getIconSvg', 'fa-solid fa-server') → { width, height, path } \| null` | 无需权限 |
| | 内置图标（Font Awesome 类名，与 manifest icon 同一体系）→ SVG path，插件内联 `<svg><path/></svg>` 渲染（currentColor 跟随主题色），不引入图标字体。可用类名 = 启动器 `src/components/BuiltinIcons.tsx` 内置集 | |
| **（事件）plugin:locale-changed** | `window.addEventListener('plugin:locale-changed', e => …)` | 无需权限（被动事件） |
| | 启动器切换语言时向所有插件沙箱广播；插件收到后重拉 `getPluginStrings` 重渲染（与主题跟随对齐）。`e.detail.locale` 为新 locale | |
| **addMenuItem** | `addMenuItem(item: PluginMenuItem)` | `ui:inject_sidebar` |
| | 运行时动态注册侧边栏菜单项，停用时自动移除 | |

## callBackend 特权路由

`callBackend` 只要求 `network:fetch`，但后端有些路由的语义远强于「能发 HTTP 请求」。这些路由按**方法 + 路径**额外校验权限（实现在 `src/plugins/backend-guard.ts`，匹配前会把端点规范成 fetch 实际请求的 pathname，因此 `..` 段、查询串、`_method` 覆盖都绕不过去）：

| 路由 | 方法 | 额外权限 |
|------|------|----------|
| `/plugins/process/*` | 任意 | `process:manage` |
| `/plugins/shell/*` | POST | `shell:execute` |
| `/plugins/files/{id}/{authorize,read,write,delete,extract,list}` | POST | `filesystem:write` |
| `/plugins/{install,install-url,upload}` | POST | `plugin:install` |
| `/plugins/{id}` | DELETE | `plugin:install` |
| `/plugins/{id}/rollback` | POST | `plugin:install` |
| `/plugins/{id}/state` | PUT | `plugin:install` |

用对应方法调这些路由时，manifest 必须同时声明 `network:fetch` 与上表的权限，否则抛 `Permission denied: <endpoint> requires <perm>`。**优先使用专用桥方法**（`process.spawn`、`writeText`、`uploadPlugin`）而不是 `callBackend` —— 专用方法的权限语义更清晰，也不受路由表变动影响。

> 新增特权后端路由时必须同步登记到 `backend-guard.ts` 的 `BACKEND_ROUTE_RULES`，否则该路由对任何持有 `network:fetch` 的插件都是敞开的。`pnpm run test:backend-guard` 会校验规则表。

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