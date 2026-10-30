// Copyright (C) 2026 Qomicex Launcher Contributors
// SPDX-License-Identifier: GPL-3.0-or-later

// 插件自持 i18n（VS Code `l10n/` + `%key%` / Chrome `_locales` + `__MSG_key__`
// 的同型设计）：
//
// - manifest 可声明 `"l10n": "l10n"`（包内目录，相对 .qplugin 根）；
// - 目录内存 `bundle.json`（默认语言）+ `bundle.<locale>.json`（如 zh-CN），
//   值为扁平 `key → string` 映射；
// - manifest 的**显示字符串**用 `%key%` 引用词条，宿主在加载清单时按启动器
//   当前 locale 解析（locale 包缺失的 key 回退默认包，再缺失回退原样输出
//   `%key%`——保持可诊断）；
// - 插件运行时 UI 经桥 `call('getPluginStrings')` 拿合并后的包自行渲染。
//
// 由此：插件贡献给宿主渲染的一切文案（菜单、安装方式、悬浮窗标题、进度标题、
// 步骤标签…）都不再依赖启动器 i18n——那是启动器内置功能的命名空间。

import { API_BASE } from '../api/client.ts'
import { resolveLang } from '../i18n/lang.ts'
import type { PluginManifest } from './types.ts'

/** 启动器当前 locale（如 'zh-CN'；解析失败回退 'en-US'）。 */
export function currentLocale(): string {
  return resolveLang(localStorage.getItem('qomicex-language'))
}

type Bundle = Record<string, string>

const bundleCache = new Map<string, Bundle>()

function fetchJson(url: string): Promise<unknown | null> {
  return fetch(url).then(r => (r.ok ? r.json() : null)).catch(() => null)
}

/**
 * 取插件合并后的字符串包：`bundle.json`（默认）打底、`bundle.<locale>.json`
 * 覆盖。按 (pluginId, locale) 缓存；失败返回空包（所有 %key% 回退原样）。
 */
export async function getPluginBundle(pluginId: string, l10nDir: string, locale: string): Promise<Bundle> {
  const cacheKey = `${pluginId}@${locale}`
  const cached = bundleCache.get(cacheKey)
  if (cached) return cached
  const base = `${API_BASE}/plugins/${encodeURIComponent(pluginId)}/files/${l10nDir.replace(/^\.?\//, '').replace(/\/$/, '')}`
  const [def, loc] = await Promise.all([
    fetchJson(`${base}/bundle.json`),
    locale ? fetchJson(`${base}/bundle.${locale}.json`) : null,
  ])
  const merged: Bundle = {
    ...((def && typeof def === 'object' ? def : {}) as Bundle),
    ...((loc && typeof loc === 'object' ? loc : {}) as Bundle),
  }
  // 两包都读取失败（网络/文件缺失）时不缓存空对象——否则后续调用永远命中
  // 空缓存，%key% 原样显示直到重载。任一包成功才缓存。
  if (def !== null || loc !== null) bundleCache.set(cacheKey, merged)
  return merged
}

/** 清空插件字符串包缓存（重装/重扫后调用，避免读到旧包）。 */
export function invalidatePluginL10n(pluginId?: string) {
  if (!pluginId) {
    bundleCache.clear()
    return
  }
  for (const key of [...bundleCache.keys()]) {
    if (key.startsWith(`${pluginId}@`)) bundleCache.delete(key)
  }
}

/** `%key%` → 词条；非模板值原样返回。缺 key 回退原样（可诊断）。 */
export function resolveTemplate(value: string, bundle: Bundle): string {
  const m = /^%([A-Za-z0-9_.-]+)%$/.exec(value.trim())
  if (!m) return value
  return bundle[m[1]] ?? value
}

/**
 * 解析 manifest 中的 `%key%` 显示字符串。
 *
 * **只解析显示字段**（name / menuItems[].label / installModes[].label+description /
 * overlay.title），其余字段——尤其 `permissions`、`id`、路由路径——保持原值：
 * 运行时权限检查（executePluginMethod）与插件加载器（路由/资源 URL）都消费
 * 解析后的 manifest，整树递归会让 `"permissions": ["%p%"]` 经词条获得提权。
 */
export async function resolveManifestL10n(manifest: PluginManifest, locale = currentLocale()): Promise<PluginManifest> {
  const dir = manifest.l10n?.trim()
  if (!dir) return manifest
  const bundle = await getPluginBundle(manifest.id, dir, locale)
  if (Object.keys(bundle).length === 0) return manifest
  const t = (s: string | undefined) => (s === undefined ? s : resolveTemplate(s, bundle))
  const c = manifest.contributes
  return {
    ...manifest,
    name: resolveTemplate(manifest.name, bundle),
    contributes: c && {
      ...c,
      menuItems: c.menuItems?.map(m => ({ ...m, label: resolveTemplate(m.label, bundle) })),
      installModes: c.installModes?.map(m => ({
        ...m,
        label: resolveTemplate(m.label, bundle),
        description: t(m.description),
      })),
      overlay: c.overlay && { ...c.overlay, title: t(c.overlay.title) },
    },
  }
}

/** 语言切换后重解析 store 里声明了 l10n 的清单（侧栏新渲染、安装方式对话框
 * 等消费方下次读取即新语言）。注意：已注册的侧栏槽位捕获了旧 label 字符串，
 * 需插件重新激活（重启启动器/停用再启用）才完全切换——与主流生态一致。 */
export async function retranslateStoreManifests() {
  const { usePluginStore } = await import('../stores/pluginStore.ts')
  const plugins = usePluginStore.getState().plugins
  const updates = await Promise.all(
    plugins
      .filter(p => p.manifest.l10n)
      // 必须从 rawManifest 重新解析：manifest 里已是旧语言文案（不含 %key%），
      // 再解析一次不会恢复模板，语言切换会继续显示旧文案。
      .map(async p => ({
        id: p.manifest.id,
        manifest: await resolveManifestL10n(p.rawManifest ?? p.manifest),
      })),
  )
  if (updates.length === 0) return
  const byId = new Map(updates.map(u => [u.id, u.manifest] as const))
  usePluginStore.setState(s => ({
    plugins: s.plugins.map(p => {
      const m = byId.get(p.manifest.id)
      return m ? { ...p, manifest: m } : p
    }),
  }))
}
