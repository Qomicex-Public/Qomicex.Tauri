// Copyright (C) 2026 Qomicex Launcher Contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { useEffect, useState } from 'react'
import { Plus, X } from 'lucide-react'
import { Button, Input, Separator, Switch, Tooltip, useMessageBox } from './ui'
import { useI18n } from '../i18n/index.tsx'
import { usePluginStore } from '../stores/pluginStore.ts'
import { PERMISSION_CATALOG, DEFAULT_PLUGIN_PERMISSION_CONFIG } from '../plugins/types.ts'
import type { PluginInfo, PluginPermissionConfig } from '../plugins/types.ts'
import { contributionPermissionsChanged } from '../plugins/permission-rules.ts'
import { savePluginPermissions } from '../api/plugins.ts'
import { activatePlugin, deactivatePlugin } from '../plugins/plugin-loader.tsx'

// 保存队列按插件放在模块级：面板关闭/重开后组件实例重建，组件内的队列会丢，
// 新的 PUT 就可能与尚未完成的旧 PUT 并发，旧响应晚到会把 store 覆盖回旧配置。
const saveQueues = new Map<string, Promise<void>>()
/** 每个插件最近一次保存的序号：只有最新请求的响应才能写回 store/draft。 */
const saveSeqs = new Map<string, number>()
/** 最近一次经后端确认的配置：保存失败时回滚到它，而不是回滚到某次乐观值。 */
const confirmedConfigs = new Map<string, PluginPermissionConfig>()

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
  const [draft, setDraft] = useState<PluginPermissionConfig>(saved)
  const [allowInput, setAllowInput] = useState('')
  const [allowError, setAllowError] = useState(false)

  useEffect(() => {
    setDraft(saved)
  }, [saved])

  // 只在切换到另一个插件时清空输入框；保存响应更新 saved 时不应打断正在输入的白名单。
  useEffect(() => {
    setAllowInput('')
    setAllowError(false)
    confirmedConfigs.set(
      pluginId,
      usePluginStore.getState().permissionConfigs[pluginId] ?? DEFAULT_PLUGIN_PERMISSION_CONFIG,
    )
  }, [pluginId])

  const total = plugin.manifest.permissions.length
  const enabledCount = total - draft.disabled.filter((p) => plugin.manifest.permissions.includes(p)).length

  const persist = async (next: PluginPermissionConfig) => {
    const seq = (saveSeqs.get(pluginId) ?? 0) + 1
    saveSeqs.set(pluginId, seq)
    // 乐观更新：闸门读的是 store，等到后端返回再更新会让开关回弹。
    setDraft(next)
    setPermissionConfig(pluginId, next)
    const job = async () => {
      const before = confirmedConfigs.get(pluginId) ?? DEFAULT_PLUGIN_PERMISSION_CONFIG
      try {
        const normalized = await savePluginPermissions(pluginId, next)
        confirmedConfigs.set(pluginId, normalized)
        // 更晚的编辑已经基于更新的草稿排队：旧响应不能回写，否则会丢改动。
        if (saveSeqs.get(pluginId) === seq) {
          setPermissionConfig(pluginId, normalized)
          setDraft(normalized)
        }
        if (contributionPermissionsChanged(before, normalized)) await reloadPlugin()
      } catch (e) {
        if (saveSeqs.get(pluginId) === seq) {
          const confirmed = confirmedConfigs.get(pluginId) ?? DEFAULT_PLUGIN_PERMISSION_CONFIG
          setPermissionConfig(pluginId, confirmed)
          setDraft(confirmed)
        }
        notify(t('settings.plugins.permissionSaveFailed'), 'error')
        console.warn(`[plugin] 保存权限配置失败 ${pluginId}`, e)
      }
    }
    const queue = saveQueues.get(pluginId) ?? Promise.resolve()
    const queued = queue.then(job, job)
    saveQueues.set(pluginId, queued)
    await queued
  }

  const reloadPlugin = async () => {
    // 读 store 的实时状态而不是面板打开时的快照：保存请求返回前用户可能已停用插件。
    if (usePluginStore.getState().getPlugin(pluginId)?.state !== 'active') return
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

