// Copyright (C) 2026 Qomicex Launcher Contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { Fragment, useState, type CSSProperties, type ReactNode } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { Button, Checkbox, Select, SelectOption, Tabs, cn } from '../../../components/ui'
import {
  WIDGET_LIMITS,
  hostOf,
  interpolate,
  isSafeHttpsUrl,
  resolvePath,
} from './schema.ts'
import type {
  ActionSpec,
  ButtonNode,
  CheckBoxNode,
  ColorPickerNode,
  ColumnNode,
  ContainerNode,
  FilePickerNode,
  GridNode,
  ImageNode,
  LinkNode,
  ListNode,
  MediaNode,
  ProgressNode,
  RowNode,
  SelectNode,
  SliderNode,
  SpacerNode,
  TabsNode,
  TextBoxNode,
  TextNode,
  UsingNode,
  WidgetNode,
} from './types.ts'

export interface RenderRuntime {
  inputs: Record<string, unknown>
  setInput: (name: string, value: unknown) => void
  data: Record<string, unknown>
  resources: Record<string, unknown>
  results: Record<string, unknown>
  children: Record<string, unknown>
  onAction: (action?: ActionSpec, control?: string) => void
  renderUsing: (node: UsingNode) => ReactNode
  allowedHosts: Set<string>
}

export interface RenderContext extends RenderRuntime {
  scope: Record<string, unknown>
}

const GAP: Record<number, string> = {
  0: 'gap-0', 1: 'gap-1', 2: 'gap-2', 3: 'gap-3', 4: 'gap-4',
  5: 'gap-5', 6: 'gap-6', 7: 'gap-7', 8: 'gap-8',
}
const PADDING: Record<number, string> = {
  0: 'p-0', 1: 'p-1', 2: 'p-2', 3: 'p-3', 4: 'p-4',
  5: 'p-5', 6: 'p-6', 7: 'p-7', 8: 'p-8',
}
const ALIGN: Record<string, string> = {
  Start: 'items-start', Center: 'items-center', End: 'items-end', Stretch: 'items-stretch',
}
const JUSTIFY: Record<string, string> = {
  Start: 'justify-start', Center: 'justify-center', End: 'justify-end', Between: 'justify-between',
}
const TEXT_SIZE: Record<string, string> = {
  Xs: 'text-xs', Sm: 'text-sm', Md: 'text-base', Lg: 'text-lg', Xl: 'text-xl', '2Xl': 'text-2xl',
}
const TEXT_WEIGHT: Record<string, string> = {
  Normal: 'font-normal', Medium: 'font-medium', Semibold: 'font-semibold', Bold: 'font-bold',
}
const TEXT_COLOR: Record<string, string> = {
  Default: 'text-foreground', Muted: 'text-muted-foreground', Primary: 'text-primary', Destructive: 'text-destructive',
}
const TEXT_ALIGN: Record<string, string> = {
  Start: 'text-left', Center: 'text-center', End: 'text-right',
}
const CLAMP: Record<number, string> = {
  1: 'line-clamp-1', 2: 'line-clamp-2', 3: 'line-clamp-3',
  4: 'line-clamp-4', 5: 'line-clamp-5', 6: 'line-clamp-6',
}
const BACKGROUND: Record<string, string> = {
  Transparent: '', Card: 'bg-card/70 backdrop-blur-md', Muted: 'bg-muted/40', Primary: 'bg-primary/10',
}
const RADIUS: Record<string, string> = {
  None: 'rounded-none', Sm: 'rounded-md', Md: 'rounded-lg', Lg: 'rounded-xl', Full: 'rounded-full',
}
const GRID_COLS: Record<number, string> = {
  1: 'grid-cols-1', 2: 'grid-cols-2', 3: 'grid-cols-3',
  4: 'grid-cols-4', 5: 'grid-cols-5', 6: 'grid-cols-6',
}

