// Copyright (C) 2026 Qomicex Launcher Contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import {
  ACTION_ARGS,
  ACTION_NAMES,
  ACTION_REQUIRED,
  BUTTON_BASE_ATTRS,
  ELEMENT_ATTRS,
  FOLDER_TARGETS,
  INSTALL_CATEGORIES,
  INSTALL_SOURCES,
  NAV_TARGETS,
  WIDGET_LIMITS,
  WidgetError,
  assertSafeXml,
  isBound,
  isSafeHttpsUrl,
  validateIdentifier,
  type ActionName,
  type DataSourceSpec,
} from './schema.ts'
import type {
  ButtonNode,
  ColumnNode,
  ContainerNode,
  GridNode,
  IfNode,
  ImageNode,
  ListItemNode,
  ListNode,
  RowNode,
  SpacerNode,
  TabItemNode,
  TabsNode,
  TextNode,
  WidgetDocument,
  WidgetNode,
} from './types.ts'

interface ParseCtx {
  nodes: number
  datas: DataSourceSpec[]
  dataNames: Set<string>
  staticImageUrls: string[]
}

function attr(el: Element, name: string): string | undefined {
  return el.hasAttribute(name) ? (el.getAttribute(name) ?? '') : undefined
}

function requiredAttr(el: Element, name: string): string {
  const value = attr(el, name)
  if (value === undefined || value.trim() === '') {
    throw new WidgetError('missingAttribute', `${el.tagName}@${name}`)
  }
  return value
}

function intAttr(el: Element, name: string, min: number, max: number, fallback?: number): number {
  const raw = attr(el, name)
  if (raw === undefined) {
    if (fallback !== undefined) return fallback
    throw new WidgetError('missingAttribute', `${el.tagName}@${name}`)
  }
  const value = Number(raw)
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new WidgetError('invalidAttribute', `${el.tagName}@${name}=${raw}`)
  }
  return value
}

function boolAttr(el: Element, name: string, fallback: boolean): boolean {
  const raw = attr(el, name)
  if (raw === undefined) return fallback
  if (raw === 'true') return true
  if (raw === 'false') return false
  throw new WidgetError('invalidAttribute', `${el.tagName}@${name}=${raw}`)
}

function enumAttr<T extends string>(
  el: Element,
  name: string,
  allowed: readonly T[],
  fallback?: T,
): T | undefined {
  const raw = attr(el, name)
  if (raw === undefined) return fallback
  if (!(allowed as readonly string[]).includes(raw)) {
    throw new WidgetError('invalidAttribute', `${el.tagName}@${name}=${raw}`)
  }
  return raw as T
}

function validateAttrs(el: Element, extra: readonly string[] = []): void {
  const allowed = new Set([...(ELEMENT_ATTRS[el.tagName] ?? []), ...extra])
  for (const attribute of Array.from(el.attributes)) {
    if (!allowed.has(attribute.name)) {
      throw new WidgetError('unknownAttribute', `${el.tagName}@${attribute.name}`)
    }
  }
}

function assertNoText(el: Element): void {
  for (const child of Array.from(el.childNodes)) {
    if (child.nodeType === 3 && child.textContent?.trim()) {
      throw new WidgetError('textNotAllowed', el.tagName)
    }
  }
}

function validateStaticUrl(value: string, label: string): void {
  if (!isBound(value) && !isSafeHttpsUrl(value)) {
    throw new WidgetError('invalidUrl', `${label}=${value}`)
  }
}

function validatePath(value: string, label: string): string {
  const path = value.trim().replace(/^\{(.*)\}$/s, '$1').trim()
  if (!path || !/^[A-Za-z0-9_.-]+$/.test(path)) {
    throw new WidgetError('invalidPath', `${label}=${value}`)
  }
  return path
}

function parseData(el: Element, ctx: ParseCtx): void {
  validateAttrs(el)
  if (ctx.datas.length >= WIDGET_LIMITS.maxDataSources) {
    throw new WidgetError('tooManyData')
  }
  const name = attr(el, 'name')?.trim() || 'data'
  validateIdentifier(name, 'Data@name')
  if (ctx.dataNames.has(name)) {
    throw new WidgetError('duplicateData', name)
  }
  const url = requiredAttr(el, 'url')
  validateStaticUrl(url, 'Data@url')
  if (!isSafeHttpsUrl(url)) {
    throw new WidgetError('invalidUrl', `Data@url=${url}`)
  }
  ctx.datas.push({
    name,
    url,
    refresh: intAttr(el, 'refresh', 60, 86400, 3600),
  })
  ctx.dataNames.add(name)
}

