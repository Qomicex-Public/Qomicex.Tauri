// Copyright (C) 2026 Qomicex Launcher Contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { useCallback, useEffect, useState } from 'react'
import { CheckCircle2, Circle, Layers, RotateCw } from 'lucide-react'
import { cn } from '../lib/utils.ts'
import { Dialog, DialogHeader, DialogTitle, DialogBody, DialogFooter, Button, Select, SelectOption, useMessageBox } from './ui'
import { getInstances } from '../api/instance.ts'
import { loadSettings } from '../api/settings.ts'
import { useI18n } from '../i18n/index.tsx'
import { quickInstallViaDownloadCenterForFolder } from '../lib/quickInstall.ts'
import {
  buildFavoriteFolderPlan,
  installedSkipCount,
  type FavoriteFolderMember,
} from '../lib/favoriteFolderInstall.ts'
import { countSkipped, type FavoriteFolderInstallPlan, type FavoriteSkipReason } from '../lib/favoriteFolderInstallPlan.ts'
import type { GameInstance } from '../types/index.ts'

interface FavoriteFolderInstallDialogProps {
  open: boolean
  onClose: () => void
  /** 收藏夹名（批任务标题与提示文案） */
  folderName: string
  /** 收藏夹的完整成员（不受视图上的来源/分类/标签/搜索过滤影响） */
  members: readonly FavoriteFolderMember[]
}

/** 跳过原因 → i18n key 后缀（与 submodule 的 resource.favorites.installFolder.skip.* 对应）。 */
const SKIP_REASON_KEYS: Record<FavoriteSkipReason, string> = {
  installed: 'installed',
  noCompatibleVersion: 'noCompatibleVersion',
  missingUrl: 'missingUrl',
  unsupportedSource: 'unsupportedSource',
  notMod: 'notMod',
  duplicate: 'duplicate',
  lookupFailed: 'lookupFailed',
}

