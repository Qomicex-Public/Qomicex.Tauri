// Copyright (C) 2026 Qomicex Launcher Contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useMessageBox } from '../../../components/ui'
import { useI18n } from '../../../i18n/index.tsx'
import { fetchWidgetUrl } from '../../../api/widgets.ts'
import { openExternalUrl } from '../../../api/system.ts'
import { useDashboard } from '../context.tsx'
import { runWidgetAction } from './actions.ts'
import {
  collectAutoHosts,
  interpolateDeep,
  WIDGET_LIMITS,
  WidgetError,
} from './schema.ts'
import { makeBinaryValue, mimeFromPath, parseResourceEntries, parseXmlValue, readLocalBinary, readLocalText, resolveDataPath } from './binary.ts'
import { renderNodes, type RenderContext } from './render.tsx'
import { runFunction as executeFunction } from './script/functions.ts'
import { ScriptSandbox } from './script/sandbox.ts'
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
  WidgetDocument,
} from './types.ts'
import { parseWidgetXml } from './xml.ts'

export interface ChildSnapshot {
  Inputs: Record<string, unknown>
  Data: Record<string, unknown>
  Results: Record<string, unknown>
  State: { Loading: boolean; Error: boolean }
}

interface CustomWidgetProps {
  def: CustomWidgetDef
  chain?: string[]
  initialInputs?: Record<string, unknown>
  onSnapshot?: (snapshot: ChildSnapshot) => void
  preview?: boolean
}

function dataScopeOf(data: Record<string, unknown>, sources: WidgetDocument['datas']): Record<string, unknown> {
  const root: Record<string, unknown> = {}
  for (const source of sources) {
    const value = data[source.name]
    root[source.name] = value
    if (source.name === 'Data' && value && typeof value === 'object' && !Array.isArray(value)) {
      Object.assign(root, value as Record<string, unknown>)
    }
  }
  return root
}

