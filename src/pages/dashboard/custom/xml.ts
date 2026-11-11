// Copyright (C) 2026 Qomicex Launcher Contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import {
  ACTION_ARGS,
  ACTION_NAMES,
  ACTION_REQUIRED,
  ATTACHED_ATTRS,
  CONTENT_PROPERTY,
  DATA_SOURCES,
  DATA_TYPES,
  DIALOG_SIZES,
  ANIMATION_EASINGS,
  ANIMATION_KINDS,
  ANIMATION_TRIGGERS,
  CONVERTER_TYPES,
  ELEMENT_ATTRS,
  FIELD_TYPES,
  FOLDER_TARGETS,
  INSTALL_CATEGORIES,
  INSTALL_SOURCES,
  NAV_TARGETS,
  NODE_ATTRS,
  NODE_TAGS,
  TRIGGER_EVENTS,
  WIDGET_LIMITS,
  WidgetError,
  assertSafeXml,
  isBound,
  isSafeHttpsUrl,
  isVersionRequirement,
  parseTtlSpec,
  sanitizeAlias,
  validateIdentifier,
  type ActionName,
  type DataSourceSpec,
} from './schema.ts'
import type {
  ActionSpec,
  AnimationSpec,
  ButtonNode,
  CheckBoxNode,
  ConverterSpec,
  ConverterType,
  ColorPickerNode,
  ColumnNode,
  ContainerNode,
  DialogNode,
  EffectSpec,
  FilePickerNode,
  FunctionNode,
  FunctionInput,
  FunctionOutput,
  GridAttached,
  GridNode,
  IfNode,
  ImageNode,
  InputDecl,
  LinkNode,
  ListItemNode,
  ListNode,
  MediaNode,
  OutputDecl,
  PageNode,
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
import { validateWhen } from './responsive.ts'
import { parseBinding } from './converters.ts'

interface ParseCtx {
  nodes: number
  datas: DataSourceSpec[]
  converters: ConverterSpec[]
  resources: ResourceEntry[]
  functions: FunctionNode[]
  triggers: TriggerNode[]
  staticMediaUrls: string[]
  nestedUrls: string[]
  aliases: Set<string>
  usingCount: number
  names: Set<string>
  inputs: InputDecl[]
  outputs: OutputDecl[]
  pages: Map<string, PageNode[]>
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
    } else if (child.tagName === 'Widget.Inputs' || child.tagName === 'Widget.Outputs' || child.tagName === 'Widget.Converters') {
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
    if (name === 'Effects' || name === 'Animations') continue
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
      if (!(NODE_TAGS.has(tag) && (NODE_ATTRS as readonly string[]).includes(name))) {
        throw new WidgetError('unknownAttribute', `${tag}.${name}`)
      }
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

/** 内容语法：标签之间的文本等价于给 ContentProperty 赋值。 */
function applyContentProperty(
  tag: string,
  attrs: Map<string, string>,
  el: Element,
  children: Element[],
): void {
  const property = CONTENT_PROPERTY[tag]
  if (!property) return
  const text = directText(el)
  if (children.length > 0) {
    throw new WidgetError('unknownElement', `${tag} 的内容只能是文本，子元素请用属性元素或容器`)
  }
  if (!text) return
  if (attrs.has(property)) {
    throw new WidgetError('duplicateProperty', `${tag}.${property} 同时通过属性和内容赋值`)
  }
  attrs.set(property, text)
}

function validateAttrs(tag: string, attrs: Map<string, string>): void {
  const allowed = new Set<string>([
    ...(ELEMENT_ATTRS[tag] ?? []),
    ...ATTACHED_ATTRS,
    ...(NODE_TAGS.has(tag) ? NODE_ATTRS : []),
  ])
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

function parsePageReference(value: string): string {
  const raw = value.trim().replace(/^\{(.*)\}$/s, '$1').trim()
  const name = raw.startsWith('Resources.') ? raw.slice('Resources.'.length) : raw
  validateIdentifier(name, `Content=${value}`)
  return name
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
  const dialog = actionName.trim().replace(/^\{(.*)\}$/s, '$1').match(/^([A-Za-z_][A-Za-z0-9_-]*)\.(Show|Hide)$/)
  if (dialog) {
    return {
      name: dialog[2] === 'Show' ? 'ShowDialog' : 'HideDialog',
      args: { Target: dialog[1] },
    }
  }
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

function parseInputs(el: Element, ctx: ParseCtx): void {
  const { attrs, children } = readElement(el)
  validateAttrs('Widget.Inputs', attrs)
  assertNoText(el)
  for (const child of children) {
    if (child.tagName !== 'Input') throw new WidgetError('invalidAttribute', `Widget.Inputs 内不允许 ${child.tagName}`)
    if (ctx.inputs.length >= 32) throw new WidgetError('tooManyNodes')
    const split = readElement(child)
    applyProperties('Input', split.attrs, split.propertyElements)
    validateAttrs('Input', split.attrs)
    if (split.children.length > 0) throw new WidgetError('invalidAttribute', 'Input 不能包含子元素')
    const name = requiredAttr(split.attrs, 'Input', 'Name').trim()
    validateIdentifier(name, 'Input@Name')
    if (ctx.inputs.some((item) => item.name === name)) throw new WidgetError('invalidAttribute', `Input 重复: ${name}`)
    ctx.inputs.push({
      name,
      type: enumAttr(split.attrs, 'Input', 'Type', FIELD_TYPES, 'String')!,
      required: boolAttr(split.attrs, 'Input', 'Required', false),
      default: attr(split.attrs, 'Default'),
    })
  }
}

function parseOutputs(el: Element, ctx: ParseCtx): void {
  const { attrs, children } = readElement(el)
  validateAttrs('Widget.Outputs', attrs)
  assertNoText(el)
  for (const child of children) {
    if (child.tagName !== 'Output') throw new WidgetError('invalidAttribute', `Widget.Outputs 内不允许 ${child.tagName}`)
    if (ctx.outputs.length >= 32) throw new WidgetError('tooManyNodes')
    const split = readElement(child)
    applyProperties('Output', split.attrs, split.propertyElements)
    validateAttrs('Output', split.attrs)
    if (split.children.length > 0) throw new WidgetError('invalidAttribute', 'Output 不能包含子元素')
    const name = requiredAttr(split.attrs, 'Output', 'Name').trim()
    validateIdentifier(name, 'Output@Name')
    if (['__proto__', 'constructor', 'prototype'].includes(name)) {
      throw new WidgetError('invalidAttribute', `Output@Name=${name}`)
    }
    if (ctx.outputs.some((item) => item.name === name)) throw new WidgetError('invalidAttribute', `Output 重复: ${name}`)
    ctx.outputs.push({
      name,
      type: enumAttr(split.attrs, 'Output', 'Type', FIELD_TYPES, 'Json')!,
      source: validatePath(requiredAttr(split.attrs, 'Output', 'Source'), 'Output@Source'),
    })
  }
}

function parseData(el: Element, ctx: ParseCtx): void {
  const { attrs, propertyElements, children } = readElement(el)
  applyProperties('Data', attrs, propertyElements)
  applyContentProperty('Data', attrs, el, children)
  validateAttrs('Data', attrs)
  if (ctx.datas.length >= WIDGET_LIMITS.maxDataSources) throw new WidgetError('tooManyData')
  const name = attr(attrs, 'Name')?.trim() || 'Data'
  validateIdentifier(name, 'Data@Name')
  if (ctx.names.has(`data:${name}`)) throw new WidgetError('duplicateData', name)
  const type = enumAttr(attrs, 'Data', 'Type', DATA_TYPES, 'Json')!
  const source = enumAttr(attrs, 'Data', 'Source', DATA_SOURCES, 'Url')!
  const refresh = intAttr(attrs, 'Data', 'Refresh', 0, 86400, 3600)
  const async = boolAttr(attrs, 'Data', 'Async', true)
  const mime = attr(attrs, 'Mime')?.trim() || undefined
  if (source === 'Url') {
    const url = requiredAttr(attrs, 'Data', 'Url')
    if (!isBound(url) && !isSafeHttpsUrl(url)) throw new WidgetError('invalidUrl', `Data@Url=${url}`)
    ctx.datas.push({ name, type, source, url, refresh, mime, async })
  } else {
    const path = requiredAttr(attrs, 'Data', 'Path')
    ctx.datas.push({ name, type, source, path, refresh, mime, async })
  }
  ctx.names.add(`data:${name}`)
}

function parseResources(el: Element, ctx: ParseCtx, depth: number): void {
  const { attrs, children } = readElement(el)
  validateAttrs('Resources', attrs)
  assertNoText(el)
  for (const child of children) {
    if (!['String', 'Bool', 'Number', 'Binary', 'Resource'].includes(child.tagName)) {
      throw new WidgetError('invalidResource', `Resources 内不允许 ${child.tagName}`)
    }
    const split = readElement(child)
    applyProperties(child.tagName, split.attrs, split.propertyElements)
    validateAttrs(child.tagName, split.attrs)
    const name = requiredAttr(split.attrs, child.tagName, 'Name').trim()
    validateIdentifier(name, `${child.tagName}@Name`)
    if (ctx.names.has(`resource:${name}`)) throw new WidgetError('invalidResource', `重复资源 ${name}`)
    if (child.tagName === 'Resource' && split.attrs.get('Type')?.trim() === 'Page') {
      if (Array.from(child.childNodes).some((node) => node.nodeType === 3 && node.textContent?.trim())) {
        throw new WidgetError('invalidResource', `Page ${name} 不能包含直接文本`)
      }
      const page = parsePageChildren(child, ctx, depth + 1)
      ctx.resources.push({ name, type: 'Page', value: '', page })
      ctx.pages.set(name, page)
      ctx.names.add(`resource:${name}`)
      continue
    }
    if (Array.from(child.children).length > 0) {
      throw new WidgetError('invalidResource', `${child.tagName} 不能包含子元素`)
    }
    let type: ResourceEntry['type']
    const textAttr = attr(split.attrs, 'Text')
    const textContent = (child.textContent ?? '').trim()
    if (textAttr !== undefined && textContent) {
      throw new WidgetError('duplicateProperty', `${child.tagName}@Text`)
    }
    let value = (textAttr ?? textContent).trim()
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
    const effectsEl = split.propertyElements.get('Effects')
    const effects = effectsEl ? parseEffects(effectsEl) : undefined
    if (functionName && actionName) throw new WidgetError('invalidTrigger', 'Function 与 Action 只能二选一')
    if (!functionName && !actionName && !effects) throw new WidgetError('invalidTrigger', 'Trigger 需要 Function、Action 或 Effects')

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
      target: attr(split.attrs, 'Target')?.trim() || undefined,
      effects,
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
  const argumentsJson = attr(attrs, 'Arguments')?.trim() || undefined
  if (refUrl) ctx.nestedUrls.push(refUrl)
  return {
    kind: 'using',
    name: refName,
    url: refUrl,
    as,
    refresh: attrs.has('Refresh') ? intAttr(attrs, 'Using', 'Refresh', 60, 86400) : undefined,
    argumentsJson,
    ...baseNode('Using', attrs),
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

function parseConverters(el: Element, ctx: ParseCtx): void {
  const { attrs, children } = readElement(el)
  validateAttrs(el.tagName, attrs)
  assertNoText(el)
  for (const child of children) {
    if (child.tagName !== 'Converter') throw new WidgetError('invalidConverter', `Converters 内不允许 ${child.tagName}`)
    if (ctx.converters.length >= WIDGET_LIMITS.maxConverters) throw new WidgetError('tooManyNodes')
    ctx.nodes += 1
    if (ctx.nodes > WIDGET_LIMITS.maxNodes) throw new WidgetError('tooManyNodes')
    const split = readElement(child)
    validateAttrs('Converter', split.attrs)
    const name = requiredAttr(split.attrs, 'Converter', 'Name').trim()
    validateIdentifier(name, 'Converter@Name')
    if (ctx.names.has(`converter:${name}`)) throw new WidgetError('invalidConverter', `重复 Converter ${name}`)
    const type = enumAttr(split.attrs, 'Converter', 'Type', CONVERTER_TYPES, 'String') as ConverterType
    const map: Array<{ from: string; to: string }> = []
    for (const mapEntry of split.children) {
      if (mapEntry.tagName !== 'MapEntry' || type !== 'Map') {
        throw new WidgetError('invalidConverter', `${name} 不允许子元素 ${mapEntry.tagName}`)
      }
      if (map.length >= WIDGET_LIMITS.maxMapEntries) throw new WidgetError('invalidConverter', `${name} 的 MapEntry 超过上限`)
      ctx.nodes += 1
      if (ctx.nodes > WIDGET_LIMITS.maxNodes) throw new WidgetError('tooManyNodes')
      const entry = readElement(mapEntry)
      validateAttrs('MapEntry', entry.attrs)
      if (entry.children.length > 0) throw new WidgetError('invalidConverter', 'MapEntry 不能包含子元素')
      map.push({
        from: requiredAttr(entry.attrs, 'MapEntry', 'From'),
        to: requiredAttr(entry.attrs, 'MapEntry', 'To'),
      })
    }
    const convertScript = split.propertyElements.get('Convert')?.textContent?.trim() || undefined
    const convertBackScript = split.propertyElements.get('ConvertBack')?.textContent?.trim() || undefined
    if (type === 'Script' && !convertScript) throw new WidgetError('invalidConverter', `${name} 缺少 Convert 脚本`)
    const bytes = new TextEncoder().encode(`${convertScript ?? ''}${convertBackScript ?? ''}`).length
    if (bytes > WIDGET_LIMITS.maxScriptBytes) throw new WidgetError('invalidConverter', `${name} 脚本超过 64KB`)
    ctx.converters.push({
      name,
      type,
      format: attr(split.attrs, 'Format')?.trim() || undefined,
      map: map.length > 0 ? map : undefined,
      convertScript,
      convertBackScript,
    })
    ctx.names.add(`converter:${name}`)
  }
}

function parseEffects(el: Element): EffectSpec[] {
  const { attrs, children } = readElement(el)
  validateAttrs('Effects', attrs)
  assertNoText(el)
  const effects: EffectSpec[] = []
  for (const child of children) {
    if (child.children.length > 0) throw new WidgetError('invalidAttribute', `${child.tagName} 不能包含子元素`)
    const split = readElement(child)
    validateAttrs(child.tagName, split.attrs)
    switch (child.tagName) {
      case 'ShadowEffect': {
        const color = (attr(split.attrs, 'Color') ?? 'Black').trim()
        if (!/^[#A-Za-z0-9(),.%\s-]+$/.test(color)) {
          throw new WidgetError('invalidAttribute', `ShadowEffect@Color=${color}`)
        }
        effects.push({
          kind: 'shadow',
          radius: numberAttr(split.attrs, 'ShadowEffect', 'Radius', 0, 100, 5),
          color,
          offsetX: numberAttr(split.attrs, 'ShadowEffect', 'OffsetX', -100, 100, 0),
          offsetY: numberAttr(split.attrs, 'ShadowEffect', 'OffsetY', -100, 100, 0),
          spread: numberAttr(split.attrs, 'ShadowEffect', 'Spread', 0, 100, 0),
          inset: boolAttr(split.attrs, 'ShadowEffect', 'Inset', false),
        })
        break
      }
      case 'BlurEffect':
        effects.push({ kind: 'blur', radius: numberAttr(split.attrs, 'BlurEffect', 'Radius', 0, 100, 5) })
        break
      case 'OpacityEffect':
        effects.push({ kind: 'opacity', value: numberAttr(split.attrs, 'OpacityEffect', 'Value', 0, 1, 1) })
        break
      case 'ScaleEffect':
        effects.push({ kind: 'scale', value: numberAttr(split.attrs, 'ScaleEffect', 'Value', 0, 10, 1) })
        break
      case 'RotateEffect':
        effects.push({ kind: 'rotate', angle: numberAttr(split.attrs, 'RotateEffect', 'Angle', -360, 360, 0) })
        break
      default:
        throw new WidgetError('unknownElement', `Effects 内不允许 ${child.tagName}`)
    }
  }
  return effects
}

function parseAnimations(el: Element): AnimationSpec[] {
  const { attrs, children } = readElement(el)
  validateAttrs('Animations', attrs)
  assertNoText(el)
  const animations: AnimationSpec[] = []
  for (const child of children) {
    if (child.children.length > 0) throw new WidgetError('invalidAnimation', `${child.tagName} 不能包含子元素`)
    const split = readElement(child)
    validateAttrs(child.tagName, split.attrs)
    if (!(ANIMATION_KINDS as readonly string[]).includes(child.tagName)) {
      throw new WidgetError('invalidAnimation', `Animations 内不允许 ${child.tagName}`)
    }
    const kind = child.tagName.replace('In', '').replace('To', '').toLowerCase() as AnimationSpec['kind']
    const repeatRaw = attr(split.attrs, 'Repeat')?.trim()
    const repeat = repeatRaw === 'Infinite'
      ? 'Infinite'
      : repeatRaw
        ? intAttr(split.attrs, child.tagName, 'Repeat', 1, 100)
        : 1
    animations.push({
      kind: kind === 'fade' ? 'fade' : kind === 'slide' ? 'slide' : kind === 'scale' ? 'scale' : kind === 'rotate' ? 'rotate' : kind === 'pulse' ? 'pulse' : 'spin',
      duration: intAttr(split.attrs, child.tagName, 'Duration', 0, 10000, 300),
      delay: intAttr(split.attrs, child.tagName, 'Delay', 0, 10000, 0),
      easing: enumAttr(split.attrs, child.tagName, 'Easing', ANIMATION_EASINGS, 'Ease')!,
      repeat,
      trigger: enumAttr(split.attrs, child.tagName, 'Trigger', ANIMATION_TRIGGERS, 'Loaded')!,
      from: split.attrs.has('From') ? numberAttr(split.attrs, child.tagName, 'From', -1000, 1000) : undefined,
      to: split.attrs.has('To') ? numberAttr(split.attrs, child.tagName, 'To', -1000, 1000) : undefined,
      direction: child.tagName === 'SlideIn'
        ? enumAttr(split.attrs, child.tagName, 'Direction', ['Left', 'Right', 'Top', 'Bottom'] as const, 'Bottom')
        : undefined,
      distance: child.tagName === 'SlideIn'
        ? numberAttr(split.attrs, child.tagName, 'Distance', 0, 500, 8)
        : undefined,
    })
  }
  return animations
}

function parseNode(el: Element, ctx: ParseCtx, depth: number): WidgetNode {
  const node = parseNodeInner(el, ctx, depth)
  const { propertyElements } = readElement(el)
  const effects = propertyElements.get('Effects')
  if (effects) node.effects = parseEffects(effects)
  const animations = propertyElements.get('Animations')
  if (animations) node.animations = parseAnimations(animations)
  return node
}

function parseNodeInner(el: Element, ctx: ParseCtx, depth: number): WidgetNode {
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
    case 'Dialog':
      return parseDialog(el, ctx, depth)
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
      return { kind: 'divider', ...baseNode('Divider', attrs) }
    }
    case 'Spacer': {
      const { attrs, propertyElements, children } = readElement(el)
      applyProperties('Spacer', attrs, propertyElements)
      applyContentProperty('Spacer', attrs, el, children)
      validateAttrs('Spacer', attrs)
      return { kind: 'spacer', size: intAttr(attrs, 'Spacer', 'Size', 0, 96, 8), ...baseNode('Spacer', attrs) } satisfies SpacerNode
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
  const { attrs, propertyElements, children: childEls } = readElement(el)
  applyProperties('Container', attrs, propertyElements)
  validateAttrs('Container', attrs)
  const meta = baseNode('Container', attrs)
  if (meta.contentPage && childEls.length > 0) throw new WidgetError('invalidAttribute', 'Container 不能同时使用 Content 和子元素')
  return {
    kind: 'container',
    ...layoutAttrs(attrs, 'Container'),
    direction: enumAttr(attrs, 'Container', 'Direction', ['Row', 'Column'] as const, 'Column')!,
    border: boolAttr(attrs, 'Container', 'Border', true),
    background: enumAttr(attrs, 'Container', 'Background', ['Transparent', 'Card', 'Muted', 'Primary'] as const, 'Card')!,
    radius: enumAttr(attrs, 'Container', 'Radius', ['None', 'Sm', 'Md', 'Lg', 'Full'] as const, 'Lg')!,
    children: meta.contentPage ? [] : parseChildren(el, ctx, depth + 1),
    ...meta,
  }
}

function parseRowColumn(el: Element, ctx: ParseCtx, depth: number): RowNode | ColumnNode {
  const { attrs, propertyElements, children: childEls } = readElement(el)
  applyProperties(el.tagName, attrs, propertyElements)
  validateAttrs(el.tagName, attrs)
  const meta = baseNode(el.tagName, attrs)
  if (meta.contentPage && childEls.length > 0) throw new WidgetError('invalidAttribute', `${el.tagName} 不能同时使用 Content 和子元素`)
  const common = {
    ...layoutAttrs(attrs, el.tagName),
    wrap: boolAttr(attrs, el.tagName, 'Wrap', false),
    children: meta.contentPage ? [] : parseChildren(el, ctx, depth + 1),
    ...meta,
  }
  return el.tagName === 'Row' ? { kind: 'row', ...common } : { kind: 'column', ...common }
}

function parseGrid(el: Element, ctx: ParseCtx, depth: number): GridNode {
  const { attrs, propertyElements, children: childEls } = readElement(el)
  applyProperties('Grid', attrs, propertyElements)
  validateAttrs('Grid', attrs)
  const meta = baseNode('Grid', attrs)
  if (meta.contentPage && childEls.length > 0) throw new WidgetError('invalidAttribute', 'Grid 不能同时使用 Content 和子元素')
  return {
    kind: 'grid',
    columns: intAttr(attrs, 'Grid', 'Columns', 1, 6),
    ...layoutAttrs(attrs, 'Grid'),
    children: meta.contentPage ? [] : parseChildren(el, ctx, depth + 1),
    ...meta,
  }
}

function parseTabItem(el: Element, ctx: ParseCtx, depth: number): TabItemNode {
  const split = readElement(el)
  applyProperties('TabItem', split.attrs, split.propertyElements)
  validateAttrs('TabItem', split.attrs)
  const meta = baseNode('TabItem', split.attrs)
  if (meta.contentPage && split.children.length > 0) throw new WidgetError('invalidAttribute', 'TabItem 不能同时使用 Content 和子元素')
  return {
    kind: 'tabItem',
    title: requiredAttr(split.attrs, 'TabItem', 'Title'),
    target: meta.target,
    visible: meta.visible,
    when: meta.when,
    contentPage: meta.contentPage,
    effects: split.propertyElements.get('Effects') ? parseEffects(split.propertyElements.get('Effects')!) : undefined,
    animations: split.propertyElements.get('Animations') ? parseAnimations(split.propertyElements.get('Animations')!) : undefined,
    children: meta.contentPage ? [] : parseChildren(el, ctx, depth + 1),
  }
}

function parseListItem(el: Element, ctx: ParseCtx, depth: number): ListItemNode {
  const split = readElement(el)
  applyProperties('ListItem', split.attrs, split.propertyElements)
  validateAttrs('ListItem', split.attrs)
  const meta = baseNode('ListItem', split.attrs)
  if (meta.contentPage && split.children.length > 0) throw new WidgetError('invalidAttribute', 'ListItem 不能同时使用 Content 和子元素')
  if (!meta.contentPage && split.children.length !== 1) {
    throw new WidgetError('listItemRoot', 'ListItem 必须且只能包含一个根元素')
  }
  assertNoText(el)
  return {
    kind: 'listItem',
    target: meta.target,
    visible: meta.visible,
    when: meta.when,
    contentPage: meta.contentPage,
    effects: split.propertyElements.get('Effects') ? parseEffects(split.propertyElements.get('Effects')!) : undefined,
    animations: split.propertyElements.get('Animations') ? parseAnimations(split.propertyElements.get('Animations')!) : undefined,
    child: meta.contentPage ? undefined : parseNode(split.children[0], ctx, depth + 1),
  }
}

function parsePageChildren(el: Element, ctx: ParseCtx, depth: number): PageNode[] {
  if (depth > WIDGET_LIMITS.maxDepth) throw new WidgetError('tooDeep', el.tagName)
  assertNoText(el)
  const { children } = readElement(el)
  const nodes: PageNode[] = []
  for (const child of children) {
    ctx.nodes += 1
    if (ctx.nodes > WIDGET_LIMITS.maxNodes) throw new WidgetError('tooManyNodes')
    if (child.tagName === 'Data') {
      parseData(child, ctx)
      continue
    }
    if (child.tagName === 'TabItem') {
      nodes.push(parseTabItem(child, ctx, depth + 1))
      continue
    }
    if (child.tagName === 'ListItem') {
      nodes.push(parseListItem(child, ctx, depth + 1))
      continue
    }
    nodes.push(parseNode(child, ctx, depth))
  }
  return nodes
}

function parseTabs(el: Element, ctx: ParseCtx, depth: number): TabsNode {
  const { attrs, propertyElements } = readElement(el)
  applyProperties('Tabs', attrs, propertyElements)
  validateAttrs('Tabs', attrs)
  assertNoText(el)
  if (depth + 1 > WIDGET_LIMITS.maxDepth) throw new WidgetError('tooDeep', el.tagName)
  const meta = baseNode('Tabs', attrs)
  const { children: childEls } = readElement(el)
  if (meta.contentPage && childEls.length > 0) throw new WidgetError('invalidAttribute', 'Tabs 不能同时使用 Content 和子元素')
  const children: TabItemNode[] = []
  if (!meta.contentPage) {
    for (const child of childEls) {
      ctx.nodes += 1
      if (ctx.nodes > WIDGET_LIMITS.maxNodes) throw new WidgetError('tooManyNodes')
      if (child.tagName !== 'TabItem') throw new WidgetError('tabsTemplate', `Tabs 内不允许 ${child.tagName}`)
      children.push(parseTabItem(child, ctx, depth + 1))
    }
    if (children.length === 0) throw new WidgetError('tabsTemplate', 'Tabs 至少需要一个 TabItem')
  }
  return {
    kind: 'tabs',
    defaultIndex: intAttr(attrs, 'Tabs', 'Default', 0, Math.max(0, children.length - 1), 0),
    children,
    ...meta,
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
  const meta = baseNode('List', attrs)
  if (meta.contentPage && childEls.length > 0) throw new WidgetError('invalidAttribute', 'List 不能同时使用 Content 和子元素')
  let item: ListItemNode | undefined
  if (!meta.contentPage) {
    if (childEls.length !== 1 || childEls[0].tagName !== 'ListItem') {
      throw new WidgetError('listTemplate', 'List 必须且只能包含一个 ListItem')
    }
    ctx.nodes += 1
    item = parseListItem(childEls[0], ctx, depth + 1)
  }
  return {
    kind: 'list',
    items,
    as,
    gap: intAttr(attrs, 'List', 'Gap', 0, 8, 0),
    emptyText: attr(attrs, 'EmptyText') || undefined,
    item,
    ...meta,
  }
}

function parseIf(el: Element, ctx: ParseCtx, depth: number): IfNode {
  const { attrs, propertyElements, children: childEls } = readElement(el)
  applyProperties('If', attrs, propertyElements)
  validateAttrs('If', attrs)
  const meta = baseNode('If', attrs)
  if (meta.contentPage && childEls.length > 0) throw new WidgetError('invalidAttribute', 'If 不能同时使用 Content 和子元素')
  return {
    kind: 'if',
    test: validatePath(requiredAttr(attrs, 'If', 'Test'), 'If@Test'),
    children: meta.contentPage ? [] : parseChildren(el, ctx, depth + 1),
    ...meta,
  }
}

function parseDialog(el: Element, ctx: ParseCtx, depth: number): DialogNode {
  const { attrs, propertyElements, children: childEls } = readElement(el)
  applyProperties('Dialog', attrs, propertyElements)
  validateAttrs('Dialog', attrs)
  const meta = baseNode('Dialog', attrs)
  const name = requiredAttr(attrs, 'Dialog', 'Name').trim()
  validateIdentifier(name, 'Dialog@Name')
  if (ctx.names.has(`dialog:${name}`)) throw new WidgetError('invalidAttribute', `Dialog 重复: ${name}`)
  ctx.names.add(`dialog:${name}`)
  if (meta.contentPage && childEls.length > 0) throw new WidgetError('invalidAttribute', 'Dialog 不能同时使用 Content 和子元素')
  const width = (attrs.has('Width')
    ? enumAttr(attrs, 'Dialog', 'Width', DIALOG_SIZES, 'Md')
    : attrs.has('Size')
      ? enumAttr(attrs, 'Dialog', 'Size', DIALOG_SIZES, 'Md')
      : 'Md') ?? 'Md'
  return {
    kind: 'dialog',
    name,
    title: attr(attrs, 'Title'),
    width,
    children: meta.contentPage ? [] : parseChildren(el, ctx, depth + 1),
    ...meta,
  }
}

function baseNode(_tag: string, attrs: Map<string, string>) {
  const target = attr(attrs, 'Target')?.trim() || undefined
  if (target) validateIdentifier(target, `${_tag}@Target`)
  const rawWhen = attr(attrs, 'When')?.trim()
  let when: string | undefined
  if (attrs.has('When')) {
    try {
      when = validateWhen(rawWhen ?? '')
    } catch {
      throw new WidgetError('invalidAttribute', `${_tag}@When=${rawWhen ?? ''}`)
    }
  }
  return {
    attached: parseAttached(attrs),
    target,
    visible: attrs.has('Visible') ? boolAttr(attrs, _tag, 'Visible', true) : undefined,
    when,
    contentPage: attr(attrs, 'Content')?.trim() ? parsePageReference(attr(attrs, 'Content')!) : undefined,
  }
}

function parseText(el: Element): TextNode {
  const { attrs, propertyElements, children } = readElement(el)
  applyProperties('Text', attrs, propertyElements)
  applyContentProperty('Text', attrs, el, children)
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

function parseShortcutKeys(el: Element): string[] {
  const { children } = readElement(el)
  const parts: string[] = []
  for (const child of children) {
    if (child.tagName !== 'ShortcutKey') throw new WidgetError('invalidAttribute', `ShortcutKeys 内不允许 ${child.tagName}`)
    const split = readElement(child)
    validateAttrs('ShortcutKey', split.attrs)
    parts.push(requiredAttr(split.attrs, 'ShortcutKey', 'Key').trim())
  }
  const modifiers = new Set<string>()
  let main: string | null = null
  for (const part of parts) {
    for (const token of part.split('+').map((item) => item.trim()).filter(Boolean)) {
      const lower = token.toLowerCase()
      if (lower === 'ctrl' || lower === 'control') modifiers.add('ctrl')
      else if (lower === 'alt') modifiers.add('alt')
      else if (lower === 'shift') modifiers.add('shift')
      else if (lower === 'meta' || lower === 'cmd' || lower === 'command') modifiers.add('meta')
      else {
        if (main) throw new WidgetError('invalidAttribute', 'ShortcutKeys 只能有一个主键')
        if (!/^([a-z0-9]|f([1-9]|1[0-2])|enter|space|escape|tab|backspace|delete|arrow(up|down|left|right))$/i.test(token)) {
          throw new WidgetError('invalidAttribute', `ShortcutKey=${token}`)
        }
        main = lower
      }
    }
  }
  if (!main) throw new WidgetError('invalidAttribute', 'ShortcutKeys 缺少主键')
  return [`${[...modifiers].sort().join('+')}${modifiers.size ? '+' : ''}${main}`]
}

function parseButton(el: Element): ButtonNode {
  const { attrs, propertyElements, children } = readElement(el)
  const shortcutEl = propertyElements.get('ShortcutKeys')
  if (shortcutEl) propertyElements.delete('ShortcutKeys')
  applyProperties('Button', attrs, propertyElements)
  applyContentProperty('Button', attrs, el, children)
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
    shortcuts: shortcutEl ? parseShortcutKeys(shortcutEl) : undefined,
    ...baseNode('Button', attrs),
  }
}

function parseImage(el: Element, ctx: ParseCtx): ImageNode {
  const { attrs, propertyElements, children } = readElement(el)
  applyProperties('Image', attrs, propertyElements)
  applyContentProperty('Image', attrs, el, children)
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
  const { attrs, propertyElements, children } = readElement(el)
  applyProperties('Media', attrs, propertyElements)
  applyContentProperty('Media', attrs, el, children)
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
  const { attrs, propertyElements, children } = readElement(el)
  applyProperties('TextBox', attrs, propertyElements)
  applyContentProperty('TextBox', attrs, el, children)
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
  const { attrs, propertyElements, children } = readElement(el)
  applyProperties('CheckBox', attrs, propertyElements)
  applyContentProperty('CheckBox', attrs, el, children)
  validateAttrs('CheckBox', attrs)
  return {
    kind: 'checkBox',
    name: requiredAttr(attrs, 'CheckBox', 'Name').trim(),
    text: attr(attrs, 'Text'),
    checked: attr(attrs, 'Checked')?.includes('{')
      ? attr(attrs, 'Checked')!
      : boolAttr(attrs, 'CheckBox', 'Checked', false),
    onChange: parseOnChange(attrs, 'CheckBox'),
    ...baseNode('CheckBox', attrs),
  }
}

function parseSlider(el: Element): SliderNode {
  const { attrs, propertyElements, children } = readElement(el)
  applyProperties('Slider', attrs, propertyElements)
  applyContentProperty('Slider', attrs, el, children)
  validateAttrs('Slider', attrs)
  return {
    kind: 'slider',
    name: requiredAttr(attrs, 'Slider', 'Name').trim(),
    value: isBound(attr(attrs, 'Value') ?? '')
      ? attr(attrs, 'Value')!
      : numberAttr(attrs, 'Slider', 'Value', -1_000_000, 1_000_000, 0),
    min: numberAttr(attrs, 'Slider', 'Min', -1_000_000, 1_000_000, 0),
    max: numberAttr(attrs, 'Slider', 'Max', -1_000_000, 1_000_000, 100),
    step: numberAttr(attrs, 'Slider', 'Step', 0.000001, 1_000_000, 1),
    onChange: parseOnChange(attrs, 'Slider'),
    ...baseNode('Slider', attrs),
  }
}

function parseSelect(el: Element): SelectNode {
  const { attrs, propertyElements, children } = readElement(el)
  applyProperties('Select', attrs, propertyElements)
  applyContentProperty('Select', attrs, el, children)
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
  const { attrs, propertyElements, children } = readElement(el)
  applyProperties('Progress', attrs, propertyElements)
  applyContentProperty('Progress', attrs, el, children)
  validateAttrs('Progress', attrs)
  return {
    kind: 'progress',
    value: requiredAttr(attrs, 'Progress', 'Value'),
    max: numberAttr(attrs, 'Progress', 'Max', 0, 1_000_000, 100),
    ...baseNode('Progress', attrs),
  }
}

function parseLink(el: Element): LinkNode {
  const { attrs, propertyElements, children } = readElement(el)
  const shortcutEl = propertyElements.get('ShortcutKeys')
  if (shortcutEl) propertyElements.delete('ShortcutKeys')
  applyProperties('Link', attrs, propertyElements)
  applyContentProperty('Link', attrs, el, children)
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
    shortcuts: shortcutEl ? parseShortcutKeys(shortcutEl) : undefined,
    ...baseNode('Link', attrs),
  }
}

function parseFilePicker(el: Element): FilePickerNode {
  const { attrs, propertyElements, children } = readElement(el)
  applyProperties('FilePicker', attrs, propertyElements)
  applyContentProperty('FilePicker', attrs, el, children)
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
  const { attrs, propertyElements, children } = readElement(el)
  applyProperties('ColorPicker', attrs, propertyElements)
  applyContentProperty('ColorPicker', attrs, el, children)
  validateAttrs('ColorPicker', attrs)
  return {
    kind: 'colorPicker',
    name: requiredAttr(attrs, 'ColorPicker', 'Name').trim(),
    value: attr(attrs, 'Value'),
    onChange: parseOnChange(attrs, 'ColorPicker'),
    ...baseNode('ColorPicker', attrs),
  }
}

function collectPageRefs(nodes: PageNode[], out: Set<string>): void {
  for (const node of nodes) {
    if (node.contentPage) out.add(node.contentPage)
    switch (node.kind) {
      case 'container':
      case 'row':
      case 'column':
      case 'grid':
      case 'if':
      case 'dialog':
        collectPageRefs(node.children, out)
        break
      case 'tabs':
        for (const tab of node.children) {
          if (tab.contentPage) out.add(tab.contentPage)
          collectPageRefs(tab.children, out)
        }
        break
      case 'tabItem':
        collectPageRefs(node.children, out)
        break
      case 'list':
        if (node.item?.contentPage) out.add(node.item.contentPage)
        if (node.item?.child) collectPageRefs([node.item.child], out)
        break
      case 'listItem':
        if (node.child) collectPageRefs([node.child], out)
        break
      default:
        break
    }
  }
}

function validatePageUsage(nodes: PageNode[], ctx: ParseCtx): void {
  for (const node of nodes) {
    switch (node.kind) {
      case 'tabs':
        if (node.contentPage) {
          const page = ctx.pages.get(node.contentPage) ?? []
          if (page.length === 0 || page.some((item) => item.kind !== 'tabItem')) {
            throw new WidgetError('invalidPage', `${node.contentPage} 必须是 Tabs 的 Page`)
          }
        }
        for (const tab of node.children) validatePageUsage(tab.children, ctx)
        break
      case 'list':
        if (node.contentPage) {
          const page = ctx.pages.get(node.contentPage) ?? []
          const items = page.filter((item) => item.kind === 'listItem')
          if (page.length !== 1 || items.length !== 1) {
            throw new WidgetError('invalidPage', `${node.contentPage} 必须包含一个 ListItem`)
          }
        }
        if (node.item?.child) validatePageUsage([node.item.child], ctx)
        break
      case 'container':
      case 'row':
      case 'column':
      case 'grid':
      case 'if':
      case 'dialog':
        validatePageUsage(node.children, ctx)
        break
      case 'tabItem':
        validatePageUsage(node.children, ctx)
        break
      case 'listItem':
        if (node.child) validatePageUsage([node.child], ctx)
        break
      default:
        break
    }
  }
}

function validatePages(ctx: ParseCtx, rootNodes: WidgetNode[]): void {
  const refs = new Set<string>()
  collectPageRefs(rootNodes, refs)
  collectPageRefs([...ctx.pages.values()].flat(), refs)
  for (const name of refs) {
    if (!ctx.pages.has(name)) throw new WidgetError('invalidPage', name)
  }
  validatePageUsage(rootNodes, ctx)
  for (const page of ctx.pages.values()) validatePageUsage(page, ctx)
  const visiting = new Set<string>()
  const visited = new Set<string>()
  const visit = (name: string) => {
    if (visited.has(name)) return
    if (visiting.has(name)) throw new WidgetError('invalidPage', `循环引用 ${name}`)
    visiting.add(name)
    const refsInPage = new Set<string>()
    collectPageRefs(ctx.pages.get(name) ?? [], refsInPage)
    for (const ref of refsInPage) {
      if (!ctx.pages.has(ref)) throw new WidgetError('invalidPage', ref)
      visit(ref)
    }
    visiting.delete(name)
    visited.add(name)
  }
  for (const name of ctx.pages.keys()) visit(name)
}

function collectTargets(nodes: WidgetNode[], out = new Set<string>()): void {
  for (const node of nodes) {
    if (node.target) {
      if (out.has(node.target)) throw new WidgetError('invalidAttribute', `Target 重复: ${node.target}`)
      out.add(node.target)
    }
    switch (node.kind) {
      case 'container':
      case 'row':
      case 'column':
      case 'grid':
      case 'if':
      case 'dialog':
        collectTargets(node.children, out)
        break
      case 'tabs':
        for (const tab of node.children) {
          if (tab.target) {
            if (out.has(tab.target)) throw new WidgetError('invalidAttribute', `Target 重复: ${tab.target}`)
            out.add(tab.target)
          }
          collectTargets(tab.children, out)
        }
        break
      case 'list':
        if (node.item) {
          if (node.item.target) {
            if (out.has(node.item.target)) throw new WidgetError('invalidAttribute', `Target 重复: ${node.item.target}`)
            out.add(node.item.target)
          }
          if (node.item.child) collectTargets([node.item.child], out)
        }
        break
      default:
        break
    }
  }
}

/** 解析并严格校验组件 XML；任何未知元素/属性都直接失败。 */
function validateConverterReferences(value: unknown, names: Set<string>, seen = new Set<unknown>()): void {
  if (typeof value === 'string') {
    for (const match of value.matchAll(/\{([^{}]+)\}/g)) {
      const binding = parseBinding(`{${match[1]}}`)
      if (binding?.converter && !names.has(binding.converter)) {
        throw new WidgetError('invalidConverter', `未知 Converter ${binding.converter}`)
      }
    }
    return
  }
  if (!value || typeof value !== 'object' || seen.has(value)) return
  seen.add(value)
  if (Array.isArray(value)) {
    for (const item of value) validateConverterReferences(item, names, seen)
    return
  }
  for (const [key, item] of Object.entries(value)) {
    if (key === 'script' || key === 'convertScript' || key === 'convertBackScript') continue
    validateConverterReferences(item, names, seen)
  }
}

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
  const launcherVersion = attr(rootSplit.attrs, 'LauncherVersion')?.trim() || undefined
  if (launcherVersion && !isVersionRequirement(launcherVersion)) {
    throw new WidgetError('invalidAttribute', `Widget@LauncherVersion=${launcherVersion}`)
  }
  const updateTtl = attr(rootSplit.attrs, 'UpdateTTL')?.trim() ? parseTtlSpec(attr(rootSplit.attrs, 'UpdateTTL')!) : undefined
  const refreshTtl = attr(rootSplit.attrs, 'RefreshTTL')?.trim() ? parseTtlSpec(attr(rootSplit.attrs, 'RefreshTTL')!) : undefined

  const ctx: ParseCtx = {
    nodes: 0,
    datas: [],
    converters: [],
    resources: [],
    functions: [],
    triggers: [],
    staticMediaUrls: [],
    nestedUrls: [],
    aliases: new Set(),
    usingCount: 0,
    names: new Set(),
    inputs: [],
    outputs: [],
    pages: new Map(),
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
        parseResources(child, ctx, 1)
        break
      case 'Triggers':
        parseTriggers(child, ctx)
        break
      case 'Function':
        parseFunction(child, ctx)
        break
      case 'Widget.Inputs':
        parseInputs(child, ctx)
        break
      case 'Widget.Outputs':
        parseOutputs(child, ctx)
        break
      case 'Widget.Converters':
      case 'Converters':
        parseConverters(child, ctx)
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

  collectTargets(nodes)
  validatePages(ctx, nodes)

  const result: WidgetDocument = {
    name,
    version,
    author: attr(rootSplit.attrs, 'Author')?.trim() || undefined,
    description: attr(rootSplit.attrs, 'Description')?.trim() || undefined,
    updateUrl,
    updateTtl,
    refreshTtl,
    launcherVersion,
    inputs: ctx.inputs,
    outputs: ctx.outputs,
    converters: ctx.converters,
    datas: ctx.datas,
    resources: ctx.resources,
    pages: Object.fromEntries(ctx.pages),
    functions: ctx.functions,
    triggers: ctx.triggers,
    nodes,
    staticMediaUrls: ctx.staticMediaUrls,
    nestedUrls: [...new Set(ctx.nestedUrls)],
  }
  validateConverterReferences(result, new Set(ctx.converters.map((converter) => converter.name)))
  return result
}

/** 收集函数脚本的可补全上下文（编辑器使用）。 */
export function functionFields(fn: FunctionNode): StructDef[] {
  return fn.structs
}
