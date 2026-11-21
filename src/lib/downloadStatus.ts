// Copyright (C) 2026 Qomicex Launcher Contributors
// SPDX-License-Identifier: GPL-3.0-or-later

/** 任务状态 → 展示配置。进度对账也用它校验后端状态，避免出现未定义的卡片状态。 */
export const STATUS_CONFIG: Record<string, { label: string; color: string }> = {
  queued: { label: 'queued', color: 'text-muted-foreground bg-muted border-border' },
  downloading: { label: 'downloading', color: 'text-blue-400 bg-blue-500/10 border-blue-500/25' },
  paused: { label: 'paused', color: 'text-amber-400 bg-amber-500/10 border-amber-500/25' },
  // 待补全：安装已落地但缺文件，等用户手动补齐（issue #291）。与 paused 同为琥珀色，
  // 但语义不同（后者是用户主动暂停），卡片上用不同文案与操作区分。
  'awaiting-files': { label: 'awaiting-files', color: 'text-amber-400 bg-amber-500/10 border-amber-500/25' },
  completed: { label: 'completed', color: 'text-emerald-400 bg-emerald-500/10 border-emerald-500/25' },
  failed: { label: 'failed', color: 'text-red-400 bg-red-500/10 border-red-500/25' },
  cancelled: { label: 'cancelled', color: 'text-gray-400 bg-gray-500/10 border-gray-500/25' },
}
