import { useCallback, useEffect } from 'react'
import { getTasks, removeTask } from '../stores/downloadStore.ts'
import { useMessageBox } from '../components/ui/message-box.tsx'
import { CloseGuardContext } from './closeGuardContext.ts'

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

  const closeWithGuard = useCallback(async () => {
    if (hasActiveTasks()) {
      const ok = await confirm('还有未完成的任务，关闭后将删除所有任务。\n\n确定要关闭吗？')
      if (!ok) return
      clearActiveTasks()
    }
    try {
      const { getCurrentWindow } = await import('@tauri-apps/api/window')
      await getCurrentWindow().close()
    } catch {
      window.close()
    }
  }, [confirm])

  useEffect(() => {
    let unlisten: (() => void) | undefined
    let mounted = true

    ;(async () => {
      try {
        const { getCurrentWindow } = await import('@tauri-apps/api/window')
        const win = getCurrentWindow()
        unlisten = await win.onCloseRequested(async (event) => {
          if (!hasActiveTasks()) return
          const ok = await confirm('还有未完成的任务，关闭后将删除所有任务。\n\n确定要关闭吗？')
          if (mounted && ok) {
            clearActiveTasks()
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
  }, [confirm])

  return { closeWithGuard, Provider: CloseGuardContext.Provider }
}