export function renderNodes(nodes: WidgetNode[], ctx: RenderContext, keyPrefix = ''): ReactNode[] {
  return nodes.map((node, index) => (
    <Fragment key={`${keyPrefix}${index}`}>{renderNode(node, ctx)}</Fragment>
  ))
}

function isTruthy(value: unknown): boolean {
  if (Array.isArray(value)) return value.length > 0
  return value !== undefined && value !== null && value !== false && value !== '' && value !== 0
}

function attachedStyle(node: WidgetNode): CSSProperties | undefined {
  const attached = node.attached
  if (!attached) return undefined
  return {
    gridRow: attached.row !== undefined
      ? `${attached.row + 1} / span ${attached.rowSpan ?? 1}`
      : undefined,
    gridColumn: attached.column !== undefined
      ? `${attached.column + 1} / span ${attached.columnSpan ?? 1}`
      : undefined,
  }
}

function renderNode(node: WidgetNode, ctx: RenderContext): ReactNode {
  switch (node.kind) {
    case 'container':
      return renderContainer(node, ctx)
    case 'row':
    case 'column':
      return renderRowColumn(node, ctx)
    case 'grid':
      return renderGrid(node, ctx)
    case 'tabs':
      return <TabsView key="tabs" node={node} ctx={ctx} />
    case 'list':
      return <ListView key="list" node={node} ctx={ctx} />
    case 'if':
      return isTruthy(resolvePath(ctx.scope, node.test)) ? renderNodes(node.children, ctx) : null
    case 'text':
      return renderText(node, ctx)
    case 'button':
      return renderButton(node, ctx)
    case 'image':
      return renderImage(node, ctx)
    case 'media':
      return renderMedia(node, ctx)
    case 'textBox':
      return <TextBoxControl key="textBox" node={node} ctx={ctx} />
    case 'checkBox':
      return <CheckBoxControl key="checkBox" node={node} ctx={ctx} />
    case 'slider':
      return <SliderControl key="slider" node={node} ctx={ctx} />
    case 'select':
      return <SelectControl key="select" node={node} ctx={ctx} />
    case 'progress':
      return renderProgress(node, ctx)
    case 'link':
      return renderLink(node, ctx)
    case 'filePicker':
      return <FilePickerControl key="filePicker" node={node} ctx={ctx} />
    case 'colorPicker':
      return <ColorPickerControl key="colorPicker" node={node} ctx={ctx} />
    case 'divider':
      return <div key="divider" className="h-px w-full bg-border/50" />
    case 'spacer':
      return renderSpacer(node)
    case 'using':
      return ctx.renderUsing(node)
    default:
      return null
  }
}

function renderContainer(node: ContainerNode, ctx: RenderContext): ReactNode {
  return (
    <div
      style={attachedStyle(node)}
      className={cn(
        'flex min-w-0',
        node.direction === 'Row' ? 'flex-row' : 'flex-col',
        node.border && 'border border-border/40',
        BACKGROUND[node.background],
        RADIUS[node.radius],
        GAP[node.gap ?? 0],
        PADDING[node.padding ?? 0],
        node.align && ALIGN[node.align],
        node.justify && JUSTIFY[node.justify],
      )}
    >
      {renderNodes(node.children, ctx)}
    </div>
  )
}

function renderRowColumn(node: RowNode | ColumnNode, ctx: RenderContext): ReactNode {
  return (
    <div
      style={attachedStyle(node)}
      className={cn(
        'flex min-w-0',
        node.kind === 'row' ? 'flex-row' : 'flex-col',
        node.wrap ? 'flex-wrap' : 'flex-nowrap',
        GAP[node.gap ?? 0],
        PADDING[node.padding ?? 0],
        node.align && ALIGN[node.align],
        node.justify && JUSTIFY[node.justify],
      )}
    >
      {renderNodes(node.children, ctx)}
    </div>
  )
}

