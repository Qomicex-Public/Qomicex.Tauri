// Copyright (C) 2026 Qomicex Launcher Contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { Fragment, useState, type ReactNode } from 'react'
import { Button, Tabs } from '../../../components/ui'
import { cn } from '../../../components/ui'
import {
  WIDGET_LIMITS,
  hostOf,
  interpolate,
  isSafeHttpsUrl,
  resolvePath,
} from './schema.ts'
import type {
  ButtonNode,
  ColumnNode,
  ContainerNode,
  GridNode,
  ImageNode,
  ListNode,
  RowNode,
  SpacerNode,
  TabsNode,
  TextNode,
  WidgetAction,
  WidgetNode,
} from './types.ts'

export interface RenderContext {
  scope: Record<string, unknown>
  action: (action: WidgetAction) => void
  allowedHosts: Set<string>
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
  start: 'items-start', center: 'items-center', end: 'items-end', stretch: 'items-stretch',
}
const JUSTIFY: Record<string, string> = {
  start: 'justify-start', center: 'justify-center', end: 'justify-end', between: 'justify-between',
}
const TEXT_SIZE: Record<string, string> = {
  xs: 'text-xs', sm: 'text-sm', md: 'text-base', lg: 'text-lg', xl: 'text-xl', '2xl': 'text-2xl',
}
const TEXT_WEIGHT: Record<string, string> = {
  normal: 'font-normal', medium: 'font-medium', semibold: 'font-semibold', bold: 'font-bold',
}
const TEXT_COLOR: Record<string, string> = {
  default: 'text-foreground', muted: 'text-muted-foreground', primary: 'text-primary', destructive: 'text-destructive',
}
const TEXT_ALIGN: Record<string, string> = {
  start: 'text-left', center: 'text-center', end: 'text-right',
}
const CLAMP: Record<number, string> = {
  1: 'line-clamp-1', 2: 'line-clamp-2', 3: 'line-clamp-3',
  4: 'line-clamp-4', 5: 'line-clamp-5', 6: 'line-clamp-6',
}
const BACKGROUND: Record<string, string> = {
  transparent: '', card: 'bg-card/70 backdrop-blur-md', muted: 'bg-muted/40', primary: 'bg-primary/10',
}
const RADIUS: Record<string, string> = {
  none: 'rounded-none', sm: 'rounded-md', md: 'rounded-lg', lg: 'rounded-xl', full: 'rounded-full',
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
    case 'divider':
      return <div key="divider" className="h-px w-full bg-border/50" />
    case 'spacer':
      return renderSpacer(node)
    default:
      return null
  }
}

function renderContainer(node: ContainerNode, ctx: RenderContext): ReactNode {
  return (
    <div
      className={cn(
        'flex min-w-0',
        node.direction === 'row' ? 'flex-row' : 'flex-col',
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
      className={cn(
        'grid min-w-0',
        GRID_COLS[node.columns],
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

function TabsView({ node, ctx }: { node: TabsNode; ctx: RenderContext }) {
  const [active, setActive] = useState(String(node.defaultIndex))
  const index = Math.min(Number(active) || 0, node.children.length - 1)
  const current = node.children[index]
  const tabs = node.children.map((child, i) => ({
    id: String(i),
    label: interpolate(child.title, ctx.scope),
  }))
  return (
    <div className="flex min-w-0 flex-col gap-2">
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
    <div className={cn('flex min-w-0 flex-col', GAP[node.gap ?? 0])}>
      {items.map((item, index) => (
        <Fragment key={index}>
          {renderNode(node.item.child, {
            ...ctx,
            scope: { ...ctx.scope, [node.as]: item, index },
          })}
        </Fragment>
      ))}
    </div>
  )
}

function renderText(node: TextNode, ctx: RenderContext): ReactNode {
  return (
    <span
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
  const args = Object.fromEntries(
    Object.entries(node.args).map(([name, value]) => [name, interpolate(value, ctx.scope)]),
  )
  return (
    <Button
      type="button"
      variant={node.variant}
      size={node.size}
      onClick={() => ctx.action({ name: node.onClick, args })}
    >
      {interpolate(node.text, ctx.scope)}
    </Button>
  )
}

function renderImage(node: ImageNode, ctx: RenderContext): ReactNode {
  const src = interpolate(node.src, ctx.scope)
  if (!isSafeHttpsUrl(src)) return null
  const host = hostOf(src)
  if (!host || !ctx.allowedHosts.has(host)) return null
  return (
    <img
      src={src}
      alt={node.alt ?? ''}
      loading="lazy"
      referrerPolicy="no-referrer"
      className={cn('object-cover', node.rounded && 'rounded-md', node.w === undefined && 'w-full', node.h === undefined && 'h-auto')}
      style={{ width: node.w, height: node.h }}
    />
  )
}

function renderSpacer(node: SpacerNode): ReactNode {
  return <div className="shrink-0" style={{ width: node.size, height: node.size }} />
}
