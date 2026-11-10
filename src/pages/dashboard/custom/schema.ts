// Copyright (C) 2026 Qomicex Launcher Contributors
// SPDX-License-Identifier: GPL-3.0-or-later

// QWidget XML 的白名单、限制与纯函数工具。
// 解析层（xml.ts）只做 DOM 遍历，所有安全判定集中在这里，方便用 node 脚本回归。

export const WIDGET_LIMITS = {
  maxXmlBytes: 64 * 1024,
  maxDepth: 12,
  maxNodes: 500,
  maxListItems: 200,
  maxDataSources: 8,
  maxDataBytes: 512 * 1024,
  maxCacheBytes: 1024 * 1024,
  maxFileBytes: 256 * 1024,
  updateTtlMs: 6 * 60 * 60 * 1000,
} as const

export const ACTION_NAMES = [
  'launch',
  'setDefaultInstance',
  'openInstance',
  'navigate',
  'openUrl',
  'openFolder',
  'copy',
  'selectAccount',
  'install',
  'refresh',
] as const
export type ActionName = (typeof ACTION_NAMES)[number]

export const ACTION_ARGS: Record<ActionName, readonly string[]> = {
  launch: ['instance'],
  setDefaultInstance: ['instance'],
  openInstance: ['instance'],
  navigate: ['to'],
  openUrl: ['url'],
  openFolder: ['target'],
  copy: ['value'],
  selectAccount: [],
  install: ['projectId', 'source', 'category'],
  refresh: [],
}

export const ACTION_REQUIRED: Record<ActionName, readonly string[]> = {
  launch: [],
  setDefaultInstance: ['instance'],
  openInstance: ['instance'],
  navigate: ['to'],
  openUrl: ['url'],
  openFolder: ['target'],
  copy: ['value'],
  selectAccount: [],
  install: ['projectId', 'source'],
  refresh: [],
}

export const NAV_TARGETS = [
  'instances',
  'downloads',
  'accounts',
  'resourceCenter',
  'settings',
  'connect',
  'running',
] as const
export type NavTarget = (typeof NAV_TARGETS)[number]

export const NAV_PATHS: Record<NavTarget, string> = {
  instances: '/instances',
  downloads: '/downloads',
  accounts: '/accounts',
  resourceCenter: '/resource-center',
  settings: '/settings',
  connect: '/connect',
  running: '/running',
}

export const FOLDER_TARGETS = ['game', 'logs', 'data', 'screenshots'] as const
export type FolderTarget = (typeof FOLDER_TARGETS)[number]

export const INSTALL_SOURCES = ['curseforge', 'modrinth', 'ftb'] as const
export const INSTALL_CATEGORIES = ['mod', 'modpack', 'shader', 'resourcepack', 'datapack', 'save'] as const

export const TEXT_SIZES = ['xs', 'sm', 'md', 'lg', 'xl', '2xl'] as const
export const TEXT_WEIGHTS = ['normal', 'medium', 'semibold', 'bold'] as const
export const TEXT_COLORS = ['default', 'muted', 'primary', 'destructive'] as const
export const ALIGN_VALUES = ['start', 'center', 'end', 'stretch'] as const
export const JUSTIFY_VALUES = ['start', 'center', 'end', 'between'] as const
export const BUTTON_VARIANTS = ['default', 'secondary', 'outline', 'ghost', 'destructive', 'link'] as const
export const BUTTON_SIZES = ['sm', 'default', 'lg'] as const
export const BACKGROUND_VALUES = ['transparent', 'card', 'muted', 'primary'] as const
export const RADIUS_VALUES = ['none', 'sm', 'md', 'lg', 'full'] as const

/** 元素 → 允许属性。未知元素/属性一律解析失败（远程 XML 不交给宽松解析）。 */
export const ELEMENT_ATTRS: Record<string, readonly string[]> = {
  Widget: ['name', 'version', 'author', 'description', 'updateUrl'],
  Data: ['name', 'url', 'refresh'],
  Container: ['direction', 'gap', 'padding', 'align', 'justify', 'border', 'background', 'radius'],
  Row: ['gap', 'padding', 'align', 'justify', 'wrap'],
  Column: ['gap', 'padding', 'align', 'justify', 'wrap'],
  Grid: ['columns', 'gap', 'padding', 'align', 'justify'],
  Tabs: ['default'],
  TabItem: ['title'],
  List: ['items', 'as', 'gap', 'emptyText'],
  ListItem: [],
  If: ['test'],
  Text: ['value', 'size', 'weight', 'color', 'clamp', 'align'],
  Button: ['text', 'variant', 'size', 'onClick', 'url', 'to', 'instance', 'target', 'value', 'source', 'projectId', 'category'],
  Image: ['src', 'alt', 'w', 'h', 'rounded'],
  Divider: [],
  Spacer: ['size'],
}

