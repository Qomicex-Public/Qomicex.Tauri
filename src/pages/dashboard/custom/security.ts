// Copyright (C) 2026 Qomicex Launcher Contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import type { ActionSpec, PageNode, TriggerNode, WidgetDocument, WidgetNode } from './types.ts'

export interface ExecutableAction {
  name: string
  args: Record<string, string>
  event?: string
}

interface FunctionCall {
  name: string
  args: Record<string, string>
  event?: string
}

export const BINDING_ROOTS = new Set(['Data', 'Resources', 'Inputs', 'Results', 'Children', 'Size', 'State'])

function pushAction(action: ActionSpec | undefined, out: ExecutableAction[], event?: string): void {
  if (!action) return
  if (action.name !== 'RunCommand' && action.name !== 'PluginApi') return
  out.push({ name: action.name, args: { ...action.args }, ...(event ? { event } : {}) })
}

function pushFunction(
  action: ActionSpec | undefined,
  names?: Set<string>,
  calls?: FunctionCall[],
  event?: string,
): void {
  if (action?.name !== 'CallFunction') return
  const name = action.args.Function?.trim()
  if (!name) return
  names?.add(name)
  calls?.push({ name, args: { ...action.args }, ...(event ? { event } : {}) })
}

function walkNode(
  node: WidgetNode | PageNode,
  out: ExecutableAction[],
  functions?: Set<string>,
  calls?: FunctionCall[],
): void {
  const functionSink = functions ?? new Set<string>()
  if ('actions' in node) {
    for (const action of node.actions ?? []) {
      pushAction(action.action, out, action.event)
      pushFunction(action.action, functionSink, calls, action.event)
    }
  }
  switch (node.kind) {
    case 'button':
    case 'link':
      pushAction(node.onClick, out)
      pushFunction(node.onClick, functionSink, calls)
      break
    case 'textBox':
    case 'checkBox':
    case 'slider':
    case 'select':
    case 'colorPicker':
      pushAction(node.onChange, out)
      pushFunction(node.onChange, functionSink, calls)
      break
    case 'container':
    case 'row':
    case 'column':
    case 'grid':
    case 'if':
    case 'dialog':
      for (const child of node.children) walkNode(child, out, functions, calls)
      break
    case 'tabs':
      for (const tab of node.children) {
        walkNode(tab, out, functions, calls)
        for (const child of tab.children) walkNode(child, out, functions, calls)
      }
      break
    case 'tabItem':
      for (const child of node.children) walkNode(child, out, functions, calls)
      break
    case 'list':
      if (node.item) walkNode(node.item, out, functions, calls)
      break
    case 'listItem':
      if (node.child) walkNode(node.child, out, functions, calls)
      break
    default:
      break
  }
}

export function executableActions(doc: WidgetDocument): ExecutableAction[] {
  const out: ExecutableAction[] = []
  for (const node of doc.nodes) walkNode(node, out)
  for (const page of Object.values(doc.pages)) for (const node of page) walkNode(node, out)
  for (const trigger of doc.triggers) pushAction(trigger.action, out)
  return out
}

function executableFunctionData(doc: WidgetDocument): { names: Set<string>; calls: FunctionCall[] } {
  const names = new Set<string>()
  const calls: FunctionCall[] = []
  for (const node of doc.nodes) walkNode(node, [], names, calls)
  for (const page of Object.values(doc.pages)) for (const node of page) walkNode(node, [], names, calls)
  for (const trigger of doc.triggers) {
    if (trigger.function) names.add(trigger.function)
    pushFunction(trigger.action, names, calls)
  }
  return { names, calls }
}

/**
 * 远程更新只比较“可能执行本机能力”的部分：命令/插件调用，以及存在这些动作时的
 * 函数和触发器。普通数据源、文本、布局变化不触发确认。
 */
export function executableFingerprint(doc: WidgetDocument): string {
  const actions = executableActions(doc)
  const { names: functionNames, calls: functionCalls } = executableFunctionData(doc)
  const converters = doc.converters
    .filter((converter) => converter.convertScript || converter.convertBackScript)
    .map((converter) => ({
      name: converter.name,
      type: converter.type,
      convert: converter.convertScript,
      convertBack: converter.convertBackScript,
    }))
  if (actions.length === 0 && converters.length === 0 && functionNames.size === 0) return ''
  const triggers: Array<Pick<TriggerNode, 'event' | 'function' | 'control' | 'data' | 'interval' | 'once'>> =
    doc.triggers.map(({ event, function: fn, control, data, interval, once }) => ({
      event,
      function: fn,
      control,
      data,
      interval,
      once,
    }))
  const functions = actions.length > 0 || converters.length > 0
    ? doc.functions
    : doc.functions.filter((fn) => functionNames.has(fn.name))
  return JSON.stringify({
    actions,
    converters,
    functionCalls,
    functions: functions.map((fn) => ({ name: fn.name, script: fn.script, timeout: fn.timeout })),
    triggers,
  })
}

export function bindingRoots(template: string | undefined): string[] {
  if (!template) return []
  const roots: string[] = []
  for (const match of template.matchAll(/\{([^{}]+)\}/g)) {
    const root = match[1].trim().split('.')[0]
    if (root && BINDING_ROOTS.has(root)) roots.push(root)
  }
  return roots
}

export function hasExternalBinding(roots: string[]): boolean {
  return roots.some((root) => root === 'Data' || root === 'Results' || root === 'Children')
}

export function commandHash(command: string, workingDirectory?: string): string {
  const text = `${command}\u0000${workingDirectory ?? ''}`
  let hash = 2166136261
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0).toString(16)
}

const approvedExecutables = new Set<string>()
const approvedCommands = new Set<string>()

export function approveExecutable(key: string): void {
  approvedExecutables.add(key)
}

export function isExecutableApproved(key: string): boolean {
  return approvedExecutables.has(key)
}

export function approveCommand(key: string): void {
  approvedCommands.add(key)
}

export function isCommandApproved(key: string): boolean {
  return approvedCommands.has(key)
}
