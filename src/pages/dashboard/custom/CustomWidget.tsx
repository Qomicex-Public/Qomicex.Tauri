// Copyright (C) 2026 Qomicex Launcher Contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useMessageBox } from '../../../components/ui'
import { useI18n } from '../../../i18n/index.tsx'
import { fetchWidgetUrl } from '../../../api/widgets.ts'
import { openExternalUrl } from '../../../api/system.ts'
import { useDashboard, useWidgetSize } from '../context.tsx'
import { runWidgetAction } from './actions.ts'
import type { BindingOptions } from './converters.ts'
import {
  collectAutoHosts,
  compareVersions,
  hostOf,
  interpolate,
  interpolateDeep,
  isBound,
  isSafeHttpsUrl,
  resolvePath,
  WIDGET_LIMITS,
  WidgetError,
} from './schema.ts'
import { makeBinaryValue, mimeFromPath, parseResourceEntries, parseXmlValue, readLocalBinary, readLocalText, resolveDataPath } from './binary.ts'
import { resolveInputValues, resolveOutputValues } from './contract.ts'
import { getLauncherVersion } from './launcher-version.ts'
import { renderNodes, applyNodeOverrides, contentProperty, propertyField, type RenderContext } from './render.tsx'
import { runFunction as executeFunction } from './script/functions.ts'
import { ScriptSandbox } from './script/sandbox.ts'
import { bindingRoots, commandHash, executableActions, executableFingerprint, hasExternalBinding, isCommandApproved, isExecutableApproved, approveCommand, approveExecutable, BINDING_ROOTS } from './security.ts'
import {
  getBinary,
  getRemoteWidget,
  setBinary,
  setRemoteWidget,
  useCustomWidgetStore,
  type CustomWidgetDef,
} from './store.ts'
import type {
  ActionSpec,
  TriggerNode,
  UsingNode,
  PageNode,
  EffectSpec,
  WidgetDocument,
  WidgetNode,
  WidgetSizeInfo,
} from './types.ts'
import { parseWidgetXml } from './xml.ts'

export interface ChildSnapshot {
  Inputs: Record<string, unknown>
  Data?: Record<string, unknown>
  Results?: Record<string, unknown>
  Outputs?: Record<string, unknown>
  State: { Loading: boolean; Error: boolean }
}

const preLaunchUpdateDone = new Set<string>()
const preLaunchRefreshDone = new Set<string>()

type TtlMode =
  | { type: 'interval'; ms: number }
  | { type: 'mount' }
  | { type: 'launch' }
  | { type: 'none' }

function ttlMode(spec: WidgetDocument['updateTtl'] | undefined, fallbackMs: number): TtlMode {
  if (spec === undefined || spec === 'Default') return { type: 'interval', ms: fallbackMs }
  if (spec === 'None') return { type: 'none' }
  if (spec === 'Immediately' || spec === 'PreLoad') return { type: 'mount' }
  if (spec === 'PreLaunch') return { type: 'launch' }
  return { type: 'interval', ms: Math.max(0, spec * 1000) }
}

interface CustomWidgetProps {
  def: CustomWidgetDef
  chain?: string[]
  initialInputs?: Record<string, unknown>
  onSnapshot?: (snapshot: ChildSnapshot) => void
  preview?: boolean
}

function findNodeByTarget(nodes: WidgetNode[], target: string): WidgetNode | null {
  for (const node of nodes) {
    if (node.target === target) return node
    switch (node.kind) {
      case 'container':
      case 'row':
      case 'column':
      case 'grid':
      case 'if':
      case 'dialog':
        {
          const found = findNodeByTarget(node.children, target)
          if (found) return found
        }
        break
      case 'tabs':
        for (const tab of node.children) {
          const found = findNodeByTarget(tab.children, target)
          if (found) return found
        }
        break
      case 'list':
        {
          const found = node.item?.child ? findNodeByTarget([node.item.child], target) : null
          if (found) return found
        }
        break
      default:
        break
    }
  }
  return null
}

const NON_PROPERTY_ATTRS = new Set(['Target', 'Name', 'OnClick', 'OnChange', 'Function', 'Arguments', 'Command', 'WorkingDirectory', 'Timeout', 'PluginId', 'Method'])

function nodeProperty(node: WidgetNode, property: string, scope: Record<string, unknown>, overrides: Record<string, unknown>): unknown {  const field = propertyField(node, property)
  if (!field || NON_PROPERTY_ATTRS.has(property)) throw new Error(`不可读写属性: ${property}`)
  const effective = applyNodeOverrides(node, overrides)
  const raw = (effective as unknown as Record<string, unknown>)[field]
  if (field === 'visible') return raw !== false
  if (field === 'items') {
    if (Array.isArray(raw)) return raw
    return typeof raw === 'string' ? resolvePath(scope, raw) ?? [] : []
  }
  if (typeof raw === 'string') return interpolate(raw, scope)
  return raw
}

function resolveActionValue(value: string, scope: Record<string, unknown>): string {
  return value.replace(/\{([^{}]+)\}/g, (raw, token: string) => {
    const root = token.trim().split('.')[0]
    if (!BINDING_ROOTS.has(root)) return raw
    const found = resolveScopeValue(scope, token)
    return found === undefined || found === null ? '' : String(found)
  })
}

function dataScopeOf(
  data: Record<string, unknown>,
  sources: WidgetDocument['datas'],
  status: Record<string, 'Loading' | 'Completed' | 'Error'>,
): Record<string, unknown> {
  const root: Record<string, unknown> = {}
  const statusMap: Record<string, 'Loading' | 'Completed' | 'Error'> = {}
  for (const source of sources) {
    const value = data[source.name]
    root[source.name] = value
    statusMap[source.name] = status[source.name] ?? 'Loading'
    if (source.name === 'Data' && value && typeof value === 'object' && !Array.isArray(value)) {
      Object.assign(root, value as Record<string, unknown>)
    }
  }
  if (sources.length > 0) root.Status = statusMap
  return root
}

interface ShortcutBinding {
  keys: string
  action?: ActionSpec
  control?: string
}

