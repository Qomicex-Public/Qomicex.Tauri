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
  Textarea,
  useMessageBox,
} from '../../../components/ui'
import { openExternalUrl } from '../../../api/system.ts'
import { fetchWidgetUrl } from '../../../api/widgets.ts'
import { useI18n } from '../../../i18n/index.tsx'
import { renderNodes } from './render.tsx'
import { WIDGET_LIMITS, WidgetError, collectAutoHosts, hostOf, isSafeHttpsUrl } from './schema.ts'
import { useCustomWidgetStore, type PendingUpdate } from './store.ts'
import { WIDGET_TEMPLATE } from './template.ts'
import type { ActionName } from './schema.ts'
import type { WidgetNode } from './types.ts'
import { parseWidgetXml } from './xml.ts'

const HELP_URL = 'https://github.com/Qomicex-Public/Qomicex.Tauri/blob/main/docs/junsi-dev-docs/6-UI/主页自定义组件-XML语法.md'

function collectActions(nodes: WidgetNode[], out = new Set<ActionName>()): Set<ActionName> {
  for (const node of nodes) {
    switch (node.kind) {
      case 'button':
        out.add(node.onClick)
        break
      case 'container':
      case 'row':
      case 'column':
      case 'grid':
        collectActions(node.children, out)
        break
      case 'tabs':
        for (const tab of node.children) collectActions(tab.children, out)
        break
      case 'list':
        collectActions([node.item.child], out)
        break
      case 'if':
        collectActions(node.children, out)
        break
      default:
        break
    }
  }
  return out
}

interface WidgetEditorDialogProps {
  open: boolean
  widgetId: string | null
  onClose: () => void
}

