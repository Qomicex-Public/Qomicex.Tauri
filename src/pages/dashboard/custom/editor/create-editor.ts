// Copyright (C) 2026 Qomicex Launcher Contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import {
  EditorView,
  keymap,
  lineNumbers,
  highlightActiveLineGutter,
  highlightSpecialChars,
  drawSelection,
  dropCursor,
  rectangularSelection,
  crosshairCursor,
  highlightActiveLine,
} from '@codemirror/view'
import { EditorState, Prec } from '@codemirror/state'
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import { search, searchKeymap, highlightSelectionMatches } from '@codemirror/search'
import {
  bracketMatching,
  foldGutter,
  foldKeymap,
  indentOnInput,
  syntaxHighlighting,
  HighlightStyle,
} from '@codemirror/language'
import {
  autocompletion,
  closeBrackets,
  closeBracketsKeymap,
  acceptCompletion,
  completionStatus,
  startCompletion,
  type Completion,
  type CompletionContext,
  type CompletionResult,
} from '@codemirror/autocomplete'
import { linter, lintGutter, type Diagnostic } from '@codemirror/lint'
import { javascript } from '@codemirror/lang-javascript'
import { xml } from '@codemirror/lang-xml'
import { tags } from '@lezer/highlight'
import { ELEMENT_ATTRS } from '../schema.ts'
import type { CustomWidgetDef } from '../store.ts'
import { parseWidgetXml } from '../xml.ts'
import { transpileScript } from '../script/transpile.ts'

export interface TsCompletionContext {
  inputFields: string[]
  inputs: string[]
  resources: string[]
  data: string[]
  functions: string[]
}

export interface EditorStatus {
  line: number
  column: number
  length: number
}

export interface MountEditorOptions {
  value: string
  language: 'xml' | 'ts'
  getDefs: () => CustomWidgetDef[]
  getTsContext: () => TsCompletionContext
  onChange: (value: string) => void
  onSave?: () => void
  onStatus?: (status: EditorStatus) => void
}

export interface EditorHandle {
  setValue: (value: string) => void
  focus: () => void
  insertCompletion: (label: string) => void
  destroy: () => void
}

const VALUE_SUGGESTIONS: Record<string, string[]> = {
  Size: ['Xs', 'Sm', 'Md', 'Lg', 'Xl', '2Xl'],
  Weight: ['Normal', 'Medium', 'Semibold', 'Bold'],
  Color: ['Default', 'Muted', 'Primary', 'Destructive'],
  Align: ['Start', 'Center', 'End', 'Stretch'],
  Justify: ['Start', 'Center', 'End', 'Between'],
  Variant: ['Default', 'Secondary', 'Outline', 'Ghost', 'Destructive', 'Link'],
  Direction: ['Row', 'Column'],
  Background: ['Transparent', 'Card', 'Muted', 'Primary'],
  Radius: ['None', 'Sm', 'Md', 'Lg', 'Full'],
  Type: ['Json', 'Text', 'Xml', 'Binary', 'Audio', 'Video', 'String', 'Bool', 'Number', 'DateTime'],
  Source: ['Url', 'File', 'Curseforge', 'Modrinth', 'Ftb'],
  Folder: ['Game', 'Logs', 'Data', 'Screenshots'],
  To: ['Instances', 'Downloads', 'Accounts', 'ResourceCenter', 'Settings', 'Connect', 'Running'],
  Event: ['Loaded', 'DataChanged', 'Click', 'Timer'],
  OnClick: ['Launch', 'SetDefaultInstance', 'OpenInstance', 'Navigate', 'OpenUrl', 'OpenFolder', 'Copy', 'SelectAccount', 'Install', 'Refresh', 'CallFunction', 'RunCommand', 'PluginApi'],
  OnChange: ['Launch', 'SetDefaultInstance', 'OpenInstance', 'Navigate', 'OpenUrl', 'OpenFolder', 'Copy', 'SelectAccount', 'Install', 'Refresh', 'CallFunction', 'RunCommand', 'PluginApi'],
  Action: ['Launch', 'SetDefaultInstance', 'OpenInstance', 'Navigate', 'OpenUrl', 'OpenFolder', 'Copy', 'SelectAccount', 'Install', 'Refresh', 'CallFunction', 'RunCommand', 'PluginApi'],
  Category: ['Mod', 'Modpack', 'Shader', 'Resourcepack', 'Datapack', 'Save'],
}

