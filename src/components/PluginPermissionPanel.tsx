// Copyright (C) 2026 Qomicex Launcher Contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { useEffect, useRef, useState } from 'react'
import { Plus, X } from 'lucide-react'
import { Button, Input, Separator, Switch, Tooltip, useMessageBox } from './ui'
import { useI18n } from '../i18n/index.tsx'
import { usePluginStore } from '../stores/pluginStore.ts'
import { PERMISSION_CATALOG, DEFAULT_PLUGIN_PERMISSION_CONFIG } from '../plugins/types.ts'
import type { PluginInfo, PluginPermissionConfig } from '../plugins/types.ts'
import { savePluginPermissions } from '../api/plugins.ts'
import { activatePlugin, deactivatePlugin } from '../plugins/plugin-loader.tsx'

/** 改动这些权限会改变 manifest 静态贡献，必须重启插件才能重新注册/注销。 */
const CONTRIBUTION_PERMISSIONS = new Set([
  'ui:inject_sidebar',
  'ui:inject_settings',
  'ui:sub_window',
  'hook:register',
])

const RISK_CLASS: Record<string, string> = {
  normal: 'border-blue-500/30 text-blue-400',
  warning: 'border-yellow-500/30 text-yellow-400',
  danger: 'border-red-500/30 text-red-400',
}

/** 白名单输入的宽松预检：拒绝空格/协议/路径，其余交给后端规范化。 */
function looksLikeHostEntry(value: string): boolean {
  return /^(\*\.)?[a-z0-9][a-z0-9.-]*(:\d{1,5})?$/i.test(value.trim())
}

