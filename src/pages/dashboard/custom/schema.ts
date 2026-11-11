// Copyright (C) 2026 Qomicex Launcher Contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { convertMultiValue, convertValue, parseBinding, type BindingOptions } from './converters.ts'

// QWidget v2 XML 的白名单、限制与纯函数工具。
// 元素/属性/枚举值统一大驼峰；解析层只做 DOM 遍历，安全判定集中在这里。

export const WIDGET_LIMITS = {
  maxXmlBytes: 256 * 1024,
  maxDepth: 16,
  maxNodes: 1000,
  maxListItems: 200,
  maxDataSources: 8,
  maxDataBytes: 1024 * 1024,
  maxBinaryBytes: 8 * 1024 * 1024,
  maxCacheBytes: 2 * 1024 * 1024,
  maxFileBytes: 256 * 1024,
  updateTtlMs: 6 * 60 * 60 * 1000,
  maxNestedDepth: 5,
  maxNestedInstances: 20,
  maxConverters: 32,
  maxMapEntries: 64,
  maxScriptBytes: 64 * 1024,
  defaultScriptTimeoutMs: 3000,
  maxScriptTimeoutMs: 10000,
  maxCommandOutputBytes: 64 * 1024,
  maxCommandTimeoutMs: 60_000,
  triggerRatePerSecond: 20,
} as const

export const ACTION_NAMES = [
  'Launch',
  'SetDefaultInstance',
  'OpenInstance',
  'Navigate',
  'OpenUrl',
  'OpenFolder',
  'Copy',
  'SelectAccount',
  'Install',
  'Refresh',
  'CallFunction',
  'RunCommand',
  'PluginApi',
  'ShowDialog',
  'HideDialog',
] as const
export type ActionName = (typeof ACTION_NAMES)[number]

export const ACTION_ARGS: Record<ActionName, readonly string[]> = {
  Launch: ['Instance'],
  SetDefaultInstance: ['Instance'],
  OpenInstance: ['Instance'],
  Navigate: ['To'],
  OpenUrl: ['Url'],
  OpenFolder: ['Folder'],
  Copy: ['Value'],
  SelectAccount: [],
  Install: ['ProjectId', 'Source', 'Category'],
  Refresh: [],
  CallFunction: ['Function', 'Arguments'],
  RunCommand: ['Command', 'WorkingDirectory', 'Timeout'],
  PluginApi: ['PluginId', 'Method', 'Arguments'],
  ShowDialog: ['Target'],
  HideDialog: ['Target'],
}

export const ACTION_REQUIRED: Record<ActionName, readonly string[]> = {
  Launch: [],
  SetDefaultInstance: ['Instance'],
  OpenInstance: ['Instance'],
  Navigate: ['To'],
  OpenUrl: ['Url'],
  OpenFolder: ['Folder'],
  Copy: ['Value'],
  SelectAccount: [],
  Install: ['ProjectId', 'Source'],
  Refresh: [],
  CallFunction: ['Function'],
  RunCommand: ['Command'],
  PluginApi: ['PluginId', 'Method'],
  ShowDialog: ['Target'],
  HideDialog: ['Target'],
}

export const NAV_TARGETS = [
  'Instances',
  'Downloads',
  'Accounts',
  'ResourceCenter',
  'Settings',
  'Connect',
  'Running',
] as const
export type NavTarget = (typeof NAV_TARGETS)[number]

export const NAV_PATHS: Record<NavTarget, string> = {
  Instances: '/instances',
  Downloads: '/downloads',
  Accounts: '/accounts',
  ResourceCenter: '/resource-center',
  Settings: '/settings',
  Connect: '/connect',
  Running: '/running',
}

export const FOLDER_TARGETS = ['Game', 'Logs', 'Data', 'Screenshots'] as const
export type FolderTarget = (typeof FOLDER_TARGETS)[number]

export const INSTALL_SOURCES = ['Curseforge', 'Modrinth', 'Ftb'] as const
export const INSTALL_CATEGORIES = ['Mod', 'Modpack', 'Shader', 'Resourcepack', 'Datapack', 'Save'] as const