export function CustomWidget({ def, chain = [], initialInputs, onSnapshot, preview = false }: CustomWidgetProps) {
  const { t } = useI18n()
  const { defaultInstance, launch, refresh, resolveAccountCheck } = useDashboard()
  const navigate = useNavigate()
  const { notify, error: showError } = useMessageBox()
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

  const [inputs, setInputs] = useState<Record<string, unknown>>(initialInputs ?? {})
  const inputsRef = useRef(inputs)
  inputsRef.current = inputs
  const [results, setResults] = useState<Record<string, Record<string, unknown>>>({})
  const [children, setChildren] = useState<Record<string, ChildSnapshot>>({})
  const [data, setData] = useState<Record<string, unknown>>({})
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [tick, setTick] = useState(0)
  const objectUrls = useRef(new Set<string>())
  const sandboxRef = useRef<ScriptSandbox | null>(null)
  const triggerRate = useRef<number[]>([])
  const loadedRef = useRef<string | null>(null)
  const lastSnapshot = useRef('')
  const executeFunctionRef = useRef<(name: string, trigger: TriggerNode) => void>(() => {})

  const trackUrl = useCallback((url: string) => {
    objectUrls.current.add(url)
  }, [])

  useEffect(() => {
    if (!initialInputs) return
    setInputs((prev) => ({ ...initialInputs, ...prev }))
  }, [initialInputs])

  // 在线组件的静默更新：按 TTL 拉取并直接替换（按用户选择不做二次确认）。
  useEffect(() => {
    if (!doc) return
    const updateUrl = doc.updateUrl ?? def.sourceUrl
    if (!updateUrl) return
    const now = Date.now()
    if (now - (def.lastChecked ?? 0) < WIDGET_LIMITS.updateTtlMs) return
    const controller = new AbortController()
    let cancelled = false
    void fetchWidgetUrl(updateUrl, controller.signal)
      .then((response) => {
        if (cancelled) return
        if (response.body === def.xml) {
          updateDef(def.id, { lastChecked: now })
          return
        }
        const next = parseWidgetXml(response.body)
        const hosts = collectAutoHosts({
          datas: next.datas,
          updateUrl: next.updateUrl,
          staticMediaUrls: next.staticMediaUrls,
          nestedUrls: next.nestedUrls,
        })
        updateDef(def.id, {
          xml: response.body,
          name: next.name,
          hosts: [...new Set([...def.hosts, ...hosts])],
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
  }, [doc, def, updateDef, clearData])

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

  const scope = useMemo(() => {
    const named: Record<string, unknown> = { ...data }
    return {
      ...named,
      Data: dataScopeOf(data, doc?.datas ?? []),
      Resources: resources,
      Inputs: inputs,
      Results: results,
      Children: children,
      State: { Loading: loading, Error: !!error },
    }
  }, [data, doc, resources, inputs, results, children, loading, error])

  const setInput = useCallback((name: string, value: unknown) => {
    const next = { ...inputsRef.current, [name]: value }
    inputsRef.current = next
    setInputs(next)
  }, [])

  const decodeData = useCallback(async (source: WidgetDocument['datas'][number], signal: AbortSignal): Promise<unknown> => {
    if (source.source === 'File') {
      const path = resolveDataPath(def, source.path ?? '')
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
    const response = await fetchWidgetUrl(source.url, signal, {
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
  }, [def, trackUrl])

  useEffect(() => {
    if (!doc || doc.datas.length === 0) return
    const controller = new AbortController()
    let cancelled = false
    const now = Date.now()
    const cache = useCustomWidgetStore.getState().dataCache[def.id]
    const next: Record<string, unknown> = { ...data }
    let changed = false

    const stale = doc.datas.filter((source) => {
      const entry = cache?.[source.name]
      const fresh = entry && (source.refresh <= 0 || now - entry.at <= source.refresh * 1000)
      if (fresh) {
        next[source.name] = entry.json
        changed = true
        return false
      }
      if (source.type === 'Binary') {
        const binary = getBinary(`${def.id}:${source.name}`)
        if (binary) {
          next[source.name] = binary
          changed = true
          return false
        }
      }
      return true
    })
    if (changed) setData(next)
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
        if (source.type !== 'Binary') setCachedData(def.id, source.name, value)
        fireTriggerRef.current?.('DataChanged', source.name)
      }),
    ).then((items) => {
      if (cancelled) return
      setLoading(false)
      const failed = items.filter((item) => item.status === 'rejected')
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
  }, [doc, def, tick, decodeData, setCachedData])

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
    refreshWidget: () => setTick((value) => value + 1),
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
      setResults((prev) => ({ ...prev, Command: result as unknown as Record<string, unknown> }))
    },
    callPlugin: async (pluginId: string, method: string, args: unknown) => {
      if (preview) throw new Error(t('dashboard.custom.previewBlocked'))
      const registry = (window as unknown as { __pluginRegistry?: { call: (id: string, method: string, args: unknown[]) => Promise<unknown> } }).__pluginRegistry
      if (!registry) throw new Error('Plugin registry unavailable')
      const list = args === undefined ? [] : Array.isArray(args) ? args : [args]
      const value = await registry.call(pluginId, method, list)
      setResults((prev) => ({ ...prev, PluginApi: { Value: value } }))
    },
    scope: { ...scope, Inputs: inputsRef.current },
    t,
  }), [defaultInstance, launch, refresh, resolveAccountCheck, notify, navigate, sandbox, doc, resources, data, results, scope, preview, def, t])
  const executeAction = useCallback(async (action: ActionSpec | undefined, control?: string) => {
    if (!action && !control) return
    if (control) fireTriggerRef.current?.('Click', control)
    if (!action) return
    const rawArgs = { ...action.args }
    const resolvedArgs: Record<string, string> = {}
    for (const [key, value] of Object.entries(rawArgs)) {
      if (key === 'Arguments') resolvedArgs[key] = value
      else resolvedArgs[key] = value.replace(/\{([^{}]+)\}/g, (_, token: string) => {
        const found = resolveScopeValue({ ...scope, Inputs: inputsRef.current }, token)
        return found === undefined || found === null ? '' : String(found)
      })
    }
    try {
      await runWidgetAction({ name: action.name, args: resolvedArgs }, actionContext())
    } catch (error) {
      showError(error instanceof Error ? error.message : String(error), t('dashboard.custom.actionFailed'))
    }
  }, [actionContext, scope, showError, t])
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
      if (trigger.function) {
        executeFunctionRef.current(trigger.function, trigger)
      } else if (trigger.action) {
        void executeAction(trigger.action)
      }
    }
  }, [doc, executeAction])

  const fireTriggerRef = useRef(fireTrigger)
  fireTriggerRef.current = fireTrigger

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
      })
      setResults((prev) => ({ ...prev, [name]: output }))
    } catch (error) {
      showError(error instanceof Error ? error.message : String(error), t('dashboard.custom.functionFailed'))
    }
  }, [doc, sandbox, resources, data, results, scope, showError, t])
  executeFunctionRef.current = executeFunctionByName

  // Loaded 触发器：每次组件挂载/XML 变化后执行一次。
  useEffect(() => {
    if (!doc) return
    const key = `${def.id}:${def.xml.length}`
    if (loadedRef.current === key) return
    loadedRef.current = key
    const timer = setTimeout(() => fireTrigger('Loaded', ''), 0)
    return () => clearTimeout(timer)
  }, [doc, def.id, def.xml, fireTrigger])

  // Timer 触发器。
  useEffect(() => {
    if (!doc || preview) return
    const timers: Array<ReturnType<typeof setInterval>> = []
    for (const trigger of doc.triggers) {
      if (trigger.event !== 'Timer') continue
      let fired = false
      const timer = setInterval(() => {
        if (trigger.once && fired) return
        fired = true
        if (trigger.function) void executeFunctionByName(trigger.function, trigger)
        else if (trigger.action) void executeAction(trigger.action)
      }, trigger.interval ?? 60000)
      timers.push(timer)
    }
    return () => {
      for (const timer of timers) clearInterval(timer)
    }
  }, [doc, preview, executeFunctionByName, executeAction])

  // 父组件只读快照。
  useEffect(() => {
    if (!onSnapshot) return
    const snapshot: ChildSnapshot = {
      Inputs: inputs,
      Data: data,
      Results: results,
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
  }, [inputs, data, results, loading, error, onSnapshot])

  const renderUsing = useCallback((node: UsingNode) => (
    <NestedUsing
      node={node}
      chain={chain}
      parentScope={scope}
      parentAllowedHosts={new Set(def.hosts)}
      onSnapshot={(child) => setChildren((prev) => ({ ...prev, [node.as]: child }))}
      preview={preview}
    />
  ), [chain, scope, def.hosts, preview])

  const renderContext: RenderContext = {
    scope,
    inputs,
    setInput,
    data,
    resources,
    results,
    children,
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

  return (
    <div className="h-full min-h-0 overflow-auto" data-widget-version={doc.version}>
      {renderNodes(doc.nodes, renderContext)}
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
  onSnapshot: (snapshot: ChildSnapshot) => void
  preview: boolean
}

function NestedUsing({ node, chain, parentScope, parentAllowedHosts, onSnapshot, preview }: NestedUsingProps) {
  const { t } = useI18n()
  const defs = useCustomWidgetStore((s) => s.defs)
  const local = node.name ? defs.filter((item) => item.name === node.name) : []
  const [remoteXml, setRemoteXml] = useState<string | null>(node.url ? getRemoteWidget(node.url) : null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!node.url) return
    const url = node.url
    const key = `remote:${url}`
    if (chain.includes(key)) {
      setError(t('dashboard.custom.nestedCycle'))
      return
    }
    let cancelled = false
    const cached = getRemoteWidget(url)
    if (cached) {
      setRemoteXml(cached)
      return
    }
    void fetchWidgetUrl(url)
      .then((response) => {
        if (cancelled) return
        setRemoteXml(response.body)
        setRemoteWidget(url, response.body)
      })
      .catch((cause) => {
        if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause))
      })
    return () => { cancelled = true }
  }, [node.url, chain, t])

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
    ...collectAutoHosts({
      datas: childDoc.datas,
      updateUrl: childDoc.updateUrl,
      staticMediaUrls: childDoc.staticMediaUrls,
      nestedUrls: childDoc.nestedUrls,
    }),
  ])
  let args: Record<string, unknown> | undefined
  if (node.argumentsJson) {
    try {
      const parsed = JSON.parse(node.argumentsJson) as unknown
      args = interpolateDeep(parsed, parentScope) as Record<string, unknown>
    } catch {
      return <WidgetErrorBox message={t('dashboard.custom.invalidArguments')} />
    }
  }

  const childDef: CustomWidgetDef = {
    id: localDef?.id ?? `remote:${node.url}`,
    name: localDef?.name ?? childDoc.name,
    xml,
    sourceUrl: node.url ?? localDef?.sourceUrl,
    sourcePath: localDef?.sourcePath,
    hosts: [...childHosts],
    lastChecked: Date.now(),
  }

  return (
    <CustomWidget
      def={childDef}
      chain={[...chain, key]}
      initialInputs={args}
      onSnapshot={onSnapshot}
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