function renderGrid(node: GridNode, ctx: RenderContext): ReactNode {
  return (
    <div
      style={attachedStyle(node)}
      className={cn(
        'grid min-w-0',
        GRID_COLS[node.columns],
        GAP[node.gap ?? 0],
        PADDING[node.padding ?? 0],
        node.align && ALIGN[node.align],
        node.justify && JUSTIFY[node.justify],
      )}
    >
      {node.children.map((child, index) => (
        <div key={index} style={attachedStyle(child)} className="min-w-0">
          {renderNode(child, ctx)}
        </div>
      ))}
    </div>
  )
}

function TabsView({ node, ctx }: { node: TabsNode; ctx: RenderContext }) {
  const [active, setActive] = useState(String(node.defaultIndex))
  const index = Math.min(Number(active) || 0, node.children.length - 1)
  const current = node.children[index]
  const tabs = node.children.map((child, i) => ({ id: String(i), label: interpolate(child.title, ctx.scope) }))
  return (
    <div style={attachedStyle(node)} className="flex min-w-0 flex-col gap-2">
      <Tabs tabs={tabs} activeTab={String(index)} onChange={setActive} />
      <div className="min-w-0">{renderNodes(current?.children ?? [], ctx, `tab${index}-`)}</div>
    </div>
  )
}

function ListView({ node, ctx }: { node: ListNode; ctx: RenderContext }) {
  const value = resolvePath(ctx.scope, node.items)
  const items = Array.isArray(value) ? value.slice(0, WIDGET_LIMITS.maxListItems) : []
  if (items.length === 0) {
    if (!node.emptyText) return null
    return <span className="text-xs text-muted-foreground">{interpolate(node.emptyText, ctx.scope)}</span>
  }
  return (
    <div style={attachedStyle(node)} className={cn('flex min-w-0 flex-col', GAP[node.gap ?? 0])}>
      {items.map((item, index) => (
        <Fragment key={index}>
          {renderNode(node.item.child, {
            ...ctx,
            scope: { ...ctx.scope, [node.as]: item, Index: index },
          })}
        </Fragment>
      ))}
    </div>
  )
}

function renderText(node: TextNode, ctx: RenderContext): ReactNode {
  return (
    <span
      style={attachedStyle(node)}
      className={cn(
        'block min-w-0 whitespace-pre-wrap break-words',
        TEXT_SIZE[node.size],
        TEXT_WEIGHT[node.weight],
        TEXT_COLOR[node.color],
        node.clamp && CLAMP[node.clamp],
        node.align && TEXT_ALIGN[node.align],
      )}
    >
      {interpolate(node.value, ctx.scope)}
    </span>
  )
}

function renderButton(node: ButtonNode, ctx: RenderContext): ReactNode {
  return (
    <Button
      type="button"
      variant={node.variant === 'Default' ? 'default' : node.variant.toLowerCase() as 'secondary' | 'outline' | 'ghost' | 'destructive' | 'link'}
      size={node.size === 'Md' ? 'default' : node.size.toLowerCase() as 'sm' | 'lg'}
      onClick={() => ctx.onAction(node.onClick, node.name)}
    >
      {interpolate(node.text, ctx.scope)}
    </Button>
  )
}

function isPlayableSrc(src: string): boolean {
  return src.startsWith('blob:') || src.startsWith('data:') || isSafeHttpsUrl(src)
}

function renderImage(node: ImageNode, ctx: RenderContext): ReactNode {
  const src = interpolate(node.src, ctx.scope)
  if (!isPlayableSrc(src)) return null
  if (src.startsWith('https://')) {
    const host = hostOf(src)
    if (!host || !ctx.allowedHosts.has(host)) return null
  }
  return (
    <img
      src={src}
      alt={node.alt ?? ''}
      loading="lazy"
      referrerPolicy="no-referrer"
      style={{ width: node.w, height: node.h }}
      className={cn('object-cover', node.rounded && 'rounded-md', node.w === undefined && 'w-full', node.h === undefined && 'h-auto')}
    />
  )
}