const BOOL_ATTRS = new Set(['Controls', 'AutoPlay', 'Loop', 'Muted', 'Multiline', 'Password', 'ReadOnly', 'Checked', 'Once', 'Rounded', 'Border', 'Wrap'])

function completionOption(label: string, type: Completion['type'], detail?: string): Completion {
  return { label, type, detail }
}

function attributeCompletion(name: string): Completion {
  return {
    label: name,
    type: 'property',
    apply: (view, _completion, from, to) => {
      const insert = `${name}=""`
      view.dispatch({
        changes: { from, to, insert },
        selection: { anchor: from + name.length + 2 },
      })
    },
  }
}

function tagged(text: string, pattern: RegExp): string[] {
  return [...text.matchAll(pattern)].map((match) => match[1]).filter(Boolean)
}

function knownNames(text: string, defs: CustomWidgetDef[]) {
  return {
    data: tagged(text, /<Data\b[^>]*\bName\s*=\s*"([^"]+)"/g),
    resources: tagged(text, /<(?:String|Bool|Number|Binary|Resource)\b[^>]*\bName\s*=\s*"([^"]+)"/g),
    functions: tagged(text, /<Function\b[^>]*\bName\s*=\s*"([^"]+)"/g),
    inputs: tagged(text, /<(?:TextBox|CheckBox|Slider|Select|FilePicker|ColorPicker|Button|Link)\b[^>]*\bName\s*=\s*"([^"]+)"/g),
    aliases: tagged(text, /<Widget\.Using\b[^>]*\bAs\s*=\s*"([^"]+)"/g),
    widgets: defs.map((def) => def.name),
  }
}

