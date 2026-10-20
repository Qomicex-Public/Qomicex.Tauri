// Copyright (C) 2026 Qomicex Launcher Contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { useEffect, useState } from 'react'
import { Info } from 'lucide-react'
import { getRegion } from '../api/system.ts'
import { useI18n } from '../i18n/index.tsx'

/**
 * 中国大陆合规提示条。
 *
 * 只在本机区域判定为中国大陆时渲染，境外不出现也不占布局（见 ADR-117）。
 * 判定失败按「不在大陆」处理：这条提示不该因为区域接口异常而打扰用户。
 */
export function ComplianceBanner() {
  const { t } = useI18n()
  const [show, setShow] = useState(false)

  useEffect(() => {
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

  return (
    <div className="flex shrink-0 items-start gap-2 border-b border-border/60 bg-muted/40 px-4 py-2 text-xs text-muted-foreground">
      <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
      <p className="leading-relaxed">{t('compliance.banner')}</p>
    </div>
  )
}
