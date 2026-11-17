// Copyright (C) 2026 Qomicex Launcher Contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { useMemo, useState } from 'react'
import Markdown from 'react-markdown'
import { openUrl } from '@tauri-apps/plugin-opener'
import { ChevronDown, ChevronRight, ExternalLink } from 'lucide-react'
import type { ChangelogEntry } from '../api/update.ts'
import { Tooltip } from './ui'
import { useI18n } from '../i18n/index.tsx'
import { REPOSITORY_URL } from '../constants/credits.ts'
import {
  categoryLabelKey,
  displayVersion,
  parseNotes,
  splitVisibleVersions,
  type UpdateCategory,
} from '../lib/updateHistory.ts'

interface Props {
  entries: ChangelogEntry[]
  /** 最新的那条版本号（用于打「最新」徽章） */
  latestVersion?: string
  /** 还有更早的版本没取到（渲染「更早版本见发布页」提示） */
  hasOlderVersions: boolean
}

/** 分类标签的配色：新增=绿、修复=红、重构/性能/其他=中性。 */
const CATEGORY_CLASS: Record<UpdateCategory, string> = {
  feat: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400',
  fix: 'border-rose-500/30 bg-rose-500/10 text-rose-600 dark:text-rose-400',
  refactor: 'border-border bg-muted text-muted-foreground',
  perf: 'border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-400',
  other: 'border-border bg-muted text-muted-foreground',
}

function releaseUrl(version: string): string {
  return `${REPOSITORY_URL}/releases/tag/v${version.replace(/^v+/, '')}`
}

function openRelease(version: string) {
  const url = releaseUrl(version)
  void openUrl(url).catch(() => window.open(url, '_blank'))
}

/** 单个版本段：段头（版本号 + 详情链接）+ 条目列表。 */
function VersionSection({
  entry,
  isLatest,
}: {
  entry: ChangelogEntry
  isLatest: boolean
}) {
  const { t } = useI18n()
  const parsed = useMemo(() => parseNotes(entry.notes), [entry.notes])

  return (
    <section className="space-y-2">
      <div className="flex items-center gap-2">
        <span className="font-semibold text-foreground">{displayVersion(entry.version)}</span>
        {isLatest && (
          <span className="rounded-full border border-primary/30 bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium text-primary">
            {t('dialogs.update.latestBadge')}
          </span>
        )}
        <Tooltip content={t('dialogs.update.viewRelease')}>
          <button
            onClick={() => openRelease(entry.version)}
            className="ml-auto inline-flex shrink-0 items-center gap-1 text-xs text-muted-foreground hover:text-primary"
          >
            {t('dialogs.update.viewDetail')}
            <ExternalLink className="h-2.5 w-2.5" />
          </button>
        </Tooltip>
      </div>

      {parsed ? (
        <ul className="space-y-1.5">
          {parsed.entries.map((item, i) => (
            <li key={i} className="flex items-start gap-2 text-sm leading-relaxed">
              <span
                className={`mt-0.5 shrink-0 rounded border px-1.5 py-0.5 text-[10px] font-medium ${CATEGORY_CLASS[item.category]}`}
              >
                {t(categoryLabelKey(item.category))}
              </span>
              <span className="min-w-0 break-words text-muted-foreground prose prose-sm max-w-none dark:prose-invert [&_p]:inline [&_p]:m-0">
                <Markdown>{item.text}</Markdown>
              </span>
            </li>
          ))}
        </ul>
      ) : (
        // 解析失败（老格式 / 上游改了文案）：退回整段 markdown，最坏情况只是
        // 少了分类标签，不会出现空列表。
        <div className="break-words text-sm leading-relaxed text-muted-foreground prose prose-sm max-w-none dark:prose-invert">
          <Markdown>{entry.notes}</Markdown>
        </div>
      )}
    </section>
  )
}

/**
 * 跨版本更新内容（issue #357）。
 *
 * 按参考设计渲染：最近的 N 个版本逐段列出（段头版本号 + 每条的分类标签），
 * 更早的版本收进「还有 N 个更早的版本」折叠入口。
 *
 * `entries` 为空时**不渲染任何东西**，由调用方退回原来的单块 `changelog`
 * 渲染——这是后端降级的对称实现，两处都不做「空面板」。
 */
export default function UpdateChangelog({
  entries,
  latestVersion,
  hasOlderVersions,
}: Props) {
  const { t } = useI18n()
  const [showOlder, setShowOlder] = useState(false)

  const { visible, older } = splitVisibleVersions(entries)
  const shown = showOlder ? entries : visible
  const olderCount = older.length

  if (entries.length === 0) return null

  return (
    <div className="space-y-4">
      <div className="max-h-72 space-y-4 overflow-y-auto [scrollbar-gutter:stable] rounded-lg bg-background p-3">
        {shown.map((entry) => (
          <VersionSection
            key={entry.version}
            entry={entry}
            isLatest={entry.version === latestVersion}
          />
        ))}

        {olderCount > 0 && (
          <button
            onClick={() => setShowOlder((v) => !v)}
            className="flex w-full items-center gap-1 pt-1 text-xs text-muted-foreground hover:text-foreground"
          >
            {showOlder ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
            {showOlder
              ? t('dialogs.update.hideOlder', { count: olderCount })
              : t('dialogs.update.moreOlder', { count: olderCount })}
          </button>
        )}

        {hasOlderVersions && (
          <p className="pt-1 text-[11px] text-muted-foreground/80">
            {t('dialogs.update.historyTruncated')}
          </p>
        )}
      </div>
    </div>
  )
}