export function PluginPermissionPanel({ plugin }: { plugin: PluginInfo }) {
  const { t } = useI18n()
  const { confirm, notify } = useMessageBox()
  const pluginId = plugin.manifest.id
  const saved = usePluginStore(
    (s) => s.permissionConfigs[pluginId] ?? DEFAULT_PLUGIN_PERMISSION_CONFIG
  )
  const setPermissionConfig = usePluginStore((s) => s.setPermissionConfig)
  // 用实时状态而不是打开弹窗时的快照：用户可能在弹窗打开期间把插件停用。
  const isActive = usePluginStore((s) => s.getPlugin(pluginId)?.state === 'active')
  const [draft, setDraft] = useState<PluginPermissionConfig>(saved)
  const [allowInput, setAllowInput] = useState('')
  const [allowError, setAllowError] = useState(false)
  // 连续拨动多个开关时串行保存：并发 PUT 的响应顺序不保证，后到的旧响应会把
  // store 覆盖回少一项的状态。
  const saveQueue = useRef<Promise<void>>(Promise.resolve())

  useEffect(() => {
    setDraft(saved)
    setAllowInput('')
    setAllowError(false)
  }, [saved, pluginId])

  const total = plugin.manifest.permissions.length
  const enabledCount = total - draft.disabled.filter((p) => plugin.manifest.permissions.includes(p)).length

  const persist = async (next: PluginPermissionConfig) => {
    const previous = saved
    // 乐观更新：闸门读的是 store，等到后端返回再更新会让开关回弹。
    setDraft(next)
    setPermissionConfig(pluginId, next)
    const job = async () => {
      try {
        const normalized = await savePluginPermissions(pluginId, next)
        setPermissionConfig(pluginId, normalized)
        setDraft(normalized)
        if (needsContributionReload(previous, normalized)) await reloadPlugin()
      } catch (e) {
        setPermissionConfig(pluginId, previous)
        setDraft(previous)
        notify(t('settings.plugins.permissionSaveFailed'), 'error')
        console.warn(`[plugin] 保存权限配置失败 ${pluginId}`, e)
      }
    }
    saveQueue.current = saveQueue.current.then(job, job)
    await saveQueue.current
  }

  const reloadPlugin = async () => {
    if (!isActive) return
    try {
      deactivatePlugin(pluginId)
      await activatePlugin(plugin)
      notify(t('settings.plugins.permissionReloaded'), 'success')
    } catch (e) {
      console.warn(`[plugin] 权限变更后重启插件失败 ${pluginId}`, e)
    }
  }

  const toggle = async (permission: string, enabled: boolean) => {
    if (!enabled && PERMISSION_CATALOG[permission]?.risk === 'danger') {
      const label = PERMISSION_CATALOG[permission]?.key
        ? t(PERMISSION_CATALOG[permission].key)
        : permission
      if (!(await confirm(t('settings.plugins.permissionDangerConfirm', { permission: label })))) return
    }
    const disabled = enabled
      ? draft.disabled.filter((p) => p !== permission)
      : [...draft.disabled, permission]
    await persist({ ...draft, disabled })
  }

  const handleReset = async () => {
    if (!(await confirm(t('settings.plugins.permissionResetConfirm', { name: plugin.manifest.name })))) return
    await persist({ ...DEFAULT_PLUGIN_PERMISSION_CONFIG, corsProxy: { ...DEFAULT_PLUGIN_PERMISSION_CONFIG.corsProxy } })
  }

  const addAllowEntry = async () => {
    const entry = allowInput.trim().toLowerCase()
    if (!entry) return
    if (!looksLikeHostEntry(entry)) {
      setAllowError(true)
      return
    }
    setAllowError(false)
    setAllowInput('')
    if (draft.corsProxy.allowlist.includes(entry)) return
    await persist({
      ...draft,
      corsProxy: { ...draft.corsProxy, allowlist: [...draft.corsProxy.allowlist, entry] },
    })
  }

  const removeAllowEntry = async (entry: string) => {
    await persist({
      ...draft,
      corsProxy: {
        ...draft.corsProxy,
        allowlist: draft.corsProxy.allowlist.filter((e) => e !== entry),
      },
    })
  }

  const corsProxyEnabled = plugin.manifest.permissions.includes('network:cors_proxy')
    && !draft.disabled.includes('network:cors_proxy')

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <span className="text-sm text-muted-foreground">
          {t('settings.plugins.permissionEnabledCount', { enabled: enabledCount, total })}
        </span>
        <Button size="sm" variant="outline" className="ml-auto" onClick={() => void handleReset()}>
          {t('settings.plugins.permissionReset')}
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">{t('settings.plugins.permissionHint')}</p>
      <Separator />

      {total === 0 && (
        <p className="text-sm text-muted-foreground">{t('settings.plugins.permissionNoneDeclared')}</p>
      )}

      <div className="space-y-1">
        {plugin.manifest.permissions.map((permission) => {
          const info = PERMISSION_CATALOG[permission]
          const enabled = !draft.disabled.includes(permission)
          return (
            <div key={permission} className="rounded-md border border-border/60 px-3 py-2">
              <div className="flex items-center gap-2 text-sm">
                <span className={`rounded border px-1.5 py-0.5 text-xs ${RISK_CLASS[info?.risk ?? 'normal'] ?? ''}`}>
                  {info?.risk ?? 'normal'}
                </span>
                <span className={enabled ? '' : 'text-muted-foreground line-through'}>
                  {info?.key ? t(info.key) : permission}
                </span>
                {!enabled && (
                  <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                    {t('settings.plugins.permissionDisabledTag')}
                  </span>
                )}
                <Switch
                  className="ml-auto"
                  checked={enabled}
                  onCheckedChange={(v) => void toggle(permission, v)}
                  aria-label={permission}
                />
              </div>

              {permission === 'network:cors_proxy' && corsProxyEnabled && (
                <div className="mt-3 space-y-3 rounded-md bg-muted/40 p-3">
                  <div>
                    <p className="text-sm font-medium">{t('settings.plugins.corsProxyTitle')}</p>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      {t('settings.plugins.corsProxyDesc')}
                    </p>
                  </div>
                  <div className="flex items-start gap-2">
                    <div className="min-w-0 flex-1">
                      <p className="text-sm">{t('settings.plugins.corsProxyAllowPrivate')}</p>
                      <p className="mt-0.5 text-xs text-muted-foreground">
                        {t('settings.plugins.corsProxyAllowPrivateDesc')}
                      </p>
                    </div>
                    <Switch
                      checked={draft.corsProxy.allowPrivate}
                      onCheckedChange={(v) => void persist({
                        ...draft,
                        corsProxy: { ...draft.corsProxy, allowPrivate: v },
                      })}
                      aria-label={t('settings.plugins.corsProxyAllowPrivate')}
                    />
                  </div>
                  <div className="space-y-2">
                    <div>
                      <p className="text-sm">{t('settings.plugins.corsProxyAllowlist')}</p>
                      <p className="mt-0.5 text-xs text-muted-foreground">
                        {t('settings.plugins.corsProxyAllowlistDesc')}
                      </p>
                    </div>
                    {draft.corsProxy.allowlist.length === 0 ? (
                      <p className="text-xs text-muted-foreground">{t('settings.plugins.corsProxyAllowlistEmpty')}</p>
                    ) : (
                      <div className="flex flex-wrap gap-1.5">
                        {draft.corsProxy.allowlist.map((entry) => (
                          <span
                            key={entry}
                            className="inline-flex items-center gap-1 rounded border border-border bg-background px-2 py-0.5 text-xs"
                          >
                            {entry}
                            <Tooltip content={t('settings.plugins.corsProxyRemove')}>
                              <button
                                type="button"
                                className="text-muted-foreground hover:text-foreground"
                                onClick={() => void removeAllowEntry(entry)}
                                aria-label={`${t('settings.plugins.corsProxyRemove')}: ${entry}`}
                              >
                                <X className="h-3 w-3" />
                              </button>
                            </Tooltip>
                          </span>
                        ))}
                      </div>
                    )}
                    <div className="flex items-center gap-2">
                      <Input
                        value={allowInput}
                        onChange={(e) => {
                          setAllowInput(e.target.value)
                          setAllowError(false)
                        }}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') void addAllowEntry()
                        }}
                        placeholder={t('settings.plugins.corsProxyAllowlistPlaceholder')}
                        className="h-8"
                      />
                      <Button size="sm" variant="outline" onClick={() => void addAllowEntry()}>
                        <Plus className="h-3.5 w-3.5" />
                        {t('settings.plugins.corsProxyAdd')}
                      </Button>
                    </div>
                    {allowError && (
                      <p className="text-xs text-destructive">{t('settings.plugins.corsProxyInvalid')}</p>
                    )}
                  </div>
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}

function needsContributionReload(before: PluginPermissionConfig, after: PluginPermissionConfig): boolean {
  for (const permission of CONTRIBUTION_PERMISSIONS) {
    if (before.disabled.includes(permission) !== after.disabled.includes(permission)) return true
  }
  return false
}
