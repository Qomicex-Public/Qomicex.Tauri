// Copyright (C) 2026 Qomicex Launcher Contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { Fragment, useState, type CSSProperties, type ReactNode } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { Button, Checkbox, Dialog, DialogBody, DialogHeader, DialogTitle, Select, SelectOption, Tabs, cn } from '../../../components/ui'
import {
  ELEMENT_ATTRS,
  NODE_ATTRS,
  WIDGET_LIMITS,
  hostOf,
  interpolate,
  isSafeHttpsUrl,
  resolvePath,
  stringifyBinding,
} from './schema.ts'
import { convertBackValue, convertMultiValue, convertValue, exactBinding } from './converters.ts'
import { evaluateWhen } from './responsive.ts'
import type { BindingOptions } from './converters.ts'
import type {
  ActionSpec,
  AnimationSpec,
  BindingSpec,
  ButtonNode,
  CheckBoxNode,
  ColorPickerNode,
  ColumnNode,
  ContainerNode,
  DialogNode,
  EffectSpec,
  FilePickerNode,
  GridNode,
  ImageNode,
  LinkNode,
  ListNode,
  ListItemNode,
  MediaNode,
  PageNode,
  ProgressNode,
  RowNode,
  SelectNode,
  SliderNode,
  SpacerNode,
  TabsNode,
  TabItemNode,
  TextBoxNode,
  TextNode,
  UsingNode,
  WidgetNode,
  WidgetSizeInfo,
} from './types.ts'