export function WidgetEditorDialog({ open, widgetId, onClose }: WidgetEditorDialogProps) {
  const { t } = useI18n()
  const { confirm, error: showError } = useMessageBox()
  const defs = useCustomWidgetStore((s) => s.defs)
  const addDef = useCustomWidgetStore((s) => s.addDef)
  const updateDef = useCustomWidgetStore((s) => s.updateDef)
  const removeDef = useCustomWidgetStore((s) => s.removeDef)
  const clearData = useCustomWidgetStore((s) => s.clearData)
  const def = widgetId ? defs.find((item) => item.id === widgetId) : undefined

  const [xml, setXml] = useState(WIDGET_TEMPLATE)
  const [sourceUrl, setSourceUrl] = useState('')
  const [sampleJson, setSampleJson] = useState('{\n  "data": {}\n}')
  const [confirmed, setConfirmed] = useState<Set<string>>(new Set())
  const [pending, setPending] = useState<PendingUpdate | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    setXml(def?.xml ?? WIDGET_TEMPLATE)
    setSourceUrl(def?.sourceUrl ?? '')
    setConfirmed(new Set(def?.hosts ?? []))
    setPending(def?.pendingUpdate ?? null)
    setSampleJson('{\n  "data": {}\n}')
    setNotice(null)
    setBusy(null)
    // 只在打开/切换组件时重置；def 自身更新（保存前）不覆盖用户正在编辑的内容
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, widgetId])

  const parsed = useMemo(() => {
    try {
      return { doc: parseWidgetXml(xml), error: null as WidgetError | null }
    } catch (e) {
      return { doc: null, error: e instanceof WidgetError ? e : new WidgetError('xmlInvalid') }
    }
  }, [xml])
  const doc = parsed.doc

  const hosts = useMemo(() => {
    if (!doc) return []
    const list = collectAutoHosts({
      datas: doc.datas,
      updateUrl: doc.updateUrl,
      staticImageUrls: doc.staticImageUrls,
    })
    const sourceHost = hostOf(sourceUrl.trim())
    return [...new Set([...list, ...(sourceHost ? [sourceHost] : [])])].sort()
  }, [doc, sourceUrl])

  const actions = useMemo(() => (doc ? [...collectActions(doc.nodes)].sort() : []), [doc])
  const sourceValid = !sourceUrl.trim() || isSafeHttpsUrl(sourceUrl.trim())
  const hostsConfirmed = hosts.every((host) => confirmed.has(host))
  const canSave = !!doc && sourceValid && hostsConfirmed && !busy

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
    return { ...sample, state: { loading: false, error: false } }
  }, [sample])

  const setHost = (host: string, checked: boolean) => {
    setConfirmed((prev) => {
      const next = new Set(prev)
      if (checked) next.add(host)
      else next.delete(host)
      return next
    })
  }

  const importXml = (content: string, source: string, resetHosts: boolean) => {
    parseWidgetXml(content)
    setXml(content)
    setSourceUrl(source)
    setPending(null)
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
      importXml(response.body, url, true)
    } catch (e) {
      showError(e instanceof Error ? e.message : String(e), t('dashboard.custom.importFailed'))
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
      importXml(content, '', true)
    } catch (e) {
      showError(e instanceof Error ? e.message : String(e), t('dashboard.custom.importFailed'))
    } finally {
      setBusy(null)
    }
  }

  const onExportFile = async () => {
    if (!doc) return
    setBusy('export')
    try {
      const path = await saveDialog({
        defaultPath: `${doc.name || 'widget'}.qwidget`,
        filters: [{ name: 'QWidget', extensions: ['qwidget'] }],
      })
      if (!path) return
      await invoke('write_widget_file', { path, content: xml })
    } catch (e) {
      showError(e instanceof Error ? e.message : String(e), t('dashboard.custom.exportFailed'))
    } finally {
      setBusy(null)
    }
  }

  const onSave = () => {
    if (!doc || !canSave) return
    const name = doc.name
    const normalizedSource = sourceUrl.trim() || undefined
    if (widgetId) {
      const changed = !def || def.xml !== xml || def.sourceUrl !== normalizedSource
      updateDef(widgetId, {
        name,
        xml,
        sourceUrl: normalizedSource,
        hosts: [...confirmed],
        pendingUpdate: undefined,
        lastChecked: changed ? Date.now() : def?.lastChecked,
      })
      if (changed) clearData(widgetId)
    } else {
      addDef({
        id: crypto.randomUUID(),
        name,
        xml,
        sourceUrl: normalizedSource,
        hosts: [...confirmed],
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

  const applyPending = () => {
    if (!pending) return
    try {
      importXml(pending.xml, sourceUrl, false)
    } catch (e) {
      showError(e instanceof Error ? e.message : String(e), t('dashboard.custom.importFailed'))
    }
  }

  return (
    <Dialog open={open} onClose={onClose} className="max-w-5xl" closeOnBackdrop={false}>
      <DialogHeader onClose={onClose}>
        <DialogTitle>{t('dashboard.custom.editorTitle')}</DialogTitle>
        <DialogDescription>{t('dashboard.custom.editorDesc')}</DialogDescription>
      </DialogHeader>

      <DialogBody className="max-h-[72vh] overflow-y-auto">
        <div className="grid gap-4 lg:grid-cols-2">
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
            {!sourceValid && <p className="text-xs text-destructive">{t('dashboard.custom.invalidSource')}</p>}

            <div>
              <div className="mb-1 flex items-center justify-between">
                <p className="text-xs text-muted-foreground">{t('dashboard.custom.xml')}</p>
                <span className="text-[11px] text-muted-foreground/60">
                  {new TextEncoder().encode(xml).length} / {WIDGET_LIMITS.maxXmlBytes}
                </span>
              </div>
              <Textarea
                value={xml}
                onChange={(e) => setXml(e.target.value)}
                spellCheck={false}
                className="min-h-[320px] resize-y font-mono text-xs leading-relaxed"
              />
            </div>

            <div>
              <p className="mb-1 text-xs text-muted-foreground">{t('dashboard.custom.sampleData')}</p>
              <Textarea
                value={sampleJson}
                onChange={(e) => setSampleJson(e.target.value)}
                spellCheck={false}
                className="min-h-[90px] resize-y font-mono text-xs"
              />
              {!sample && <p className="mt-1 text-xs text-destructive">{t('dashboard.custom.invalidJson')}</p>}
            </div>

            <div className="flex flex-wrap gap-2">
              <Button size="sm" variant="outline" onClick={() => setXml(WIDGET_TEMPLATE)}>
                {t('dashboard.custom.template')}
              </Button>
              <Button size="sm" variant="outline" onClick={onImportFile} disabled={busy !== null}>
                {t('dashboard.custom.importFile')}
              </Button>
              <Button size="sm" variant="outline" onClick={onExportFile} disabled={!doc || busy !== null}>
                {t('dashboard.custom.exportFile')}
              </Button>
              <Button size="sm" variant="ghost" onClick={() => void openExternalUrl(HELP_URL)}>
                {t('dashboard.custom.help')}
              </Button>
            </div>
          </div>

          <div className="flex min-w-0 flex-col gap-3">
            {pending && (
              <div className="rounded-lg border border-primary/30 bg-primary/10 p-2.5 text-xs">
                <p>{t('dashboard.custom.pendingUpdate', { version: pending.version, hosts: pending.hosts.join(', ') })}</p>
                <Button size="sm" className="mt-2" onClick={applyPending}>
                  {t('dashboard.custom.applyUpdate')}
                </Button>
              </div>
            )}

            <div>
              <div className="mb-1 flex items-center justify-between">
                <p className="text-xs text-muted-foreground">{t('dashboard.custom.preview')}</p>
                <span className={doc ? 'text-[11px] text-primary' : 'text-[11px] text-destructive'}>
                  {doc ? t('dashboard.custom.valid') : t('dashboard.custom.invalid')}
                </span>
              </div>
              <div className="max-h-[360px] min-h-[160px] overflow-auto rounded-lg border border-border/50 bg-background/40 p-3">
                {doc && previewScope
                  ? renderNodes(doc.nodes, {
                      scope: previewScope,
                      action: () => {},
                      allowedHosts: confirmed,
                    })
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
                      <Checkbox
                        checked={confirmed.has(host)}
                        onCheckedChange={(checked) => setHost(host, checked === true)}
                      />
                      <span className="font-mono">{host}</span>
                    </label>
                  ))}
                </div>
              )}
            </div>

            <div>
              <p className="mb-1 text-xs text-muted-foreground">{t('dashboard.custom.actions')}</p>
              <p className="font-mono text-xs text-muted-foreground/80">
                {actions.length > 0 ? actions.join(', ') : t('dashboard.custom.noActions')}
              </p>
            </div>

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
        <Button size="sm" onClick={onSave} disabled={!canSave}>
          {busy === 'save' ? t('dashboard.custom.saving') : t('dashboard.custom.save')}
        </Button>
      </DialogFooter>
    </Dialog>
  )
}