export const TEXT_SIZES = ['Xs', 'Sm', 'Md', 'Lg', 'Xl', '2Xl'] as const
export const TEXT_WEIGHTS = ['Normal', 'Medium', 'Semibold', 'Bold'] as const
export const TEXT_COLORS = ['Default', 'Muted', 'Primary', 'Destructive'] as const
export const ALIGN_VALUES = ['Start', 'Center', 'End', 'Stretch'] as const
export const JUSTIFY_VALUES = ['Start', 'Center', 'End', 'Between'] as const
export const BUTTON_VARIANTS = ['Default', 'Secondary', 'Outline', 'Ghost', 'Destructive', 'Link'] as const
export const BUTTON_SIZES = ['Sm', 'Md', 'Lg'] as const
export const BACKGROUND_VALUES = ['Transparent', 'Card', 'Muted', 'Primary'] as const
export const RADIUS_VALUES = ['None', 'Sm', 'Md', 'Lg', 'Full'] as const
export const DATA_TYPES = ['Json', 'Text', 'Xml', 'Binary'] as const
export const DATA_SOURCES = ['Url', 'File'] as const
export const MEDIA_TYPES = ['Audio', 'Video'] as const
export const DIALOG_SIZES = ['Sm', 'Md', 'Lg', 'Xl', 'Full'] as const
export const TTL_VALUES = ['Default', 'Immediately', 'PreLaunch', 'PreLoad', 'None'] as const
export type TtlSpec = number | (typeof TTL_VALUES)[number]
export const TRIGGER_EVENTS = ['Loaded', 'DataChanged', 'Click', 'Timer', 'Resize'] as const
export const FIELD_TYPES = ['String', 'Number', 'Bool', 'DateTime', 'Json', 'Binary'] as const
export const CONVERTER_TYPES = [
  'String',
  'Number',
  'Bool',
  'DateTime',
  'Json',
  'Format',
  'Map',
  'BoolToVisibility',
  'Upper',
  'Lower',
  'Join',
  'Script',
] as const
export const ANIMATION_KINDS = ['FadeIn', 'SlideIn', 'ScaleTo', 'RotateTo', 'Pulse', 'Spin'] as const
export const ANIMATION_TRIGGERS = ['Loaded', 'Hover', 'Click'] as const
export const ANIMATION_EASINGS = ['Linear', 'Ease', 'EaseIn', 'EaseOut', 'EaseInOut'] as const

