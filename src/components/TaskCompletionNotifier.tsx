import { useEffect, useRef } from 'react'
import { getTasks, subscribe } from '../stores/downloadStore.ts'
import { useMessageBox } from './ui/message-box.tsx'

export default function TaskCompletionNotifier() {
  const { notify } = useMessageBox()
  const prevRef = useRef<Map<string, string>>(new Map())

  useEffect(() => {
    return subscribe(() => {
      const tasks = getTasks()
      const prev = prevRef.current
      for (const t of tasks) {
        const old = prev.get(t.id)
        if (old && old !== 'completed' && t.status === 'completed')
          notify(`${t.name} 下载完成`, 'success')
        prev.set(t.id, t.status)
      }
      for (const id of prev.keys()) {
        if (!tasks.some(t => t.id === id)) prev.delete(id)
      }
    })
  }, [notify])

  return null
}
