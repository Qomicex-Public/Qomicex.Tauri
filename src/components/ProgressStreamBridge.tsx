// Copyright (C) 2026 Qomicex Launcher Contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { useEffect, useRef } from 'react'
import { useI18n } from '../i18n/index.tsx'
import { startProgressSync } from '../lib/progressSync.ts'

/**
 * 全局进度流宿主：App 级挂载一次。
 *
 * 流的所有权上移到 App 后，离开下载中心仍会对账任务进度；页面只订阅 downloadStore。
 * `t` 走 ref：语言切换不该重连流。
 */
export default function ProgressStreamBridge() {
  const { t } = useI18n()
  const tRef = useRef(t)
  tRef.current = t

  useEffect(() => startProgressSync((key) => tRef.current(key)), [])
  return null
}
