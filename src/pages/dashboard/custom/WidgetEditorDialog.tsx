// Copyright (C) 2026 Qomicex Launcher Contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { useEffect, useMemo, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { open as openDialog, save as saveDialog } from '@tauri-apps/plugin-dialog'
import {
  Button,
  Checkbox,
  Dialog,
  DialogBody,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  Select,
  SelectOption,
  Textarea,
  useMessageBox,
} from '../../../components/ui'
import { openExternalUrl } from '../../../api/system.ts'
import { fetchWidgetUrl } from '../../../api/widgets.ts'
import { useI18n } from '../../../i18n/index.tsx'
import { CodeEditor } from './editor/CodeEditor.tsx'
import { parseResourceEntries, resolveDataPath, widgetBaseDir } from './binary.ts'
import { renderNodes, type RenderContext } from './render.tsx'
import { runFunction as executeFunction, type FunctionContext } from './script/functions.ts'
import { ScriptSandbox } from './script/sandbox.ts'
import { executableFingerprint } from './security.ts'
import {
  WIDGET_LIMITS,
  WidgetError,
  collectAutoHosts,
  compareVersions,
  hostOf,
  isSafeHttpsUrl,
} from './schema.ts'
import { useCustomWidgetStore } from './store.ts'
import { WIDGET_TEMPLATE } from './template.ts'
import { getLauncherVersion } from './launcher-version.ts'
import type { ActionName } from './schema.ts'
import type { UsingNode, WidgetNode } from './types.ts'
import { parseWidgetXml } from './xml.ts'

const HELP_BASE = 'https://docs.qomicex.top'
const RISK_KEY = 'qomicex.dashboard.customRisk.v1'

function collectActions(nodes: WidgetNode[], out = new Set<ActionName>()): Set<ActionName> {
  for (const node of nodes) {
    switch (node.kind) {
      case 'button':
      case 'link':
        if (node.onClick) out.add(node.onClick.name)
        break
      case 'textBox':
      case 'checkBox':
      case 'slider':
      case 'select':
      case 'colorPicker':
        if (node.onChange) out.add(node.onChange.name)
        break
      case 'container':
      case 'row':
      case 'column':
      case 'grid':
      case 'if':
        collectActions(node.children, out)
        break
      case 'tabs':
        for (const tab of node.children) collectActions(tab.children, out)
        break
      case 'list':
        collectActions([node.item.child], out)
        break
      default:
        break
    }
  }
  return out
}

function collectInputNames(nodes: WidgetNode[], out = new Set<string>()): Set<string> {
  for (const node of nodes) {
    switch (node.kind) {
      case 'textBox':
      case 'checkBox':
      case 'slider':
      case 'select':
      case 'filePicker':
      case 'colorPicker':
        out.add(node.name)
        break
      case 'container':
      case 'row':
      case 'column':
      case 'grid':
      case 'if':
        collectInputNames(node.children, out)
        break
      case 'tabs':
        for (const tab of node.children) collectInputNames(tab.children, out)
        break
      case 'list':
        collectInputNames([node.item.child], out)
        break
      default:
        break
    }
  }
  return out
}

