// Copyright (C) 2026 Qomicex Launcher Contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { useCallback, useEffect } from 'react'
import { getTasks, removeTask } from '../stores/downloadStore.ts'
import { useMessageBox } from '../components/ui'
import { useI18n } from '../i18n/index.tsx'
import { CloseGuardContext } from './closeGuardContext.ts'
import { broadcastPluginLifecycle } from '../plugins/sandbox.ts'

// 一次退出流程中 launcher-exit 只广播一次：closeWithGuard 广播后调 close()
// 会再次触发 onCloseRequested（此时已无活动任务又会广播），unload 还有第三次。
// 插件的 onLauncherExit 回调（保存状态/停子进程）重复执行有副作用。
// 用户取消关闭（preventDefault）后重置，允许下次退出再广播。
let exitBroadcasted = false
function broadcastExitOnce() {
  if (exitBroadcasted) return
  exitBroadcasted = true
  broadcastPluginLifecycle('launcher-exit')
}
function resetExitBroadcast() {
  exitBroadcasted = false
}

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
    broadcastExitOnce()
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
            broadcastExitOnce()
            return
          }
          const ok = await confirm(closeConfirmMsg)
          if (mounted && ok) {
            clearActiveTasks()
            broadcastExitOnce()
          } else {
            // 用户取消：重置守卫，下次退出可再广播
            resetExitBroadcast()
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
      broadcastExitOnce()
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
