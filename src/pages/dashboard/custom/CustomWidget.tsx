// Copyright (C) 2026 Qomicex Launcher Contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useMessageBox } from '../../../components/ui'
import { useI18n } from '../../../i18n/index.tsx'
import { fetchWidgetUrl } from '../../../api/widgets.ts'
import { useDashboard } from '../context.tsx'
import { runWidgetAction } from './actions.ts'
import { renderNodes } from './render.tsx'
import { WIDGET_LIMITS, WidgetError, collectAutoHosts, hostOf } from './schema.ts'
import { useCustomWidgetStore, type CustomWidgetDef } from './store.ts'
import type { WidgetAction } from './types.ts'
import { parseWidgetXml } from './xml.ts'

export function CustomWidget({ def }: { def: CustomWidgetDef }) {
  const { t } = useI18n()
  const { defaultInstance, launch, refresh, resolveAccountCheck } = useDashboard()
  const navigate = useNavigate()
  const { notify, error: showError } = useMessageBox()
  const setData = useCustomWidgetStore((s) => s.setData)
  const clearData = useCustomWidgetStore((s) => s.clearData)
  const updateDef = useCustomWidgetStore((s) => s.updateDef)
  const dataCache = useCustomWidgetStore((s) => s.dataCache[def.id])

  const [tick, setTick] = useState(0)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const parsed = useMemo(() => {
    try {
      return { doc: parseWidgetXml(def.xml), error: null as WidgetError | null }
    } catch (e) {
      return { doc: null, error: e instanceof WidgetError ? e : new WidgetError('xmlInvalid') }
    }
  }, [def.xml])
  const doc = parsed.doc

  useEffect(() => {
    if (!doc) return
    const cache = useCustomWidgetStore.getState().dataCache[def.id]
    const confirmed = new Set(def.hosts)
    const sources = doc.datas.filter((source) => {
      const host = hostOf(source.url)
      return !!host && confirmed.has(host)
    })
    if (doc.datas.length > 0 && sources.length === 0) {
      setError('host')
      setLoading(false)
      return
    }
    const now = Date.now()
    const stale = sources.filter((source) => {
      const entry = cache?.[source.name]
      return !entry || now - entry.at > source.refresh * 1000
    })
    if (stale.length === 0) {
      setError(null)
      setLoading(false)
      return
    }

    const controller = new AbortController()
    let cancelled = false
    setLoading(true)
    setError(null)
    void Promise.allSettled(
      stale.map(async (source) => {
        const response = await fetchWidgetUrl(source.url, controller.signal)
        const json = JSON.parse(response.body) as unknown
        if (!cancelled) setData(def.id, source.name, json)
      }),
    ).then((results) => {
      if (cancelled) return
      setLoading(false)
      if (results.some((result) => result.status === 'rejected')) setError('data')
    })
    return () => {
      cancelled = true
      controller.abort()
    }
  }, [doc, def.id, def.hosts, tick, setData])

  useEffect(() => {
    if (!doc || doc.datas.length === 0) return
    const minSeconds = Math.max(60, Math.min(...doc.datas.map((source) => source.refresh)))
    const timer = setInterval(() => setTick((value) => value + 1), minSeconds * 1000)
    return () => clearInterval(timer)
  }, [doc])

  useEffect(() => {
    if (!doc) return
    const updateUrl = doc.updateUrl ?? def.sourceUrl
    if (!updateUrl) return
    const sourceHost = hostOf(updateUrl)
    if (!sourceHost || !def.hosts.includes(sourceHost)) return
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
          staticImageUrls: next.staticImageUrls,
        })
        const unknown = hosts.filter((host) => !def.hosts.includes(host))
        if (unknown.length > 0) {
          updateDef(def.id, {
            lastChecked: now,
            pendingUpdate: { xml: response.body, version: next.version, hosts: unknown },
          })
          return
        }
        updateDef(def.id, {
          xml: response.body,
          name: next.name,
          hosts,
          lastChecked: now,
          pendingUpdate: undefined,
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
  }, [doc, def.id, def.sourceUrl, def.lastChecked, def.xml, def.hosts, updateDef, clearData])

  const handleAction = useCallback(async (action: WidgetAction) => {
    try {
      await runWidgetAction(action, {
        defaultInstance,
        launch,
        refreshDashboard: refresh,
        selectAccount: async () => {
          await resolveAccountCheck()
        },
        refreshWidget: () => setTick((value) => value + 1),
        notify,
        navigateTo: (path) => navigate(path),
        t,
      })
    } catch (e) {
      showError(e instanceof Error ? e.message : String(e), t('dashboard.custom.actionFailed'))
    }
  }, [defaultInstance, launch, refresh, resolveAccountCheck, notify, navigate, t, showError])

  const scope = useMemo(() => {
    const values: Record<string, unknown> = {}
    for (const source of doc?.datas ?? []) {
      const entry = dataCache?.[source.name]
      if (entry) values[source.name] = entry.json
    }
    values.state = { loading, error: !!error }
    return values
  }, [doc, dataCache, loading, error])

  if (!doc) {
    return (
      <div className="flex h-full items-center justify-center rounded-xl border border-destructive/30 p-3 text-xs text-destructive">
        {t('dashboard.custom.invalid')}
      </div>
    )
  }

  return (
    <div className="h-full min-h-0 overflow-auto">
      {renderNodes(doc.nodes, {
        scope,
        action: handleAction,
        allowedHosts: new Set(def.hosts),
      })}
    </div>
  )
}