function parseChildren(el: Element, ctx: ParseCtx, depth: number): WidgetNode[] {
  if (depth > WIDGET_LIMITS.maxDepth) {
    throw new WidgetError('tooDeep', el.tagName)
  }
  assertNoText(el)
  const nodes: WidgetNode[] = []
  for (const child of Array.from(el.children)) {
    ctx.nodes += 1
    if (ctx.nodes > WIDGET_LIMITS.maxNodes) {
      throw new WidgetError('tooManyNodes')
    }
    if (child.tagName === 'Data') {
      parseData(child, ctx)
      continue
    }
    nodes.push(parseNode(child, ctx, depth))
  }
  return nodes
}

function parseNode(el: Element, ctx: ParseCtx, depth: number): WidgetNode {
  switch (el.tagName) {
    case 'Container':
      return parseContainer(el, ctx, depth)
    case 'Row':
    case 'Column':
      return parseRowColumn(el, ctx, depth)
    case 'Grid':
      return parseGrid(el, ctx, depth)
    case 'Tabs':
      return parseTabs(el, ctx, depth)
    case 'TabItem':
      throw new WidgetError('tabsTemplate', 'TabItem 只能作为 Tabs 的直接子元素')
    case 'List':
      return parseList(el, ctx, depth)
    case 'ListItem':
      throw new WidgetError('listTemplate', 'ListItem 只能作为 List 的直接子元素')
    case 'If':
      return parseIf(el, ctx, depth)
    case 'Text':
      return parseText(el)
    case 'Button':
      return parseButton(el)
    case 'Image':
      return parseImage(el, ctx)
    case 'Divider':
      validateAttrs(el)
      return { kind: 'divider' }
    case 'Spacer':
      validateAttrs(el)
      return { kind: 'spacer', size: intAttr(el, 'size', 0, 48, 8) } satisfies SpacerNode
    case 'Widget':
      throw new WidgetError('root', 'Widget 不能嵌套')
    default:
      throw new WidgetError('unknownElement', el.tagName)
  }
}

function parseContainer(el: Element, ctx: ParseCtx, depth: number): ContainerNode {
  validateAttrs(el)
  return {
    kind: 'container',
    direction: enumAttr(el, 'direction', ['row', 'column'] as const, 'column')!,
    border: boolAttr(el, 'border', true),
    background: enumAttr(el, 'background', ['transparent', 'card', 'muted', 'primary'] as const, 'card')!,
    radius: enumAttr(el, 'radius', ['none', 'sm', 'md', 'lg', 'full'] as const, 'lg')!,
    gap: intAttr(el, 'gap', 0, 8, 0),
    padding: intAttr(el, 'padding', 0, 8, 0),
    align: enumAttr(el, 'align', ['start', 'center', 'end', 'stretch'] as const),
    justify: enumAttr(el, 'justify', ['start', 'center', 'end', 'between'] as const),
    children: parseChildren(el, ctx, depth + 1),
  }
}

function parseRowColumn(el: Element, ctx: ParseCtx, depth: number): RowNode | ColumnNode {
  validateAttrs(el)
  const common = {
    gap: intAttr(el, 'gap', 0, 8, 0),
    padding: intAttr(el, 'padding', 0, 8, 0),
    align: enumAttr(el, 'align', ['start', 'center', 'end', 'stretch'] as const),
    justify: enumAttr(el, 'justify', ['start', 'center', 'end', 'between'] as const),
    wrap: boolAttr(el, 'wrap', false),
    children: parseChildren(el, ctx, depth + 1),
  }
  return el.tagName === 'Row' ? { kind: 'row', ...common } : { kind: 'column', ...common }
}

function parseGrid(el: Element, ctx: ParseCtx, depth: number): GridNode {
  validateAttrs(el)
  return {
    kind: 'grid',
    columns: intAttr(el, 'columns', 1, 6),
    gap: intAttr(el, 'gap', 0, 8, 0),
    padding: intAttr(el, 'padding', 0, 8, 0),
    align: enumAttr(el, 'align', ['start', 'center', 'end', 'stretch'] as const),
    justify: enumAttr(el, 'justify', ['start', 'center', 'end', 'between'] as const),
    children: parseChildren(el, ctx, depth + 1),
  }
}

