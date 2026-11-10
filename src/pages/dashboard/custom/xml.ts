// Copyright (C) 2026 Qomicex Launcher Contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import {
  ACTION_ARGS,
  ACTION_NAMES,
  ACTION_REQUIRED,
  ATTACHED_ATTRS,
  DATA_SOURCES,
  DATA_TYPES,
  ELEMENT_ATTRS,
  FIELD_TYPES,
  FOLDER_TARGETS,
  INSTALL_CATEGORIES,
  INSTALL_SOURCES,
  NAV_TARGETS,
  TRIGGER_EVENTS,
  WIDGET_LIMITS,
  WidgetError,
  assertSafeXml,
  isBound,
  isSafeHttpsUrl,
  sanitizeAlias,
  validateIdentifier,
  type ActionName,
  type DataSourceSpec,
} from './schema.ts'
import type {
  ActionSpec,
  ButtonNode,
  CheckBoxNode,
  ColorPickerNode,
  ColumnNode,
  ContainerNode,
  FilePickerNode,
  FunctionNode,
  FunctionInput,
  FunctionOutput,
  GridAttached,
  GridNode,
  IfNode,
  ImageNode,
  LinkNode,
  ListItemNode,
  ListNode,
  MediaNode,
  ProgressNode,
  ResourceEntry,
  RowNode,
  SelectNode,
  SliderNode,
  SpacerNode,
  StructDef,
  StructField,
  TabItemNode,
  TabsNode,
  TextBoxNode,
  TextNode,
  TriggerNode,
  UsingNode,
  WidgetDocument,
  WidgetNode,
} from './types.ts'

interface ParseCtx {
  nodes: number
  datas: DataSourceSpec[]
  resources: ResourceEntry[]
  functions: FunctionNode[]
  triggers: TriggerNode[]
  staticMediaUrls: string[]
  nestedUrls: string[]
  aliases: Set<string>
  usingCount: number
  names: Set<string>
}

interface SplitElement {
  attrs: Map<string, string>
  propertyElements: Map<string, Element>
  children: Element[]
}

function readElement(el: Element): SplitElement {
  const attrs = new Map<string, string>()
  for (const attribute of Array.from(el.attributes)) attrs.set(attribute.name, attribute.value)
  const propertyElements = new Map<string, Element>()
  const children: Element[] = []
  for (const child of Array.from(el.children)) {
    if (child.tagName === 'Widget.Using' || child.tagName === 'Using') {
      children.push(child)
    } else if (child.tagName.startsWith(`${el.tagName}.`)) {
      propertyElements.set(child.tagName.slice(el.tagName.length + 1), child)
    } else if ((ATTACHED_ATTRS as readonly string[]).includes(child.tagName)) {
      propertyElements.set(child.tagName, child)
    } else {
      children.push(child)
    }
  }
  return { attrs, propertyElements, children }
}

function propertyText(el: Element, preserve = false): string {
  const text = el.textContent ?? ''
  return preserve ? text : text.trim()
}

function applyProperties(
  tag: string,
  attrs: Map<string, string>,
  propertyElements: Map<string, Element>,
): void {
  for (const [name, el] of propertyElements) {
    if ((ATTACHED_ATTRS as readonly string[]).includes(name)) {
      if (Array.from(el.children).length > 0) throw new WidgetError('invalidAttribute', `${tag}.${name}`)
      if (attrs.has(name)) throw new WidgetError('duplicateProperty', `${tag}.${name}`)
      attrs.set(name, propertyText(el))
      continue
    }
    if (Array.from(el.children).length > 0) {
      throw new WidgetError('invalidAttribute', `${tag}.${name} 不能包含子元素`)
    }
    if (!(ELEMENT_ATTRS[tag] ?? []).includes(name)) {
      throw new WidgetError('unknownAttribute', `${tag}.${name}`)
    }
    if (attrs.has(name)) throw new WidgetError('duplicateProperty', `${tag}.${name}`)
    const preserve = name === 'Arguments' || name === 'Script'
    attrs.set(name, propertyText(el, preserve))
  }
}

/** 只取元素的直接文本节点，避免把属性元素内容（如 Widget.Using.Arguments）当成值。 */
function directText(el: Element): string {
  let out = ''
  for (const child of Array.from(el.childNodes)) {
    if (child.nodeType === 3 || child.nodeType === 4) out += child.textContent ?? ''
  }
  return out.trim()
}

function validateAttrs(tag: string, attrs: Map<string, string>): void {
  const allowed = new Set<string>([...(ELEMENT_ATTRS[tag] ?? []), ...ATTACHED_ATTRS])
  for (const name of attrs.keys()) {
    if (!allowed.has(name)) throw new WidgetError('unknownAttribute', `${tag}@${name}`)
  }
}

function attr(attrs: Map<string, string>, name: string): string | undefined {
  return attrs.get(name)
}

function requiredAttr(attrs: Map<string, string>, tag: string, name: string): string {
  const value = attrs.get(name)
  if (value === undefined || value.trim() === '') {
    throw new WidgetError('missingAttribute', `${tag}@${name}`)
  }
  return value
}

function intAttr(
  attrs: Map<string, string>,
  tag: string,
  name: string,
  min: number,
  max: number,
  fallback?: number,
): number {
  const raw = attrs.get(name)
  if (raw === undefined) {
    if (fallback !== undefined) return fallback
    throw new WidgetError('missingAttribute', `${tag}@${name}`)
  }
  const value = Number(raw)
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new WidgetError('invalidAttribute', `${tag}@${name}=${raw}`)
  }
  return value
}