function collectShortcuts(
  nodes: PageNode[],
  out: ShortcutBinding[],
): void {
  for (const node of nodes) {
    if (node.kind === 'button' || node.kind === 'link') {
      for (const keys of node.shortcuts ?? []) {
        const action = node.onClick
          ?? (node.kind === 'link' && node.url ? { name: 'OpenUrl' as const, args: { Url: node.url } } : undefined)
        out.push({ keys, action, control: node.name })
      }
    }
    switch (node.kind) {
      case 'container':
      case 'row':
      case 'column':
      case 'grid':
      case 'if':
      case 'dialog':
        collectShortcuts(node.children, out)
        break
      case 'tabs':
        for (const tab of node.children) collectShortcuts(tab.children, out)
        break
      case 'tabItem':
        collectShortcuts(node.children, out)
        break
      case 'list':
        if (node.item?.child) collectShortcuts([node.item.child], out)
        break
      case 'listItem':
        if (node.child) collectShortcuts([node.child], out)
        break
      default:
        break
    }
  }
}

export function CustomWidget({ def, chain = [], initialInputs, onSnapshot, preview = false }: CustomWidgetProps) {
  const { t, lang } = useI18n()
  const { defaultInstance, launch, refresh, resolveAccountCheck } = useDashboard()
  const gridSize = useWidgetSize()
  const navigate = useNavigate()
  const { notify, error: showError, confirm } = useMessageBox()
  const setCachedData = useCustomWidgetStore((s) => s.setData)
  const updateDef = useCustomWidgetStore((s) => s.updateDef)
  const clearData = useCustomWidgetStore((s) => s.clearData)

  const parsed = useMemo(() => {
    try {
      return { doc: parseWidgetXml(def.xml), error: null as WidgetError | null }
    } catch (error) {
      return { doc: null, error: error instanceof WidgetError ? error : new WidgetError('xmlInvalid') }
    }
  }, [def.xml])
  const doc = parsed.doc

  const inputResolution = useMemo(() => {
    try {
      return { values: resolveInputValues(doc?.inputs ?? [], initialInputs), error: null as string | null }
    } catch (cause) {
      return { values: {}, error: cause instanceof Error ? cause.message : String(cause) }
    }
  }, [doc, initialInputs])
  const resolvedInputs = inputResolution.values

  const [inputs, setInputs] = useState<Record<string, unknown>>(resolvedInputs)
  const inputsRef = useRef(inputs)
  const [results, setResults] = useState<Record<string, Record<string, unknown>>>({})
  const [children, setChildren] = useState<Record<string, ChildSnapshot>>({})
  const [overrides, setOverrides] = useState<Record<string, Record<string, unknown>>>({})
  const overridesRef = useRef<Record<string, Record<string, unknown>>>({})
  const [effectOverrides, setEffectOverrides] = useState<Record<string, EffectSpec[]>>({})
  const [openDialogs, setOpenDialogs] = useState<Set<string>>(new Set())
  const [data, setData] = useState<Record<string, unknown>>({})
  const [dataStatus, setDataStatus] = useState<Record<string, 'Loading' | 'Completed' | 'Error'>>({})
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [tick, setTick] = useState(0)
  const [pixelSize, setPixelSize] = useState({ width: 0, height: 0 })
  const [launcherVersion, setLauncherVersion] = useState<string | null>(null)
  const objectUrls = useRef(new Set<string>())
  const sandboxRef = useRef<ScriptSandbox | null>(null)
  const triggerRate = useRef<number[]>([])
  const timerFiredRef = useRef<Set<string>>(new Set())
  const loadedRef = useRef<string | null>(null)
  const lastResizeRef = useRef<string | null>(null)
  const lastSnapshot = useRef('')
  const forceRefreshRef = useRef(false)
  const lastInitialInputs = useRef('')
  const lastInitialInputKeys = useRef<string[]>([])
  const rootRef = useRef<HTMLDivElement>(null)
  const sizeRef = useRef<WidgetSizeInfo>({ Width: 0, Height: 0, PixelWidth: 0, PixelHeight: 0 })
  const updateMountRef = useRef<string | null>(null)
  const refreshMountRef = useRef<string | null>(null)
  const executeFunctionRef = useRef<(name: string, trigger: TriggerNode) => void>(() => {})
  const runtimeRef = useRef<{
    setProperty: (target: string, property: string, value: unknown) => Promise<unknown>
    getProperty: (target: string, property: string) => Promise<unknown>
    getSize: () => Promise<WidgetSizeInfo>
    invoke: (target: string, method: string, args: unknown[]) => Promise<unknown>
  } | null>(null)

  const trackUrl = useCallback((url: string) => {
    objectUrls.current.add(url)
  }, [])

  useEffect(() => {
    inputsRef.current = inputs
  }, [inputs])

  useEffect(() => {
    if (!initialInputs && !doc?.inputs.length) return
    let signature: string
    try {
      signature = JSON.stringify(resolvedInputs)
    } catch {
      signature = String(Date.now())
    }
    if (signature === lastInitialInputs.current) return
    lastInitialInputs.current = signature
    try {
      const current = Object.fromEntries(Object.keys(resolvedInputs).map((key) => [key, inputsRef.current[key]]))
      if (signature === JSON.stringify(current)) return
    } catch {
      /* 输入不可序列化时仍继续应用 */
    }
    const next = { ...inputsRef.current }
    for (const key of lastInitialInputKeys.current) {
      if (!(key in resolvedInputs)) delete next[key]
    }
    for (const [key, value] of Object.entries(resolvedInputs)) next[key] = value
    lastInitialInputKeys.current = Object.keys(resolvedInputs)
    inputsRef.current = next
    setInputs(next)
  }, [initialInputs, doc, resolvedInputs])

  useEffect(() => {
    overridesRef.current = {}
    setOverrides({})
    setEffectOverrides({})
    setOpenDialogs(new Set())
  }, [def.id, def.xml])

  // 在线组件更新：纯数据/布局静默替换；可执行内容变化时确认。
  useEffect(() => {
    if (!doc) return
    const updateUrl = doc.updateUrl ?? def.sourceUrl
    if (!updateUrl) return
    const mode = ttlMode(doc.updateTtl, WIDGET_LIMITS.updateTtlMs)
    if (mode.type === 'none') return
    const now = Date.now()
    if (mode.type === 'interval' && now - (def.lastChecked ?? 0) < mode.ms) return
    if (mode.type === 'mount') {
      const key = def.id
      if (updateMountRef.current === key) return
      updateMountRef.current = key
    }
    if (mode.type === 'launch') {
      if (preLaunchUpdateDone.has(def.id)) return
      preLaunchUpdateDone.add(def.id)
    }
    const controller = new AbortController()
    let cancelled = false
    void fetchWidgetUrl(updateUrl, controller.signal)
      .then(async (response) => {
        if (cancelled) return
        if (response.body === def.xml) {
          updateDef(def.id, { lastChecked: now })
          return
        }
        const next = parseWidgetXml(response.body)
        const nextExecutable = executableFingerprint(next)
        const currentExecutable = def.executableHash ?? executableFingerprint(doc)
        if (nextExecutable && nextExecutable !== currentExecutable) {
          const commands = executableActions(next)
            .map((action) => action.args.Command ?? action.args.PluginId ?? action.name)
            .join(' | ')
          const accepted = await confirm(
            `${t('dashboard.custom.riskMessage')}\n\n${commands}`,
            t('dashboard.custom.riskTitle'),
          )
          if (!accepted) {
            updateDef(def.id, { lastChecked: now })
            return
          }
        }
        if (cancelled) return
        const currentDef = useCustomWidgetStore.getState().defs.find((item) => item.id === def.id)
        if (!currentDef || currentDef.xml !== def.xml) return
        const hosts = collectAutoHosts({
          datas: next.datas,
          updateUrl: next.updateUrl,
          staticMediaUrls: next.staticMediaUrls,
          nestedUrls: next.nestedUrls,
        })
        const sourceHost = def.sourceUrl ? hostOf(def.sourceUrl) : null
        updateDef(def.id, {
          xml: response.body,
          name: next.name,
          hosts: [...new Set([...def.hosts, ...hosts, ...(sourceHost ? [sourceHost] : [])])],
          executableHash: nextExecutable || undefined,
          lastChecked: now,
        })
        clearData(def.id)
      })
      .catch(() => {
        if (!cancelled) updateDef(def.id, { lastChecked: now })
      })
    return () => {
      cancelled = true
      controller.abort()
    }
  }, [doc, def, updateDef, clearData, confirm, t])

  useEffect(() => {
    if (!doc?.launcherVersion) return
    void getLauncherVersion().then(setLauncherVersion)
  }, [doc])

  useEffect(() => {
    const urls = objectUrls.current
    return () => {
      for (const url of urls) URL.revokeObjectURL(url)
      urls.clear()
      sandboxRef.current?.destroy()
      sandboxRef.current = null
    }
  }, [])

  const resources = useMemo(() => (doc ? parseResourceEntries(doc.resources, trackUrl) : {}), [doc, trackUrl])

  const size = useMemo<WidgetSizeInfo>(() => ({
    Width: gridSize.w,
    Height: gridSize.h,
    PixelWidth: pixelSize.width,
    PixelHeight: pixelSize.height,
  }), [gridSize.w, gridSize.h, pixelSize.width, pixelSize.height])

  useEffect(() => {
    sizeRef.current = size
  }, [size])

  useEffect(() => {
    const element = rootRef.current
    if (!element) return
    const observer = new ResizeObserver((entries) => {
      const rect = entries[0]?.contentRect
      if (!rect) return
      const width = Math.round(rect.width)
      const height = Math.round(rect.height)
      setPixelSize((prev) => (prev.width === width && prev.height === height ? prev : { width, height }))
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [doc])

  const scope = useMemo(() => {
    const named: Record<string, unknown> = { ...data }
    return {
      ...named,
      Data: dataScopeOf(data, doc?.datas ?? [], dataStatus),
      Resources: resources,
      Inputs: inputs,
      Results: results,
      Children: children,
      Size: size,
      State: { Loading: loading, Error: !!error },
    }
  }, [data, doc, resources, inputs, results, children, size, dataStatus, loading, error])

  const outputs = useMemo(
    () => (doc ? resolveOutputValues(doc.outputs, (source) => resolvePath(scope, source)) : {}),
    [doc, scope],
  )

  const bindingOptions = useMemo(
    () => ({ converters: doc?.converters ?? [], locale: lang, targetType: 'string' }),
    [doc, lang],
  )

  const setInput = useCallback((name: string, value: unknown) => {
    const next = { ...inputsRef.current, [name]: value }
    inputsRef.current = next
    setInputs(next)
  }, [])

  const showDialog = useCallback((name: string) => {
    setOpenDialogs((prev) => new Set(prev).add(name))
  }, [])

  const hideDialog = useCallback((name: string) => {
    setOpenDialogs((prev) => {
      const next = new Set(prev)
      next.delete(name)
      return next
    })
  }, [])

  const applyEffects = useCallback((target: string, effects: EffectSpec[]) => {
    setEffectOverrides((prev) => ({ ...prev, [target]: effects }))
  }, [])

  const setProperty = useCallback(async (target: string, property: string, value: unknown): Promise<unknown> => {
    if (!doc) throw new Error('组件未加载')
    if (NON_PROPERTY_ATTRS.has(property)) throw new Error(`不可读写属性: ${property}`)
    if (value === undefined) throw new Error(`SetProperty(${target}, ${property}) 的值不能是 undefined`)
    const node = findNodeByTarget(doc.nodes, target)
    if (!node) throw new Error(`找不到 Target: ${target}`)
    const field = propertyField(node, property)
    if (!field) throw new Error(`不可读写属性: ${property}`)
    const storedProperty = property === 'Content' ? (contentProperty(node) ?? property) : property
    const normalized = field === 'visible'
      ? value === true || value === 'true' || value === 'True'
      : value
    const effective = applyNodeOverrides(node, { [storedProperty]: normalized })
    const coerced = (effective as unknown as Record<string, unknown>)[field]
    if (
      field === 'value'
      || field === 'checked'
    ) {
      if (node.kind === 'textBox' || node.kind === 'slider' || node.kind === 'select' || node.kind === 'colorPicker' || node.kind === 'filePicker') {
        setInput(node.name, coerced)
      } else if (node.kind === 'checkBox' && field === 'checked') {
        setInput(node.name, coerced)
      }
    }
    const nextOverrides = {
      ...overridesRef.current,
      [target]: { ...(overridesRef.current[target] ?? {}), [storedProperty]: coerced },
    }
    overridesRef.current = nextOverrides
    setOverrides(nextOverrides)
    return coerced
  }, [doc, setInput])

  const getSize = useCallback(async (): Promise<WidgetSizeInfo> => sizeRef.current, [])

  const getProperty = useCallback(async (target: string, property: string): Promise<unknown> => {    if (!doc) throw new Error('组件未加载')
    if (NON_PROPERTY_ATTRS.has(property)) throw new Error(`不可读写属性: ${property}`)
    const node = findNodeByTarget(doc.nodes, target)
    if (!node) throw new Error(`找不到 Target: ${target}`)
    const field = propertyField(node, property)
    if (!field) throw new Error(`不可读写属性: ${property}`)
    const nodeName = 'name' in node ? node.name : undefined
    const currentInput = nodeName ? inputsRef.current[nodeName] : undefined
    if (field === 'value' || field === 'checked') {
      if (currentInput !== undefined) return currentInput
      if (node.kind === 'checkBox' && field === 'checked') return node.checked
    }
    return nodeProperty(node, property, { ...scope, Inputs: inputsRef.current }, overridesRef.current[target] ?? {})
  }, [doc, scope])

  const decodeData = useCallback(async (source: WidgetDocument['datas'][number], signal: AbortSignal): Promise<unknown> => {
    const inputScope = { Inputs: inputsRef.current }
    if (source.source === 'File') {
      const rawPath = interpolate(source.path ?? '', inputScope)
      const path = resolveDataPath({ sourcePath: def.sourcePath }, rawPath)
      if (source.type === 'Binary') {
        const file = await readLocalBinary(path)
        const value = makeBinaryValue(file.base64, source.mime || mimeFromPath(path), file.size)
        trackUrl(value.Url)
        setBinary(`${def.id}:${source.name}`, value)
        return value
      }
      const text = await readLocalText(path)
      if (source.type === 'Json') return JSON.parse(text)
      if (source.type === 'Xml') return parseXmlValue(text)
      return text
    }

    if (!source.url) throw new Error('数据源缺少 Url')
    const url = interpolate(source.url, inputScope)
    if (!isSafeHttpsUrl(url)) throw new Error(`数据源 Url 无效: ${url}`)
    const host = hostOf(url)
    if (!host || !def.hosts.includes(host)) throw new Error(`数据源域名未确认: ${host ?? url}`)
    const response = await fetchWidgetUrl(url, signal, {
      binary: source.type === 'Binary',
      timeoutMs: 20_000,
    })
    if (source.type === 'Binary') {
      if (!response.base64) throw new Error('二进制响应为空')
      const value = makeBinaryValue(response.base64, source.mime || response.contentType || 'application/octet-stream', response.size ?? 0)
      trackUrl(value.Url)
      setBinary(`${def.id}:${source.name}`, value)
      return value
    }
    if (source.type === 'Xml') return parseXmlValue(response.body)
    if (source.type === 'Json') return JSON.parse(response.body)
    return response.body
  }, [def.id, def.sourcePath, def.hosts, trackUrl])

  useEffect(() => {
    if (!doc || doc.datas.length === 0) return
    const controller = new AbortController()
    let cancelled = false
    const now = Date.now()
    const force = forceRefreshRef.current
    forceRefreshRef.current = false
    const cache = useCustomWidgetStore.getState().dataCache[def.id]
    const next: Record<string, unknown> = { ...data }
    let changed = false

    const stale = doc.datas.filter((source) => {
      const dynamic = isBound(source.url ?? '') || isBound(source.path ?? '')
      if (force || dynamic) return true
      const entry = cache?.[source.name]
      const freshWindow = Math.max(0, source.refresh * 1000 - 5000)
      const fresh = entry && source.refresh > 0 && now - entry.at < freshWindow
      if (fresh) {
        next[source.name] = entry.json
        changed = true
        return false
      }
      if (source.type === 'Binary') {
        const binary = getBinary(`${def.id}:${source.name}`)
        if (binary) {
          const freshBinary = makeBinaryValue(binary.Base64, binary.Mime, binary.Size)
          trackUrl(freshBinary.Url)
          setBinary(`${def.id}:${source.name}`, freshBinary)
          next[source.name] = freshBinary
          changed = true
          return false
        }
      }
      return true
    })
    if (changed) setData(next)
    const statuses: Record<string, 'Loading' | 'Completed' | 'Error'> = {}
    const staleNames = new Set(stale.map((source) => source.name))
    for (const source of doc.datas) {
      statuses[source.name] = staleNames.has(source.name)
        ? 'Loading'
        : next[source.name] !== undefined
          ? 'Completed'
          : 'Loading'
    }
    setDataStatus(statuses)
    if (stale.length === 0) {
      setLoading(false)
      setError(null)
      return
    }

    setLoading(true)
    setError(null)
    const fetched: Record<string, unknown> = {}
    void Promise.allSettled(
      stale.map(async (source) => {
        const value = await decodeData(source, controller.signal)
        if (cancelled) return
        fetched[source.name] = value
        if (source.type !== 'Binary' && !isBound(source.url ?? '') && !isBound(source.path ?? '')) {
          setCachedData(def.id, source.name, value)
        }
        fireTriggerRef.current?.('DataChanged', source.name)
      }),
    ).then((items) => {
      if (cancelled) return
      setLoading(false)
      const failed = items.filter((item) => item.status === 'rejected')
      const finalStatuses = { ...statuses }
      items.forEach((item, index) => {
        finalStatuses[stale[index].name] = item.status === 'rejected' ? 'Error' : 'Completed'
      })
      setDataStatus(finalStatuses)
      setError(failed.length > 0 ? 'data' : null)
      if (Object.keys(fetched).length > 0) {
        setData((prev) => ({ ...prev, ...fetched }))
      }
    })
    return () => {
      cancelled = true
      controller.abort()
    }
    // data 故意不进依赖：只在数据源/刷新/重试时重拉，避免 setData 触发自身
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc, def.id, tick, inputs, decodeData, setCachedData])

  const sandbox = useCallback(() => {
    if (!sandboxRef.current) {
      sandboxRef.current = new ScriptSandbox({
        Notify: (message, type) => notify(message, type as 'info' | 'error' | 'success' | undefined),
        OpenUrl: (url) => {
          if (!url.startsWith('https://')) return
          void openExternalUrl(url).catch(() => {})
        },
        Navigate: (path) => navigate(path),
        Log: (message) => console.warn('[widget]', message),
        GetSize: () => runtimeRef.current?.getSize() ?? Promise.reject(new Error('组件运行时不可用')),
        SetProperty: (target, property, value) => runtimeRef.current?.setProperty(target, property, value) ?? Promise.reject(new Error('组件运行时不可用')),
        GetProperty: (target, property) => runtimeRef.current?.getProperty(target, property) ?? Promise.reject(new Error('组件运行时不可用')),
        Invoke: (target, method, args) => runtimeRef.current?.invoke(target, method, args) ?? Promise.reject(new Error('组件运行时不可用')),
      })
    }
    return sandboxRef.current
  }, [navigate, notify])

  const actionContext = useCallback(() => ({
    defaultInstance,
    launch,
    refreshDashboard: refresh,
    selectAccount: async () => {
      await resolveAccountCheck()
    },
    refreshWidget: () => {
      forceRefreshRef.current = true
      setTick((value) => value + 1)
    },
    notify,
    navigateTo: (path: string) => navigate(path),
    runFunction: async (name: string, action: ActionSpec) => {
      const fn = doc?.functions.find((item) => item.name === name)
      if (!fn) throw new Error(name)
      const output = await executeFunction(fn, action, sandbox(), {
        inputs: inputsRef.current,
        resources,
        data,
        results,
        scope: { ...scope, Inputs: inputsRef.current },
        size,
      })
      setResults((prev) => ({ ...prev, [name]: output }))
    },
    runCommand: async (command: string, workingDirectory?: string, timeout?: number) => {
      if (preview) throw new Error(t('dashboard.custom.previewBlocked'))
      const { invoke } = await import('@tauri-apps/api/core')
      const cwd = workingDirectory ? resolveDataPath(def, workingDirectory) : undefined
      const result = await invoke<{ exitCode: number; stdout: string; stderr: string }>('run_widget_command', {
        command,
        workingDirectory: cwd,
        timeoutMs: timeout,
      })
      setResults((prev) => ({
        ...prev,
        Command: { ExitCode: result.exitCode, Stdout: result.stdout, Stderr: result.stderr },
      }))
    },
    callPlugin: async (pluginId: string, method: string, args: unknown) => {
      if (preview) throw new Error(t('dashboard.custom.previewBlocked'))
      const registry = (window as unknown as { __pluginRegistry?: { call: (id: string, method: string, args: unknown[]) => Promise<unknown> } }).__pluginRegistry
      if (!registry) throw new Error('Plugin registry unavailable')
      const list = args === undefined ? [] : Array.isArray(args) ? args : [args]
      const value = await registry.call(pluginId, method, list)
      setResults((prev) => ({ ...prev, PluginApi: { Value: value } }))
    },
    showDialog,
    hideDialog,
    scope: { ...scope, Inputs: inputsRef.current },
    t,
  }), [defaultInstance, launch, refresh, resolveAccountCheck, notify, navigate, sandbox, doc, resources, data, results, scope, size, preview, def, t, showDialog, hideDialog])

  const ensureCommandTrusted = useCallback(async (
    rawCommand: string | undefined,
    rawWorkingDirectory: string | undefined,
    command: string | undefined,
    workingDirectory: string | undefined,
  ): Promise<boolean> => {
    const remote = !!def.sourceUrl
    const roots = [...bindingRoots(rawCommand), ...bindingRoots(rawWorkingDirectory)]
    const dynamic = roots.length > 0
    if (!dynamic) {
      if (!remote) return true
      const fingerprint = doc ? executableFingerprint(doc) : ''
      const key = `${def.id}:${fingerprint}`
      if (def.executableHash === fingerprint || isExecutableApproved(key)) return true
      const accepted = await confirm(
        `${t('dashboard.custom.riskMessage')}\n\n${command ?? ''}`,
        t('dashboard.custom.riskTitle'),
      )
      if (!accepted) return false
      approveExecutable(key)
      updateDef(def.id, { executableHash: fingerprint })
      return true
    }
    const external = hasExternalBinding(roots) || (remote && roots.length > 0)
    if (!external) return true
    const hash = commandHash(command ?? '', workingDirectory)
    const key = `${def.id}:${hash}`
    if ((def.trustedCommands ?? []).includes(hash) || isCommandApproved(key)) return true
    const accepted = await confirm(
      `${t('dashboard.custom.riskMessage')}\n\n${command ?? ''}`,
      t('dashboard.custom.riskTitle'),
    )
    if (!accepted) return false
    approveCommand(key)
    updateDef(def.id, { trustedCommands: [...(def.trustedCommands ?? []), hash].slice(-32) })
    return true
  }, [confirm, def, doc, t, updateDef])

  const executeAction = useCallback(async (action: ActionSpec | undefined, control?: string) => {
    if (!action && !control) return
    if (control) fireTriggerRef.current?.('Click', control)
    if (!action) return
    const rawArgs = { ...action.args }
    const resolvedArgs: Record<string, string> = {}
    for (const [key, value] of Object.entries(rawArgs)) {
      if (key === 'Arguments') {
        resolvedArgs[key] = value
      } else {
        resolvedArgs[key] = resolveActionValue(value, { ...scope, Inputs: inputsRef.current })
      }
    }
    if (action.name === 'RunCommand') {
      const accepted = await ensureCommandTrusted(
        rawArgs.Command,
        rawArgs.WorkingDirectory,
        resolvedArgs.Command,
        resolvedArgs.WorkingDirectory,
      )
      if (!accepted) return
    }
    try {
      await runWidgetAction({ name: action.name, args: resolvedArgs }, actionContext())
    } catch (error) {
      showError(error instanceof Error ? error.message : String(error), t('dashboard.custom.actionFailed'))
    }
  }, [actionContext, ensureCommandTrusted, scope, showError, t])

  useEffect(() => {
    if (!doc) return
    const bindings: ShortcutBinding[] = []
    collectShortcuts(doc.nodes, bindings)
    for (const page of Object.values(doc.pages)) collectShortcuts(page, bindings)
    if (bindings.length === 0) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.repeat) return
      const target = event.target
      if (target instanceof Element && target.closest('input, textarea, select, [contenteditable="true"]')) return
      const key = event.key === ' ' ? 'space' : event.key.toLowerCase()
      const modifiers = [
        event.altKey ? 'alt' : '',
        event.ctrlKey ? 'ctrl' : '',
        event.metaKey ? 'meta' : '',
        event.shiftKey ? 'shift' : '',
      ].filter(Boolean).sort()
      const combo = `${modifiers.length ? `${modifiers.join('+')}+` : ''}${key}`
      const binding = bindings.find((item) => item.keys === combo)
      if (!binding) return
      event.preventDefault()
      void executeAction(binding.action, binding.control)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [doc, executeAction])

  const invoke = useCallback(async (target: string, method: string, args: unknown[]): Promise<unknown> => {
    if (!doc) throw new Error('组件未加载')
    const node = findNodeByTarget(doc.nodes, target)
    if (!node) throw new Error(`找不到 Target: ${target}`)
    switch (method.toLowerCase()) {
      case 'click':
        if (node.kind !== 'button' && node.kind !== 'link') throw new Error(`Target ${target} 不是可点击控件`)
        await executeAction(node.onClick ?? (node.kind === 'link' && node.url ? { name: 'OpenUrl', args: { Url: node.url } } : undefined), node.name)
        return true
      case 'setvalue':
        return setProperty(target, 'Value', args[0])
      case 'setproperty':
        return setProperty(target, String(args[0] ?? ''), args[1])
      case 'getproperty':
        return getProperty(target, String(args[0] ?? ''))
      case 'toggle':
        if (node.kind !== 'checkBox') throw new Error(`Target ${target} 不是 CheckBox`)
        await setProperty(target, 'Checked', !(inputsRef.current[node.name] ?? node.checked))
        return true
      case 'refresh':
        forceRefreshRef.current = true
        setTick((value) => value + 1)
        return true
      case 'focus':
      case 'blur': {
        const root = document.querySelector(`[data-widget-root="${CSS.escape(def.id)}"]`)
        const holder = root?.querySelector(`[data-widget-target="${CSS.escape(target)}"]`) as HTMLElement | null
        const focusable = 'input,textarea,select,button,[tabindex]'
        const element = (holder?.matches(focusable) ? holder : holder?.querySelector(focusable)) as HTMLElement | null
        if (!element) throw new Error(`Target ${target} 没有可聚焦元素`)
        if (method.toLowerCase() === 'focus') element.focus()
        else element.blur()
        return true
      }
      default:
        throw new Error(`未知 Invoke 方法: ${method}`)
    }
  }, [doc, executeAction, setProperty, getProperty, def.id])

  useEffect(() => {
    runtimeRef.current = { setProperty, getProperty, getSize, invoke }
  }, [setProperty, getProperty, getSize, invoke])

  const fireTrigger = useCallback((event: string, target: string) => {
    if (!doc) return
    const now = Date.now()
    triggerRate.current = triggerRate.current.filter((time) => now - time < 1000)
    if (triggerRate.current.length >= WIDGET_LIMITS.triggerRatePerSecond) return
    for (const trigger of doc.triggers) {
      if (trigger.event !== event) continue
      if (event === 'Click' && trigger.control !== target) continue
      if (event === 'DataChanged' && trigger.data !== target) continue
      triggerRate.current.push(now)
      const effectTarget = trigger.target ?? (event === 'Click' ? target : undefined)
      if (trigger.effects && effectTarget) applyEffects(effectTarget, trigger.effects)
      if (trigger.function) {
        executeFunctionRef.current(trigger.function, trigger)
      } else if (trigger.action) {
        void executeAction(trigger.action)
      }
    }
  }, [doc, executeAction, applyEffects])

  const fireTriggerRef = useRef(fireTrigger)

  const executeFunctionByName = useCallback(async (name: string, trigger: TriggerNode) => {
    const fn = doc?.functions.find((item) => item.name === name)
    if (!fn) return
    try {
      const output = await executeFunction(fn, trigger.action, sandbox(), {
        inputs: inputsRef.current,
        resources,
        data,
        results,
        scope: { ...scope, Inputs: inputsRef.current },
        size,
      })
      setResults((prev) => ({ ...prev, [name]: output }))
    } catch (error) {
      showError(error instanceof Error ? error.message : String(error), t('dashboard.custom.functionFailed'))
    }
  }, [doc, sandbox, resources, data, results, scope, size, showError, t])

  useEffect(() => {
    fireTriggerRef.current = fireTrigger
    executeFunctionRef.current = executeFunctionByName
  }, [fireTrigger, executeFunctionByName])

  // Loaded 触发器：每次组件挂载/XML 变化后执行一次。
  useEffect(() => {
    if (!doc) return
    const key = `${def.id}:${def.xml}`
    if (loadedRef.current === key) return
    const timer = setTimeout(() => {
      loadedRef.current = key
      fireTriggerRef.current?.('Loaded', '')
    }, 0)
    return () => clearTimeout(timer)
  }, [doc, def.id, def.xml])

  // RefreshTTL：按配置重新拉取数据，保留 Inputs / Dialog / Tab 等组件状态。
  useEffect(() => {
    if (!doc || preview) return
    const mode = doc.refreshTtl === undefined ? ({ type: 'none' } as const) : ttlMode(doc.refreshTtl, 0)
    if (mode.type === 'none') return
    const refresh = () => {
      forceRefreshRef.current = true
      setTick((value) => value + 1)
    }
    if (mode.type === 'interval') {
      if (mode.ms <= 0) return
      const timer = setInterval(refresh, mode.ms)
      return () => clearInterval(timer)
    }
    if (mode.type === 'mount') {
      const key = def.id
      if (refreshMountRef.current === key) return
      refreshMountRef.current = key
      refresh()
      return
    }
    if (preLaunchRefreshDone.has(def.id)) return
    preLaunchRefreshDone.add(def.id)
    refresh()
  }, [doc, def.id, def.xml, preview])

  // 尺寸变化后防抖触发 Resize；首次尺寸只记录，交给 Loaded 处理初始布局。
  useEffect(() => {
    if (!doc || preview) return
    const signature = `${size.Width}:${size.Height}:${size.PixelWidth}:${size.PixelHeight}`
    if (lastResizeRef.current === null) {
      lastResizeRef.current = signature
      return
    }
    if (lastResizeRef.current === signature) return
    lastResizeRef.current = signature
    const timer = setTimeout(() => fireTriggerRef.current?.('Resize', ''), 150)
    return () => clearTimeout(timer)
  }, [doc, preview, size.Width, size.Height, size.PixelWidth, size.PixelHeight])

  // Timer 触发器。
  useEffect(() => {
    if (!doc || preview) return
    const timers: Array<ReturnType<typeof setInterval>> = []
    doc.triggers.forEach((trigger, index) => {
      if (trigger.event !== 'Timer') return
      const key = `${def.id}:${index}:${def.xml}`
      if (trigger.once && timerFiredRef.current.has(key)) return
      const timer = setInterval(() => {
        if (trigger.once) {
          if (timerFiredRef.current.has(key)) return
          timerFiredRef.current.add(key)
        }
        if (trigger.function) void executeFunctionByName(trigger.function, trigger)
        else if (trigger.action) void executeAction(trigger.action)
      }, trigger.interval ?? 60000)
      timers.push(timer)
    })
    return () => {
      for (const timer of timers) clearInterval(timer)
    }
  }, [doc, preview, executeFunctionByName, executeAction, def.id, def.xml])

  // 父组件只读快照。
  useEffect(() => {
    if (!onSnapshot) return
    const snapshot: ChildSnapshot = {
      Inputs: inputs,
      Data: data,
      Results: results,
      Outputs: outputs,
      State: { Loading: loading, Error: !!error },
    }
    let signature: string
    try {
      signature = JSON.stringify(snapshot)
    } catch {
      return
    }
    if (signature && signature !== lastSnapshot.current) {
      lastSnapshot.current = signature
      onSnapshot(snapshot)
    }
  }, [inputs, data, results, outputs, loading, error, onSnapshot])

  const renderUsing = useCallback((node: UsingNode) => (
    <NestedUsing
      node={node}
      chain={chain}
      parentScope={scope}
      parentAllowedHosts={new Set(def.hosts)}
      bindingOptions={bindingOptions}
      onSnapshot={(child) => setChildren((prev) => ({ ...prev, [node.as]: child }))}
      preview={preview}
    />
  ), [chain, scope, def.hosts, bindingOptions, preview])

  const renderContext: RenderContext = {
    scope,
    inputs,
    setInput,
    data,
    resources,
    results,
    children,
    overrides,
    effects: effectOverrides,
    bindingOptions,
    size,
    pages: doc?.pages ?? {},
    openDialogs,
    showDialog,
    hideDialog,
    onAction: (action, control) => { void executeAction(action, control) },
    renderUsing,
    allowedHosts: new Set(def.hosts),
  }

  if (!doc) {
    return (
      <div className="flex h-full items-center justify-center rounded-xl border border-destructive/30 p-3 text-xs text-destructive">
        {t('dashboard.custom.invalid')}
      </div>
    )
  }

  if (inputResolution.error) {
    return <WidgetErrorBox message={`${t('dashboard.custom.invalidArguments')}: ${inputResolution.error}`} />
  }

  if (doc.launcherVersion && launcherVersion && compareVersions(launcherVersion, doc.launcherVersion) < 0) {
    return (
      <WidgetErrorBox
        message={t('dashboard.custom.launcherTooOld', { required: doc.launcherVersion, current: launcherVersion })}
      />
    )
  }

  if (doc.nodes.length === 0) return null

  return (
    <div ref={rootRef} className="flex h-full min-h-0 flex-col overflow-hidden" data-widget-version={doc.version} data-widget-root={def.id}>
      {renderNodes(doc.nodes, renderContext, '', true)}
    </div>
  )
}

function resolveScopeValue(scope: Record<string, unknown>, token: string): unknown {
  let current: unknown = scope
  for (const part of token.split('.')) {
    if (!current || typeof current !== 'object') return undefined
    current = (current as Record<string, unknown>)[part]
  }
  return current
}

interface NestedUsingProps {
  node: UsingNode
  chain: string[]
  parentScope: Record<string, unknown>
  parentAllowedHosts: Set<string>
  bindingOptions: BindingOptions
  onSnapshot: (snapshot: ChildSnapshot) => void
  preview: boolean
}

function NestedUsing({ node, chain, parentScope, parentAllowedHosts, bindingOptions, onSnapshot, preview }: NestedUsingProps) {
  const { t } = useI18n()
  const { confirm } = useMessageBox()
  const defs = useCustomWidgetStore((s) => s.defs)
  const local = node.name ? defs.filter((item) => item.name === node.name) : []
  const [remoteXml, setRemoteXml] = useState<string | null>(node.url ? getRemoteWidget(node.url, node.refresh ? node.refresh * 1000 : undefined) : null)
  const [error, setError] = useState<string | null>(null)
  const mountedAt = useRef(Date.now())
  const childDefCache = useRef<{ key: string; def: CustomWidgetDef } | null>(null)

  useEffect(() => {
    if (!node.url) return
    const url = node.url
    const key = `remote:${url}`
    if (chain.includes(key)) {
      setError(t('dashboard.custom.nestedCycle'))
      return
    }
    let cancelled = false
    const cached = getRemoteWidget(url, node.refresh ? node.refresh * 1000 : undefined)
    if (cached) {
      setRemoteXml(cached)
      return
    }
    void fetchWidgetUrl(url)
      .then(async (response) => {
        if (cancelled) return
        const nextFingerprint = (() => {
          try {
            return executableFingerprint(parseWidgetXml(response.body))
          } catch {
            return ''
          }
        })()
        if (nextFingerprint) {
          const previousXml = getRemoteWidget(url, Number.MAX_SAFE_INTEGER)
          let previousFingerprint = ''
          if (previousXml) {
            try {
              previousFingerprint = executableFingerprint(parseWidgetXml(previousXml))
            } catch {
              previousFingerprint = ''
            }
          }
          if (nextFingerprint !== previousFingerprint) {
            const key = `remote:${url}:${nextFingerprint}`
            if (!isExecutableApproved(key)) {
              let commands: string
              try {
                commands = executableActions(parseWidgetXml(response.body))
                  .map((action) => action.args.Command ?? action.args.PluginId ?? action.name)
                  .join(' | ')
              } catch {
                commands = ''
              }
              const accepted = await confirm(
                `${t('dashboard.custom.riskMessage')}\n\n${commands}`,
                t('dashboard.custom.riskTitle'),
              )
              if (!accepted) {
                setError(t('dashboard.custom.riskTitle'))
                return
              }
              approveExecutable(key)
            }
          }
        }
        setRemoteXml(response.body)
        setRemoteWidget(url, response.body)
      })
      .catch((cause) => {
        if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause))
      })
    return () => { cancelled = true }
  }, [node.url, node.refresh, chain, t, confirm])

  if (chain.length >= WIDGET_LIMITS.maxNestedDepth) {
    return <WidgetErrorBox message={t('dashboard.custom.nestedTooDeep')} />
  }
  if (node.name && local.length === 0) {
    return <WidgetErrorBox message={t('dashboard.custom.nestedMissing', { name: node.name })} />
  }
  if (node.name && local.length > 1) {
    return <WidgetErrorBox message={t('dashboard.custom.nestedAmbiguous', { name: node.name })} />
  }
  if (node.url) {
    const key = `remote:${node.url}`
    if (chain.includes(key)) return <WidgetErrorBox message={t('dashboard.custom.nestedCycle')} />
  }
  if (error) return <WidgetErrorBox message={error} />

  const localDef = local[0]
  const key = localDef ? `local:${localDef.id}` : `remote:${node.url}`
  if (chain.includes(key)) return <WidgetErrorBox message={t('dashboard.custom.nestedCycle')} />
  const xml = localDef?.xml ?? remoteXml
  if (!xml) return <WidgetErrorBox message={t('dashboard.custom.nestedLoading')} />

  let childDoc: WidgetDocument
  try {
    childDoc = parseWidgetXml(xml)
  } catch (cause) {
    return <WidgetErrorBox message={cause instanceof Error ? cause.message : String(cause)} />
  }

  const childHosts = new Set([
    ...parentAllowedHosts,
    ...(localDef?.hosts ?? []),
    ...(localDef
      ? collectAutoHosts({
          datas: childDoc.datas,
          updateUrl: childDoc.updateUrl,
          staticMediaUrls: childDoc.staticMediaUrls,
          nestedUrls: childDoc.nestedUrls,
        })
      : []),
  ])
  let args: Record<string, unknown> | undefined
  if (node.argumentsJson) {
    try {
      const parsed = JSON.parse(node.argumentsJson) as unknown
      args = interpolateDeep(parsed, parentScope, bindingOptions) as Record<string, unknown>
    } catch {
      return <WidgetErrorBox message={t('dashboard.custom.invalidArguments')} />
    }
  }

  let resolvedArgs: Record<string, unknown>
  try {
    resolvedArgs = resolveInputValues(childDoc.inputs, args)
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause)
    return <WidgetErrorBox message={`${t('dashboard.custom.invalidArguments')}: ${detail}`} />
  }

  const publishSnapshot = (snapshot: ChildSnapshot) => {
    if (childDoc.outputs.length === 0) {
      onSnapshot(snapshot)
      return
    }
    onSnapshot({
      Inputs: snapshot.Inputs,
      Outputs: snapshot.Outputs,
      State: snapshot.State,
    })
  }

  const childHostsList = [...childHosts].sort()
  const childDefKey = JSON.stringify([
    localDef?.id ?? `remote:${node.url}`,
    localDef?.name ?? childDoc.name,
    xml,
    node.url ?? localDef?.sourceUrl,
    localDef?.sourcePath,
    childHostsList,
  ])
  if (childDefCache.current?.key !== childDefKey) {
    childDefCache.current = {
      key: childDefKey,
      def: {
        id: localDef?.id ?? `remote:${node.url}`,
        name: localDef?.name ?? childDoc.name,
        xml,
        sourceUrl: node.url ?? localDef?.sourceUrl,
        sourcePath: localDef?.sourcePath,
        hosts: childHostsList,
        lastChecked: mountedAt.current,
      },
    }
  }
  const childDef = childDefCache.current!.def

  return (
    <CustomWidget
      def={childDef}
      chain={[...chain, key]}
      initialInputs={resolvedArgs}
      onSnapshot={publishSnapshot}
      preview={preview}
    />
  )
}

function WidgetErrorBox({ message }: { message: string }) {
  return (
    <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-2 text-xs text-destructive">
      {message}
    </div>
  )
}