/** 元素 → 允许属性。未知元素/属性一律解析失败。 */
export const ELEMENT_ATTRS: Record<string, readonly string[]> = {
  Widget: ['Name', 'Version', 'Author', 'Description', 'UpdateUrl', 'LauncherVersion', 'UpdateTTL', 'RefreshTTL'],
  'Widget.Inputs': [],
  Input: ['Name', 'Type', 'Required', 'Default'],
  'Widget.Outputs': [],
  Output: ['Name', 'Type', 'Source'],
  'Widget.Converters': [],
  Converters: [],
  Converter: ['Name', 'Type', 'Format'],
  MapEntry: ['From', 'To'],
  Animations: [],
  FadeIn: ['Duration', 'Delay', 'Easing', 'Repeat', 'Trigger', 'From', 'To'],
  SlideIn: ['Duration', 'Delay', 'Easing', 'Repeat', 'Trigger', 'Direction', 'Distance'],
  ScaleTo: ['Duration', 'Delay', 'Easing', 'Repeat', 'Trigger', 'From', 'To'],
  RotateTo: ['Duration', 'Delay', 'Easing', 'Repeat', 'Trigger', 'From', 'To'],
  Pulse: ['Duration', 'Delay', 'Easing', 'Repeat', 'Trigger'],
  Spin: ['Duration', 'Delay', 'Easing', 'Repeat', 'Trigger'],
  Data: ['Name', 'Type', 'Source', 'Url', 'Path', 'Mime', 'Refresh', 'Async'],
  Resources: [],
  String: ['Name', 'Text'],
  Bool: ['Name', 'Text'],
  Number: ['Name', 'Text'],
  Binary: ['Name', 'Mime', 'Text'],
  Resource: ['Name', 'Type', 'Mime', 'Text'],
  Triggers: [],
  Trigger: ['Event', 'Function', 'Action', 'Control', 'Data', 'Interval', 'Once', 'Target', 'Instance', 'To', 'Url', 'Folder', 'Value', 'ProjectId', 'Source', 'Category', 'Command', 'WorkingDirectory', 'Timeout', 'PluginId', 'Method', 'Arguments'],
  Function: ['Name', 'Timeout'],
  ShortcutKey: ['Key'],
  Effects: [],
  ShadowEffect: ['Radius', 'Color', 'OffsetX', 'OffsetY', 'Spread', 'Inset'],
  BlurEffect: ['Radius'],
  OpacityEffect: ['Value'],
  ScaleEffect: ['Value'],
  RotateEffect: ['Angle'],
  Struct: ['Name'],
  Field: ['Name', 'Type'],
  Container: ['Direction', 'Gap', 'Padding', 'Align', 'Justify', 'Border', 'Background', 'Radius', 'Content'],
  Row: ['Gap', 'Padding', 'Align', 'Justify', 'Wrap', 'Content'],
  Column: ['Gap', 'Padding', 'Align', 'Justify', 'Wrap', 'Content'],
  Grid: ['Columns', 'Gap', 'Padding', 'Align', 'Justify', 'Content'],
  Tabs: ['Default', 'Content'],
  TabItem: ['Title', 'Content'],
  List: ['Items', 'As', 'Gap', 'EmptyText', 'Content'],
  ListItem: ['Content'],
  If: ['Test', 'Content'],
  Dialog: ['Name', 'Title', 'Width', 'Size', 'Content'],
  Text: ['Value', 'Size', 'Weight', 'Color', 'Clamp', 'Align'],
  Button: ['Name', 'Text', 'Variant', 'Size', 'OnClick', 'Instance', 'To', 'Url', 'Folder', 'Value', 'ProjectId', 'Source', 'Category', 'Function', 'Arguments', 'Command', 'WorkingDirectory', 'Timeout', 'PluginId', 'Method'],
  Image: ['Src', 'Alt', 'W', 'H', 'Rounded'],
  Media: ['Type', 'Source', 'Controls', 'AutoPlay', 'Loop', 'Poster', 'Volume', 'Muted'],
  TextBox: ['Name', 'Value', 'Placeholder', 'Multiline', 'Password', 'ReadOnly', 'MaxLength', 'OnChange'],
  CheckBox: ['Name', 'Text', 'Checked', 'OnChange'],
  Slider: ['Name', 'Value', 'Min', 'Max', 'Step', 'OnChange'],
  Select: ['Name', 'Value', 'Options', 'OnChange'],
  Progress: ['Value', 'Max'],
  Link: ['Name', 'Text', 'Url', 'OnClick', 'To'],
  FilePicker: ['Name', 'Text', 'Filter', 'Value'],
  ColorPicker: ['Name', 'Value', 'OnChange'],
  Divider: [],
  Spacer: ['Size'],
  Using: ['Name', 'Url', 'As', 'Refresh', 'Arguments'],
}

export const BUTTON_BASE_ATTRS = ['Name', 'Text', 'Variant', 'Size', 'OnClick'] as const
export const LINK_BASE_ATTRS = ['Name', 'Text', 'Url', 'OnClick', 'To'] as const
export const ATTACHED_ATTRS = ['Grid.Row', 'Grid.Column', 'Grid.RowSpan', 'Grid.ColumnSpan'] as const

/** 所有节点通用：Target 供脚本定位，Visible 控制显隐。 */
export const NODE_ATTRS = ['Target', 'Visible', 'When'] as const