function numberAttr(
  attrs: Map<string, string>,
  tag: string,
  name: string,
  min: number,
  max: number,
  fallback?: number,
): number {
  const raw = attrs.get(name)
  if (raw === undefined) {
    if (fallback !== undefined) return fallback
    throw new WidgetError('missingAttribute', `${tag}@${name}`)
  }
  const value = Number(raw)
  if (!Number.isFinite(value) || value < min || value > max) {
    throw new WidgetError('invalidAttribute', `${tag}@${name}=${raw}`)
  }
  return value
}

function boolAttr(attrs: Map<string, string>, tag: string, name: string, fallback: boolean): boolean {
  const raw = attrs.get(name)
  if (raw === undefined) return fallback
  if (raw === 'True' || raw === 'true') return true
  if (raw === 'False' || raw === 'false') return false
  throw new WidgetError('invalidAttribute', `${tag}@${name}=${raw}`)
}

function enumAttr<T extends string>(
  attrs: Map<string, string>,
  tag: string,
  name: string,
  allowed: readonly T[],
  fallback?: T,
): T | undefined {
  const raw = attrs.get(name)
  if (raw === undefined) return fallback
  if (!(allowed as readonly string[]).includes(raw)) {
    throw new WidgetError('invalidAttribute', `${tag}@${name}=${raw}`)
  }
  return raw as T
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

function parseAttached(attrs: Map<string, string>): GridAttached | undefined {
  const attached: GridAttached = {}
  let any = false
  const map: Array<[string, keyof GridAttached]> = [
    ['Grid.Row', 'row'],
    ['Grid.Column', 'column'],
    ['Grid.RowSpan', 'rowSpan'],
    ['Grid.ColumnSpan', 'columnSpan'],
  ]
  for (const [name, key] of map) {
    const raw = attrs.get(name)
    if (raw === undefined) continue
    const value = Number(raw)
    if (!Number.isInteger(value) || value < 0 || value > 100) {
      throw new WidgetError('invalidAttribute', `${name}=${raw}`)
    }
    attached[key] = value
    any = true
  }
  return any ? attached : undefined
}

function parseAction(attrs: Map<string, string>, tag: string, actionName: string): ActionSpec {
  if (!(ACTION_NAMES as readonly string[]).includes(actionName)) {
    throw new WidgetError('invalidAction', `${tag}@OnClick=${actionName}`)
  }
  const name = actionName as ActionName
  for (const key of ACTION_REQUIRED[name]) requiredAttr(attrs, tag, key)
  const args: Record<string, string> = {}
  for (const key of ACTION_ARGS[name]) {
    const value = attrs.get(key)
    if (value !== undefined) args[key] = value
  }
  switch (name) {
    case 'Navigate': {
      if (isBound(args.To ?? '') || !(NAV_TARGETS as readonly string[]).includes(args.To ?? '')) {
        throw new WidgetError('invalidAttribute', `${tag}@To=${args.To}`)
      }
      break
    }
    case 'OpenFolder': {
      if (isBound(args.Folder ?? '') || !(FOLDER_TARGETS as readonly string[]).includes(args.Folder ?? '')) {
        throw new WidgetError('invalidAttribute', `${tag}@Folder=${args.Folder}`)
      }
      break
    }
    case 'OpenUrl':
      validateStaticUrl(args.Url ?? '', `${tag}@Url`)
      break
    case 'Install': {
      if (isBound(args.Source ?? '') || !(INSTALL_SOURCES as readonly string[]).includes(args.Source ?? '')) {
        throw new WidgetError('invalidAttribute', `${tag}@Source=${args.Source}`)
      }
      const category = args.Category ?? 'Mod'
      if (isBound(category) || !(INSTALL_CATEGORIES as readonly string[]).includes(category)) {
        throw new WidgetError('invalidAttribute', `${tag}@Category=${category}`)
      }
      args.Category = category
      break
    }
    default:
      break
  }
  return { name, args }
}

function parseData(el: Element, ctx: ParseCtx): void {
  const { attrs, propertyElements } = readElement(el)
  applyProperties('Data', attrs, propertyElements)
  validateAttrs('Data', attrs)
  if (ctx.datas.length >= WIDGET_LIMITS.maxDataSources) throw new WidgetError('tooManyData')
  const name = attr(attrs, 'Name')?.trim() || 'Data'
  validateIdentifier(name, 'Data@Name')
  if (ctx.names.has(`data:${name}`)) throw new WidgetError('duplicateData', name)
  const type = enumAttr(attrs, 'Data', 'Type', DATA_TYPES, 'Json')!
  const source = enumAttr(attrs, 'Data', 'Source', DATA_SOURCES, 'Url')!
  const refresh = intAttr(attrs, 'Data', 'Refresh', 0, 86400, 3600)
  const mime = attr(attrs, 'Mime')?.trim() || undefined
  if (source === 'Url') {
    const url = requiredAttr(attrs, 'Data', 'Url')
    if (!isSafeHttpsUrl(url)) throw new WidgetError('invalidUrl', `Data@Url=${url}`)
    ctx.datas.push({ name, type, source, url, refresh, mime })
  } else {
    const path = requiredAttr(attrs, 'Data', 'Path')
    ctx.datas.push({ name, type, source, path, refresh, mime })
  }
  ctx.names.add(`data:${name}`)
}

function parseResources(el: Element, ctx: ParseCtx): void {
  const { attrs, children } = readElement(el)
  validateAttrs('Resources', attrs)
  assertNoText(el)
  for (const child of children) {
    const split = readElement(child)
    applyProperties(child.tagName, split.attrs, split.propertyElements)
    validateAttrs(child.tagName, split.attrs)
    if (Array.from(child.children).length > 0) {
      throw new WidgetError('invalidResource', `${child.tagName} 不能包含子元素`)
    }
    const name = requiredAttr(split.attrs, child.tagName, 'Name').trim()
    validateIdentifier(name, `${child.tagName}@Name`)
    if (ctx.names.has(`resource:${name}`)) throw new WidgetError('invalidResource', `重复资源 ${name}`)
    let type: ResourceEntry['type']
    let value = (child.textContent ?? '').trim()
    let mime: string | undefined
    if (child.tagName === 'Resource') {
      type = enumAttr(split.attrs, 'Resource', 'Type', ['String', 'Bool', 'Number', 'Binary', 'Json'] as const, 'String')!
      mime = attr(split.attrs, 'Mime')?.trim() || undefined
    } else {
      type = child.tagName as ResourceEntry['type']
    }
    if (child.tagName === 'Binary') {
      mime = attr(split.attrs, 'Mime')?.trim() || undefined
      if (!/^[A-Za-z0-9+/=\s]*$/.test(value)) {
        throw new WidgetError('invalidResource', `Binary ${name} 不是合法 base64`)
      }
      value = value.replace(/\s+/g, '')
    }
    ctx.resources.push({ name, type, value, mime })
    ctx.names.add(`resource:${name}`)
  }
}

function parseTriggers(el: Element, ctx: ParseCtx): void {
  const { attrs, children } = readElement(el)
  validateAttrs('Triggers', attrs)
  assertNoText(el)
  for (const child of children) {
    if (child.tagName !== 'Trigger') throw new WidgetError('invalidTrigger', child.tagName)
    const split = readElement(child)
    applyProperties('Trigger', split.attrs, split.propertyElements)
    validateAttrs('Trigger', split.attrs)
    const event = enumAttr(split.attrs, 'Trigger', 'Event', TRIGGER_EVENTS)
    if (!event) throw new WidgetError('missingAttribute', 'Trigger@Event')
    const functionName = attr(split.attrs, 'Function')?.trim()
    const actionName = attr(split.attrs, 'Action')?.trim()
    if (functionName && actionName) throw new WidgetError('invalidTrigger', 'Function 与 Action 只能二选一')
    if (!functionName && !actionName) throw new WidgetError('invalidTrigger', 'Trigger 需要 Function 或 Action')

    let action: ActionSpec | undefined
    if (actionName) {
      // Trigger 的 Action 参数与按钮共用；Function 属性在 Trigger 上表示简写，不参与动作参数。
      action = parseAction(split.attrs, 'Trigger', actionName)
    } else if (functionName) {
      action = {
        name: 'CallFunction',
        args: {
          Function: functionName,
          ...(split.attrs.get('Arguments') !== undefined ? { Arguments: split.attrs.get('Arguments')! } : {}),
        },
      }
    }
    const trigger: TriggerNode = {
      event,
      function: functionName,
      action,
      control: attr(split.attrs, 'Control')?.trim() || undefined,
      data: attr(split.attrs, 'Data')?.trim() || undefined,
      interval: event === 'Timer' ? intAttr(split.attrs, 'Trigger', 'Interval', 1000, 3600000, 60000) : undefined,
      once: boolAttr(split.attrs, 'Trigger', 'Once', false),
    }
    if (event === 'Click' && !trigger.control) throw new WidgetError('invalidTrigger', 'Click 需要 Control')
    if (event === 'DataChanged' && !trigger.data) throw new WidgetError('invalidTrigger', 'DataChanged 需要 Data')
    ctx.triggers.push(trigger)
    if (ctx.triggers.length > 32) throw new WidgetError('invalidTrigger', 'Trigger 超过 32 个')
  }
}

function parseStructs(el: Element): StructDef[] {
  const { attrs, children } = readElement(el)
  validateAttrs('Function.Interface', attrs)
  const structs: StructDef[] = []
  const names = new Set<string>()
  for (const child of children) {
    if (child.tagName !== 'Struct') throw new WidgetError('invalidStruct', child.tagName)
    const split = readElement(child)
    applyProperties('Struct', split.attrs, split.propertyElements)
    validateAttrs('Struct', split.attrs)
    const name = requiredAttr(split.attrs, 'Struct', 'Name').trim()
    validateIdentifier(name, 'Struct@Name')
    if (names.has(name)) throw new WidgetError('invalidStruct', `重复结构体 ${name}`)
    const fields: StructField[] = []
    const fieldNames = new Set<string>()
    for (const fieldEl of Array.from(child.children)) {
      if (fieldEl.tagName !== 'Field') throw new WidgetError('invalidStruct', fieldEl.tagName)
      const fieldSplit = readElement(fieldEl)
      applyProperties('Field', fieldSplit.attrs, fieldSplit.propertyElements)
      validateAttrs('Field', fieldSplit.attrs)
      const fieldName = requiredAttr(fieldSplit.attrs, 'Field', 'Name').trim()
      validateIdentifier(fieldName, 'Field@Name')
      if (fieldNames.has(fieldName)) throw new WidgetError('invalidStruct', `重复字段 ${fieldName}`)
      const type = requiredAttr(fieldSplit.attrs, 'Field', 'Type').trim()
      fields.push({ name: fieldName, type })
      fieldNames.add(fieldName)
    }
    if (fields.length === 0) throw new WidgetError('invalidStruct', `${name} 没有字段`)
    structs.push({ name, fields })
    names.add(name)
  }
  return structs
}

function parseFunction(el: Element, ctx: ParseCtx): void {
  const { attrs, propertyElements, children } = readElement(el)
  validateAttrs('Function', attrs)
  if (children.length > 0) throw new WidgetError('invalidFunction', 'Function 只能包含属性元素')
  const name = requiredAttr(attrs, 'Function', 'Name').trim()
  validateIdentifier(name, 'Function@Name')
  if (ctx.functions.some((fn) => fn.name === name)) throw new WidgetError('invalidFunction', `重复函数 ${name}`)
  const timeout = intAttr(attrs, 'Function', 'Timeout', 100, WIDGET_LIMITS.maxScriptTimeoutMs, WIDGET_LIMITS.defaultScriptTimeoutMs)

  const interfaceEl = propertyElements.get('Interface')
  const structs = interfaceEl ? parseStructs(interfaceEl) : []
  const structNames = new Set(structs.map((s) => s.name))
  const validateType = (type: string, label: string) => {
    if (!(FIELD_TYPES as readonly string[]).includes(type) && !structNames.has(type)) {
      throw new WidgetError('invalidFunction', `${label} 引用未知类型 ${type}`)
    }
  }

  const inputEl = propertyElements.get('Input')
  const inputs: FunctionInput[] = []
  if (inputEl) {
    const inputAttrs = new Map(Array.from(inputEl.attributes).map((a) => [a.name, a.value]))
    const type = requiredAttr(inputAttrs, 'Function.Input', 'Type').trim()
    validateType(type, 'Function.Input')
    const variable = (inputEl.textContent ?? '').trim() || 'Input'
    validateIdentifier(variable, 'Function.Input')
    inputs.push({ type, name: variable })
  }

  const outputEls = Array.from(el.children).filter((child) => child.tagName === 'Function.Output')
  const outputs: FunctionOutput[] = []
  for (const outputEl of outputEls) {
    const outputAttrs = new Map(Array.from(outputEl.attributes).map((a) => [a.name, a.value]))
    const type = requiredAttr(outputAttrs, 'Function.Output', 'Type').trim()
    validateType(type, 'Function.Output')
    const variable = (outputEl.textContent ?? '').trim()
    validateIdentifier(variable, 'Function.Output')
    outputs.push({ type, name: variable })
  }

  const scriptEl = propertyElements.get('Script')
  if (!scriptEl) throw new WidgetError('invalidFunction', `${name} 缺少 Function.Script`)
  const script = (scriptEl.textContent ?? '').replace(/^\s+|\s+$/g, '')
  if (!script) throw new WidgetError('invalidScript', `${name} 脚本为空`)
  if (new TextEncoder().encode(script).length > WIDGET_LIMITS.maxScriptBytes) {
    throw new WidgetError('invalidScript', `${name} 脚本超过 64KB`)
  }

  ctx.functions.push({ name, timeout, structs, inputs, outputs, script })
  ctx.names.add(`function:${name}`)
}

function parseUsing(el: Element, ctx: ParseCtx): UsingNode {
  const { attrs, propertyElements, children } = readElement(el)
  applyProperties('Using', attrs, propertyElements)
  validateAttrs('Using', attrs)
  if (children.length > 0) throw new WidgetError('invalidUsing', 'Widget.Using 不能包含子节点')
  const name = attr(attrs, 'Name')?.trim()
  const url = attr(attrs, 'Url')?.trim()
  const text = directText(el)
  const refName = name || (!url && text && !text.startsWith('https://') ? text : undefined)
  const refUrl = url || (!name && text.startsWith('https://') ? text : undefined)
  if (!refName && !refUrl) throw new WidgetError('invalidUsing', 'Widget.Using 需要 Name 或 Url')
  if (refName && refUrl) throw new WidgetError('invalidUsing', 'Name 与 Url 只能二选一')
  if (refUrl && !isSafeHttpsUrl(refUrl)) throw new WidgetError('invalidUrl', `Widget.Using@Url=${refUrl}`)
  const as = attr(attrs, 'As')?.trim() || sanitizeAlias((refName ?? refUrl ?? 'Child').split(/[/\\]/).pop()?.replace(/\.qwidget$/i, '') ?? 'Child')
  validateIdentifier(as, 'Widget.Using@As')
  if (ctx.aliases.has(as)) throw new WidgetError('invalidUsing', `别名重复 ${as}`)
  ctx.aliases.add(as)
  ctx.usingCount += 1
  if (ctx.usingCount > WIDGET_LIMITS.maxNestedInstances) {
    throw new WidgetError('invalidUsing', `嵌套实例超过 ${WIDGET_LIMITS.maxNestedInstances} 个`)
  }
  const argsEl = propertyElements.get('Arguments')
  const argumentsJson = argsEl ? (argsEl.textContent ?? '').trim() : undefined
  if (refUrl) ctx.nestedUrls.push(refUrl)
  return {
    kind: 'using',
    name: refName,
    url: refUrl,
    as,
    refresh: attrs.has('Refresh') ? intAttr(attrs, 'Using', 'Refresh', 60, 86400) : undefined,
    argumentsJson,
    attached: parseAttached(attrs),
  }
}

function parseChildren(el: Element, ctx: ParseCtx, depth: number): WidgetNode[] {
  if (depth > WIDGET_LIMITS.maxDepth) throw new WidgetError('tooDeep', el.tagName)
  assertNoText(el)
  const { children } = readElement(el)
  const nodes: WidgetNode[] = []
  for (const child of children) {
    ctx.nodes += 1
    if (ctx.nodes > WIDGET_LIMITS.maxNodes) throw new WidgetError('tooManyNodes')
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
    case 'Widget.Using':
    case 'Using':
      return parseUsing(el, ctx)
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
    case 'Media':
      return parseMedia(el, ctx)
    case 'TextBox':
      return parseTextBox(el)
    case 'CheckBox':
      return parseCheckBox(el)
    case 'Slider':
      return parseSlider(el)
    case 'Select':
      return parseSelect(el)
    case 'Progress':
      return parseProgress(el)
    case 'Link':
      return parseLink(el)
    case 'FilePicker':
      return parseFilePicker(el)
    case 'ColorPicker':
      return parseColorPicker(el)
    case 'Divider': {
      const { attrs, propertyElements } = readElement(el)
      applyProperties('Divider', attrs, propertyElements)
      validateAttrs('Divider', attrs)
      return { kind: 'divider', attached: parseAttached(attrs) }
    }
    case 'Spacer': {
      const { attrs, propertyElements } = readElement(el)
      applyProperties('Spacer', attrs, propertyElements)
      validateAttrs('Spacer', attrs)
      return { kind: 'spacer', size: intAttr(attrs, 'Spacer', 'Size', 0, 96, 8), attached: parseAttached(attrs) } satisfies SpacerNode
    }
    case 'Widget':
      throw new WidgetError('root', 'Widget 不能嵌套')
    case 'Data':
      throw new WidgetError('invalidAttribute', 'Data 只能作为布局容器的子元素')
    default:
      throw new WidgetError('unknownElement', el.tagName)
  }
}

function layoutAttrs(attrs: Map<string, string>, tag: string) {
  return {
    gap: intAttr(attrs, tag, 'Gap', 0, 8, 0),
    padding: intAttr(attrs, tag, 'Padding', 0, 8, 0),
    align: enumAttr(attrs, tag, 'Align', ['Start', 'Center', 'End', 'Stretch'] as const),
    justify: enumAttr(attrs, tag, 'Justify', ['Start', 'Center', 'End', 'Between'] as const),
  }
}

function parseContainer(el: Element, ctx: ParseCtx, depth: number): ContainerNode {
  const { attrs, propertyElements } = readElement(el)
  applyProperties('Container', attrs, propertyElements)
  validateAttrs('Container', attrs)
  return {
    kind: 'container',
    ...layoutAttrs(attrs, 'Container'),
    direction: enumAttr(attrs, 'Container', 'Direction', ['Row', 'Column'] as const, 'Column')!,
    border: boolAttr(attrs, 'Container', 'Border', true),
    background: enumAttr(attrs, 'Container', 'Background', ['Transparent', 'Card', 'Muted', 'Primary'] as const, 'Card')!,
    radius: enumAttr(attrs, 'Container', 'Radius', ['None', 'Sm', 'Md', 'Lg', 'Full'] as const, 'Lg')!,
    children: parseChildren(el, ctx, depth + 1),
    attached: parseAttached(attrs),
  }
}

function parseRowColumn(el: Element, ctx: ParseCtx, depth: number): RowNode | ColumnNode {
  const { attrs, propertyElements } = readElement(el)
  applyProperties(el.tagName, attrs, propertyElements)
  validateAttrs(el.tagName, attrs)
  const common = {
    ...layoutAttrs(attrs, el.tagName),
    wrap: boolAttr(attrs, el.tagName, 'Wrap', false),
    children: parseChildren(el, ctx, depth + 1),
    attached: parseAttached(attrs),
  }
  return el.tagName === 'Row' ? { kind: 'row', ...common } : { kind: 'column', ...common }
}

function parseGrid(el: Element, ctx: ParseCtx, depth: number): GridNode {
  const { attrs, propertyElements } = readElement(el)
  applyProperties('Grid', attrs, propertyElements)
  validateAttrs('Grid', attrs)
  return {
    kind: 'grid',
    columns: intAttr(attrs, 'Grid', 'Columns', 1, 6),
    ...layoutAttrs(attrs, 'Grid'),
    children: parseChildren(el, ctx, depth + 1),
    attached: parseAttached(attrs),
  }
}

function parseTabs(el: Element, ctx: ParseCtx, depth: number): TabsNode {
  const { attrs, propertyElements } = readElement(el)
  applyProperties('Tabs', attrs, propertyElements)
  validateAttrs('Tabs', attrs)
  assertNoText(el)
  if (depth + 1 > WIDGET_LIMITS.maxDepth) throw new WidgetError('tooDeep', el.tagName)
  const { children: childEls } = readElement(el)
  const children: TabItemNode[] = []
  for (const child of childEls) {
    ctx.nodes += 1
    if (ctx.nodes > WIDGET_LIMITS.maxNodes) throw new WidgetError('tooManyNodes')
    if (child.tagName !== 'TabItem') throw new WidgetError('tabsTemplate', `Tabs 内不允许 ${child.tagName}`)
    const split = readElement(child)
    applyProperties('TabItem', split.attrs, split.propertyElements)
    validateAttrs('TabItem', split.attrs)
    children.push({
      kind: 'tabItem',
      title: requiredAttr(split.attrs, 'TabItem', 'Title'),
      children: parseChildren(child, ctx, depth + 2),
    })
  }
  if (children.length === 0) throw new WidgetError('tabsTemplate', 'Tabs 至少需要一个 TabItem')
  return {
    kind: 'tabs',
    defaultIndex: intAttr(attrs, 'Tabs', 'Default', 0, children.length - 1, 0),
    children,
    attached: parseAttached(attrs),
  }
}

function parseList(el: Element, ctx: ParseCtx, depth: number): ListNode {
  const { attrs, propertyElements, children: childEls } = readElement(el)
  applyProperties('List', attrs, propertyElements)
  validateAttrs('List', attrs)
  if (depth + 1 > WIDGET_LIMITS.maxDepth) throw new WidgetError('tooDeep', el.tagName)
  const items = validatePath(requiredAttr(attrs, 'List', 'Items'), 'List@Items')
  const as = attr(attrs, 'As')?.trim() || 'item'
  validateIdentifier(as, 'List@As')
  if (childEls.length !== 1 || childEls[0].tagName !== 'ListItem') {
    throw new WidgetError('listTemplate', 'List 必须且只能包含一个 ListItem')
  }
  const itemEl = childEls[0]
  const itemSplit = readElement(itemEl)
  applyProperties('ListItem', itemSplit.attrs, itemSplit.propertyElements)
  validateAttrs('ListItem', itemSplit.attrs)
  if (itemSplit.children.length !== 1) {
    throw new WidgetError('listItemRoot', 'ListItem 必须且只能包含一个根元素')
  }
  assertNoText(itemEl)
  ctx.nodes += 1
  const item: ListItemNode = { kind: 'listItem', child: parseNode(itemSplit.children[0], ctx, depth + 2) }
  return {
    kind: 'list',
    items,
    as,
    gap: intAttr(attrs, 'List', 'Gap', 0, 8, 0),
    emptyText: attr(attrs, 'EmptyText') || undefined,
    item,
    attached: parseAttached(attrs),
  }
}

function parseIf(el: Element, ctx: ParseCtx, depth: number): IfNode {
  const { attrs, propertyElements } = readElement(el)
  applyProperties('If', attrs, propertyElements)
  validateAttrs('If', attrs)
  return {
    kind: 'if',
    test: validatePath(requiredAttr(attrs, 'If', 'Test'), 'If@Test'),
    children: parseChildren(el, ctx, depth + 1),
    attached: parseAttached(attrs),
  }
}

function baseNode(_tag: string, attrs: Map<string, string>) {
  return { attached: parseAttached(attrs) }
}

function parseText(el: Element): TextNode {
  const { attrs, propertyElements } = readElement(el)
  applyProperties('Text', attrs, propertyElements)
  validateAttrs('Text', attrs)
  return {
    kind: 'text',
    value: requiredAttr(attrs, 'Text', 'Value'),
    size: enumAttr(attrs, 'Text', 'Size', ['Xs', 'Sm', 'Md', 'Lg', 'Xl', '2Xl'] as const, 'Md')!,
    weight: enumAttr(attrs, 'Text', 'Weight', ['Normal', 'Medium', 'Semibold', 'Bold'] as const, 'Normal')!,
    color: enumAttr(attrs, 'Text', 'Color', ['Default', 'Muted', 'Primary', 'Destructive'] as const, 'Default')!,
    clamp: attrs.has('Clamp') ? intAttr(attrs, 'Text', 'Clamp', 1, 6) : undefined,
    align: enumAttr(attrs, 'Text', 'Align', ['Start', 'Center', 'End'] as const),
    ...baseNode('Text', attrs),
  }
}

function parseButton(el: Element): ButtonNode {
  const { attrs, propertyElements } = readElement(el)
  applyProperties('Button', attrs, propertyElements)
  validateAttrs('Button', attrs)
  const onClickRaw = attr(attrs, 'OnClick')
  const onClick = onClickRaw ? parseAction(attrs, 'Button', onClickRaw) : undefined
  if (!onClickRaw) {
    for (const key of Object.keys(Object.fromEntries(attrs))) {
      if ((ACTION_ARGS.CallFunction as readonly string[]).includes(key) && key !== 'Function' && key !== 'Arguments') {
        throw new WidgetError('invalidAttribute', `Button@${key} 缺少 OnClick`)
      }
    }
  }
  return {
    kind: 'button',
    name: attr(attrs, 'Name')?.trim() || undefined,
    text: requiredAttr(attrs, 'Button', 'Text'),
    variant: enumAttr(attrs, 'Button', 'Variant', ['Default', 'Secondary', 'Outline', 'Ghost', 'Destructive', 'Link'] as const, 'Default')!,
    size: enumAttr(attrs, 'Button', 'Size', ['Sm', 'Md', 'Lg'] as const, 'Md')!,
    onClick,
    ...baseNode('Button', attrs),
  }
}

function parseImage(el: Element, ctx: ParseCtx): ImageNode {
  const { attrs, propertyElements } = readElement(el)
  applyProperties('Image', attrs, propertyElements)
  validateAttrs('Image', attrs)
  const src = requiredAttr(attrs, 'Image', 'Src')
  validateStaticUrl(src, 'Image@Src')
  if (!isBound(src)) ctx.staticMediaUrls.push(src)
  return {
    kind: 'image',
    src,
    alt: attr(attrs, 'Alt') || undefined,
    w: attrs.has('W') ? intAttr(attrs, 'Image', 'W', 1, 2048) : undefined,
    h: attrs.has('H') ? intAttr(attrs, 'Image', 'H', 1, 2048) : undefined,
    rounded: boolAttr(attrs, 'Image', 'Rounded', false),
    ...baseNode('Image', attrs),
  }
}

function parseMedia(el: Element, ctx: ParseCtx): MediaNode {
  const { attrs, propertyElements } = readElement(el)
  applyProperties('Media', attrs, propertyElements)
  validateAttrs('Media', attrs)
  const source = requiredAttr(attrs, 'Media', 'Source')
  validateStaticUrl(source, 'Media@Source')
  if (!isBound(source)) ctx.staticMediaUrls.push(source)
  return {
    kind: 'media',
    type: enumAttr(attrs, 'Media', 'Type', ['Audio', 'Video'] as const, 'Audio')!,
    source,
    controls: boolAttr(attrs, 'Media', 'Controls', true),
    autoPlay: boolAttr(attrs, 'Media', 'AutoPlay', false),
    loop: boolAttr(attrs, 'Media', 'Loop', false),
    poster: attr(attrs, 'Poster') || undefined,
    volume: attrs.has('Volume') ? numberAttr(attrs, 'Media', 'Volume', 0, 1, 1) : undefined,
    muted: boolAttr(attrs, 'Media', 'Muted', false),
    ...baseNode('Media', attrs),
  }
}

function parseOnChange(attrs: Map<string, string>, tag: string): ActionSpec | undefined {
  const raw = attr(attrs, 'OnChange')
  return raw ? parseAction(attrs, tag, raw) : undefined
}

function parseTextBox(el: Element): TextBoxNode {
  const { attrs, propertyElements } = readElement(el)
  applyProperties('TextBox', attrs, propertyElements)
  validateAttrs('TextBox', attrs)
  return {
    kind: 'textBox',
    name: requiredAttr(attrs, 'TextBox', 'Name').trim(),
    value: attr(attrs, 'Value'),
    placeholder: attr(attrs, 'Placeholder'),
    multiline: boolAttr(attrs, 'TextBox', 'Multiline', false),
    password: boolAttr(attrs, 'TextBox', 'Password', false),
    readOnly: boolAttr(attrs, 'TextBox', 'ReadOnly', false),
    maxLength: attrs.has('MaxLength') ? intAttr(attrs, 'TextBox', 'MaxLength', 0, 10000) : undefined,
    onChange: parseOnChange(attrs, 'TextBox'),
    ...baseNode('TextBox', attrs),
  }
}

function parseCheckBox(el: Element): CheckBoxNode {
  const { attrs, propertyElements } = readElement(el)
  applyProperties('CheckBox', attrs, propertyElements)
  validateAttrs('CheckBox', attrs)
  return {
    kind: 'checkBox',
    name: requiredAttr(attrs, 'CheckBox', 'Name').trim(),
    text: attr(attrs, 'Text'),
    checked: boolAttr(attrs, 'CheckBox', 'Checked', false),
    onChange: parseOnChange(attrs, 'CheckBox'),
    ...baseNode('CheckBox', attrs),
  }
}

function parseSlider(el: Element): SliderNode {
  const { attrs, propertyElements } = readElement(el)
  applyProperties('Slider', attrs, propertyElements)
  validateAttrs('Slider', attrs)
  return {
    kind: 'slider',
    name: requiredAttr(attrs, 'Slider', 'Name').trim(),
    value: numberAttr(attrs, 'Slider', 'Value', -1_000_000, 1_000_000, 0),
    min: numberAttr(attrs, 'Slider', 'Min', -1_000_000, 1_000_000, 0),
    max: numberAttr(attrs, 'Slider', 'Max', -1_000_000, 1_000_000, 100),
    step: numberAttr(attrs, 'Slider', 'Step', 0.000001, 1_000_000, 1),
    onChange: parseOnChange(attrs, 'Slider'),
    ...baseNode('Slider', attrs),
  }
}

function parseSelect(el: Element): SelectNode {
  const { attrs, propertyElements } = readElement(el)
  applyProperties('Select', attrs, propertyElements)
  validateAttrs('Select', attrs)
  const options = attr(attrs, 'Options') ?? '[]'
  if (!isBound(options)) {
    try {
      const parsed = JSON.parse(options)
      if (!Array.isArray(parsed)) throw new Error('not array')
    } catch {
      throw new WidgetError('invalidAttribute', `Select@Options=${options}`)
    }
  }
  return {
    kind: 'select',
    name: requiredAttr(attrs, 'Select', 'Name').trim(),
    value: attr(attrs, 'Value'),
    options,
    onChange: parseOnChange(attrs, 'Select'),
    ...baseNode('Select', attrs),
  }
}

function parseProgress(el: Element): ProgressNode {
  const { attrs, propertyElements } = readElement(el)
  applyProperties('Progress', attrs, propertyElements)
  validateAttrs('Progress', attrs)
  return {
    kind: 'progress',
    value: requiredAttr(attrs, 'Progress', 'Value'),
    max: numberAttr(attrs, 'Progress', 'Max', 0, 1_000_000, 100),
    ...baseNode('Progress', attrs),
  }
}

function parseLink(el: Element): LinkNode {
  const { attrs, propertyElements } = readElement(el)
  applyProperties('Link', attrs, propertyElements)
  validateAttrs('Link', attrs)
  const url = attr(attrs, 'Url')
  if (url) validateStaticUrl(url, 'Link@Url')
  const onClickRaw = attr(attrs, 'OnClick')
  const onClick = onClickRaw ? parseAction(attrs, 'Link', onClickRaw) : undefined
  return {
    kind: 'link',
    name: attr(attrs, 'Name')?.trim() || undefined,
    text: requiredAttr(attrs, 'Link', 'Text'),
    url,
    onClick,
    ...baseNode('Link', attrs),
  }
}

function parseFilePicker(el: Element): FilePickerNode {
  const { attrs, propertyElements } = readElement(el)
  applyProperties('FilePicker', attrs, propertyElements)
  validateAttrs('FilePicker', attrs)
  return {
    kind: 'filePicker',
    name: requiredAttr(attrs, 'FilePicker', 'Name').trim(),
    text: attr(attrs, 'Text') ?? '选择文件',
    filter: attr(attrs, 'Filter'),
    value: attr(attrs, 'Value'),
    ...baseNode('FilePicker', attrs),
  }
}

function parseColorPicker(el: Element): ColorPickerNode {
  const { attrs, propertyElements } = readElement(el)
  applyProperties('ColorPicker', attrs, propertyElements)
  validateAttrs('ColorPicker', attrs)
  return {
    kind: 'colorPicker',
    name: requiredAttr(attrs, 'ColorPicker', 'Name').trim(),
    value: attr(attrs, 'Value'),
    onChange: parseOnChange(attrs, 'ColorPicker'),
    ...baseNode('ColorPicker', attrs),
  }
}

/** 解析并严格校验组件 XML；任何未知元素/属性都直接失败。 */
export function parseWidgetXml(xml: string): WidgetDocument {
  assertSafeXml(xml)
  const doc = new DOMParser().parseFromString(xml, 'application/xml')
  const parseError = doc.getElementsByTagName('parsererror')[0]
  if (parseError || !doc.documentElement || doc.documentElement.tagName === 'parsererror') {
    throw new WidgetError('xmlInvalid', parseError?.textContent?.slice(0, 300))
  }
  const root = doc.documentElement
  if (root.tagName !== 'Widget') throw new WidgetError('root', root.tagName)
  const rootSplit = readElement(root)
  applyProperties('Widget', rootSplit.attrs, rootSplit.propertyElements)
  validateAttrs('Widget', rootSplit.attrs)
  assertNoText(root)

  const name = requiredAttr(rootSplit.attrs, 'Widget', 'Name').trim()
  if (name.length > 64) throw new WidgetError('invalidAttribute', 'Widget@Name>64')
  const version = requiredAttr(rootSplit.attrs, 'Widget', 'Version').trim()
  const updateUrl = attr(rootSplit.attrs, 'UpdateUrl')?.trim() || undefined
  if (updateUrl && (isBound(updateUrl) || !isSafeHttpsUrl(updateUrl))) {
    throw new WidgetError('invalidUrl', `Widget@UpdateUrl=${updateUrl}`)
  }

  const ctx: ParseCtx = {
    nodes: 0,
    datas: [],
    resources: [],
    functions: [],
    triggers: [],
    staticMediaUrls: [],
    nestedUrls: [],
    aliases: new Set(),
    usingCount: 0,
    names: new Set(),
  }
  const nodes: WidgetNode[] = []
  for (const child of rootSplit.children) {
    ctx.nodes += 1
    if (ctx.nodes > WIDGET_LIMITS.maxNodes) throw new WidgetError('tooManyNodes')
    switch (child.tagName) {
      case 'Data':
        parseData(child, ctx)
        break
      case 'Resources':
        parseResources(child, ctx)
        break
      case 'Triggers':
        parseTriggers(child, ctx)
        break
      case 'Function':
        parseFunction(child, ctx)
        break
      case 'Widget.Using':
      case 'Using':
        nodes.push(parseUsing(child, ctx))
        break
      default:
        nodes.push(parseNode(child, ctx, 1))
        break
    }
  }

  return {
    name,
    version,
    author: attr(rootSplit.attrs, 'Author')?.trim() || undefined,
    description: attr(rootSplit.attrs, 'Description')?.trim() || undefined,
    updateUrl,
    datas: ctx.datas,
    resources: ctx.resources,
    functions: ctx.functions,
    triggers: ctx.triggers,
    nodes,
    staticMediaUrls: ctx.staticMediaUrls,
    nestedUrls: [...new Set(ctx.nestedUrls)],
  }
}

/** 收集函数脚本的可补全上下文（编辑器使用）。 */
export function functionFields(fn: FunctionNode): StructDef[] {
  return fn.structs
}
