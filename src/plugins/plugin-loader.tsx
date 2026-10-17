// Copyright (C) 2026 Qomicex Launcher Contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { Tooltip } from '../components/ui/index.ts'
import type { PluginInfo, PluginMenuItem, PluginContributes } from './types.ts'
import { usePluginStore } from '../stores/pluginStore.ts'
import { createSandbox, renderInline, getInstance, getWebviewInstance, registerWebviewInstance, destroyWebviewInstance, convertCssLinks, getFileUrl, createSlotSandbox, destroySlotSandboxes } from './sandbox.ts'
import { initL4Bridge } from './webview-bridge.ts'
import { getL4HostBridge } from './l4-registry.ts'
import { registerSlot, unregisterPluginSlots } from './slots.tsx'
import { getHookRegistry } from './hook-registry.ts'
import { PluginSlot } from './PluginSlot.tsx'
import type { SlotId } from './slots.tsx'
import { NavItem } from '../components/Sidebar.tsx'
import { PluginIcon } from '../components/PluginIcon.tsx'
import { useSidebarExpanded } from '../components/sidebarExpansion.tsx'
import { cn } from '../lib/utils.ts'
import { API_BASE } from '../api/client.ts'
import { reportPluginError } from '../lib/telemetry.ts'
import { registerPluginIconTheme, unregisterPluginIconTheme } from '../theme/index.ts'
import { clearThemeOverride } from '../theme/override.ts'

const activeThemes = new Map<string, HTMLStyleElement>()
const activeFontLinks = new Map<string, HTMLLinkElement[]>()

export function resolvePluginAssetUrl(pluginId: string, icon: string): string {
  if (/^(https?:\/\/|data:)/i.test(icon)) return icon
  if (!/[/.]/.test(icon)) return icon
  return `${API_BASE}/plugins/${encodeURIComponent(pluginId)}/files/${icon.replace(/^\.\//, '')}`
}

function resolveDependencyProblem(plugin: PluginInfo): string | null {
  const deps = plugin.manifest.dependencies ?? []
  if (deps.length === 0) return null
  const { plugins } = usePluginStore.getState()
  for (const dep of deps) {
    if (dep.optional) continue
    const target = plugins.find(p => p.manifest.id === dep.id)
    if (!target) return `缺少必装前置插件 ${dep.id}`
    if (target.state !== 'active') return `前置插件 ${dep.id} 未启用`
    if (dep.version && !satisfiesVersion(target.manifest.version, dep.version))
      return `前置插件 ${dep.id} 版本不满足 ${dep.version}（当前 ${target.manifest.version}）`
  }
  return null
}

function satisfiesVersion(installed: string, range: string): boolean {
  const parts = range.split(' ').filter(Boolean)
  return parts.every(p => satisfiesSingle(installed, p))
}

function satisfiesSingle(installed: string, constraint: string): boolean {
  const cmp = (a: string, b: string) => {
    const pa = (a.split('-')[0].split('+')[0].split('.')).map(Number)
    const pb = (b.split('-')[0].split('+')[0].split('.')).map(Number)
    const len = Math.max(pa.length, pb.length)
    for (let i = 0; i < len; i++) {
      const va = pa[i] ?? 0, vb = pb[i] ?? 0
      if (va !== vb) return va < vb ? -1 : 1
    }
    return 0
  }
  if (constraint.startsWith('>=')) return cmp(installed, constraint.slice(2).trim()) >= 0
  if (constraint.startsWith('<=')) return cmp(installed, constraint.slice(2).trim()) <= 0
  if (constraint.startsWith('>')) return cmp(installed, constraint.slice(1).trim()) > 0
  if (constraint.startsWith('<')) return cmp(installed, constraint.slice(1).trim()) < 0
  if (constraint.startsWith('=')) return cmp(installed, constraint.slice(1).trim()) === 0
  return cmp(installed, constraint) === 0
}

