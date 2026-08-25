import { useCallback, useEffect, useState } from 'react'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import { faArrowsRotate } from '@fortawesome/free-solid-svg-icons'
import { Button, Dialog, DialogHeader, DialogTitle, DialogBody, DialogFooter, Input, Separator, useMessageBox } from './ui'
import { useI18n } from '../i18n/index.tsx'
import { PluginCard } from './PluginCard.tsx'
import { PluginIcon } from './PluginIcon.tsx'
import { resolvePluginAssetUrl, deactivatePlugin } from '../plugins/plugin-loader.tsx'
import { usePluginStore, collectInstalledPlugins, buildUpdatesMap } from '../stores/pluginStore.ts'
import { PERMISSION_CATALOG, type PluginInfo } from '../plugins/types.ts'
import { setPluginState as apiSetPluginState, rollbackPlugin } from '../api/plugins.ts'
import { API_BASE } from '../api/client.ts'
import { uploadFile } from '../api/ipc.ts'
import { checkStoreUpdates, installStorePlugin, type StoreUpdateEntry } from '../api/pluginStore.ts'

export default function PluginStoreManage() {
  const { t } = useI18n()
  const { confirm: msgConfirm, notify } = useMessageBox()
  const { plugins, loading, loadPlugins, updates, setUpdates } = usePluginStore()

  const [pluginQuery, setPluginQuery] = useState('')
  const [pluginsMsg, setPluginsMsg] = useState<string | null>(null)
  const [pluginDetail, setPluginDetail] = useState<PluginInfo | null>(null)
  const [pluginInstalling, setPluginInstalling] = useState(false)
  const [checkingUpdates, setCheckingUpdates] = useState(false)
  /** localId → 升级中 */
  const [upgrading, setUpgrading] = useState<Record<string, boolean>>({})
  /** localId → 回滚中 */
  const [rollingBack, setRollingBack] = useState<Record<string, boolean>>({})

  useEffect(() => {
    if (!pluginsMsg) return
    const timer = setTimeout(() => setPluginsMsg(null), 3000)
    return () => clearTimeout(timer)
  }, [pluginsMsg])

  const handlePluginToggle = useCallback(
    async (id: string, active: boolean) => {
      try {
        await apiSetPluginState(id, active ? 'active' : 'disabled')
        await loadPlugins()
        setPluginsMsg(t('settings.plugins.changesApplied'))
      } catch {
        setPluginsMsg(t('settings.plugins.saveFailed'))
      }
    },
    [loadPlugins, t]
  )

  const handlePluginUninstall = useCallback(
    async (id: string) => {
      if (!(await msgConfirm(t('settings.plugins.uninstallConfirm')))) return
      deactivatePlugin(id)
      try {
        const res = await fetch(`${API_BASE}/plugins/${id}`, { method: 'DELETE' })
        if (!res.ok) throw new Error('Uninstall failed')
        setUpdates((prev) => {
          const next = { ...prev }
          delete next[id]
          return next
        })
        setPluginsMsg(t('settings.plugins.uninstalled'))
        await loadPlugins()
      } catch {
        setPluginsMsg(t('settings.plugins.uninstallFailed'))
      }
    },
    [loadPlugins, msgConfirm, t]
  )

  const handlePluginInstall = () => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = '.qplugin,.zip'
    input.onchange = async () => {
      const file = input.files?.[0]
      if (!file) return
      setPluginInstalling(true)
      try {
        const res = await uploadFile('/plugins/upload', file, 'plugin')
        if (!res.ok) throw new Error(`Upload failed (${res.status})`)
        setPluginsMsg(t('settings.plugins.installSuccess'))
        setPluginDetail(null)
        await loadPlugins()
        notify(t('settings.plugins.installSuccess'), 'success')
      } catch (e) {
        notify(t('settings.plugins.installFailed', { message: e instanceof Error ? e.message : 'Unknown' }), 'error')
      } finally {
        setPluginInstalling(false)
      }
    }
    input.click()
  }

  const handlePluginRefresh = async () => {
    setPluginsMsg(null)
    await usePluginStore.getState().rescan()
  }

  async function handleCheckUpdates() {
    setCheckingUpdates(true)
    try {
      const installed = collectInstalledPlugins(plugins)
      const res: { updates: StoreUpdateEntry[] } = await checkStoreUpdates(installed)
      const map = buildUpdatesMap(res.updates ?? [], plugins)
      setUpdates(map)
      notify(
        Object.keys(map).length > 0
          ? t('settings.plugins.store.updatesAvailable', { count: Object.keys(map).length })
          : t('settings.plugins.store.allUpToDate'),
        'success'
      )
    } catch (e) {
      notify(e instanceof Error ? e.message : String(e), 'error')
    } finally {
      setCheckingUpdates(false)
    }
  }

  const handlePluginUpgrade = useCallback(
    async (localId: string) => {
      const entry = updates[localId]
      if (!entry) return
      const plugin = plugins.find((p) => p.manifest.id === localId)
      const name = plugin?.manifest.name ?? localId
      if (!(await msgConfirm(t('settings.plugins.store.installConfirmDesc', { name, version: entry.latestVersion }), t('settings.plugins.store.updateConfirmTitle')))) return
      setUpgrading((prev) => ({ ...prev, [localId]: true }))
      try {
        await installStorePlugin(entry.slug, entry.latestVersion)
        setUpdates((prev) => {
          const next = { ...prev }
          delete next[localId]
          return next
        })
        await loadPlugins()
        notify(t('settings.plugins.store.installSuccess'), 'success')
      } catch (e) {
        notify(t('settings.plugins.store.installFailed', { message: e instanceof Error ? e.message : String(e) }), 'error')
      } finally {
        setUpgrading((prev) => {
          const next = { ...prev }
          delete next[localId]
          return next
        })
      }
    },
    [updates, plugins, msgConfirm, notify, t, loadPlugins, setUpdates]
  )

  const handlePluginRollback = useCallback(
    async (localId: string) => {
      const plugin = plugins.find((p) => p.manifest.id === localId)
      const name = plugin?.manifest.name ?? localId
      if (!(await msgConfirm(t('settings.plugins.store.rollbackConfirm', { name })))) return
      setRollingBack((prev) => ({ ...prev, [localId]: true }))
      try {
        await rollbackPlugin(localId)
        await loadPlugins()
        notify(t('settings.plugins.store.rollbackSuccess'), 'success')
      } catch (e) {
        notify(t('settings.plugins.store.rollbackFailed', { message: e instanceof Error ? e.message : String(e) }), 'error')
      } finally {
        setRollingBack((prev) => {
          const next = { ...prev }
          delete next[localId]
          return next
        })
      }
    },
    [plugins, msgConfirm, notify, t, loadPlugins]
  )

  const filtered = plugins.filter((p) =>
    p.manifest.name.toLowerCase().includes(pluginQuery.trim().toLowerCase())
  )

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center gap-2">
          <span className="text-sm text-muted-foreground">
            {t('settings.plugins.installedCount', { count: plugins.length })}
            {Object.keys(updates).length > 0 && (
              <span className="ml-2 rounded bg-primary/15 px-1.5 py-0.5 text-[11px] font-medium text-primary">
                {t('settings.plugins.store.updatesAvailable', { count: Object.keys(updates).length })}
              </span>
            )}
          </span>
          <div className="ml-auto flex items-center gap-2">
            <Input
              value={pluginQuery}
              onChange={(e) => setPluginQuery(e.target.value)}
              placeholder={t('settings.plugins.searchPlaceholder')}
              className="h-8 w-52"
            />
            <Button onClick={() => void handleCheckUpdates()} size="sm" variant="outline" disabled={checkingUpdates}>
              <FontAwesomeIcon icon={faArrowsRotate} className={`mr-1.5 h-3.5 w-3.5 ${checkingUpdates ? 'animate-spin' : ''}`} />
              {checkingUpdates ? t('settings.plugins.store.checkingUpdates') : t('settings.plugins.store.checkUpdates')}
            </Button>
            <Button onClick={handlePluginRefresh} size="sm" variant="outline" disabled={loading}>{t('common.refresh')}</Button>
            <Button onClick={handlePluginInstall} size="sm" disabled={pluginInstalling}>
              {pluginInstalling ? t('settings.plugins.installing') : t('settings.plugins.store.localInstall')}
            </Button>
          </div>
        </div>
        {pluginsMsg && (
          <div className="mb-4 rounded bg-primary/10 px-4 py-2 text-sm text-primary">{pluginsMsg}</div>
        )}
        {loading ? (
          <p className="text-muted-foreground">{t('common.loading')}</p>
        ) : plugins.length === 0 ? (
          <div className="flex min-h-[200px] items-center justify-center">
            <p className="text-muted-foreground">{t('settings.plugins.noneInstalled')}</p>
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            {filtered.map((p) => {
              const updateTo = updates[p.manifest.id]
              return (
                <div key={p.manifest.id} className="relative">
                  {updateTo && (
                    <span className="absolute -right-1.5 -top-1.5 z-10 rounded bg-primary px-1.5 py-0.5 text-[10px] font-medium text-primary-foreground shadow">
                      v{updateTo.latestVersion}
                    </span>
                  )}
                  <PluginCard
                    plugin={p}
                    onToggle={handlePluginToggle}
                    onUninstall={handlePluginUninstall}
                    onClick={() => setPluginDetail(p)}
                    upgradeTo={updateTo?.latestVersion}
                    upgrading={!!upgrading[p.manifest.id]}
                    onUpgrade={handlePluginUpgrade}
                    rollingBack={!!rollingBack[p.manifest.id]}
                    onRollback={handlePluginRollback}
                  />
                </div>
              )
            })}
          </div>
        )}
        {plugins.length > 0 && filtered.length === 0 && (
          <p className="py-6 text-center text-sm text-muted-foreground">{t('settings.plugins.noMatch')}</p>
        )}

      {/* 本地插件详情 */}
      <Dialog open={!!pluginDetail} onClose={() => setPluginDetail(null)}>
        <DialogHeader onClose={() => setPluginDetail(null)}>
          <DialogTitle>{pluginDetail?.manifest.name ?? ''}</DialogTitle>
        </DialogHeader>
        <DialogBody className="space-y-4">
          {pluginDetail && (
            <>
              <div className="text-sm text-muted-foreground">
                {pluginDetail.manifest.id}@{pluginDetail.manifest.version}
              </div>
              <div className="flex flex-wrap gap-1">
                {pluginDetail.manifest.layers.map((layer) => (
                  <span key={layer} className="rounded border border-border px-1.5 py-0.5 text-xs text-muted-foreground">{layer.toUpperCase()}</span>
                ))}
              </div>
              <Separator />
              {pluginDetail.manifest.permissions.length > 0 && (
                <div className="space-y-1">
                  <p className="text-sm text-muted-foreground">{t('settings.plugins.permissions', { count: pluginDetail.manifest.permissions.length })}</p>
                  {pluginDetail.manifest.permissions.map((p) => {
                    const info = PERMISSION_CATALOG[p]
                    const colors: Record<string, string> = {
                      normal: 'border-blue-500/30 text-blue-400',
                      warning: 'border-yellow-500/30 text-yellow-400',
                      danger: 'border-red-500/30 text-red-400',
                    }
                    return (
                      <div key={p} className="flex items-center gap-2 text-sm">
                        <span className={`rounded border px-1.5 py-0.5 text-xs ${colors[info?.risk ?? 'normal'] ?? ''}`}>
                          {info?.risk ?? 'normal'}
                        </span>
                        <span>{info?.key ? t(info.key) : p}</span>
                      </div>
                    )
                  })}
                </div>
              )}
              {pluginDetail.manifest.contributes?.menuItems && pluginDetail.manifest.contributes.menuItems.length > 0 && (
                <div className="space-y-1">
                  <p className="text-sm text-muted-foreground">{t('settings.plugins.contributes')}</p>
                  {pluginDetail.manifest.contributes.menuItems.map((item) => (
                    <div key={item.path} className="flex items-center gap-2 text-sm">
                      <PluginIcon icon={resolvePluginAssetUrl(pluginDetail.manifest.id, item.icon ?? '')} fallback="" />
                      <span>{item.label}</span>
                      <span className="text-xs text-muted-foreground">{item.path}</span>
                    </div>
                  ))}
                </div>
              )}
            </>
          )}
        </DialogBody>
        <DialogFooter>
          <Button variant="secondary" onClick={() => setPluginDetail(null)}>{t('common.close')}</Button>
        </DialogFooter>
      </Dialog>
    </div>
  )
}
