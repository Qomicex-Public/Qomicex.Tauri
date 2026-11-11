// Copyright (C) 2026 Qomicex Launcher Contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import type {
  ActionName,
  DATA_SOURCES,
  DATA_TYPES,
  DataSourceSpec,
  FIELD_TYPES,
  FolderTarget,
  INSTALL_CATEGORIES,
  INSTALL_SOURCES,
  NavTarget,
  TRIGGER_EVENTS,
} from './schema.ts'

export type Bindable = string

export interface ActionSpec {
  name: ActionName
  args: Record<string, string>
}

export interface GridAttached {
  row?: number
  column?: number
  rowSpan?: number
  columnSpan?: number
}

export interface NodeBase {
  attached?: GridAttached
  /** 脚本定位键，与输入控件的 Name 分离。 */
  target?: string
  visible?: boolean
  /** 尺寸条件，如 "Size.Width <= 1"；不满足时不渲染。 */
  when?: string
  /** 引用 Resource Type="Page" 的页面名。 */
  contentPage?: string
}

export interface WidgetSizeInfo {
  Width: number
  Height: number
  PixelWidth: number
  PixelHeight: number
}

export type FieldType = (typeof FIELD_TYPES)[number]

export interface InputDecl {
  name: string
  type: FieldType
  required: boolean
  default?: string
}

export interface OutputDecl {
  name: string
  type: FieldType
  source: string
}

export interface LayoutAttrs {
  gap?: number
  padding?: number
  align?: 'Start' | 'Center' | 'End' | 'Stretch'
  justify?: 'Start' | 'Center' | 'End' | 'Between'
  wrap?: boolean
}

export interface ContainerNode extends NodeBase, LayoutAttrs {
  kind: 'container'
  direction: 'Row' | 'Column'
  border: boolean
  background: 'Transparent' | 'Card' | 'Muted' | 'Primary'
  radius: 'None' | 'Sm' | 'Md' | 'Lg' | 'Full'
  children: WidgetNode[]
}

export interface RowNode extends NodeBase, LayoutAttrs {
  kind: 'row'
  children: WidgetNode[]
}

export interface ColumnNode extends NodeBase, LayoutAttrs {
  kind: 'column'
  children: WidgetNode[]
}

export interface GridNode extends NodeBase, LayoutAttrs {
  kind: 'grid'
  columns: number
  children: WidgetNode[]
}

export interface TabItemNode {
  kind: 'tabItem'
  title: Bindable
  target?: string
  visible?: boolean
  when?: string
  contentPage?: string
  children: WidgetNode[]
}

export interface TabsNode extends NodeBase {
  kind: 'tabs'
  defaultIndex: number
  children: TabItemNode[]
}

export interface ListItemNode {
  kind: 'listItem'
  target?: string
  visible?: boolean
  when?: string
  contentPage?: string
  child?: WidgetNode
}

export interface ListNode extends NodeBase {
  kind: 'list'
  items: string
  as: string
  gap?: number
  emptyText?: Bindable
  item?: ListItemNode
}

export interface TextNode extends NodeBase {
  kind: 'text'
  value: Bindable
  size: 'Xs' | 'Sm' | 'Md' | 'Lg' | 'Xl' | '2Xl'
  weight: 'Normal' | 'Medium' | 'Semibold' | 'Bold'
  color: 'Default' | 'Muted' | 'Primary' | 'Destructive'
  clamp?: number
  align?: 'Start' | 'Center' | 'End'
}

export interface ButtonNode extends NodeBase {
  kind: 'button'
  name?: string
  text: Bindable
  variant: 'Default' | 'Secondary' | 'Outline' | 'Ghost' | 'Destructive' | 'Link'
  size: 'Sm' | 'Md' | 'Lg'
  onClick?: ActionSpec
}

export interface ImageNode extends NodeBase {
  kind: 'image'
  src: Bindable
  alt?: string
  w?: number
  h?: number
  rounded: boolean
}

export interface MediaNode extends NodeBase {
  kind: 'media'
  type: 'Audio' | 'Video'
  source: Bindable
  controls: boolean
  autoPlay: boolean
  loop: boolean
  poster?: Bindable
  volume?: number
  muted: boolean
}