/** l4 渲染判定：manifest.render==='webview' 或 layers 含 l4。 */
function useWebview(plugin: PluginInfo): boolean {
  return plugin.manifest.render === 'webview' || plugin.manifest.layers.includes('l4')
}

/**
 * 是否发布页面入口（`menuItems[].action !== 'overlay'`）。无页面入口的插件是库插件：
 * 用户永远导航不到它的页面，iframe 没有宿主容器，必须在激活时隐藏挂载，否则
 * `srcdoc` 不执行、`registerMethod` 不注册（issue #260）。
 */
function hasPageEntry(plugin: PluginInfo): boolean {
  const items = plugin.manifest.contributes?.menuItems ?? []
  return items.some((item) => item.action !== 'overlay')
}

/**
 * l4 创建去重：label → in-flight Promise<void>。`activatePlugin` 并发调用同一插件时
 * 返回同一个 promise，避免窗口未注册前重复执行生命周期/菜单注入（非原子竞态）。
 */
const pendingWebviews = new Map<string, Promise<void>>()

/**
 * 期望的插件状态（active / disabled）。仅用于消除「激活过程中用户停用」的竞态：
 * 远程窗口创建要 await，期间 `deactivatePlugin` 找不到实例可销毁，创建完成后若无
 * 重新校验，会把已被停用的插件重新注册并置为 active（窗口也跟着留着）。
 */
const desiredState = new Map<string, 'active' | 'disabled'>()

/**
 * l4：把插件托管到独立 Tauri WebviewWindow（独立 renderer 进程）。
 * 加载启动器路由 `/plugins/p/:id?pluginWebview=1`，插件 API 经跨窗口事件桥
 * 代理回主窗口执行（见 webview-bridge.ts）。幂等：窗口已存在则 focus。
 * 非 Tauri（纯浏览器 pnpm dev）降级为同窗口 iframe。
 */
export async function createRemoteWebview(plugin: PluginInfo): Promise<void> {
  const isTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
  if (!isTauri) {
    // 纯浏览器降级：无页面入口的库插件同样需要隐藏挂载，否则降级路径上方法不注册
    createSandbox(plugin, !hasPageEntry(plugin))
    return
  }

  const label = `plugin-webview-${plugin.manifest.id}`

  // 已注册（窗口已创建完成）→ 聚焦即返回
  if (getWebviewInstance(plugin.manifest.id)) {
    try { await (await import('@tauri-apps/api/webviewWindow')).WebviewWindow.getByLabel(label).then(w => w?.setFocus()) } catch { /* ignore */ }
    return
  }

  // 已在创建中 → 等待同一个 promise（原子去重）
  const pending = pendingWebviews.get(label)
  if (pending) return pending

  const { WebviewWindow } = await import('@tauri-apps/api/webviewWindow')
  const existing = await WebviewWindow.getByLabel(label).catch(() => null)
  if (existing) {
    try { await existing.setFocus() } catch { /* ignore */ }
    return
  }

  // 监听器装好之前创建窗口，插件前端抢先发出的 register/call 会没人接收（事件丢弃）
  await initL4Bridge()

  const win = new WebviewWindow(label, {
    // pluginId 必须显式带上：App.tsx 用 `pluginWebview=1&pluginId=<id>` 判定 l4 窗口模式
    // 并把 id 传给 PluginWebviewPage。缺它时该参数是空串，窗口里 fetchPlugin('') 失败，
    // l4 插件页永远加载不出来。
    url: `/plugins/p/${encodeURIComponent(plugin.manifest.id)}?pluginWebview=1&pluginId=${encodeURIComponent(plugin.manifest.id)}`,
    title: plugin.manifest.name,
    width: 1200,
    height: 800,
    minWidth: 480,
    minHeight: 320,
  })

  const created = new Promise<void>((resolve) => {
    win.once('tauri://created', () => {
      pendingWebviews.delete(label)
      // 创建期间用户停用了插件：不能注册实例，直接关窗，避免已停用的插件被重新拉起
      if (desiredState.get(plugin.manifest.id) === 'disabled') {
        console.warn('[plugin] l4 窗口创建完成时插件已被停用，直接关闭', plugin.manifest.id)
        win.close().catch(() => {})
        resolve()
        return
      }
      registerWebviewInstance(plugin.manifest.id, {
        plugin,
        destroy: () => { win.close().catch(() => {}) },
      })
      // 用户手动关闭 l4 窗口 → 清理实例表，避免去重时误判仍存活
      win.once('tauri://destroyed', () => {
        destroyWebviewInstance(plugin.manifest.id)
        // 同时清掉注册表登记：否则 has() 恒为 true，调用被发往已关闭的窗口直到超时
        getL4HostBridge()?.unregisterWindow(plugin.manifest.id)
        // 窗口已消失，期望状态不再有意义（避免与真实状态长期脱节）
        desiredState.delete(plugin.manifest.id)
      })
      resolve()
    })
    win.once('tauri://error', (e) => {
      pendingWebviews.delete(label)
      console.error('[plugin] l4 webview 创建失败，降级为 iframe', plugin.manifest.id, e)
      // 创建期间用户已停用：不能建降级沙箱，也不能清掉停用标记 —— 否则等待中的
      // activatePlugin 会越过停用检查、把插件重新置回 active
      if (desiredState.get(plugin.manifest.id) === 'disabled') {
        resolve()
        return
      }
      if (!getInstance(plugin.manifest.id)) createSandbox(plugin, !hasPageEntry(plugin))
      resolve()
    })
  })
  pendingWebviews.set(label, created)
  return created
}