export const NODE_TAGS = new Set([
  'Container',
  'Row',
  'Column',
  'Grid',
  'Tabs',
  'TabItem',
  'List',
  'ListItem',
  'If',
  'Text',
  'Button',
  'Image',
  'Media',
  'TextBox',
  'CheckBox',
  'Slider',
  'Select',
  'Progress',
  'Link',
  'FilePicker',
  'ColorPicker',
  'Divider',
  'Spacer',
  'Dialog',
  'Using',
])

/** 属性值补全表：按元素 + 属性；文档和编辑器共用同一份枚举。 */
export const ATTRIBUTE_VALUES: Record<string, Record<string, readonly string[]>> = {
  '*': {
    Visible: ['True', 'False'],
    When: ['Size.Width &lt;= 1', 'Size.Width &gt;= 2', 'Size.PixelWidth &lt; 420'],
    Animations: [],
  },
  Widget: {
    UpdateTTL: TTL_VALUES,
    RefreshTTL: TTL_VALUES,
  },
  Input: {
    Type: FIELD_TYPES,
    Required: ['True', 'False'],
  },
  Converter: {
    Type: CONVERTER_TYPES,
  },
  FadeIn: {
    Trigger: ANIMATION_TRIGGERS,
    Easing: ANIMATION_EASINGS,
  },
  SlideIn: {
    Trigger: ANIMATION_TRIGGERS,
    Easing: ANIMATION_EASINGS,
    Direction: ['Left', 'Right', 'Top', 'Bottom'],
  },
  ScaleTo: {
    Trigger: ANIMATION_TRIGGERS,
    Easing: ANIMATION_EASINGS,
  },
  RotateTo: {
    Trigger: ANIMATION_TRIGGERS,
    Easing: ANIMATION_EASINGS,
  },
  Pulse: {
    Trigger: ANIMATION_TRIGGERS,
    Easing: ANIMATION_EASINGS,
  },
  Spin: {
    Trigger: ANIMATION_TRIGGERS,
    Easing: ANIMATION_EASINGS,
  },
  Output: {
    Type: FIELD_TYPES,
  },
  Data: {
    Type: DATA_TYPES,
    Source: DATA_SOURCES,
    Async: ['True', 'False'],
  },
  Resource: {
    Type: [...FIELD_TYPES, 'Page'],
  },
  Dialog: {
    Width: DIALOG_SIZES,
    Size: DIALOG_SIZES,
  },
  ShadowEffect: {
    Inset: ['True', 'False'],
  },
  Field: {
    Type: FIELD_TYPES,
  },
  Trigger: {
    Event: TRIGGER_EVENTS,
    OnClick: ACTION_NAMES.filter((name) => name !== 'ShowDialog' && name !== 'HideDialog'),
    Action: ACTION_NAMES.filter((name) => name !== 'ShowDialog' && name !== 'HideDialog'),
    To: NAV_TARGETS,
    Folder: FOLDER_TARGETS,
    Source: INSTALL_SOURCES,
    Category: INSTALL_CATEGORIES,
    Once: ['True', 'False'],
  },
  Button: {
    Size: BUTTON_SIZES,
    Variant: BUTTON_VARIANTS,
    OnClick: ACTION_NAMES.filter((name) => name !== 'ShowDialog' && name !== 'HideDialog'),
    To: NAV_TARGETS,
    Folder: FOLDER_TARGETS,
    Source: INSTALL_SOURCES,
    Category: INSTALL_CATEGORIES,
  },
  Link: {
    OnClick: ACTION_NAMES.filter((name) => name !== 'ShowDialog' && name !== 'HideDialog'),
    To: NAV_TARGETS,
  },
  TextBox: {
    Multiline: ['True', 'False'],
    Password: ['True', 'False'],
    ReadOnly: ['True', 'False'],
    OnChange: ACTION_NAMES.filter((name) => name !== 'ShowDialog' && name !== 'HideDialog'),
  },
  CheckBox: {
    Checked: ['True', 'False'],
    OnChange: ACTION_NAMES.filter((name) => name !== 'ShowDialog' && name !== 'HideDialog'),
  },
  Slider: {
    OnChange: ACTION_NAMES.filter((name) => name !== 'ShowDialog' && name !== 'HideDialog'),
  },
  Select: {
    OnChange: ACTION_NAMES.filter((name) => name !== 'ShowDialog' && name !== 'HideDialog'),
  },
  Text: {
    Size: TEXT_SIZES,
    Weight: TEXT_WEIGHTS,
    Color: TEXT_COLORS,
    Align: ALIGN_VALUES,
  },
  Container: {
    Direction: ['Row', 'Column'],
    Align: ALIGN_VALUES,
    Justify: JUSTIFY_VALUES,
    Border: ['True', 'False'],
    Background: BACKGROUND_VALUES,
    Radius: RADIUS_VALUES,
  },
  Row: {
    Align: ALIGN_VALUES,
    Justify: JUSTIFY_VALUES,
    Wrap: ['True', 'False'],
  },
  Column: {
    Align: ALIGN_VALUES,
    Justify: JUSTIFY_VALUES,
    Wrap: ['True', 'False'],
  },
  Grid: {
    Align: ALIGN_VALUES,
    Justify: JUSTIFY_VALUES,
  },
  Image: {
    Rounded: ['True', 'False'],
  },
  Media: {
    Type: MEDIA_TYPES,
    Controls: ['True', 'False'],
    AutoPlay: ['True', 'False'],
    Loop: ['True', 'False'],
    Muted: ['True', 'False'],
  },
}

