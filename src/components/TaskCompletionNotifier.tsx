import { useEffect, useRef } from 'react'
import { getTasks, subscribe } from '../stores/downloadStore.ts'
import { useMessageBox } from './ui'
import { useI18n } from '../i18n/index.tsx'

export default function TaskCompletionNotifier() {
  const { notify } = useMessageBox()
  const { t } = useI18n()
  const prevRef = useRef<Map<string, string>>(new Map())

  useEffect(() => {
    return subscribe(() => {
      const tasks = getTasks()
      const prev = prevRef.current
      for (const task of tasks) {
        const old = prev.get(task.id)
        if (old && old !== 'completed' && task.status === 'completed')
          notify(t('tools.notifier.downloadCompleted', { name: task.name }), 'success')
        prev.set(task.id, task.status)
      }
      for (const id of prev.keys()) {
        if (!tasks.some(task => task.id === id)) prev.delete(id)
      }
    })
  }, [notify, t])

  return null
}