export const BUTTON_BASE_ATTRS = ['text', 'variant', 'size', 'onClick'] as const

export type WidgetErrorCode =
  | 'xmlEmpty'
  | 'xmlTooLarge'
  | 'xmlDoctype'
  | 'xmlInvalid'
  | 'root'
  | 'unknownElement'
  | 'unknownAttribute'
  | 'missingAttribute'
  | 'invalidAttribute'
  | 'textNotAllowed'
  | 'tooDeep'
  | 'tooManyNodes'
  | 'tooManyData'
  | 'duplicateData'
  | 'invalidName'
  | 'invalidAction'
  | 'invalidUrl'
  | 'invalidPath'
  | 'listTemplate'
  | 'tabsTemplate'
  | 'listItemRoot'

export class WidgetError extends Error {
  readonly code: WidgetErrorCode
  readonly detail?: string

  constructor(code: WidgetErrorCode, detail?: string) {
    super(detail ? `${code}: ${detail}` : code)
    this.name = 'WidgetError'
    this.code = code
    this.detail = detail
  }
}

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_-]*$/
const BINDING = /\{([^{}]+)\}/g
const PRIVATE_HOSTS = /^(localhost|.*\.localhost|.*\.local|.*\.internal)$/i

/** 解析 `{a.b.0.c}`，同时兼容不带花括号的直接路径。 */
export function resolvePath(scope: unknown, rawPath: string): unknown {
  const path = rawPath.trim().replace(/^\{(.*)\}$/s, '$1').trim()
  if (!path) return undefined
  let current: unknown = scope
  for (const part of path.split('.')) {
    if (current === null || current === undefined) return undefined
    if (part === '__proto__' || part === 'constructor' || part === 'prototype') return undefined
    if (Array.isArray(current)) {
      if (!/^\d+$/.test(part)) return undefined
      current = current[Number(part)]
    } else if (typeof current === 'object') {
      if (!Object.prototype.hasOwnProperty.call(current, part)) return undefined
      current = (current as Record<string, unknown>)[part]
    } else {
      return undefined
    }
  }
  return current
}

export function stringifyBinding(value: unknown): string {
  if (value === null || value === undefined) return ''
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  try {
    return JSON.stringify(value)
  } catch {
    return ''
  }
}

/** 把 `{path}` 插值成字符串；未命中为空串。 */
export function interpolate(template: string, scope: unknown): string {
  return template.replace(BINDING, (_, token: string) => stringifyBinding(resolvePath(scope, token)))
}

/** 严格 https:443、无用户信息、非本地主机名。私网 IP 由后端再拦一遍。 */
export function isSafeHttpsUrl(raw: string): boolean {
  try {
    const url = new URL(raw.trim())
    return (
      url.protocol === 'https:' &&
      !url.username &&
      !url.password &&
      (url.port === '' || url.port === '443') &&
      !!url.hostname &&
      !PRIVATE_HOSTS.test(url.hostname)
    )
  } catch {
    return false
  }
}

export function hostOf(raw: string): string | null {
  try {
    const url = new URL(raw.trim())
    return url.protocol === 'https:' ? url.hostname.toLowerCase() : null
  } catch {
    return null
  }
}

export function isBound(value: string): boolean {
  return value.includes('{')
}

export function validateIdentifier(name: string, label: string): void {
  if (!IDENTIFIER.test(name)) {
    throw new WidgetError('invalidName', `${label}: ${name}`)
  }
}

/** 远程 XML 的预检：拒绝 DOCTYPE/ENTITY 与超限内容（先于 DOMParser）。 */
export function assertSafeXml(xml: string): void {
  if (!xml.trim()) throw new WidgetError('xmlEmpty')
  if (new TextEncoder().encode(xml).length > WIDGET_LIMITS.maxXmlBytes) {
    throw new WidgetError('xmlTooLarge')
  }
  if (/<!DOCTYPE/i.test(xml) || /<!ENTITY/i.test(xml)) {
    throw new WidgetError('xmlDoctype')
  }
}

export interface DataSourceSpec {
  name: string
  url: string
  refresh: number
}

/** 组件会自动出网的目标主机：数据源、更新源、静态图片。动态图片由运行期白名单拦截。 */
export function collectAutoHosts(input: {
  datas: DataSourceSpec[]
  updateUrl?: string
  staticImageUrls: string[]
}): string[] {
  const hosts = new Set<string>()
  for (const data of input.datas) {
    const host = hostOf(data.url)
    if (host) hosts.add(host)
  }
  if (input.updateUrl) {
    const host = hostOf(input.updateUrl)
    if (host) hosts.add(host)
  }
  for (const src of input.staticImageUrls) {
    if (isBound(src)) continue
    const host = hostOf(src)
    if (host) hosts.add(host)
  }
  return [...hosts].sort()
}