function renderMedia(node: MediaNode, ctx: RenderContext): ReactNode {
  const source = interpolate(node.source, ctx.scope)
  if (!isPlayableSrc(source)) return null
  if (source.startsWith('https://')) {
    const host = hostOf(source)
    if (!host || !ctx.allowedHosts.has(host)) return null
  }
  const video = node.type === 'Video'
  const common = {
    src: source,
    controls: node.controls,
    autoPlay: node.autoPlay,
    loop: node.loop,
    muted: node.muted,
    className: 'w-full max-w-full rounded-md',
    style: { maxHeight: 320 },
  }
  return video
    ? <video {...common} poster={node.poster ? interpolate(node.poster, ctx.scope) : undefined} />
    : <audio {...common} style={{ width: '100%' }} />
}

function TextBoxControl({ node, ctx }: { node: TextBoxNode; ctx: RenderContext }) {
  const value = ctx.inputs[node.name] !== undefined
    ? String(ctx.inputs[node.name] ?? '')
    : node.value ? interpolate(node.value, ctx.scope) : ''
  const className = 'flex w-full rounded-md border border-input bg-background px-3 py-2 text-sm shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring'
  return (
    <div style={attachedStyle(node)} className="flex flex-col gap-1">
      {node.multiline ? (
        <textarea
          value={value}
          placeholder={node.placeholder ? interpolate(node.placeholder, ctx.scope) : undefined}
          readOnly={node.readOnly}
          maxLength={node.maxLength}
          onChange={(e) => {
            ctx.setInput(node.name, e.target.value)
            ctx.onAction(node.onChange)
          }}
          className={cn(className, 'min-h-[72px] resize-y')}
        />
      ) : (
        <input
          type={node.password ? 'password' : 'text'}
          value={value}
          placeholder={node.placeholder ? interpolate(node.placeholder, ctx.scope) : undefined}
          readOnly={node.readOnly}
          maxLength={node.maxLength}
          onChange={(e) => {
            ctx.setInput(node.name, e.target.value)
            ctx.onAction(node.onChange)
          }}
          className={className}
        />
      )}
    </div>
  )
}

function CheckBoxControl({ node, ctx }: { node: CheckBoxNode; ctx: RenderContext }) {
  const checked = ctx.inputs[node.name] !== undefined
    ? !!ctx.inputs[node.name]
    : typeof node.checked === 'boolean'
      ? node.checked
      : isTruthy(resolvePath(ctx.scope, node.checked))
  return (
    <label style={attachedStyle(node)} className="flex items-center gap-2 text-sm">
      <Checkbox
        checked={checked}
        onCheckedChange={(value) => {
          ctx.setInput(node.name, value === true)
          ctx.onAction(node.onChange)
        }}
      />
      {node.text ? interpolate(node.text, ctx.scope) : null}
    </label>
  )
}

function SliderControl({ node, ctx }: { node: SliderNode; ctx: RenderContext }) {
  const value = ctx.inputs[node.name] !== undefined ? Number(ctx.inputs[node.name]) : node.value
  return (
    <input
      type="range"
      value={value}
      min={node.min}
      max={node.max}
      step={node.step}
      style={attachedStyle(node)}
      onChange={(e) => {
        ctx.setInput(node.name, Number(e.target.value))
        ctx.onAction(node.onChange)
      }}
      className="w-full accent-primary"
    />
  )
}

interface SelectOptionValue {
  Label?: string
  Value?: string | number
}

function parseOptions(raw: string, ctx: RenderContext): Array<{ label: string; value: string }> {
  let parsed: unknown
  try {
    parsed = JSON.parse(interpolate(raw, ctx.scope))
  } catch {
    return []
  }
  if (!Array.isArray(parsed)) return []
  return parsed.map((item) => {
    if (item && typeof item === 'object') {
      const option = item as SelectOptionValue
      return { label: String(option.Label ?? option.Value ?? ''), value: String(option.Value ?? '') }
    }
    return { label: String(item), value: String(item) }
  })
}

