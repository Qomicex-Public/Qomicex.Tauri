// Copyright (C) 2026 Qomicex Launcher Contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { useEffect, useLayoutEffect, useRef } from 'react'
import { useI18n } from '../i18n/index.tsx'
import { startProgressSync } from '../lib/progressSync.ts'

/**
 * 全局进度流宿主：App 级挂载一次。
 *
 * 流的所有权上移到 App 后，离开下载中心仍会对账任务进度；页面只订阅 downloadStore。
 * `t` 走 ref：语言切换不该重连流；ref 在提交阶段更新，避免被放弃的渲染把未提交的
 * 语言交给已在运行的 SSE 回调。
 */
export default function ProgressStreamBridge() {
  const { t } = useI18n()
  const tRef = useRef(t)
  useLayoutEffect(() => { tRef.current = t }, [t])

  useEffect(() => startProgressSync((key) => tRef.current(key)), [])
  return null
}
