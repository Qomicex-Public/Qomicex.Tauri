// Copyright (C) 2026 Qomicex Launcher Contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { useCallback, useEffect } from 'react'
import { getTasks, removeTask } from '../stores/downloadStore.ts'
import { useMessageBox } from '../components/ui'
import { useI18n } from '../i18n/index.tsx'
import { CloseGuardContext } from './closeGuardContext.ts'
import { broadcastPluginLifecycle } from '../plugins/sandbox.ts'

function hasActiveTasks() {
  return getTasks().some(t =>
    t.status === 'queued' || t.status === 'downloading' || t.status === 'paused'
  )
}

function clearActiveTasks() {
  for (const t of getTasks()) {
    if (t.status === 'queued' || t.status === 'downloading' || t.status === 'paused')
      removeTask(t.id)
  }
}

export default function useCloseGuard() {
  const { confirm } = useMessageBox()
  const { t } = useI18n()
  const closeConfirmMsg = t('common.pendingTasksCloseConfirm')

  const closeWithGuard = useCallback(async () => {
    if (hasActiveTasks()) {
      const ok = await confirm(closeConfirmMsg)
      if (!ok) return
      clearActiveTasks()
    }
    // 关窗已成定局：通知插件做同步收尾（onLauncherExit，尽力而为）
    broadcastPluginLifecycle('launcher-exit')
    try {
      const { getCurrentWindow } = await import('@tauri-apps/api/window')
      await getCurrentWindow().close()
    } catch {
      window.close()
    }
  }, [confirm, closeConfirmMsg])

  useEffect(() => {
    let unlisten: (() => void) | undefined
    let mounted = true

    ;(async () => {
      try {
        const { getCurrentWindow } = await import('@tauri-apps/api/window')
        const win = getCurrentWindow()
        unlisten = await win.onCloseRequested(async (event) => {
          if (!hasActiveTasks()) {
            broadcastPluginLifecycle('launcher-exit')
            return
          }
          const ok = await confirm(closeConfirmMsg)
          if (mounted && ok) {
            clearActiveTasks()
            broadcastPluginLifecycle('launcher-exit')
          } else {
            event.preventDefault()
          }
        })
      } catch {
        // browser dev mode: beforeunload fallback
      }
    })()

    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (hasActiveTasks()) {
        e.preventDefault()
        e.returnValue = ''
      }
    }
    const onUnload = () => {
      broadcastPluginLifecycle('launcher-exit')
      clearActiveTasks()
    }

    window.addEventListener('beforeunload', onBeforeUnload)
    window.addEventListener('unload', onUnload)

    return () => {
      mounted = false
      unlisten?.()
      window.removeEventListener('beforeunload', onBeforeUnload)
      window.removeEventListener('unload', onUnload)
    }
  }, [confirm, closeConfirmMsg])

  return { closeWithGuard, Provider: CloseGuardContext.Provider }
}