function parseTabs(el: Element, ctx: ParseCtx, depth: number): TabsNode {
  validateAttrs(el)
  assertNoText(el)
  if (depth + 1 > WIDGET_LIMITS.maxDepth) throw new WidgetError('tooDeep', el.tagName)
  const children: TabItemNode[] = []
  for (const child of Array.from(el.children)) {
    ctx.nodes += 1
    if (ctx.nodes > WIDGET_LIMITS.maxNodes) throw new WidgetError('tooManyNodes')
    if (child.tagName !== 'TabItem') {
      throw new WidgetError('tabsTemplate', `Tabs 内不允许 ${child.tagName}`)
    }
    validateAttrs(child)
    const title = requiredAttr(child, 'title')
    children.push({
      kind: 'tabItem',
      title,
      children: parseChildren(child, ctx, depth + 2),
    })
  }
  if (children.length === 0) throw new WidgetError('tabsTemplate', 'Tabs 至少需要一个 TabItem')
  const defaultIndex = intAttr(el, 'default', 0, children.length - 1, 0)
  return { kind: 'tabs', defaultIndex, children }
}

function parseList(el: Element, ctx: ParseCtx, depth: number): ListNode {
  validateAttrs(el)
  if (depth + 1 > WIDGET_LIMITS.maxDepth) throw new WidgetError('tooDeep', el.tagName)
  const items = validatePath(requiredAttr(el, 'items'), 'List@items')
  const as = attr(el, 'as')?.trim() || 'item'
  validateIdentifier(as, 'List@as')

  const itemEls = Array.from(el.children)
  if (itemEls.length !== 1 || itemEls[0].tagName !== 'ListItem') {
    throw new WidgetError('listTemplate', 'List 必须且只能包含一个 ListItem')
  }
  assertNoText(el)
  const itemEl = itemEls[0]
  validateAttrs(itemEl)
  const itemChildren = Array.from(itemEl.children)
  if (itemChildren.length !== 1) {
    throw new WidgetError('listItemRoot', 'ListItem 必须且只能包含一个根元素')
  }
  assertNoText(itemEl)
  ctx.nodes += 1
  const item: ListItemNode = {
    kind: 'listItem',
    child: parseNode(itemChildren[0], ctx, depth + 2),
  }
  return {
    kind: 'list',
    items,
    as,
    gap: intAttr(el, 'gap', 0, 8, 0),
    emptyText: attr(el, 'emptyText') || undefined,
    item,
  }
}

function parseIf(el: Element, ctx: ParseCtx, depth: number): IfNode {
  validateAttrs(el)
  const test = validatePath(requiredAttr(el, 'test'), 'If@test')
  return {
    kind: 'if',
    test,
    children: parseChildren(el, ctx, depth + 1),
  }
}

function parseText(el: Element): TextNode {  validateAttrs(el)
  return {
    kind: 'text',
    value: requiredAttr(el, 'value'),
    size: enumAttr(el, 'size', ['xs', 'sm', 'md', 'lg', 'xl', '2xl'] as const, 'md')!,
    weight: enumAttr(el, 'weight', ['normal', 'medium', 'semibold', 'bold'] as const, 'normal')!,
    color: enumAttr(el, 'color', ['default', 'muted', 'primary', 'destructive'] as const, 'default')!,
    clamp: attr(el, 'clamp') === undefined ? undefined : intAttr(el, 'clamp', 1, 6),
    align: enumAttr(el, 'align', ['start', 'center', 'end'] as const),
  }
}

