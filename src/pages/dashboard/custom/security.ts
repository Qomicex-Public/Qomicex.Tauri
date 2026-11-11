// Copyright (C) 2026 Qomicex Launcher Contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import type { ActionSpec, TriggerNode, WidgetDocument, WidgetNode } from './types.ts'

export interface ExecutableAction {
  name: string
  args: Record<string, string>
}

export const BINDING_ROOTS = new Set(['Data', 'Resources', 'Inputs', 'Results', 'Children', 'Size', 'State'])

function pushAction(action: ActionSpec | undefined, out: ExecutableAction[]): void {
  if (!action) return
  if (action.name !== 'RunCommand' && action.name !== 'PluginApi') return
  out.push({ name: action.name, args: { ...action.args } })
}

function walkNode(node: WidgetNode, out: ExecutableAction[]): void {
  switch (node.kind) {
    case 'button':
    case 'link':
      pushAction(node.onClick, out)
      break
    case 'textBox':
    case 'checkBox':
    case 'slider':
    case 'select':
    case 'colorPicker':
      pushAction(node.onChange, out)
      break
    case 'container':
    case 'row':
    case 'column':
    case 'grid':
    case 'if':
      for (const child of node.children) walkNode(child, out)
      break
    case 'tabs':
      for (const tab of node.children) for (const child of tab.children) walkNode(child, out)
      break
    case 'list':
      walkNode(node.item.child, out)
      break
    default:
      break
  }
}

export function executableActions(doc: WidgetDocument): ExecutableAction[] {
  const out: ExecutableAction[] = []
  for (const node of doc.nodes) walkNode(node, out)
  for (const trigger of doc.triggers) pushAction(trigger.action, out)
  return out
}

/**
 * 远程更新只比较“可能执行本机能力”的部分：命令/插件调用，以及存在这些动作时的
 * 函数和触发器。普通数据源、文本、布局变化不触发确认。
 */
export function executableFingerprint(doc: WidgetDocument): string {
  const actions = executableActions(doc)
  if (actions.length === 0) return ''
  const triggers: Array<Pick<TriggerNode, 'event' | 'function' | 'control' | 'data' | 'interval' | 'once'>> =
    doc.triggers.map(({ event, function: fn, control, data, interval, once }) => ({
      event,
      function: fn,
      control,
      data,
      interval,
      once,
    }))
  return JSON.stringify({
    actions,
    functions: doc.functions.map((fn) => ({ name: fn.name, script: fn.script, timeout: fn.timeout })),
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