export function attributeValues(tag: string, attr: string): readonly string[] | undefined {
  return ATTRIBUTE_VALUES[tag]?.[attr] ?? ATTRIBUTE_VALUES['*']?.[attr]
}

/**
 * ContentProperty 映射：标签之间的文本等价于给这个属性赋值。
 * 容器/集合类元素（Container/Row/Grid/Tabs/Resources 等）的内容是子元素，不在表内。
 */
export const CONTENT_PROPERTY: Record<string, string> = {
  Text: 'Value',
  Button: 'Text',
  Link: 'Text',
  CheckBox: 'Text',
  FilePicker: 'Text',
  Media: 'Source',
  Image: 'Src',
  TextBox: 'Value',
  ColorPicker: 'Value',
  Select: 'Options',
  Progress: 'Value',
  Slider: 'Value',
  Spacer: 'Size',
  Data: 'Url',
}

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
  | 'invalidPage'
  | 'listTemplate'
  | 'tabsTemplate'
  | 'listItemRoot'
  | 'duplicateProperty'
  | 'invalidResource'
  | 'invalidTrigger'
  | 'invalidFunction'
  | 'invalidStruct'
  | 'invalidScript'
  | 'invalidConverter'
  | 'invalidAnimation'
  | 'invalidUsing'
  | 'nestedTooDeep'
  | 'nestedCycle'

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
    } else if (typeof current === 'string' && /^\d+$/.test(part)) {
      current = current[Number(part)]
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
function applyBindingToken(token: string, scope: Record<string, unknown>, options: BindingOptions): unknown {
  const binding = parseBinding(`{${token}}`)
  if (!binding) return resolvePath(scope, token)
  const values = binding.paths
    ? binding.paths.map((path) => resolvePath(scope, path))
    : [resolvePath(scope, binding.path ?? '')]
  return binding.paths
    ? convertMultiValue(values, binding.converter, binding.parameter, options, scope)
    : convertValue(values[0], binding.converter, binding.parameter, options, scope)
}

export function interpolate(template: string, scope: unknown, options: BindingOptions = {}): string {
  const root = scope && typeof scope === 'object' ? scope as Record<string, unknown> : {}
  return template.replace(BINDING, (_, token: string) => stringifyBinding(applyBindingToken(token, root, options)))
}

/** JSON/对象参数递归插值：整个值就是一个绑定时保留原始类型。 */
export function interpolateDeep(value: unknown, scope: unknown, options: BindingOptions = {}): unknown {
  if (typeof value === 'string') {
    const binding = parseBinding(value)
    if (binding) {
      const root = scope && typeof scope === 'object' ? scope as Record<string, unknown> : {}
      const values = binding.paths
        ? binding.paths.map((path) => resolvePath(root, path))
        : [resolvePath(root, binding.path ?? '')]
      return binding.paths
        ? convertMultiValue(values, binding.converter, binding.parameter, options, root)
        : convertValue(values[0], binding.converter, binding.parameter, options, root)
    }
    const exact = value.trim().match(/^\{([^{}]+)\}$/s)
    if (exact) return resolvePath(scope, exact[1])
    return interpolate(value, scope, options)
  }
  if (Array.isArray(value)) return value.map((item) => interpolateDeep(item, scope, options))
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value)) out[key] = interpolateDeep(item, scope, options)
    return out
  }
  return value
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

