// Copyright (C) 2026 Qomicex Launcher Contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import type {
  ActionName,
  DataSourceSpec,
  FolderTarget,
  NavTarget,
  INSTALL_CATEGORIES,
  INSTALL_SOURCES,
} from './schema.ts'

export type Bindable = string

export interface LayoutAttrs {
  gap?: number
  padding?: number
  align?: 'start' | 'center' | 'end' | 'stretch'
  justify?: 'start' | 'center' | 'end' | 'between'
  wrap?: boolean
}

export interface ContainerNode extends LayoutAttrs {
  kind: 'container'
  direction: 'row' | 'column'
  border: boolean
  background: 'transparent' | 'card' | 'muted' | 'primary'
  radius: 'none' | 'sm' | 'md' | 'lg' | 'full'
  children: WidgetNode[]
}

export interface RowNode extends LayoutAttrs {
  kind: 'row'
  children: WidgetNode[]
}

export interface ColumnNode extends LayoutAttrs {
  kind: 'column'
  children: WidgetNode[]
}

export interface GridNode extends LayoutAttrs {
  kind: 'grid'
  columns: number
  children: WidgetNode[]
}

export interface TabItemNode {
  kind: 'tabItem'
  title: Bindable
  children: WidgetNode[]
}

export interface TabsNode {
  kind: 'tabs'
  defaultIndex: number
  children: TabItemNode[]
}

export interface ListItemNode {
  kind: 'listItem'
  child: WidgetNode
}

export interface ListNode {
  kind: 'list'
  items: string
  as: string
  gap?: number
  emptyText?: Bindable
  item: ListItemNode
}

export interface TextNode {
  kind: 'text'
  value: Bindable
  size: 'xs' | 'sm' | 'md' | 'lg' | 'xl' | '2xl'
  weight: 'normal' | 'medium' | 'semibold' | 'bold'
  color: 'default' | 'muted' | 'primary' | 'destructive'
  clamp?: number
  align?: 'start' | 'center' | 'end'
}

export interface ButtonNode {
  kind: 'button'
  text: Bindable
  variant: 'default' | 'secondary' | 'outline' | 'ghost' | 'destructive' | 'link'
  size: 'sm' | 'default' | 'lg'
  onClick: ActionName
  args: Record<string, Bindable>
}

export interface ImageNode {
  kind: 'image'
  src: Bindable
  alt?: string
  w?: number
  h?: number
  rounded: boolean
}

export interface DividerNode {
  kind: 'divider'
}

export interface SpacerNode {
  kind: 'spacer'
  size: number
}

export interface IfNode {
  kind: 'if'
  test: string
  children: WidgetNode[]
}

export type WidgetNode =
  | ContainerNode
  | RowNode
  | ColumnNode
  | GridNode
  | TabsNode
  | ListNode
  | TextNode
  | ButtonNode
  | ImageNode
  | DividerNode
  | SpacerNode
  | IfNode

export interface WidgetDocument {
  name: string
  version: string
  author?: string
  description?: string
  updateUrl?: string
  datas: DataSourceSpec[]
  nodes: WidgetNode[]
  staticImageUrls: string[]
}

export interface WidgetAction {
  name: ActionName
  args: Record<string, string>
}

/** 动作参数在点击时才求值；这里只保存已解析的枚举类型。 */
export interface ResolvedActionArgs {
  instance?: string
  to?: NavTarget
  url?: string
  target?: FolderTarget
  value?: string
  projectId?: string
  source?: (typeof INSTALL_SOURCES)[number]
  category?: (typeof INSTALL_CATEGORIES)[number]
}