function collectUsing(nodes: WidgetNode[], out: UsingNode[] = []): UsingNode[] {
  for (const node of nodes) {
    switch (node.kind) {
      case 'using':
        out.push(node)
        break
      case 'container':
      case 'row':
      case 'column':
      case 'grid':
      case 'if':
        collectUsing(node.children, out)
        break
      case 'tabs':
        for (const tab of node.children) collectUsing(tab.children, out)
        break
      case 'list':
        collectUsing([node.item.child], out)
        break
      default:
        break
    }
  }
  return out
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function replaceFunctionScript(xml: string, name: string, script: string): string {
  const block = `<Function.Script><![CDATA[${script.replace(/]]>/g, ']]]]><![CDATA[>')}]]></Function.Script>`
  const fnRe = new RegExp(`(<Function\\b[^>]*\\bName\\s*=\\s*"${escapeRegExp(name)}"[^>]*>)([\\s\\S]*?)(</Function>)`)
  return xml.replace(fnRe, (_match, open: string, body: string, close: string) => {
    if (/<Function\.Script\b[^>]*>[\s\S]*?<\/Function\.Script>/.test(body)) {
      return open + body.replace(/<Function\.Script\b[^>]*>[\s\S]*?<\/Function\.Script>/, block) + close
    }
    return open + body + block + close
  })
}

interface WidgetEditorDialogProps {
  open: boolean
  widgetId: string | null
  onClose: () => void
}

export function WidgetEditorDialog({ open, widgetId, onClose }: WidgetEditorDialogProps) {
  const { t, lang } = useI18n()
  const { choose, confirm, error: showError } = useMessageBox()
  const defs = useCustomWidgetStore((s) => s.defs)
  const addDef = useCustomWidgetStore((s) => s.addDef)
  const updateDef = useCustomWidgetStore((s) => s.updateDef)
  const removeDef = useCustomWidgetStore((s) => s.removeDef)
  const clearData = useCustomWidgetStore((s) => s.clearData)
  const def = widgetId ? defs.find((item) => item.id === widgetId) : undefined

  const [xml, setXml] = useState(WIDGET_TEMPLATE)
  const [sourceUrl, setSourceUrl] = useState('')
  const [sourcePath, setSourcePath] = useState('')
  const [sampleJson, setSampleJson] = useState('{\n  "Data": {}\n}')
  const [confirmed, setConfirmed] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [tab, setTab] = useState<'xml' | 'function'>('xml')
  const [status, setStatus] = useState<{ line: number; column: number; length: number } | null>(null)
  const [selectedFunction, setSelectedFunction] = useState('')
  const [scriptDraft, setScriptDraft] = useState('')
  const [scriptResult, setScriptResult] = useState<string | null>(null)
  const [previewInputs, setPreviewInputs] = useState<Record<string, unknown>>({})
  const [previewResults, setPreviewResults] = useState<Record<string, Record<string, unknown>>>({})
  const [appVersion, setAppVersion] = useState<string | null>(null)
  const [previewResources, setPreviewResources] = useState<Record<string, unknown>>({})

  useEffect(() => {
    if (!open) return
    void getLauncherVersion().then(setAppVersion)
  }, [open])

  useEffect(() => {
    if (!open) return
    setXml(def?.xml ?? WIDGET_TEMPLATE)
    setSourceUrl(def?.sourceUrl ?? '')
    setSourcePath(def?.sourcePath ?? '')
    setConfirmed(new Set(def?.hosts ?? []))
    setSampleJson('{\n  "Data": {}\n}')
    setPreviewInputs({})
    setPreviewResults({})
    setNotice(null)
    setBusy(null)
    setTab('xml')
    setStatus(null)
    setSelectedFunction('')
    setScriptResult(null)
    // 只在打开/切换组件时重置，避免编辑过程中被 store 更新覆盖
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, widgetId])

  const parsed = useMemo(() => {
    try {
      return { doc: parseWidgetXml(xml), error: null as WidgetError | null }
    } catch (error) {
      return { doc: null, error: error instanceof WidgetError ? error : new WidgetError('xmlInvalid') }
    }
  }, [xml])
  const doc = parsed.doc

  useEffect(() => {
    if (!doc) {
      setPreviewResources({})
      return
    }
    const urls: string[] = []
    const resources = parseResourceEntries(doc.resources, (url) => urls.push(url))
    setPreviewResources(resources)
    return () => {
      for (const url of urls) URL.revokeObjectURL(url)
    }
  }, [doc])

  const hosts = useMemo(() => {
    if (!doc) return []
    const list = collectAutoHosts({
      datas: doc.datas,
      updateUrl: doc.updateUrl,
      staticMediaUrls: doc.staticMediaUrls,
      nestedUrls: doc.nestedUrls,
    })
    const sourceHost = hostOf(sourceUrl.trim())
    return [...new Set([...list, ...(sourceHost ? [sourceHost] : [])])].sort()
  }, [doc, sourceUrl])

  const sourceValid = !sourceUrl.trim() || isSafeHttpsUrl(sourceUrl.trim())
  const hostsConfirmed = hosts.every((host) => confirmed.has(host))
  const canSave = !!doc && sourceValid && hostsConfirmed && !busy
  const actions = useMemo(() => (doc ? [...collectActions(doc.nodes)] : []), [doc])
  const executableHash = useMemo(() => (doc ? executableFingerprint(doc) : ''), [doc])
  const remoteSource = !!sourceUrl.trim() || !!def?.sourceUrl
  const dangerous = remoteSource && !!executableHash

  const sample = useMemo(() => {
    try {
      const value = JSON.parse(sampleJson) as unknown
      if (!value || typeof value !== 'object' || Array.isArray(value)) return null
      return value as Record<string, unknown>
    } catch {
      return null
    }
  }, [sampleJson])

  const previewScope = useMemo(() => {
    if (!sample) return null
    const dataRoot = sample.Data && typeof sample.Data === 'object' && !Array.isArray(sample.Data)
      ? { ...(sample.Data as Record<string, unknown>), ...sample }
      : sample
    return {
      ...sample,
      Data: dataRoot,
      Resources: previewResources,
      Inputs: previewInputs,
      Results: previewResults,
      Children: {},
      Size: { Width: 2, Height: 2, PixelWidth: 0, PixelHeight: 0 },
      State: { Loading: false, Error: false },
    }
  }, [sample, previewResources, previewInputs, previewResults])

  const setHost = (host: string, checked: boolean) => {
    setConfirmed((prev) => {
      const next = new Set(prev)
      if (checked) next.add(host)
      else next.delete(host)
      return next
    })
  }

  const ensureRiskAccepted = async (fingerprint: string): Promise<boolean> => {
    const key = `${RISK_KEY}:${fingerprint}`
    try {
      if (localStorage.getItem(key) === '1') return true
    } catch {
      /* 存储不可用时按未确认处理 */
    }
    const accepted = await choose(
      t('dashboard.custom.riskMessage'),
      t('dashboard.custom.riskConfirm'),
      t('dashboard.custom.cancel'),
      t('dashboard.custom.riskTitle'),
    )
    if (accepted) {
      try {
        localStorage.setItem(key, '1')
      } catch {
        /* 写入失败时仅本次生效 */
      }
    }
    return accepted
  }

  const importXml = (content: string, source: string, path: string, resetHosts: boolean) => {
    parseWidgetXml(content)
    setXml(content)
    setSourceUrl(source)
    setSourcePath(path)
    setPreviewResults({})
    setPreviewInputs({})
    if (resetHosts) setConfirmed(new Set())
  }

  const onImportUrl = async () => {
    const url = sourceUrl.trim()
    if (!isSafeHttpsUrl(url)) {
      setNotice(t('dashboard.custom.invalidSource'))
      return
    }
    setBusy('import')
    setNotice(null)
    try {
      const response = await fetchWidgetUrl(url)
      importXml(response.body, url, '', true)
    } catch (error) {
      showError(error instanceof Error ? error.message : String(error), t('dashboard.custom.importFailed'))
    } finally {
      setBusy(null)
    }
  }

  const onImportFile = async () => {
    setBusy('file')
    setNotice(null)
    try {
      const picked = await openDialog({
        multiple: false,
        filters: [{ name: 'QWidget', extensions: ['qwidget', 'xml'] }],
      })
      if (!picked || Array.isArray(picked)) return
      const content = await invoke<string>('read_widget_file', { path: picked })
      importXml(content, '', picked, true)
    } catch (error) {
      showError(error instanceof Error ? error.message : String(error), t('dashboard.custom.importFailed'))
    } finally {
      setBusy(null)
    }
  }

  const onExportFile = async () => {
    if (!doc) return
    const missing = collectUsing(doc.nodes)
      .filter((dep) => dep.name && defs.filter((item) => item.name === dep.name).length !== 1)
      .map((dep) => dep.name ?? '')
    if (missing.length > 0) {
      const ok = await confirm(
        `${t('dashboard.custom.depMissing')}: ${missing.join(', ')}`,
        t('dashboard.custom.exportFile'),
      )
      if (!ok) return
    }
    setBusy('export')
    try {
      const path = await saveDialog({
        defaultPath: `${doc.name || 'widget'}.qwidget`,
        filters: [{ name: 'QWidget', extensions: ['qwidget'] }],
      })
      if (!path) return
      await invoke('write_widget_file', { path, content: xml })
    } catch (error) {
      showError(error instanceof Error ? error.message : String(error), t('dashboard.custom.exportFailed'))
    } finally {
      setBusy(null)
    }
  }

  const onSave = async () => {
    if (!doc || !canSave) return
    const normalizedSource = sourceUrl.trim() || undefined
    const isRemote = !!normalizedSource || !!def?.sourceUrl
    if (isRemote && executableHash && def?.executableHash !== executableHash) {
      if (!(await ensureRiskAccepted(executableHash))) return
    }
    if (widgetId) {
      const changed = !def || def.xml !== xml || def.sourceUrl !== normalizedSource || def.sourcePath !== (sourcePath || undefined)
      updateDef(widgetId, {
        name: doc.name,
        xml,
        sourceUrl: normalizedSource,
        sourcePath: sourcePath || undefined,
        hosts: hosts.filter((host) => confirmed.has(host)),
        executableHash: executableHash || undefined,
        lastChecked: changed ? Date.now() : def?.lastChecked,
      })
      if (changed) clearData(widgetId)
    } else {
      addDef({
        id: crypto.randomUUID(),
        name: doc.name,
        xml,
        sourceUrl: normalizedSource,
        sourcePath: sourcePath || undefined,
        hosts: hosts.filter((host) => confirmed.has(host)),
        executableHash: executableHash || undefined,
      })
    }
    onClose()
  }

  const onDelete = async () => {
    if (!widgetId) return
    const ok = await confirm(
      t('dashboard.custom.deleteConfirm', { name: def?.name ?? doc?.name ?? '' }),
      t('dashboard.custom.delete'),
    )
    if (!ok) return
    removeDef(widgetId)
    onClose()
  }

  useEffect(() => {
    if (tab !== 'function' || !doc) return
    if (!doc.functions.some((fn) => fn.name === selectedFunction)) {
      setSelectedFunction(doc.functions[0]?.name ?? '')
    }
  }, [tab, doc, selectedFunction])

  useEffect(() => {
    if (tab !== 'function' || !doc) return
    const fn = doc.functions.find((item) => item.name === selectedFunction)
    if (fn) setScriptDraft(fn.script)
    setScriptResult(null)
    // 只在切换函数/页签时载入，脚本编辑回写 XML 后不覆盖正在输入的内容
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, selectedFunction])

  const selectedFn = doc?.functions.find((fn) => fn.name === selectedFunction)

  const onScriptChange = (value: string) => {
    setScriptDraft(value)
    if (selectedFn) setXml((prev) => replaceFunctionScript(prev, selectedFn.name, value))
  }

  const tsContext = useMemo(() => {
    const fn = selectedFn
    const inputType = fn?.inputs[0]?.type
    const struct = fn?.structs.find((item) => item.name === inputType)
    return {
      inputFields: struct?.fields.map((field) => field.name) ?? [],
      inputs: doc ? [...new Set([...collectInputNames(doc.nodes), ...doc.inputs.map((item) => item.name)])] : [],
      resources: doc?.resources.map((item) => item.name) ?? [],
      data: doc?.datas.map((item) => item.name) ?? [],
      functions: doc?.functions.map((item) => item.name) ?? [],
    }
  }, [selectedFn, doc])

  const onTestFunction = async () => {
    if (!selectedFn || !previewScope) return
    setScriptResult(t('dashboard.custom.running'))
    const sandbox = new ScriptSandbox({
      Notify: () => {},
      OpenUrl: () => {},
      Navigate: () => {},
      Log: (message) => console.warn('[widget-preview]', message),
      GetSize: async () => null,
      SetProperty: async () => null,
      GetProperty: async () => null,
      Invoke: async () => null,
    })
    try {
      const output = await executeFunction(selectedFn, undefined, sandbox, {
        inputs: previewInputs,
        resources: previewResources,
        data: sample ?? {},
        results: {},
        scope: previewScope,
      } satisfies FunctionContext)
      setScriptResult(JSON.stringify(output, null, 2))
    } catch (error) {
      setScriptResult(error instanceof Error ? error.message : String(error))
    } finally {
      sandbox.destroy()
    }
  }

  const previewAction = async (action?: { name: ActionName; args: Record<string, string> }) => {
    if (!action || action.name !== 'CallFunction' || !doc) return
    const fn = doc.functions.find((item) => item.name === action.args.Function)
    if (!fn || !previewScope) return
    const sandbox = new ScriptSandbox({
      Notify: () => {},
      OpenUrl: () => {},
      Navigate: () => {},
      Log: () => {},
      GetSize: async () => null,
      SetProperty: async () => null,
      GetProperty: async () => null,
      Invoke: async () => null,
    })
    try {
      const output = await executeFunction(fn, action, sandbox, {
        inputs: previewInputs,
        resources: previewResources,
        data: sample ?? {},
        results: previewResults,
        scope: previewScope,
      })
      setPreviewResults((prev) => ({ ...prev, [fn.name]: output }))
    } catch (error) {
      showError(error instanceof Error ? error.message : String(error), t('dashboard.custom.functionFailed'))
    } finally {
      sandbox.destroy()
    }
  }

  const renderContext: RenderContext | null = previewScope ? {
    scope: previewScope,
    inputs: previewInputs,
    setInput: (name, value) => setPreviewInputs((prev) => ({ ...prev, [name]: value })),
    data: sample ?? {},
    resources: previewResources,
    results: previewResults,
    children: {},
    overrides: {},
    size: { Width: 2, Height: 2, PixelWidth: 0, PixelHeight: 0 },
    onAction: (action) => { void previewAction(action) },
    renderUsing: (node) => (
      <span className="rounded border border-dashed border-border px-1.5 py-0.5 text-[11px] text-muted-foreground">
        {t('dashboard.custom.nestedPreview', { name: node.name ?? node.url ?? '' })}
      </span>
    ),
    allowedHosts: confirmed,
  } : null

  const baseDir = widgetBaseDir({ sourcePath: sourcePath || def?.sourcePath })
  const deps = doc ? collectUsing(doc.nodes) : []

  return (
    <Dialog open={open} onClose={onClose} className="max-w-6xl" closeOnBackdrop={false}>
      <DialogHeader onClose={onClose}>
        <DialogTitle>{t('dashboard.custom.editorTitle')}</DialogTitle>
        <DialogDescription>{t('dashboard.custom.editorDesc')}</DialogDescription>
      </DialogHeader>

      <DialogBody className="max-h-[76vh] overflow-y-auto">
        {dangerous && (
          <div className="mb-3 rounded-lg border border-destructive/40 bg-destructive/10 p-2 text-xs text-destructive">
            {t('dashboard.custom.riskBanner')}
          </div>
        )}
        <div className="grid gap-4 lg:grid-cols-[minmax(0,1.25fr)_minmax(0,0.75fr)]">
          <div className="flex min-w-0 flex-col gap-3">
            <div className="flex flex-wrap items-end gap-2">
              <div className="min-w-0 flex-1">
                <p className="mb-1 text-xs text-muted-foreground">{t('dashboard.custom.sourceUrl')}</p>
                <Input
                  value={sourceUrl}
                  onChange={(e) => setSourceUrl(e.target.value)}
                  placeholder={t('dashboard.custom.sourceUrlPlaceholder')}
                  className="h-8 font-mono text-xs"
                />
              </div>
              <Button size="sm" variant="outline" onClick={onImportUrl} disabled={busy !== null}>
                {busy === 'import' ? t('dashboard.custom.importing') : t('dashboard.custom.fetch')}
              </Button>
            </div>
            {sourcePath && (
              <p className="truncate font-mono text-[11px] text-muted-foreground">
                {t('dashboard.custom.sourcePath')}: {sourcePath}
              </p>
            )}
            {!sourceValid && <p className="text-xs text-destructive">{t('dashboard.custom.invalidSource')}</p>}

            <div className="flex items-center gap-1">
              <Button size="sm" variant={tab === 'xml' ? 'default' : 'ghost'} onClick={() => setTab('xml')}>
                XML
              </Button>
              <Button
                size="sm"
                variant={tab === 'function' ? 'default' : 'ghost'}
                onClick={() => setTab('function')}
                disabled={!doc || doc.functions.length === 0}
              >
                {t('dashboard.custom.functionsTab')}
                {doc && doc.functions.length > 0 ? ` (${doc.functions.length})` : ''}
              </Button>
            </div>

            {tab === 'xml' ? (
              <>
                <CodeEditor
                  value={xml}
                  language="xml"
                  getDefs={() => defs}
                  getTsContext={() => tsContext}
                  getSampleData={() => sample}
                  onChange={(value) => setXml(value)}
                  onSave={() => { void onSave() }}
                  onStatus={(value) => setStatus(value)}
                />
                <p className="text-[11px] text-muted-foreground">
                  {status ? `${t('dashboard.custom.lineColumn', { line: status.line, column: status.column })} · ` : ''}
                  {new TextEncoder().encode(xml).length} / {WIDGET_LIMITS.maxXmlBytes}
                  {' · '}
                  {doc ? t('dashboard.custom.valid') : t('dashboard.custom.invalid')}
                </p>
                {parsed.error && (
                  <p className="text-xs text-destructive">
                    {t(`dashboard.custom.error.${parsed.error.code}`, { detail: parsed.error.detail ?? '' })}
                  </p>
                )}
              </>
            ) : (
              <div className="flex min-w-0 flex-col gap-2">
                {!doc || doc.functions.length === 0 ? (
                  <p className="text-xs text-muted-foreground">{t('dashboard.custom.noFunctions')}</p>
                ) : (
                  <>
                    <div className="flex items-center gap-2">
                      <Select value={selectedFunction} onChange={setSelectedFunction}>
                        {doc.functions.map((fn) => (
                          <SelectOption key={fn.name} value={fn.name}>{fn.name}</SelectOption>
                        ))}
                      </Select>
                      <Button size="sm" variant="outline" onClick={() => { void onTestFunction() }}>
                        {t('dashboard.custom.runFunction')}
                      </Button>
                    </div>
                    <CodeEditor
                      value={scriptDraft}
                      language="ts"
                      getDefs={() => defs}
                      getTsContext={() => tsContext}
                      getSampleData={() => sample}
                      onChange={onScriptChange}
                      onSave={() => { void onSave() }}
                      onStatus={(value) => setStatus(value)}
                    />
                    {scriptResult && (
                      <pre className="max-h-40 overflow-auto rounded-md border border-border/50 bg-muted/30 p-2 text-[11px]">{scriptResult}</pre>
                    )}
                  </>
                )}
              </div>
            )}

            <div>
              <p className="mb-1 text-xs text-muted-foreground">{t('dashboard.custom.sampleData')}</p>
              <Textarea
                value={sampleJson}
                onChange={(e) => setSampleJson(e.target.value)}
                spellCheck={false}
                className="min-h-[80px] resize-y font-mono text-xs"
              />
              {!sample && <p className="mt-1 text-xs text-destructive">{t('dashboard.custom.invalidJson')}</p>}
            </div>

            <div className="flex flex-wrap gap-2">
              <Button size="sm" variant="outline" onClick={() => { setXml(WIDGET_TEMPLATE); setSourceUrl(''); setSourcePath('') }}>
                {t('dashboard.custom.template')}
              </Button>
              <Button size="sm" variant="outline" onClick={onImportFile} disabled={busy !== null}>
                {t('dashboard.custom.importFile')}
              </Button>
              <Button size="sm" variant="outline" onClick={onExportFile} disabled={!doc || busy !== null}>
                {t('dashboard.custom.exportFile')}
              </Button>
              <Button size="sm" variant="ghost" onClick={() => void openExternalUrl(
                lang.startsWith('en')
                  ? `${HELP_BASE}/en/guide/custom-widget/syntax`
                  : `${HELP_BASE}/guide/custom-widget/syntax`,
              )}>
                {t('dashboard.custom.help')}
              </Button>
            </div>
          </div>

          <div className="flex min-w-0 flex-col gap-3">
            <div>
              <div className="mb-1 flex items-center justify-between">
                <p className="text-xs text-muted-foreground">{t('dashboard.custom.preview')}</p>
                <span className={doc ? 'text-[11px] text-primary' : 'text-[11px] text-destructive'}>
                  {doc ? t('dashboard.custom.valid') : t('dashboard.custom.invalid')}
                </span>
              </div>
              <div className="max-h-[320px] min-h-[140px] overflow-auto rounded-lg border border-border/50 bg-background/40 p-3">
                {doc && renderContext
                  ? renderNodes(doc.nodes, renderContext)
                  : parsed.error && (
                    <p className="text-xs text-destructive">
                      {t(`dashboard.custom.error.${parsed.error.code}`, { detail: parsed.error.detail ?? '' })}
                    </p>
                  )}
              </div>
            </div>

            <div>
              <p className="mb-1 text-xs text-muted-foreground">{t('dashboard.custom.hosts')}</p>
              {hosts.length === 0 ? (
                <p className="text-xs text-muted-foreground/60">{t('dashboard.custom.noHosts')}</p>
              ) : (
                <div className="flex flex-col gap-1.5 rounded-lg border border-border/50 p-2">
                  <p className="text-[11px] text-muted-foreground/70">{t('dashboard.custom.hostsHint')}</p>
                  {hosts.map((host) => (
                    <label key={host} className="flex items-center gap-2 text-xs">
                      <Checkbox checked={confirmed.has(host)} onCheckedChange={(checked) => setHost(host, checked === true)} />
                      <span className="font-mono">{host}</span>
                    </label>
                  ))}
                </div>
              )}
            </div>

            {doc && (
              <div className="flex flex-col gap-2 rounded-lg border border-border/50 p-2 text-[11px] text-muted-foreground">
                <p className="font-semibold text-foreground">{t('dashboard.custom.info')}</p>
                <div>
                  <p className="font-medium">{t('dashboard.custom.dataSources')}</p>
                  {doc.datas.length === 0 ? <p>{t('dashboard.custom.none')}</p> : doc.datas.map((source) => (
                    <p key={source.name} className="truncate font-mono">
                      {source.name} · {source.type} · {source.source === 'File'
                        ? resolveDataPath({ sourcePath: sourcePath || def?.sourcePath }, source.path ?? '')
                        : source.url}
                    </p>
                  ))}
                </div>
                <div>
                  <p className="font-medium">{t('dashboard.custom.resources')}</p>
                  {doc.resources.length === 0 ? <p>{t('dashboard.custom.none')}</p> : doc.resources.map((item) => (
                    <p key={item.name} className="font-mono">{item.name} · {item.type}</p>
                  ))}
                </div>
                <div>
                  <p className="font-medium">{t('dashboard.custom.functions')}</p>
                  {doc.functions.length === 0 ? <p>{t('dashboard.custom.none')}</p> : doc.functions.map((fn) => (
                    <p key={fn.name} className="font-mono">{fn.name}</p>
                  ))}
                </div>
                <div>
                  <p className="font-medium">{t('dashboard.custom.triggers')}</p>
                  {doc.triggers.length === 0 ? <p>{t('dashboard.custom.none')}</p> : doc.triggers.map((trigger, index) => (
                    <p key={index} className="font-mono">{trigger.event} · {trigger.function ?? trigger.action?.name ?? ''}</p>
                  ))}
                </div>
                <div>
                  <p className="font-medium">{t('dashboard.custom.nestedDeps')}</p>
                  {deps.length === 0 ? <p>{t('dashboard.custom.none')}</p> : deps.map((dep, index) => {
                    const local = dep.name ? defs.filter((item) => item.name === dep.name) : []
                    const state = dep.name
                      ? local.length === 1 ? t('dashboard.custom.depResolved') : local.length === 0 ? t('dashboard.custom.depMissing') : t('dashboard.custom.depAmbiguous')
                      : t('dashboard.custom.depRemote')
                    return <p key={index} className="truncate font-mono">{dep.as} · {dep.name ?? dep.url} · {state}</p>
                  })}
                </div>
                <div>
                  <p className="font-medium">{t('dashboard.custom.actions')}</p>
                  <p className="font-mono">{actions.length > 0 ? actions.join(', ') : t('dashboard.custom.none')}</p>
                </div>
                <p className="truncate font-mono">{t('dashboard.custom.baseDir')}: {baseDir}</p>
                {doc.launcherVersion && (
                  <p className={appVersion && compareVersions(appVersion, doc.launcherVersion) < 0 ? 'text-destructive' : ''}>
                    LauncherVersion: {doc.launcherVersion}
                    {appVersion ? ` (${appVersion})` : ''}
                  </p>
                )}
              </div>
            )}

            {notice && <p className="text-xs text-destructive">{notice}</p>}
            {!hostsConfirmed && hosts.length > 0 && (
              <p className="text-xs text-muted-foreground">{t('dashboard.custom.hostsUnconfirmed')}</p>
            )}
          </div>
        </div>
      </DialogBody>

      <DialogFooter>
        {widgetId && (
          <Button variant="destructive" size="sm" onClick={onDelete} className="mr-auto">
            {t('dashboard.custom.delete')}
          </Button>
        )}
        <Button variant="ghost" size="sm" onClick={onClose}>
          {t('dashboard.custom.cancel')}
        </Button>
        <Button size="sm" onClick={() => { void onSave() }} disabled={!canSave}>
          {t('dashboard.custom.save')}
        </Button>
      </DialogFooter>
    </Dialog>
  )
}