function bindingCompletion(context: CompletionContext, text: string): CompletionResult | null {
  const before = text.slice(0, context.pos)
  const match = before.match(/\{([\w.-]*)$/)
  if (!match) return null
  const prefix = match[1]
  const start = context.pos - prefix.length
  const parts = prefix.split('.')
  const names = knownNames(text, [])
  const options: Completion[] = []
  const push = (values: string[], type: Completion['type']) => {
    for (const value of values) options.push(completionOption(value, type))
  }
  if (parts.length === 1) {
    push(['Data', 'Resources', 'Inputs', 'Results', 'Children', 'State'], 'namespace')
  } else if (parts[0] === 'Data') {
    push(names.data, 'variable')
  } else if (parts[0] === 'Resources') {
    push(names.resources, 'variable')
  } else if (parts[0] === 'Inputs') {
    push(names.inputs, 'variable')
  } else if (parts[0] === 'Results') {
    push(names.functions, 'function')
  } else if (parts[0] === 'Children') {
    push(names.aliases, 'variable')
  } else if (parts[0] === 'State') {
    push(['Loading', 'Error'], 'property')
  }
  if (options.length === 0) return null
  return { from: start, options, validFor: /^[\w.-]*$/ }
}

function xmlCompletion(context: CompletionContext, getDefs: () => CustomWidgetDef[]): CompletionResult {
  const text = context.state.doc.toString()
  const defs = getDefs()

  const binding = bindingCompletion(context, text)
  if (binding) return binding

  const before = text.slice(0, context.pos)
  const valueMatch = before.match(/([A-Za-z.]+)\s*=\s*["'][^"']*$/)
  if (valueMatch) {
    const attr = valueMatch[1].split('.').pop() ?? ''
    const word = context.matchBefore(/[\w-]*/)
    if (!word || (word.from === word.to && !context.explicit)) return { from: context.pos, options: [] }
    const names = knownNames(text, defs)
    let values: string[] = VALUE_SUGGESTIONS[attr] ?? []
    if (attr === 'Name') values = [...names.widgets, ...names.inputs, ...names.data]
    if (attr === 'Function') values = names.functions
    if (attr === 'Control') values = names.inputs
    if (attr === 'Data') values = names.data
    if (BOOL_ATTRS.has(attr)) values = ['True', 'False']
    if (attr === 'Url' || attr === 'UpdateUrl') values = ['https://']
    const options = values.map((value) => completionOption(value, attr === 'Url' ? 'text' : 'enum'))
    return { from: word.from, options, validFor: /^[\w-]*$/ }
  }

  const openTag = before.match(/<([A-Za-z][\w.]*)\s+[^<>]*$/)
  if (openTag) {
    const tag = openTag[1]
    const attrs = ELEMENT_ATTRS[tag] ?? []
    const word = context.matchBefore(/[\w.-]*/)
    const options = [
      ...attrs.map((attr) => attributeCompletion(attr)),
      ...['Grid.Row', 'Grid.Column', 'Grid.RowSpan', 'Grid.ColumnSpan'].map((attr) => attributeCompletion(attr)),
    ]
    return { from: word?.from ?? context.pos, options, validFor: /^[\w.-]*$/ }
  }

  const tagPrefix = before.match(/<([A-Za-z][\w.]*)$/)
  if (tagPrefix) {
    const from = context.pos - tagPrefix[1].length
    const options = [
      ...Object.keys(ELEMENT_ATTRS).map((tag) => completionOption(tag, 'type')),
      completionOption('Widget.Using', 'type'),
      completionOption('Struct', 'type'),
      completionOption('Field', 'type'),
      completionOption('Trigger', 'type'),
    ]
    return { from, options, validFor: /^[\w.-]*$/ }
  }

  if (/<$/.test(before)) {
    return {
      from: context.pos,
      options: [
        ...Object.keys(ELEMENT_ATTRS).map((tag) => completionOption(tag, 'type')),
        completionOption('Widget.Using', 'type'),
        completionOption('Struct', 'type'),
        completionOption('Field', 'type'),
        completionOption('Trigger', 'type'),
      ],
      validFor: /^[\w.-]*$/,
    }
  }

  const word = context.matchBefore(/[\w.-]*/)
  if (!word || (word.from === word.to && !context.explicit)) return { from: context.pos, options: [] }
  const options = [
    ...Object.keys(ELEMENT_ATTRS).map((tag) => completionOption(tag, 'type')),
    completionOption('Widget.Using', 'type'),
    completionOption('Struct', 'type'),
    completionOption('Field', 'type'),
    completionOption('Trigger', 'type'),
    completionOption('String', 'type'),
    completionOption('Bool', 'type'),
    completionOption('Number', 'type'),
    completionOption('Binary', 'type'),
    completionOption('Resource', 'type'),
  ]
  return { from: word.from, options, validFor: /^[\w.-]*$/ }
}

function positionOfLine(text: string, line: number, column: number): number {
  const lines = text.split('\n')
  let offset = 0
  for (let i = 0; i < Math.min(line - 1, lines.length); i += 1) offset += lines[i].length + 1
  return Math.min(text.length, offset + Math.max(0, column - 1))
}

function locateError(text: string, error: unknown): { from: number; to: number; message: string } {
  const raw = error instanceof Error ? error.message : String(error)
  const lineMatch = raw.match(/line\s+(\d+)\s+(?:at\s+column\s+(\d+))?/i)
  if (lineMatch) {
    const from = positionOfLine(text, Number(lineMatch[1]), Number(lineMatch[2] ?? 1))
    return { from, to: Math.min(text.length, from + 1), message: raw }
  }
  const detail = raw.includes(':') ? raw.slice(raw.indexOf(':') + 1).trim() : raw
  const token = detail.split(/[=:\s]/)[1] ?? detail.split(/[=:\s]/)[0]
  if (token) {
    const bare = token.split('@').pop() ?? token
    const index = text.indexOf(`<${bare}`) >= 0 ? text.indexOf(`<${bare}`) : text.indexOf(`${bare}=`)
    if (index >= 0) return { from: index, to: Math.min(text.length, index + bare.length + 1), message: raw }
  }
  return { from: 0, to: Math.min(1, text.length), message: raw }
}

function xmlSlashCloseTag() {
  return Prec.highest(EditorView.inputHandler.of((view, from, to, text) => {
    if (text !== '/' || from !== to || view.composing || view.state.readOnly) return false
    const start = Math.max(0, from - 500)
    const before = view.state.sliceDoc(start, from)
    const lt = before.lastIndexOf('<')
    if (lt < 0) return false
    const fragment = before.slice(lt)
    if (fragment.startsWith('</') || fragment.includes('>')) return false
    if (!/^<[A-Za-z][\w.:-]*(\s|$)/.test(fragment)) return false
    for (const quote of ['"', "'"]) {
      if ((fragment.split(quote).length - 1) % 2 === 1) return false
    }
    const next = view.state.sliceDoc(to, Math.min(view.state.doc.length, to + 1))
    const insert = next === '>' ? '/' : '/>'
    view.dispatch({
      changes: { from, to, insert },
      selection: { anchor: from + insert.length },
      userEvent: 'input.complete',
    })
    return true
  }))
}

function xmlLintExtension() {
  return linter((view) => {
    const text = view.state.doc.toString()
    try {
      parseWidgetXml(text)
      return [] as Diagnostic[]
    } catch (error) {
      return [{ ...locateError(text, error), severity: 'error' } as Diagnostic]
    }
  }, { delay: 300 })
}

function tsLintExtension() {
  return linter((view) => {
    const text = view.state.doc.toString()
    try {
      transpileScript(text)
      return [] as Diagnostic[]
    } catch (error) {
      return [{ ...locateError(text, error), severity: 'error' } as Diagnostic]
    }
  }, { delay: 300 })
}

function tsCompletion(context: CompletionContext, getContext: () => TsCompletionContext): CompletionResult | null {
  const before = context.state.doc.toString().slice(0, context.pos)
  const match = before.match(/([A-Za-z_$][\w$]*)\.([\w$]*)$/)
  if (!match) return null
  const ctx = getContext()
  const values = ({
    Input: ctx.inputFields,
    Inputs: ctx.inputs,
    Resources: ctx.resources,
    Data: ctx.data,
    Results: ctx.functions,
    Host: ['Notify', 'OpenUrl', 'Navigate', 'Log'],
  } as Record<string, string[]>)[match[1]]
  if (!values) return null
  const start = context.pos - match[2].length
  return {
    from: start,
    options: values.map((value) => completionOption(value, 'property')),
    validFor: /^[\w$]*$/,
  }
}

const highlightStyle = HighlightStyle.define([
  { tag: tags.tagName, color: 'hsl(var(--primary))' },
  { tag: tags.attributeName, color: 'hsl(var(--chart-2, 200 80% 55%))' },
  { tag: tags.string, color: 'hsl(var(--chart-3, 150 60% 50%))' },
  { tag: tags.number, color: 'hsl(var(--chart-4, 30 80% 55%))' },
  { tag: tags.keyword, color: 'hsl(var(--primary))' },
  { tag: tags.comment, color: 'hsl(var(--muted-foreground))', fontStyle: 'italic' },
  { tag: tags.typeName, color: 'hsl(var(--chart-5, 280 60% 60%))' },
  { tag: tags.propertyName, color: 'hsl(var(--foreground))' },
])

const editorTheme = EditorView.theme({
  '&': {
    height: '100%',
    backgroundColor: 'transparent',
    color: 'hsl(var(--foreground))',
    fontSize: '12px',
  },
  '.cm-scroller': {
    overflow: 'auto',
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace',
  },
  '.cm-content': {
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace',
    padding: '8px 0',
  },
  '.cm-gutters': {
    backgroundColor: 'transparent',
    color: 'hsl(var(--muted-foreground) / 0.7)',
    border: 'none',
  },
  '.cm-activeLine': { backgroundColor: 'hsl(var(--accent) / 0.35)' },
  '.cm-activeLineGutter': { backgroundColor: 'transparent', color: 'hsl(var(--foreground))' },
  '&.cm-focused': { outline: 'none' },
  '.cm-selectionBackground, &.cm-focused .cm-selectionBackground': {
    backgroundColor: 'hsl(var(--primary) / 0.25) !important',
  },
  '.cm-tooltip': {
    backgroundColor: 'hsl(var(--popover))',
    border: '1px solid hsl(var(--border))',
    color: 'hsl(var(--popover-foreground))',
  },
  '.cm-tooltip-autocomplete > ul > li[aria-selected]': {
    backgroundColor: 'hsl(var(--accent))',
    color: 'hsl(var(--accent-foreground))',
  },
  '.cm-panels': {
    backgroundColor: 'hsl(var(--background))',
    color: 'hsl(var(--foreground))',
  },
  '.cm-searchMatch': { backgroundColor: 'hsl(var(--primary) / 0.3)' },
})

export function mountEditor(parent: HTMLElement, options: MountEditorOptions): EditorHandle {
  const onChangeRef = { current: options.onChange }
  const onSaveRef = { current: options.onSave }
  const onStatusRef = { current: options.onStatus }
  const getDefs = options.getDefs
  const getTsContext = options.getTsContext

  const extensions = [
    lineNumbers(),
    highlightActiveLineGutter(),
    highlightSpecialChars(),
    history(),
    foldGutter(),
    drawSelection(),
    dropCursor(),
    EditorState.allowMultipleSelections.of(true),
    indentOnInput(),
    search({ top: true }),
    highlightSelectionMatches(),
    highlightActiveLine(),
    rectangularSelection(),
    crosshairCursor(),
    editorTheme,
    syntaxHighlighting(highlightStyle),
    bracketMatching(),
    closeBrackets(),
    lintGutter(),
    keymap.of([
      ...closeBracketsKeymap,
      ...defaultKeymap,
      ...historyKeymap,
      ...searchKeymap,
      ...foldKeymap,
      indentWithTab,
      { key: 'Mod-s', run: () => { onSaveRef.current?.(); return true } },
      { key: 'Mod-Space', run: (view) => { startCompletion(view); return true } },
    ]),
    Prec.highest(keymap.of([
      { key: 'Tab', run: (view) => (completionStatus(view.state) === 'active' ? acceptCompletion(view) : false) },
      { key: 'Enter', run: (view) => (completionStatus(view.state) === 'active' ? acceptCompletion(view) : false) },
    ])),
    EditorView.updateListener.of((update) => {
      if (update.docChanged) onChangeRef.current(update.state.doc.toString())
      if (update.selectionSet || update.docChanged) {
        const head = update.state.selection.main.head
        const line = update.state.doc.lineAt(head)
        onStatusRef.current?.({
          line: line.number,
          column: head - line.from + 1,
          length: update.state.doc.length,
        })
      }
    }),
  ]

  if (options.language === 'xml') {
    extensions.push(
      xml(),
      xmlSlashCloseTag(),
      autocompletion({
        override: [(context) => xmlCompletion(context, getDefs)],
        selectOnOpen: true,
        activateOnTyping: true,
        defaultKeymap: true,
        interactionDelay: 0,
      }),
      xmlLintExtension(),
    )
  } else {
    extensions.push(
      javascript({ typescript: true }),
      autocompletion({ override: [(context) => tsCompletion(context, getTsContext)] }),
      tsLintExtension(),
    )
  }

  const view = new EditorView({
    state: EditorState.create({ doc: options.value, extensions }),
    parent,
  })

  return {
    setValue: (value: string) => {
      if (view.state.doc.toString() === value) return
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: value } })
    },
    focus: () => view.focus(),
    insertCompletion: (label: string) => {
      const pos = view.state.selection.main.head
      const start = Math.max(0, pos - 500)
      const before = view.state.sliceDoc(start, pos)
      const word = before.match(/[\w.:-]*$/)?.[0] ?? ''
      const from = pos - word.length
      const fragment = before.slice(before.lastIndexOf('<'))
      const inTag = /^<[A-Za-z][\w.:-]*(\s|$)/.test(fragment) && !fragment.includes('>')
      const quoted = (fragment.match(/"/g)?.length ?? 0) % 2 === 1
      const isValue = quoted || /\{[\w.:-]*$/.test(before)
      const insert = inTag && !isValue && !/^<[A-Za-z][\w.:-]*$/.test(fragment) ? `${label}=""` : label
      view.dispatch({
        changes: { from, to: pos, insert },
        selection: { anchor: from + insert.length - (inTag && !isValue && !/^<[A-Za-z][\w.:-]*$/.test(fragment) ? 1 : 0) },
        userEvent: 'input.complete',
      })
      view.focus()
    },
    destroy: () => view.destroy(),
  }
}
