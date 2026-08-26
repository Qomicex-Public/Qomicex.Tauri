import { Tooltip } from '../components/ui/index.ts'
import type { PluginInfo, PluginMenuItem, PluginContributes } from './types.ts'
import { usePluginStore } from '../stores/pluginStore.ts'
import { createSandbox, renderInline, getInstance, getWebviewInstance, registerWebviewInstance, destroyWebviewInstance } from './sandbox.ts'
import { initL4Bridge } from './webview-bridge.ts'
import { registerSlot, unregisterPluginSlots } from './slots.tsx'
import { NavItem } from '../components/Sidebar.tsx'
import { PluginIcon } from '../components/PluginIcon.tsx'
import { API_BASE } from '../api/client.ts'
import { reportPluginError } from '../lib/telemetry.ts'
import { registerPluginIconTheme, unregisterPluginIconTheme } from '../theme/index.ts'

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
 * l4 创建去重：label → in-flight Promise<void>。`activatePlugin` 并发调用同一插件时
 * 返回同一个 promise，避免窗口未注册前重复执行生命周期/菜单注入（非原子竞态）。
 */
const pendingWebviews = new Map<string, Promise<void>>()

/**
 * l4：把插件托管到独立 Tauri WebviewWindow（独立 renderer 进程）。
 * 加载启动器路由 `/plugins/p/:id?pluginWebview=1`，插件 API 经跨窗口事件桥
 * 代理回主窗口执行（见 webview-bridge.ts）。幂等：窗口已存在则 focus。
 * 非 Tauri（纯浏览器 pnpm dev）降级为同窗口 iframe。
 */
export async function createRemoteWebview(plugin: PluginInfo): Promise<void> {
  const isTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
  if (!isTauri) {
    createSandbox(plugin)
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

  initL4Bridge()

  const win = new WebviewWindow(label, {
    url: `/plugins/p/${encodeURIComponent(plugin.manifest.id)}?pluginWebview=1`,
    title: plugin.manifest.name,
    width: 1200,
    height: 800,
    minWidth: 480,
    minHeight: 320,
  })

  const created = new Promise<void>((resolve) => {
    win.once('tauri://created', () => {
      pendingWebviews.delete(label)
      registerWebviewInstance(plugin.manifest.id, {
        plugin,
        destroy: () => { win.close().catch(() => {}) },
      })
      // 用户手动关闭 l4 窗口 → 清理实例表，避免去重时误判仍存活
      win.once('tauri://destroyed', () => destroyWebviewInstance(plugin.manifest.id))
      resolve()
    })
    win.once('tauri://error', (e) => {
      pendingWebviews.delete(label)
      console.error('[plugin] l4 webview 创建失败，降级为 iframe', plugin.manifest.id, e)
      if (!getInstance(plugin.manifest.id)) createSandbox(plugin)
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

  const useSandbox = plugin.manifest.render !== 'inline'
  const useWebviewRender = useWebview(plugin)

  if (plugin.manifest.entry.frontend) {
    try {
      if (useWebviewRender) {
        await createRemoteWebview(plugin)
      } else if (useSandbox) {
        createSandbox(plugin)
      } else {
        renderInline(plugin)
      }
    } catch (e) {
      console.error(`[plugin] 激活失败 ${plugin.manifest.id}`, e)
      usePluginStore.getState().setPluginState(plugin.manifest.id, 'disabled')
      reportPluginError(plugin.manifest.id, plugin.manifest.version, 'plugin_load_failed')
      throw e
    }

    const { menuItems, overlay } = plugin.manifest.contributes ?? {}
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
  const inst = getInstance(pluginId)
  if (inst) {
    try { inst.destroy() } catch { /* ignore */ }
  }
  destroyWebviewInstance(pluginId)
  unregisterPluginSlots(pluginId)
  unregisterPluginIconTheme(pluginId)
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
    const html = await res.text()
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

  return (
    <li className="w-full flex justify-center relative">
      <Tooltip content={item.label} side="right">
        <button
          onClick={handleClick}
          className="flex h-11 w-11 items-center justify-center rounded-lg text-lg transition-all duration-200 text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          <PluginIcon pluginId={pluginId} icon={resolvePluginAssetUrl(pluginId, item.icon ?? '')} fallback={item.label[0]} />
        </button>
      </Tooltip>
    </li>
  )
}