function parseButton(el: Element): ButtonNode {
  const actionName = requiredAttr(el, 'onClick')
  if (!(ACTION_NAMES as readonly string[]).includes(actionName)) {
    throw new WidgetError('invalidAction', actionName)
  }
  const onClick = actionName as ActionName
  validateAttrs(el, [...BUTTON_BASE_ATTRS, ...ACTION_ARGS[onClick]])

  const allowed = new Set<string>([...BUTTON_BASE_ATTRS, ...ACTION_ARGS[onClick]])
  for (const attribute of Array.from(el.attributes)) {
    if (!allowed.has(attribute.name)) {
      throw new WidgetError('unknownAttribute', `Button@${attribute.name}`)
    }
  }
  for (const name of ACTION_REQUIRED[onClick]) {
    requiredAttr(el, name)
  }

  const args: Record<string, string> = {}
  for (const name of ACTION_ARGS[onClick]) {
    const value = attr(el, name)
    if (value !== undefined) args[name] = value
  }

  switch (onClick) {
    case 'navigate': {
      const to = args.to
      if (!to || isBound(to) || !(NAV_TARGETS as readonly string[]).includes(to)) {
        throw new WidgetError('invalidAttribute', `Button@to=${to}`)
      }
      break
    }
    case 'openFolder': {
      const target = args.target
      if (!target || isBound(target) || !(FOLDER_TARGETS as readonly string[]).includes(target)) {
        throw new WidgetError('invalidAttribute', `Button@target=${target}`)
      }
      break
    }
    case 'openUrl':
      validateStaticUrl(args.url ?? '', 'Button@url')
      break
    case 'install': {
      const source = args.source
      if (!source || isBound(source) || !(INSTALL_SOURCES as readonly string[]).includes(source)) {
        throw new WidgetError('invalidAttribute', `Button@source=${source}`)
      }
      const category = args.category
      if (category !== undefined) {
        if (isBound(category) || !(INSTALL_CATEGORIES as readonly string[]).includes(category)) {
          throw new WidgetError('invalidAttribute', `Button@category=${category}`)
        }
      } else {
        args.category = 'mod'
      }
      break
    }
    default:
      break
  }

  return {
    kind: 'button',
    text: requiredAttr(el, 'text'),
    variant: enumAttr(el, 'variant', ['default', 'secondary', 'outline', 'ghost', 'destructive', 'link'] as const, 'default')!,
    size: enumAttr(el, 'size', ['sm', 'default', 'lg'] as const, 'default')!,
    onClick,
    args,
  }
}

function parseImage(el: Element, ctx: ParseCtx): ImageNode {
  validateAttrs(el)
  const src = requiredAttr(el, 'src')
  validateStaticUrl(src, 'Image@src')
  if (!isBound(src)) ctx.staticImageUrls.push(src)
  return {
    kind: 'image',
    src,
    alt: attr(el, 'alt') || undefined,
    w: attr(el, 'w') === undefined ? undefined : intAttr(el, 'w', 1, 512),
    h: attr(el, 'h') === undefined ? undefined : intAttr(el, 'h', 1, 512),
    rounded: boolAttr(el, 'rounded', false),
  }
}

/** 解析并严格校验组件 XML；任何未知元素/属性都直接失败。 */
export function parseWidgetXml(xml: string): WidgetDocument {
  assertSafeXml(xml)
  const doc = new DOMParser().parseFromString(xml, 'application/xml')
  const parseError = doc.getElementsByTagName('parsererror')[0]
  if (parseError || !doc.documentElement || doc.documentElement.tagName === 'parsererror') {
    throw new WidgetError('xmlInvalid', parseError?.textContent?.slice(0, 200))
  }
  const root = doc.documentElement
  if (root.tagName !== 'Widget') {
    throw new WidgetError('root', root.tagName)
  }
  validateAttrs(root)
  assertNoText(root)

  const name = requiredAttr(root, 'name').trim()
  if (name.length > 64) throw new WidgetError('invalidAttribute', `Widget@name>64`)
  const version = requiredAttr(root, 'version').trim()
  const updateUrl = attr(root, 'updateUrl')?.trim() || undefined
  if (updateUrl && (isBound(updateUrl) || !isSafeHttpsUrl(updateUrl))) {
    throw new WidgetError('invalidUrl', `Widget@updateUrl=${updateUrl}`)
  }

  const ctx: ParseCtx = {
    nodes: 0,
    datas: [],
    dataNames: new Set(),
    staticImageUrls: [],
  }
  const nodes = parseChildren(root, ctx, 1)
  return {
    name,
    version,
    author: attr(root, 'author')?.trim() || undefined,
    description: attr(root, 'description')?.trim() || undefined,
    updateUrl,
    datas: ctx.datas,
    nodes,
    staticImageUrls: ctx.staticImageUrls,
  }
}