function SelectControl({ node, ctx }: { node: SelectNode; ctx: RenderContext }) {
  const options = parseOptions(node.options, ctx)
  const current = ctx.inputs[node.name] !== undefined
    ? String(ctx.inputs[node.name] ?? '')
    : node.value ? interpolate(node.value, ctx.scope) : ''
  return (
    <div style={attachedStyle(node)}>
      <Select
        value={current}
        onChange={(value) => {
          ctx.setInput(node.name, value)
          ctx.onAction(node.onChange)
        }}
      >
        {options.map((option) => (
          <SelectOption key={option.value} value={option.value}>{option.label}</SelectOption>
        ))}
      </Select>
    </div>
  )
}

function renderProgress(node: ProgressNode, ctx: RenderContext): ReactNode {
  const value = Number(interpolate(node.value, ctx.scope)) || 0
  const percent = Math.max(0, Math.min(100, (value / (node.max || 100)) * 100))
  return (
    <div style={attachedStyle(node)} className="h-2 w-full overflow-hidden rounded-full bg-muted">
      <div className="h-full bg-primary transition-[width]" style={{ width: `${percent}%` }} />
    </div>
  )
}

function renderLink(node: LinkNode, ctx: RenderContext): ReactNode {
  const fallback = !node.onClick && node.url
    ? { name: 'OpenUrl' as const, args: { Url: node.url } }
    : undefined
  return (
    <button
      type="button"
      style={attachedStyle(node)}
      onClick={() => ctx.onAction(node.onClick ?? fallback, node.name)}
      className="w-fit text-left text-sm text-primary underline-offset-4 hover:underline"
    >
      {interpolate(node.text, ctx.scope)}
    </button>
  )
}

function FilePickerControl({ node, ctx }: { node: FilePickerNode; ctx: RenderContext }) {
  const value = ctx.inputs[node.name] !== undefined
    ? String(ctx.inputs[node.name] ?? '')
    : node.value ? interpolate(node.value, ctx.scope) : ''
  const pick = async () => {
    try {
      if (!(window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__) return
      const filters = node.filter
        ? [{ name: 'Files', extensions: node.filter.split(',').map((item) => item.trim().replace(/^\./, '')).filter(Boolean) }]
        : undefined
      const picked = await invoke<string | null>('pick_dialog', { options: { multiple: false, filters } })
      if (picked) ctx.setInput(node.name, picked)
    } catch {
      /* 用户取消或非 Tauri 环境 */
    }
  }
  return (
    <div style={attachedStyle(node)} className="flex flex-col gap-1">
      <Button type="button" variant="outline" size="sm" onClick={() => void pick()}>
        {interpolate(node.text, ctx.scope)}
      </Button>
      <span className="truncate font-mono text-[11px] text-muted-foreground">{value}</span>
    </div>
  )
}

function ColorPickerControl({ node, ctx }: { node: ColorPickerNode; ctx: RenderContext }) {
  const value = ctx.inputs[node.name] !== undefined
    ? String(ctx.inputs[node.name] ?? '')
    : node.value ? interpolate(node.value, ctx.scope) : '#000000'
  return (
    <input
      type="color"
      value={/^#[0-9a-f]{6}$/i.test(value) ? value : '#000000'}
      style={attachedStyle(node)}
      onChange={(e) => {
        ctx.setInput(node.name, e.target.value)
        ctx.onAction(node.onChange)
      }}
      className="h-8 w-12 cursor-pointer rounded border border-input bg-background p-0.5"
    />
  )
}

function renderSpacer(node: SpacerNode): ReactNode {
  return <div className="shrink-0" style={{ ...attachedStyle(node), width: node.size, height: node.size }} />
}