export interface TextBoxNode extends NodeBase {
  kind: 'textBox'
  name: string
  value?: Bindable
  placeholder?: Bindable
  multiline: boolean
  password: boolean
  readOnly: boolean
  maxLength?: number
  onChange?: ActionSpec
}

export interface CheckBoxNode extends NodeBase {
  kind: 'checkBox'
  name: string
  text?: Bindable
  checked: boolean | Bindable
  onChange?: ActionSpec
}

export interface SliderNode extends NodeBase {
  kind: 'slider'
  name: string
  value: number
  min: number
  max: number
  step: number
  onChange?: ActionSpec
}

export interface SelectNode extends NodeBase {
  kind: 'select'
  name: string
  value?: Bindable
  options: Bindable
  onChange?: ActionSpec
}

export interface ProgressNode extends NodeBase {
  kind: 'progress'
  value: Bindable
  max: number
}

export interface LinkNode extends NodeBase {
  kind: 'link'
  name?: string
  text: Bindable
  url?: Bindable
  onClick?: ActionSpec
}

export interface FilePickerNode extends NodeBase {
  kind: 'filePicker'
  name: string
  text: Bindable
  filter?: string
  value?: Bindable
}

export interface ColorPickerNode extends NodeBase {
  kind: 'colorPicker'
  name: string
  value?: Bindable
  onChange?: ActionSpec
}

export interface DividerNode extends NodeBase {
  kind: 'divider'
}

export interface DialogNode extends NodeBase {
  kind: 'dialog'
  name: string
  title?: string
  width: 'Sm' | 'Md' | 'Lg' | 'Xl' | 'Full'
  children: WidgetNode[]
}

export type PageNode = WidgetNode | TabItemNode | ListItemNode

export interface SpacerNode extends NodeBase {
  kind: 'spacer'
  size: number
}

export interface IfNode extends NodeBase {
  kind: 'if'
  test: string
  children: WidgetNode[]
}

export interface UsingNode extends NodeBase {
  kind: 'using'
  name?: string
  url?: string
  as: string
  refresh?: number
  argumentsJson?: string
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
  | MediaNode
  | TextBoxNode
  | CheckBoxNode
  | SliderNode
  | SelectNode
  | ProgressNode
  | LinkNode
  | FilePickerNode
  | ColorPickerNode
  | DividerNode
  | DialogNode
  | SpacerNode
  | IfNode
  | UsingNode

export interface ResourceEntry {
  name: string
  type: 'String' | 'Bool' | 'Number' | 'Binary' | 'Json' | 'Page'
  value: string
  mime?: string
  page?: PageNode[]
}

export interface StructField {
  name: string
  type: (typeof FIELD_TYPES)[number] | string
}

export interface StructDef {
  name: string
  fields: StructField[]
}

export interface FunctionInput {
  type: string
  name: string
}

export interface FunctionOutput {
  type: string
  name: string
}

export interface FunctionNode {
  name: string
  timeout: number
  structs: StructDef[]
  inputs: FunctionInput[]
  outputs: FunctionOutput[]
  script: string
}

export interface TriggerNode {
  event: (typeof TRIGGER_EVENTS)[number]
  function?: string
  action?: ActionSpec
  control?: string
  data?: string
  interval?: number
  once: boolean
}

export interface WidgetDocument {
  name: string
  version: string
  author?: string
  description?: string
  updateUrl?: string
  launcherVersion?: string
  inputs: InputDecl[]
  outputs: OutputDecl[]
  datas: DataSourceSpec[]
  resources: ResourceEntry[]
  pages: Record<string, PageNode[]>
  functions: FunctionNode[]
  triggers: TriggerNode[]
  nodes: WidgetNode[]
  staticMediaUrls: string[]
  nestedUrls: string[]
}

export interface BinaryValue {
  Url: string
  Base64: string
  Mime: string
  Size: number
}

export type DataSourceType = (typeof DATA_TYPES)[number]
export type DataSourceKind = (typeof DATA_SOURCES)[number]

export interface ResolvedActionArgs {
  instance?: string
  to?: NavTarget
  url?: string
  folder?: FolderTarget
  value?: string
  projectId?: string
  source?: (typeof INSTALL_SOURCES)[number]
  category?: (typeof INSTALL_CATEGORIES)[number]
  function?: string
  arguments?: string
  command?: string
  workingDirectory?: string
  timeout?: string
  pluginId?: string
  method?: string
}