export interface RenderRuntime {
  inputs: Record<string, unknown>
  setInput: (name: string, value: unknown) => void
  data: Record<string, unknown>
  resources: Record<string, unknown>
  results: Record<string, unknown>
  children: Record<string, unknown>
  overrides: Record<string, Record<string, unknown>>
  effects: Record<string, EffectSpec[]>
  bindingOptions: BindingOptions
  size: WidgetSizeInfo
  pages: Record<string, PageNode[]>
  openDialogs: Set<string>
  showDialog: (name: string) => void
  hideDialog: (name: string) => void
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

export function renderNodes(nodes: WidgetNode[], ctx: RenderContext, keyPrefix = '', root = false): ReactNode[] {
  return nodes.map((node, index) => (
    <Fragment key={`${keyPrefix}${index}`}>{renderNode(node, ctx, root)}</Fragment>
  ))
}

const PROPERTY_FIELD: Record<string, string> = {
  Value: 'value',
  Text: 'text',
  Items: 'items',
  Options: 'options',
  Source: 'source',
  Src: 'src',
  Color: 'color',
  Size: 'size',
  Weight: 'weight',
  Variant: 'variant',
  Visible: 'visible',
  Checked: 'checked',
  Placeholder: 'placeholder',
  Url: 'url',
  Alt: 'alt',
  W: 'w',
  H: 'h',
  Rounded: 'rounded',
  Controls: 'controls',
  AutoPlay: 'autoPlay',
  Loop: 'loop',
  Poster: 'poster',
  Volume: 'volume',
  Muted: 'muted',
  Min: 'min',
  Max: 'max',
  Step: 'step',
  Multiline: 'multiline',
  Password: 'password',
  ReadOnly: 'readOnly',
  MaxLength: 'maxLength',
  Filter: 'filter',
  Clamp: 'clamp',
  Align: 'align',
  Gap: 'gap',
  Padding: 'padding',
  Border: 'border',
  Background: 'background',
  Radius: 'radius',
  Direction: 'direction',
  Columns: 'columns',
  Default: 'defaultIndex',
  Title: 'title',
  EmptyText: 'emptyText',
  Type: 'type',
  As: 'as',
  Refresh: 'refresh',
  Description: 'description',
}

const NODE_TAG: Record<WidgetNode['kind'], string> = {
  container: 'Container',
  row: 'Row',
  column: 'Column',
  grid: 'Grid',
  tabs: 'Tabs',
  list: 'List',
  if: 'If',
  text: 'Text',
  button: 'Button',
  image: 'Image',
  media: 'Media',
  textBox: 'TextBox',
  checkBox: 'CheckBox',
  slider: 'Slider',
  select: 'Select',
  progress: 'Progress',
  link: 'Link',
  filePicker: 'FilePicker',
  colorPicker: 'ColorPicker',
  divider: 'Divider',
  dialog: 'Dialog',
  spacer: 'Spacer',
  using: 'Using',
}

const NON_WRITABLE_PROPERTIES = new Set([
  'target',
  'name',
  'onclick',
  'onchange',
  'function',
  'arguments',
  'command',
  'workingdirectory',
  'timeout',
  'pluginid',
  'method',
  'as',
  'refresh',
  'kind',
  'attached',
  'children',
  'item',
  'test',
  '__proto__',
  'constructor',
  'prototype',
])

function contentField(kind: WidgetNode['kind']): string | null {
  switch (kind) {
    case 'text':
    case 'textBox':
    case 'slider':
    case 'progress':
    case 'colorPicker':
      return 'value'
    case 'button':
    case 'link':
    case 'checkBox':
    case 'filePicker':
      return 'text'
    case 'select':
      return 'options'
    case 'media':
      return 'source'
    case 'image':
      return 'src'
    case 'list':
      return 'items'
    case 'spacer':
      return 'size'
    default:
      return null
  }
}

export function contentProperty(node: WidgetNode): string | null {
  switch (node.kind) {
    case 'text':
    case 'textBox':
    case 'slider':
    case 'progress':
    case 'colorPicker':
      return 'Value'
    case 'button':
    case 'link':
    case 'checkBox':
    case 'filePicker':
      return 'Text'
    case 'select':
      return 'Options'
    case 'media':
      return 'Source'
    case 'image':
      return 'Src'
    case 'list':
      return 'Items'
    case 'spacer':
      return 'Size'
    default:
      return null
  }
}

function coerceOverride(current: unknown, value: unknown): unknown {
  if (typeof current === 'number') {
    const n = Number(value)
    return Number.isFinite(n) ? n : current
  }
  if (typeof current === 'boolean') {
    return value === true || value === 'True' || value === 'true'
  }
  return value
}

export function propertyField(node: WidgetNode, property: string): string | null {
  const lower = property.toLowerCase()
  if (NON_WRITABLE_PROPERTIES.has(lower)) return null
  const tag = NODE_TAG[node.kind]
  const attrs = ELEMENT_ATTRS[tag] ?? []
  const writable = property === 'Content' || attrs.includes(property) || (NODE_ATTRS as readonly string[]).includes(property)
  if (!writable) return null
  if (property === 'Content') return contentField(node.kind)
  return PROPERTY_FIELD[property] ?? property.charAt(0).toLowerCase() + property.slice(1)
}

export function applyNodeOverrides(node: WidgetNode, patch?: Record<string, unknown>): WidgetNode {
  if (!patch || Object.keys(patch).length === 0) return node
  const next: Record<string, unknown> = { ...node }
  for (const [property, value] of Object.entries(patch)) {
    const field = propertyField(node, property)
    if (!field) continue
    next[field] = coerceOverride((node as unknown as Record<string, unknown>)[field], value)
  }
  return next as unknown as WidgetNode
}

function isTruthy(value: unknown): boolean {
  if (Array.isArray(value)) return value.length > 0
  return value !== undefined && value !== null && value !== false && value !== '' && value !== 0
}

export function effectStyle(effects?: EffectSpec[]): CSSProperties | undefined {
  if (!effects || effects.length === 0) return undefined
  const shadows: string[] = []
  const filters: string[] = []
  const transforms: string[] = []
  let opacity: number | undefined
  for (const effect of effects) {
    switch (effect.kind) {
      case 'shadow':
        shadows.push(
          `${effect.inset ? 'inset ' : ''}${effect.offsetX}px ${effect.offsetY}px ${effect.radius}px ${effect.spread}px ${effect.color}`,
        )
        break
      case 'blur':
        filters.push(`blur(${effect.radius}px)`)
        break
      case 'opacity':
        opacity = effect.value
        break
      case 'scale':
        transforms.push(`scale(${effect.value})`)
        break
      case 'rotate':
        transforms.push(`rotate(${effect.angle}deg)`)
        break
    }
  }
  const style: CSSProperties = {}
  if (shadows.length > 0) style.boxShadow = shadows.join(', ')
  if (filters.length > 0) style.filter = filters.join(' ')
  if (transforms.length > 0) style.transform = transforms.join(' ')
  if (opacity !== undefined) style.opacity = opacity
  return style
}

const ANIMATION_NAME: Record<string, string> = {
  fade: 'qwidget-fade',
  slide: 'qwidget-slide',
  scale: 'qwidget-scale',
  rotate: 'qwidget-rotate',
  pulse: 'qwidget-pulse',
  spin: 'qwidget-spin',
}

const EASING_CSS: Record<string, string> = {
  Linear: 'linear',
  Ease: 'ease',
  EaseIn: 'ease-in',
  EaseOut: 'ease-out',
  EaseInOut: 'ease-in-out',
}

function animationValues(animations: AnimationSpec[]): {
  name: string
  duration: string
  delay: string
  easing: string
  iteration: string
} {
  return {
    name: animations.map((animation) => ANIMATION_NAME[animation.kind]).join(', '),
    duration: animations.map((animation) => `${animation.duration}ms`).join(', '),
    delay: animations.map((animation) => `${animation.delay}ms`).join(', '),
    easing: animations.map((animation) => EASING_CSS[animation.easing] ?? 'ease').join(', '),
    iteration: animations.map((animation) => animation.repeat === 'Infinite' ? 'infinite' : String(animation.repeat)).join(', '),
  }
}

export function animationClass(animations?: AnimationSpec[]): string | undefined {
  if (!animations || animations.length === 0) return undefined
  const classes = ['w-anim-override']
  if (animations.some((animation) => animation.trigger === 'Loaded')) classes.push('w-anim-loaded')
  if (animations.some((animation) => animation.trigger === 'Hover')) classes.push('w-anim-hover')
  if (animations.some((animation) => animation.trigger === 'Click')) classes.push('w-anim-click')
  return classes.join(' ')
}

export function animationStyle(animations?: AnimationSpec[]): CSSProperties | undefined {
  if (!animations || animations.length === 0) return undefined
  const loaded = animations.filter((animation) => animation.trigger === 'Loaded')
  const hover = animations.filter((animation) => animation.trigger === 'Hover')
  const click = animations.filter((animation) => animation.trigger === 'Click')
  const style: Record<string, string | number> = {}
  if (loaded.length > 0) {
    const values = animationValues(loaded)
    style['--w-anim-loaded-name'] = values.name
    style['--w-anim-loaded-duration'] = values.duration
    style['--w-anim-loaded-delay'] = values.delay
    style['--w-anim-loaded-easing'] = values.easing
    style['--w-anim-loaded-iteration'] = values.iteration
  }
  if (hover.length > 0) {
    const values = animationValues(hover)
    style['--w-anim-hover-name'] = values.name
    style['--w-anim-hover-duration'] = values.duration
    style['--w-anim-hover-delay'] = values.delay
    style['--w-anim-hover-easing'] = values.easing
    style['--w-anim-hover-iteration'] = values.iteration
  }
  if (click.length > 0) {
    const values = animationValues(click)
    style['--w-anim-click-name'] = values.name
    style['--w-anim-click-duration'] = values.duration
    style['--w-anim-click-delay'] = values.delay
    style['--w-anim-click-easing'] = values.easing
    style['--w-anim-click-iteration'] = values.iteration
  }
  for (const animation of animations) {
    if (animation.kind === 'slide') {
      const distance = animation.distance ?? 8
      style['--w-anim-x'] = animation.direction === 'Left' ? `${-distance}px` : animation.direction === 'Right' ? `${distance}px` : '0px'
      style['--w-anim-y'] = animation.direction === 'Top' ? `${-distance}px` : animation.direction === 'Bottom' ? `${distance}px` : '0px'
    }
    if (animation.kind === 'fade') {
      if (animation.from !== undefined) style['--w-anim-fade-from'] = animation.from
      if (animation.to !== undefined) style['--w-anim-fade-to'] = animation.to
    }
    if (animation.kind === 'scale') {
      if (animation.from !== undefined) style['--w-anim-scale-from'] = animation.from
      if (animation.to !== undefined) style['--w-anim-scale-to'] = animation.to
    }
    if (animation.kind === 'rotate') {
      if (animation.from !== undefined) style['--w-anim-rotate-from'] = `${animation.from}deg`
      if (animation.to !== undefined) style['--w-anim-rotate-to'] = `${animation.to}deg`
    }
  }
  return style as CSSProperties
}

function nodeStyle(node: WidgetNode): CSSProperties | undefined {
  const attached = attachedStyle(node)
  const effects = effectStyle(node.effects)
  const animations = animationStyle(node.animations)
  if (attached || effects || animations) return { ...attached, ...effects, ...animations }
  return undefined
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

function isWidgetNode(node: PageNode): node is WidgetNode {
  return node.kind !== 'tabItem' && node.kind !== 'listItem'
}

function pageNodes(contentPage: string | undefined, fallback: PageNode[], ctx: RenderContext): PageNode[] {
  if (!contentPage) return fallback
  return ctx.pages[contentPage] ?? []
}

function pageChildren(contentPage: string | undefined, fallback: WidgetNode[], ctx: RenderContext): WidgetNode[] {
  return pageNodes(contentPage, fallback, ctx).filter(isWidgetNode)
}

function dialogWidthClass(width: DialogNode['width']): string {
  switch (width) {
    case 'Sm':
      return 'max-w-sm'
    case 'Lg':
      return 'max-w-2xl'
    case 'Xl':
      return 'max-w-4xl'
    case 'Full':
      return 'max-w-[calc(100vw-2rem)]'
    default:
      return 'max-w-lg'
  }
}

function renderDialog(node: DialogNode, ctx: RenderContext): ReactNode {
  const content = pageChildren(node.contentPage, node.children, ctx)
  return (
    <Dialog
      key={`dialog-${node.name}`}
      open={ctx.openDialogs.has(node.name)}
      onClose={() => ctx.hideDialog(node.name)}
      className={dialogWidthClass(node.width)}
    >
      <DialogHeader onClose={() => ctx.hideDialog(node.name)}>
        {node.title ? <DialogTitle>{interpolate(node.title, ctx.scope, ctx.bindingOptions)}</DialogTitle> : <span />}
      </DialogHeader>
      <DialogBody
        style={{ ...effectStyle(node.effects), ...animationStyle(node.animations) }}
        className={cn('max-h-[calc(100vh-7rem)] overflow-auto', animationClass(node.animations))}
      >
        {renderNodes(content, ctx, `dialog-${node.name}-`)}
      </DialogBody>
    </Dialog>
  )
}

function renderNode(node: WidgetNode, ctx: RenderContext, root = false): ReactNode {
  const effective = applyNodeOverrides(node, node.target ? ctx.overrides[node.target] : undefined)
  const effects = effective.target ? ctx.effects[effective.target] : undefined
  if (effects !== undefined) effective.effects = effects
  if (effective.visible === false) return null
  if (effective.when && !evaluateWhen(effective.when, ctx.size)) return null
  switch (effective.kind) {
    case 'container':
      return renderContainer(effective, ctx, root)
    case 'row':
    case 'column':
      return renderRowColumn(effective, ctx, root)
    case 'grid':
      return renderGrid(effective, ctx, root)
    case 'tabs':
      return <TabsView key="tabs" node={effective} ctx={ctx} root={root} />
    case 'list':
      return <ListView key="list" node={effective} ctx={ctx} root={root} />
    case 'if':
      return isTruthy(resolvePath(ctx.scope, effective.test))
        ? renderNodes(pageChildren(effective.contentPage, effective.children, ctx), ctx, '', root)
        : null
    case 'text':
      return renderText(effective, ctx, root)
    case 'button':
      return renderButton(effective, ctx, root)
    case 'image':
      return renderImage(effective, ctx, root)
    case 'media':
      return renderMedia(effective, ctx, root)
    case 'textBox':
      return <TextBoxControl key="textBox" node={effective} ctx={ctx} root={root} />
    case 'checkBox':
      return <CheckBoxControl key="checkBox" node={effective} ctx={ctx} root={root} />
    case 'slider':
      return <SliderControl key="slider" node={effective} ctx={ctx} />
    case 'select':
      return <SelectControl key="select" node={effective} ctx={ctx} />
    case 'progress':
      return renderProgress(effective, ctx)
    case 'link':
      return renderLink(effective, ctx, root)
    case 'filePicker':
      return <FilePickerControl key="filePicker" node={effective} ctx={ctx} root={root} />
    case 'colorPicker':
      return <ColorPickerControl key="colorPicker" node={effective} ctx={ctx} />
    case 'divider':
      return <div key="divider" style={{ ...effectStyle(effective.effects), ...animationStyle(effective.animations) }} className={cn('h-px w-full bg-border/50', animationClass(effective.animations))} />
    case 'dialog':
      return renderDialog(effective, ctx)
    case 'spacer':
      return renderSpacer(effective)
    case 'using':
      return root
        ? <div style={nodeStyle(effective)} className={cn('flex min-h-0 flex-1 flex-col', animationClass(effective.animations))}>{ctx.renderUsing(effective)}</div>
        : ctx.renderUsing(effective)
    default:
      return null
  }
}

function renderContainer(node: ContainerNode, ctx: RenderContext, root = false): ReactNode {
  return (
    <div
      style={nodeStyle(node)}
      className={cn(
        'flex min-w-0',
        animationClass(node.animations),
        root && 'min-h-0 flex-1 overflow-auto',
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
      {renderNodes(pageChildren(node.contentPage, node.children, ctx), ctx)}
    </div>
  )
}

function renderRowColumn(node: RowNode | ColumnNode, ctx: RenderContext, root = false): ReactNode {
  return (
    <div
      style={nodeStyle(node)}
      className={cn(
        'flex min-w-0',
        animationClass(node.animations),
        root && 'min-h-0 flex-1 overflow-auto',
        node.kind === 'row' ? 'flex-row' : 'flex-col',
        node.wrap ? 'flex-wrap' : 'flex-nowrap',
        GAP[node.gap ?? 0],
        PADDING[node.padding ?? 0],
        node.align && ALIGN[node.align],
        node.justify && JUSTIFY[node.justify],
      )}
    >
      {renderNodes(pageChildren(node.contentPage, node.children, ctx), ctx)}
    </div>
  )
}

function renderGrid(node: GridNode, ctx: RenderContext, root = false): ReactNode {
  return (
    <div
      style={nodeStyle(node)}
      className={cn(
        'grid min-w-0',
        animationClass(node.animations),
        root && 'min-h-0 flex-1 overflow-auto',
        GRID_COLS[node.columns],
        GAP[node.gap ?? 0],
        PADDING[node.padding ?? 0],
        node.align && ALIGN[node.align],
        node.justify && JUSTIFY[node.justify],
      )}
    >
      {pageChildren(node.contentPage, node.children, ctx).map((child, index) => (
        <div key={index} style={attachedStyle(child)} className="min-w-0">
          {renderNode(child, ctx)}
        </div>
      ))}
    </div>
  )
}

function TabsView({ node, ctx, root = false }: { node: TabsNode; ctx: RenderContext; root?: boolean }) {
  const [active, setActive] = useState(String(node.defaultIndex))
  const tabsSource = pageNodes(node.contentPage, node.children, ctx).filter((item): item is TabItemNode => item.kind === 'tabItem')
  const visibleTabs = tabsSource.filter((tab) => tab.visible !== false && (!tab.when || evaluateWhen(tab.when, ctx.size)))
  if (visibleTabs.length === 0) return null
  const index = Math.min(Number(active) || 0, visibleTabs.length - 1)
  const current = visibleTabs[index]
  const tabs = visibleTabs.map((child, i) => ({ id: String(i), label: interpolate(child.title, ctx.scope, ctx.bindingOptions) }))
  return (
    <div style={nodeStyle(node)} className={cn('flex min-w-0 flex-col gap-2', animationClass(node.animations), root && 'min-h-0 flex-1 overflow-hidden')}>
      <Tabs tabs={tabs} activeTab={String(index)} onChange={setActive} />
      <div
        className={cn('min-w-0', animationClass(current?.animations), root && 'min-h-0 flex-1 overflow-auto')}
        style={{ ...effectStyle(current?.effects), ...animationStyle(current?.animations) }}
      >
        {renderNodes(pageChildren(current?.contentPage, current?.children ?? [], ctx), ctx, `tab${index}-`)}
      </div>
    </div>
  )
}

function ListView({ node, ctx, root = false }: { node: ListNode; ctx: RenderContext; root?: boolean }) {
  const value = Array.isArray(node.items) ? node.items : resolvePath(ctx.scope, node.items as string)
  const items = Array.isArray(value) ? value.slice(0, WIDGET_LIMITS.maxListItems) : []
  const sourceItem = node.item
    ?? pageNodes(node.contentPage, [], ctx).find((candidate): candidate is ListItemNode => candidate.kind === 'listItem')
  if (items.length === 0) {
    if (!node.emptyText) return null
    return <span className="text-xs text-muted-foreground">{interpolate(node.emptyText, ctx.scope, ctx.bindingOptions)}</span>
  }
  if (!sourceItem || sourceItem.visible === false || (sourceItem.when && !evaluateWhen(sourceItem.when, ctx.size))) return null
  const itemNodes = pageChildren(sourceItem.contentPage, sourceItem.child ? [sourceItem.child] : [], ctx)
  return (
    <div style={nodeStyle(node)} className={cn('flex min-w-0 flex-col', animationClass(node.animations), GAP[node.gap ?? 0], root && 'min-h-0 flex-1 overflow-auto')}>
      {items.map((item, index) => (
        <Fragment key={index}>
          <div
            style={{ ...effectStyle(sourceItem.effects), ...animationStyle(sourceItem.animations) }}
            className={cn('min-w-0', animationClass(sourceItem.animations))}
          >
            {renderNodes(itemNodes, {
              ...ctx,
              scope: { ...ctx.scope, [node.as]: item, Index: index },
            })}
          </div>
        </Fragment>
      ))}
    </div>
  )
}

function renderText(node: TextNode, ctx: RenderContext, root = false): ReactNode {
  return (
    <span
      style={nodeStyle(node)}
      className={cn(
        'block min-w-0 whitespace-pre-wrap break-words',
        animationClass(node.animations),
        root && 'min-h-0 flex-1 overflow-auto',
        TEXT_SIZE[node.size],
        TEXT_WEIGHT[node.weight],
        TEXT_COLOR[node.color],
        node.clamp && CLAMP[node.clamp],
        node.align && TEXT_ALIGN[node.align],
      )}
    >
      {interpolate(node.value ?? '', ctx.scope, ctx.bindingOptions)}
    </span>
  )
}

function renderButton(node: ButtonNode, ctx: RenderContext, root = false): ReactNode {
  return (
    <Button
      type="button"
      data-widget-target={node.target}
      className={cn(animationClass(node.animations), root && 'max-h-full overflow-auto')}
      style={nodeStyle(node)}
      variant={node.variant === 'Default' ? 'default' : node.variant.toLowerCase() as 'secondary' | 'outline' | 'ghost' | 'destructive' | 'link'}
      size={node.size === 'Md' ? 'default' : node.size.toLowerCase() as 'sm' | 'lg'}
      onClick={() => ctx.onAction(node.onClick, node.name)}
    >
      {interpolate(node.text, ctx.scope, ctx.bindingOptions)}
    </Button>
  )
}

function isPlayableSrc(src: string): boolean {
  return src.startsWith('blob:') || src.startsWith('data:') || isSafeHttpsUrl(src)
}

function renderImage(node: ImageNode, ctx: RenderContext, root = false): ReactNode {
  const src = interpolate(node.src, ctx.scope, ctx.bindingOptions)
  if (!isPlayableSrc(src)) return null
  if (!src.startsWith('blob:') && !src.startsWith('data:')) {
    const host = hostOf(src)
    if (!host || !ctx.allowedHosts.has(host)) return null
  }
  return (
    <img
      src={src}
      alt={node.alt ?? ''}
      loading="lazy"
      referrerPolicy="no-referrer"
      style={{ ...nodeStyle(node), width: node.w, height: node.h }}
      className={cn('object-cover', animationClass(node.animations), root && 'max-h-full max-w-full overflow-auto', node.rounded && 'rounded-md', node.w === undefined && 'w-full', node.h === undefined && 'h-auto')}
    />
  )
}

function renderMedia(node: MediaNode, ctx: RenderContext, root = false): ReactNode {
  const source = interpolate(node.source, ctx.scope, ctx.bindingOptions)
  if (!isPlayableSrc(source)) return null
  if (!source.startsWith('blob:') && !source.startsWith('data:')) {
    const host = hostOf(source)
    if (!host || !ctx.allowedHosts.has(host)) return null
  }
  const video = node.type === 'Video'
  const mediaRef = (element: HTMLMediaElement | null) => {
    if (element && node.volume !== undefined) element.volume = node.volume
  }
  let poster: string | undefined
  if (node.poster) {
    const candidate = interpolate(node.poster, ctx.scope, ctx.bindingOptions)
    if (isPlayableSrc(candidate)) {
      if (candidate.startsWith('blob:') || candidate.startsWith('data:')) poster = candidate
      else {
        const host = hostOf(candidate)
        if (host && ctx.allowedHosts.has(host)) poster = candidate
      }
    }
  }
  const common = {
    src: source,
    controls: node.controls,
    autoPlay: node.autoPlay,
    loop: node.loop,
    muted: node.muted,
    ref: mediaRef,
    className: cn('w-full max-w-full rounded-md', animationClass(node.animations), root && 'max-h-full overflow-auto'),
    style: { ...nodeStyle(node), maxHeight: root ? '100%' : 320 },
  }
  return video
    ? <video {...common} poster={poster} />
    : <audio {...common} style={{ ...nodeStyle(node), width: '100%', maxHeight: root ? '100%' : 320 }} />
}

function bindingSource(binding: BindingSpec, ctx: RenderContext): unknown[] {
  return binding.paths
    ? binding.paths.map((path) => resolvePath(ctx.scope, path))
    : [resolvePath(ctx.scope, binding.path ?? '')]
}

function bindingDisplay(binding: BindingSpec, ctx: RenderContext, targetType = 'string'): unknown {
  const values = bindingSource(binding, ctx)
  const options = { ...ctx.bindingOptions, targetType }
  return binding.paths
    ? convertMultiValue(values, binding.converter, binding.parameter, options, ctx.scope)
    : convertValue(values[0], binding.converter, binding.parameter, options, ctx.scope)
}

function bindingInputName(binding: BindingSpec, fallback: string): string {
  const path = binding.path ?? binding.paths?.[0] ?? ''
  const parts = path.split('.')
  return parts[0] === 'Inputs' && parts[1] ? parts[1] : fallback
}

function TextBoxControl({ node, ctx, root = false }: { node: TextBoxNode; ctx: RenderContext; root?: boolean }) {
  const binding = node.value ? exactBinding(node.value) : null
  const local = ctx.inputs[node.name]
  const source = binding ? bindingDisplay(binding, ctx) : undefined
  const value = binding
    ? binding.mode === 'OneWayToSource'
      ? stringifyBinding(local)
      : stringifyBinding(source)
    : local !== undefined
      ? String(local ?? '')
      : node.value ? interpolate(node.value, ctx.scope, ctx.bindingOptions) : ''
  const setValue = (next: string) => {
    if (binding) {
      if (binding.mode === 'OneWay') return
      const converted = convertBackValue(next, binding.converter, binding.parameter, ctx.bindingOptions, ctx.scope)
      if (converted !== undefined) ctx.setInput(bindingInputName(binding, node.name), converted)
      return
    }
    ctx.setInput(node.name, next)
  }
  const className = 'flex w-full rounded-md border border-input bg-background px-3 py-2 text-sm shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring'
  return (
    <div style={nodeStyle(node)} data-widget-target={node.target} className={cn('flex flex-col gap-1', animationClass(node.animations), root && 'max-h-full overflow-auto')}>
      {node.multiline ? (
        <textarea
          value={value}
          placeholder={node.placeholder ? interpolate(node.placeholder, ctx.scope, ctx.bindingOptions) : undefined}
          readOnly={node.readOnly}
          maxLength={node.maxLength}
          onChange={(e) => {
            setValue(e.target.value)
            ctx.onAction(node.onChange)
          }}
          className={cn(className, 'min-h-[72px] resize-y')}
        />
      ) : (
        <input
          type={node.password ? 'password' : 'text'}
          value={value}
          placeholder={node.placeholder ? interpolate(node.placeholder, ctx.scope, ctx.bindingOptions) : undefined}
          readOnly={node.readOnly}
          maxLength={node.maxLength}
          onChange={(e) => {
            setValue(e.target.value)
            ctx.onAction(node.onChange)
          }}
          className={className}
        />
      )}
    </div>
  )
}

function CheckBoxControl({ node, ctx, root = false }: { node: CheckBoxNode; ctx: RenderContext; root?: boolean }) {
  const binding = typeof node.checked === 'string' ? exactBinding(node.checked) : null
  const local = ctx.inputs[node.name]
  const source = binding ? bindingDisplay(binding, ctx, 'boolean') : undefined
  const checked = binding
    ? isTruthy(binding.mode === 'OneWayToSource' ? local : source)
    : local !== undefined
      ? !!local
      : typeof node.checked === 'boolean'
        ? node.checked
        : isTruthy(resolvePath(ctx.scope, node.checked))
  return (
    <label style={nodeStyle(node)} data-widget-target={node.target} className={cn('flex items-center gap-2 text-sm', animationClass(node.animations), root && 'max-h-full overflow-auto')}>
      <Checkbox
        checked={checked}
        onCheckedChange={(value) => {
          if (binding) {
            if (binding.mode !== 'OneWay') {
              const converted = convertBackValue(value, binding.converter, binding.parameter, ctx.bindingOptions, ctx.scope)
              if (converted !== undefined) ctx.setInput(bindingInputName(binding, node.name), converted)
            }
          } else {
            ctx.setInput(node.name, value === true)
          }
          ctx.onAction(node.onChange)
        }}
      />
      {node.text ? interpolate(node.text, ctx.scope, ctx.bindingOptions) : null}
    </label>
  )
}

function SliderControl({ node, ctx }: { node: SliderNode; ctx: RenderContext }) {
  const binding = typeof node.value === 'string' ? exactBinding(node.value) : null
  const local = ctx.inputs[node.name]
  const source = binding ? bindingDisplay(binding, ctx, 'number') : node.value
  const value = Number(binding?.mode === 'OneWayToSource' ? local : local ?? source) || 0
  return (
    <input
      type="range"
      data-widget-target={node.target}
      value={value}
      min={node.min}
      max={node.max}
      step={node.step}
      style={nodeStyle(node)}
      onChange={(e) => {
        if (binding) {
          if (binding.mode !== 'OneWay') {
            const converted = convertBackValue(Number(e.target.value), binding.converter, binding.parameter, ctx.bindingOptions, ctx.scope)
            if (converted !== undefined) ctx.setInput(bindingInputName(binding, node.name), converted)
          }
        } else {
          ctx.setInput(node.name, Number(e.target.value))
        }
        ctx.onAction(node.onChange)
      }}
      className={cn('w-full accent-primary', animationClass(node.animations))}
    />
  )
}

interface SelectOptionValue {
  Label?: string
  Value?: string | number
}

function parseOptions(raw: string | unknown[], ctx: RenderContext): Array<{ label: string; value: string }> {
  let parsed: unknown
  try {
    parsed = Array.isArray(raw) ? raw : JSON.parse(interpolate(raw as string, ctx.scope, ctx.bindingOptions))
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
    : node.value ? interpolate(node.value, ctx.scope, ctx.bindingOptions) : ''
  return (
    <div style={nodeStyle(node)} data-widget-target={node.target} className={animationClass(node.animations)}>
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
  const value = Number(interpolate(node.value, ctx.scope, ctx.bindingOptions)) || 0
  const percent = Math.max(0, Math.min(100, (value / (node.max || 100)) * 100))
  return (
    <div style={nodeStyle(node)} className={cn('h-2 w-full overflow-hidden rounded-full bg-muted', animationClass(node.animations))}>
      <div className="h-full bg-primary transition-[width]" style={{ width: `${percent}%` }} />
    </div>
  )
}

function renderLink(node: LinkNode, ctx: RenderContext, root = false): ReactNode {
  const fallback = !node.onClick && node.url
    ? { name: 'OpenUrl' as const, args: { Url: node.url } }
    : undefined
  return (
    <button
      type="button"
      data-widget-target={node.target}
      style={nodeStyle(node)}
      onClick={() => ctx.onAction(node.onClick ?? fallback, node.name)}
      className={cn('w-fit text-left text-sm text-primary underline-offset-4 hover:underline', animationClass(node.animations), root && 'max-h-full max-w-full overflow-auto')}
    >
      {interpolate(node.text, ctx.scope, ctx.bindingOptions)}
    </button>
  )
}

function FilePickerControl({ node, ctx, root = false }: { node: FilePickerNode; ctx: RenderContext; root?: boolean }) {
  const value = ctx.inputs[node.name] !== undefined
    ? String(ctx.inputs[node.name] ?? '')
    : node.value ? interpolate(node.value, ctx.scope, ctx.bindingOptions) : ''
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
    <div style={nodeStyle(node)} data-widget-target={node.target} className={cn('flex flex-col gap-1', animationClass(node.animations), root && 'max-h-full overflow-auto')}>
      <Button type="button" variant="outline" size="sm" onClick={() => void pick()}>
        {interpolate(node.text, ctx.scope, ctx.bindingOptions)}
      </Button>
      <span className="truncate font-mono text-[11px] text-muted-foreground">{value}</span>
    </div>
  )
}

function ColorPickerControl({ node, ctx }: { node: ColorPickerNode; ctx: RenderContext }) {
  const value = ctx.inputs[node.name] !== undefined
    ? String(ctx.inputs[node.name] ?? '')
    : node.value ? interpolate(node.value, ctx.scope, ctx.bindingOptions) : '#000000'
  return (
    <input
      type="color"
      data-widget-target={node.target}
      value={/^#[0-9a-f]{6}$/i.test(value) ? value : '#000000'}
      style={nodeStyle(node)}
      onChange={(e) => {
        ctx.setInput(node.name, e.target.value)
        ctx.onAction(node.onChange)
      }}
      className={cn('h-8 w-12 cursor-pointer rounded border border-input bg-background p-0.5', animationClass(node.animations))}
    />
  )
}

function renderSpacer(node: SpacerNode): ReactNode {
  return <div className={cn('shrink-0', animationClass(node.animations))} style={{ ...nodeStyle(node), width: node.size, height: node.size }} />
}