export async function activatePlugin(plugin: PluginInfo) {
  if (getInstance(plugin.manifest.id)) return

  const problem = resolveDependencyProblem(plugin)
  if (problem) {
    console.warn(`[plugin] 跳过激活 ${plugin.manifest.id}: ${problem}`)
    usePluginStore.getState().setPluginState(plugin.manifest.id, 'disabled')
    return
  }

  // 记录期望状态：远程窗口创建期间的停用请求据此在创建完成后生效
  desiredState.set(plugin.manifest.id, 'active')

  const useSandbox = plugin.manifest.render !== 'inline'
  const useWebviewRender = useWebview(plugin)
  // 库插件（无页面入口）用户永远导航不到，必须激活即隐藏挂载；有页面的插件保持
  // 懒加载，避免启动就执行所有 UI 前端（#260）。
  const hiddenMount = !hasPageEntry(plugin)

  if (plugin.manifest.entry.frontend) {
    try {
      if (useWebviewRender) {
        await createRemoteWebview(plugin)
        // 创建期间被停用：createRemoteWebview 已关窗，这里不能再注册菜单/置 active
        if (desiredState.get(plugin.manifest.id) === 'disabled') return
      } else if (useSandbox) {
        createSandbox(plugin, hiddenMount)
      } else {
        renderInline(plugin)
      }
    } catch (e) {
      console.error(`[plugin] 激活失败 ${plugin.manifest.id}`, e)
      usePluginStore.getState().setPluginState(plugin.manifest.id, 'disabled')
      reportPluginError(plugin.manifest.id, plugin.manifest.version, 'plugin_load_failed')
      throw e
    }

    const { menuItems, overlay, slots } = plugin.manifest.contributes ?? {}
    if (menuItems) {
      for (const item of menuItems) {
        if (item.action === 'overlay' && overlay) {
          registerSlot(
            plugin.manifest.id,
            'sidebar:bottom',
            () => <OverlaySidebarButton pluginId={plugin.manifest.id} item={item} overlay={overlay} />
          )
        } else {
          registerSlot(
            plugin.manifest.id,
            'sidebar:bottom',
            () => <NavItem to={`/plugins/p/${plugin.manifest.id}`} label={item.label} icon={<PluginIcon pluginId={plugin.manifest.id} icon={resolvePluginAssetUrl(plugin.manifest.id, item.icon ?? '')} fallback={item.label[0]} />} />
          )
        }
      }
    }

    // UI 槽位注入：每个 slot 声明一个独立 iframe 沙箱，挂载到主界面对应槽位
    if (slots) {
      for (const slot of slots) {
        if (!slot.file) continue
        try {
          const sandbox = createSlotSandbox(plugin, slot.file)
          registerSlot(
            plugin.manifest.id,
            slot.slot as SlotId,
            () => <PluginSlot slotId={slot.slot} sandbox={sandbox} width={slot.width} height={slot.height} />
          )
        } catch (e) {
          console.error(`[plugin] 槽位 ${slot.slot} 挂载失败 ${plugin.manifest.id}`, e)
        }
      }
    }

    usePluginStore.getState().setPluginState(plugin.manifest.id, 'active')
  }

  if (plugin.manifest.entry.theme) {
    try {
      const res = await fetch(`${API_BASE}/plugins/${plugin.manifest.id}/files/${plugin.manifest.entry.theme}`)
      if (res.ok) {
        const css = await res.text()
        const style = document.createElement('style')
        style.textContent = css
        style.setAttribute('data-plugin-theme', plugin.manifest.id)
        document.head.appendChild(style)
        activeThemes.set(plugin.manifest.id, style)
      }
    } catch { /* theme CSS not available */ }
  }

  // 插件贡献的图标主题（contributes.iconTheme — 包内 icon-theme.json 相对路径）
  const iconThemePath = plugin.manifest.contributes?.iconTheme
  if (iconThemePath) {
    try {
      const res = await fetch(`${API_BASE}/plugins/${plugin.manifest.id}/files/${iconThemePath.replace(/^\.\//, '')}`)
      if (res.ok) {
        const iconRaw = await res.json()
        registerPluginIconTheme(plugin.manifest.id, iconRaw)
      }
    } catch { /* icon theme not available — 保留既有图标渲染 */ }
  }

  // fontLinks 注入（contributes.fontLinks — 字体 CSS/CDN URL）
  // 安全约束：仅允许 ① 包内相对路径（经 resolvePluginAssetUrl 转 /api/plugins/.../files/...）或
  //          ② 显式 https: URL（data:/javascript:/file: 等一律拒绝，防 CSS 全局覆盖/任意网络请求）。
  const fontLinks = (plugin.manifest.contributes?.fontLinks ?? []).filter(
    (href) => typeof href === 'string' && (/^https:\/\//i.test(href) || !/^[a-z][a-z0-9+.-]*:/i.test(href))
  )
  if (fontLinks.length > 0) {
    const els = fontLinks.map((href) => {
      const link = document.createElement('link')
      link.rel = 'stylesheet'
      link.href = resolvePluginAssetUrl(plugin.manifest.id, href)
      link.setAttribute('data-plugin-font', plugin.manifest.id)
      document.head.appendChild(link)
      return link
    })
    activeFontLinks.set(plugin.manifest.id, els)
  }
}

export function deactivatePlugin(pluginId: string) {
  // 先记下期望状态：远程窗口仍在创建时，创建回调据此关窗而不是注册实例
  desiredState.set(pluginId, 'disabled')
  const inst = getInstance(pluginId)
  if (inst) {
    try { inst.destroy() } catch { /* ignore */ }
  }
  destroyWebviewInstance(pluginId)
  // l4 窗口的注册表登记随窗口一起失效：不清掉的话 has() 恒为 true，
  // 后续调用会被发往已关闭的窗口，只能等满超时
  getL4HostBridge()?.unregisterWindow(pluginId)
  destroySlotSandboxes(pluginId)
  unregisterPluginSlots(pluginId)
  unregisterPluginIconTheme(pluginId)
  clearThemeOverride()
  // 注销该插件注册的所有 hook（iframe 侧经主窗口 registry，inline 侧同 registry）
  getHookRegistry().unregisterAll(pluginId)
  const themeStyle = activeThemes.get(pluginId)
  if (themeStyle) {
    themeStyle.remove()
    activeThemes.delete(pluginId)
  }
  const fontEls = activeFontLinks.get(pluginId)
  if (fontEls) {
    fontEls.forEach((el) => el.remove())
    activeFontLinks.delete(pluginId)
  }
  usePluginStore.getState().destroyPluginOverlays(pluginId)
  usePluginStore.getState().setPluginState(pluginId, 'disabled')
}

export function isPluginActive(pluginId: string): boolean {
  return !!getInstance(pluginId)
}

/** 拓扑排序：被依赖插件排前面，保证先激活。无环依赖假定。 */
export function sortByDependencies(plugins: PluginInfo[]): PluginInfo[] {
  const byId = new Map(plugins.map(p => [p.manifest.id, p]))
  const visited = new Set<string>()
  const result: PluginInfo[] = []

  function visit(p: PluginInfo) {
    if (visited.has(p.manifest.id)) return
    visited.add(p.manifest.id)
    for (const dep of p.manifest.dependencies ?? []) {
      if (dep.optional) continue
      const target = byId.get(dep.id)
      if (target) visit(target)
    }
    result.push(p)
  }

  for (const p of plugins) visit(p)
  return result
}

function OverlaySidebarButton({ pluginId, item, overlay }: { pluginId: string; item: PluginMenuItem; overlay: NonNullable<PluginContributes['overlay']> }) {
  const store = usePluginStore()

  const handleClick = async () => {
    const res = await fetch(`${API_BASE}/plugins/${pluginId}/files/${overlay.file}`)
    if (!res.ok) return
    let html = await res.text()
    // 注入 <base href> 指向插件文件服务目录：悬浮窗用 blob URL 渲染，不注入则
    // 相对路径（<script src> 与 JS 模块内部 import）全部解析失败导致白屏。
    // base 注入后所有相对 URL 都会基于插件文件服务解析。
    const dir = overlay.file.split('/').slice(0, -1).join('/')
    const baseHref = `${API_BASE}/plugins/${encodeURIComponent(pluginId)}/files/${dir ? dir + '/' : ''}`
    html = html.replace(/<head>/i, `<head><base href="${baseHref}">`)
    // 悬浮窗渲染时 overlayHtml() 会把 <link rel="stylesheet"> 提取到 head，
    // 而 <base> 标签留在 body（在其后生效）——head 里 CSS 的相对 href 会用 blob base
    // 解析而失败。因此 CSS 必须显式转成插件文件服务的绝对 URL。
    html = convertCssLinks(html, (p) => getFileUrl(pluginId, overlay.file, p))
    store.createOverlay(pluginId, {
      title: overlay.title ?? item.label,
      html,
      width: overlay.width ?? 380,
      height: overlay.height ?? 500,
      minimizable: overlay.minimizable ?? true,
      resizable: overlay.resizable ?? false,
      x: 120,
      y: 80,
    })
  }

  const { expanded } = useSidebarExpanded()

  const button = (
    <button
      onClick={handleClick}
      aria-label={item.label}
      className={cn(
        'relative flex h-11 items-center overflow-hidden rounded-lg text-muted-foreground transition-colors duration-200 anim-transition hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
        expanded ? 'w-full' : 'w-11'
      )}
    >
      <span className="flex h-11 w-11 shrink-0 items-center justify-center text-lg">
        <PluginIcon pluginId={pluginId} icon={resolvePluginAssetUrl(pluginId, item.icon ?? '')} fallback={item.label[0]} />
      </span>
      <span
        aria-hidden
        className={cn(
          'min-w-0 flex-1 truncate whitespace-nowrap text-sm transition-opacity duration-200 anim-transition',
          expanded ? 'opacity-100' : 'opacity-0'
        )}
      >
        {item.label}
      </span>
    </button>
  )

  return (
    <li className="relative flex w-full justify-center">
      {expanded ? button : <Tooltip content={item.label} side="right">{button}</Tooltip>}
    </li>
  )
}
