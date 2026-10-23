// Copyright (C) 2026 Qomicex Launcher Contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { useEffect, useState } from 'react'
import { Info, X } from 'lucide-react'
import { getRegion } from '../api/system.ts'
import { useI18n } from '../i18n/index.tsx'
import { Tooltip } from './ui/index.ts'

/** 关闭状态跨启动保留：用户明确关掉的提示不再重复打扰。 */
const DISMISS_KEY = 'qomicex-compliance-notice-dismissed'

/**
 * 中国大陆合规提示，挂在实例页「下载新版本」步骤顶部（ADR-117）。
 *
 * 只在本机区域判定为中国大陆时渲染，境外不出现也不占布局。
 * 判定失败按「不在大陆」处理：这条提示不该因为区域接口异常而打扰用户。
 */
export function ComplianceNotice() {
  const { t } = useI18n()
  const [show, setShow] = useState(false)

  useEffect(() => {
    if (localStorage.getItem(DISMISS_KEY) === '1') return
    let cancelled = false
    getRegion()
      .then((r) => {
        if (!cancelled && r.chinaMainland) setShow(true)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [])

  if (!show) return null

  const dismiss = () => {
    localStorage.setItem(DISMISS_KEY, '1')
    setShow(false)
  }

  return (
    <div className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-400">
      <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
      <p className="min-w-0 flex-1 leading-relaxed">{t('compliance.banner')}</p>
      <Tooltip content={t('common.close')}>
        <button
          type="button"
          onClick={dismiss}
          aria-label={t('common.close')}
          className="shrink-0 rounded p-0.5 transition-colors hover:bg-amber-500/20"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </Tooltip>
    </div>
  )
}