export default function FavoriteFolderInstallDialog({
  open,
  onClose,
  folderName,
  members,
}: FavoriteFolderInstallDialogProps) {
  const { t, lang } = useI18n()
  const { notify } = useMessageBox()

  const [instances, setInstances] = useState<GameInstance[]>([])
  const [selectedInstance, setSelectedInstance] = useState<GameInstance | null>(null)
  const [loadingInstances, setLoadingInstances] = useState(false)
  const [plan, setPlan] = useState<FavoriteFolderInstallPlan | null>(null)
  const [existingFileNames, setExistingFileNames] = useState<string[]>([])
  const [planning, setPlanning] = useState(false)
  const [planError, setPlanError] = useState<string | null>(null)
  const [starting, setStarting] = useState(false)

  // 全部成员都交给规划器：非 mod 条目由它记成 notMod 并在对话框里统计展示。
  // 在这里预过滤会让规划器的 notMod 计数恒为 0，用户看不到「这些被排除了」。
  const allMembers = members

  // 实例候选：属于当前游戏目录 + 必须有 loader（原版实例装不了 mod）。
  useEffect(() => {
    if (!open) return
    setSelectedInstance(null)
    setPlan(null)
    setPlanError(null)
    setStarting(false)
    let cancelled = false
    ;(async () => {
      setLoadingInstances(true)
      try {
        const settings = await loadSettings()
        const norm = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
        const raw = (await getInstances()).filter(
          (i) => norm(i.gameDir) === norm(settings.gameDir) && !!i.loader,
        )
        const all = [...new Map(raw.map((i) => [i.id, i])).values()]
        if (cancelled) return
        setInstances(all)
        setSelectedInstance(all.find((i) => i.isDefault) ?? all[0] ?? null)
      } catch {
        if (!cancelled) notify(t('dialogs.resourceInstall.instancesLoadFailed'), 'error')
      }
      if (!cancelled) setLoadingInstances(false)
    })()
    return () => {
      cancelled = true
    }
  }, [open, notify, t])

  // 选定实例后生成计划（远程查询，耗时较长，显示加载态）。
  useEffect(() => {
    if (!open || !selectedInstance) {
      setPlan(null)
      return
    }
    let cancelled = false
    setPlanning(true)
    setPlanError(null)
    setPlan(null)
    ;(async () => {
      try {
        const result = await buildFavoriteFolderPlan({
          instanceId: selectedInstance.id,
          gameVersion: selectedInstance.gameVersion,
          loader: selectedInstance.loader ?? '',
          members: allMembers,
        })
        if (cancelled) return
        setPlan(result.plan)
        setExistingFileNames(result.existingFileNames)
      } catch (e) {
        if (!cancelled) {
          setPlanError(e instanceof Error ? e.message : t('dialogs.common.unknownError'))
        }
      }
      if (!cancelled) setPlanning(false)
    })()
    return () => {
      cancelled = true
    }
  }, [open, selectedInstance, allMembers, t])

  const handleInstall = useCallback(async () => {
    if (!selectedInstance || !plan || plan.downloads.length === 0) return
    setStarting(true)
    setPlanError(null)
    try {
      await quickInstallViaDownloadCenterForFolder({
        instanceId: selectedInstance.id,
        gameVersion: selectedInstance.gameVersion,
        mains: plan.downloads
          .filter((d) => d.isRoot)
          .map((d) => ({
            url: d.url,
            fileName: d.fileName,
            category: d.category,
            name: d.name,
            cnName: null,
          })),
        deps: plan.downloads
          .filter((d) => !d.isRoot)
          .map((d) => ({
            url: d.url,
            fileName: d.fileName,
            category: d.category,
            name: d.name,
            cnName: null,
          })),
        taskName: t('downloads.quickInstallName', { name: folderName }),
        existingFileNames,
        t,
        lang,
      })
      onClose()
      notify(t('dialogs.resourceInstall.addedToDownloadCenter'), 'success')
    } catch (e) {
      // 提交失败时保持对话框打开，允许用户重试（与 ResourceInstallDialog 一致）。
      setPlanError(e instanceof Error ? e.message : t('dialogs.common.unknownError'))
      setStarting(false)
    }
  }, [selectedInstance, plan, existingFileNames, folderName, t, lang, onClose, notify])

  const roots = plan?.downloads.filter((d) => d.isRoot) ?? []
  const deps = plan?.downloads.filter((d) => !d.isRoot) ?? []
  const installedCount = plan ? installedSkipCount(plan) : 0
  const nonModCount = plan ? countSkipped(plan, 'notMod') : 0
  const otherSkipped = (plan?.skipped ?? []).filter((s) => s.reason !== 'installed' && s.reason !== 'notMod')
  const canInstall = !!plan && plan.downloads.length > 0 && !starting

  return (
    <Dialog open={open} onClose={onClose}>
      <DialogHeader onClose={onClose}>
        <DialogTitle className="flex items-center gap-2">
          <Layers className="h-4 w-4 text-muted-foreground" />
          {t('resource.favorites.installFolder.title', { name: folderName })}
        </DialogTitle>
      </DialogHeader>

      <DialogBody className="space-y-4">
        <div className="space-y-1.5">
          <span className="text-xs font-medium text-muted-foreground">
            {t('dialogs.resourceInstall.selectInstance')}
          </span>
          {loadingInstances ? (
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <RotateCw className="h-3 w-3 animate-spin" />
              {t('common.loading')}
            </div>
          ) : instances.length === 0 ? (
            <div className="rounded-lg border border-dashed border-border/60 p-3 text-center text-xs text-muted-foreground">
              {t('dialogs.resourceInstall.noInstances')}
            </div>
          ) : (
            <Select
              value={selectedInstance?.id ?? ''}
              onChange={(v) => setSelectedInstance(instances.find((i) => i.id === v) ?? null)}
              placeholder={t('dialogs.resourceInstall.selectInstance')}
            >
              {instances.map((i) => (
                <SelectOption key={i.id} value={i.id}>
                  {`${i.name} · ${i.gameVersion} · ${i.loader}${i.isDefault ? ` · ${t('dialogs.resourceInstall.default')}` : ''}`}
                </SelectOption>
              ))}
            </Select>
          )}
        </div>

        {planning && (
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <RotateCw className="h-3 w-3 animate-spin" />
            {t('resource.favorites.installFolder.resolving')}
          </div>
        )}

        {planError && (
          <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-xs text-destructive">
            {planError}
          </div>
        )}

        {plan && !planning && (
          <div className="space-y-3">
            <PlanGroup
              title={t('resource.favorites.installFolder.willInstall', { count: roots.length })}
              icon={<CheckCircle2 className="h-3.5 w-3.5 text-emerald-500" />}
              items={roots.map((d) => ({ key: `${d.source}:${d.projectId}`, label: d.name }))}
            />
            {deps.length > 0 && (
              <PlanGroup
                title={t('resource.favorites.installFolder.willInstallDeps', { count: deps.length })}
                icon={<Circle className="h-3.5 w-3.5 text-sky-500" />}
                items={deps.map((d) => ({ key: `${d.source}:${d.projectId}`, label: d.name }))}
              />
            )}
            {installedCount > 0 && (
              <PlanGroup
                title={t('resource.favorites.installFolder.alreadyInstalled', { count: installedCount })}
                icon={<CheckCircle2 className="h-3.5 w-3.5 text-muted-foreground" />}
                items={(plan.skipped ?? [])
                  .filter((s) => s.reason === 'installed')
                  .map((s) => ({ key: `${s.source}:${s.projectId}`, label: s.title }))}
                muted
              />
            )}
            {otherSkipped.length > 0 && (
              <PlanGroup
                title={t('resource.favorites.installFolder.skipped', { count: otherSkipped.length })}
                icon={<Circle className="h-3.5 w-3.5 text-amber-500" />}
                items={otherSkipped.map((s) => ({
                  key: `${s.source}:${s.projectId}:${s.reason}`,
                  label: `${s.title} · ${t(`resource.favorites.installFolder.skip.${SKIP_REASON_KEYS[s.reason]}`)}`,
                }))}
                muted
              />
            )}
            {nonModCount > 0 && (
              <p className="text-[11px] text-muted-foreground">
                {t('resource.favorites.installFolder.nonModHint', { count: nonModCount })}
              </p>
            )}
            {plan.downloads.length === 0 && (
              <p className="text-xs text-muted-foreground">
                {t('resource.favorites.installFolder.nothingToInstall', { name: folderName })}
              </p>
            )}
          </div>
        )}
      </DialogBody>

      <DialogFooter>
        <Button variant="ghost" onClick={onClose} disabled={starting}>
          {t('common.cancel')}
        </Button>
        <Button onClick={handleInstall} disabled={!canInstall}>
          {starting ? t('resource.favorites.installFolder.submitting') : t('resource.favorites.installFolder.confirm')}
        </Button>
      </DialogFooter>
    </Dialog>
  )
}

function PlanGroup({
  title,
  icon,
  items,
  muted,
}: {
  title: string
  icon: React.ReactNode
  items: { key: string; label: string }[]
  muted?: boolean
}) {
  if (items.length === 0) return null
  return (
    <div className="space-y-1">
      <div className="flex items-center gap-1.5 text-xs font-medium">
        {icon}
        <span>{title}</span>
      </div>
      <ul className="space-y-0.5 pl-5">
        {items.map((it) => (
          <li
            key={it.key}
            className={cn('truncate text-[11px]', muted ? 'text-muted-foreground' : 'text-foreground/90')}
            title={it.label}
          >
            {it.label}
          </li>
        ))}
      </ul>
    </div>
  )
}