export function parseTtlSpec(raw: string): TtlSpec {
  const value = raw.trim()
  if ((TTL_VALUES as readonly string[]).includes(value)) return value as TtlSpec
  if (/^\d+$/.test(value)) {
    const seconds = Number(value)
    if (seconds <= 86400) return seconds
  }
  throw new WidgetError('invalidAttribute', `TTL=${raw}`)
}

export function validateIdentifier(name: string, label: string): void {
  if (!IDENTIFIER.test(name)) {
    throw new WidgetError('invalidName', `${label}: ${name}`)
  }
}

export function sanitizeAlias(raw: string): string {
  const base = raw.replace(/[^A-Za-z0-9_]/g, '_').replace(/^(\d)/, '_$1')
  return base || 'Child'
}

/** 宽松 semver：1 / 1.2 / 1.2.3 / 1.2.3-beta.1。 */
export function isVersionRequirement(value: string): boolean {
  return /^\d+(\.\d+){0,2}(-[0-9A-Za-z.-]+)?$/.test(value.trim())
}

/** 比较主版本号，返回 <0 / 0 / >0；预发布后缀按字符串比较。 */
export function compareVersions(a: string, b: string): number {
  const parse = (value: string) => {
    const [core, ...rest] = value.trim().split(/[-+]/)
    const nums = core.split('.').map((part) => Number(part) || 0)
    while (nums.length < 3) nums.push(0)
    return { nums, suffix: rest.join('-') }
  }
  const left = parse(a)
  const right = parse(b)
  for (let i = 0; i < 3; i += 1) {
    if (left.nums[i] !== right.nums[i]) return left.nums[i] - right.nums[i]
  }
  if (left.suffix === right.suffix) return 0
  if (!left.suffix) return 1
  if (!right.suffix) return -1
  return left.suffix.localeCompare(right.suffix)
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
  type: (typeof DATA_TYPES)[number]
  source: (typeof DATA_SOURCES)[number]
  url?: string
  path?: string
  mime?: string
  refresh: number
  async: boolean
}

/** 组件会自动出网的目标主机：数据源、更新源、嵌套组件、静态图片/媒体。 */
export function collectAutoHosts(input: {
  datas: DataSourceSpec[]
  updateUrl?: string
  staticMediaUrls: string[]
  nestedUrls: string[]
}): string[] {
  const hosts = new Set<string>()
  for (const data of input.datas) {
    if (data.source !== 'Url' || !data.url) continue
    const host = hostOf(data.url)
    if (host) hosts.add(host)
  }
  if (input.updateUrl) {
    const host = hostOf(input.updateUrl)
    if (host) hosts.add(host)
  }
  for (const url of [...input.staticMediaUrls, ...input.nestedUrls]) {
    if (isBound(url)) continue
    const host = hostOf(url)
    if (host) hosts.add(host)
  }
  return [...hosts].sort()
}

/** 本地文件相对路径解析：绝对路径原样；相对路径基于组件目录或数据目录。 */
export function resolveLocalPath(raw: string, baseDir: string): string {
  const path = raw.trim()
  if (!path) return ''
  if (/^[A-Za-z]:[\\/]/.test(path) || path.startsWith('\\\\') || path.startsWith('/')) return path
  return `${baseDir.replace(/[/\\]+$/, '')}/${path.replace(/^\.\//, '')}`
}
