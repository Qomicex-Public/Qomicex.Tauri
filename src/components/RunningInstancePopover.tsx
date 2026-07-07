import { useState, useEffect, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import { faStop } from '@fortawesome/free-solid-svg-icons'
import { useRunning } from '../contexts/RunningContext.tsx'
import { Button } from './ui/button.tsx'

function formatElapsed(startedAt: number, now: number): string {
  const sec = Math.floor((now - startedAt) / 1000)
  if (sec < 60) return `${sec}秒`
  const min = Math.floor(sec / 60)
  if (min < 60) return `${min}分${sec % 60}秒`
  const h = Math.floor(min / 60)
  return `${h}小时${min % 60}分`
}

interface Props {
  open: boolean
  onClose: () => void
  anchorRef: React.RefObject<HTMLElement | null>
}

export default function RunningInstancePopover({ open, onClose, anchorRef }: Props) {
  const { runningInstances, killInstance } = useRunning()
  const navigate = useNavigate()
  const popoverRef = useRef<HTMLDivElement>(null)
  const [now, setNow] = useState(Date.now())

  useEffect(() => {
    if (!open || runningInstances.length === 0) return
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [open, runningInstances.length])

  useEffect(() => {
    if (!open) return
    function handleClick(e: MouseEvent) {
      if (
        popoverRef.current &&
        !popoverRef.current.contains(e.target as Node) &&
        anchorRef.current &&
        !anchorRef.current.contains(e.target as Node)
      ) {
        onClose()
      }
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [open, onClose, anchorRef])

  useEffect(() => {
    if (!open) return
    function handleKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', handleKey)
    return () => document.removeEventListener('keydown', handleKey)
  }, [open, onClose])

  if (!open) return null

  return (
    <div
      ref={popoverRef}
      className="absolute left-full top-0 z-50 ml-2 w-72 rounded-xl border border-border bg-card shadow-2xl shadow-black/30 backdrop-blur-xl"
    >
      <div className="border-b border-border px-4 py-2.5 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
        运行中的游戏
      </div>
      {runningInstances.length === 0 ? (
        <div className="px-4 py-6 text-center text-sm text-muted-foreground">暂无运行中的游戏</div>
      ) : (
        <div className="max-h-60 overflow-y-auto py-1">
          {runningInstances.map(inst => (
            <div
              key={inst.instanceId}
              className="flex items-center gap-3 px-4 py-2.5 hover:bg-accent/50 cursor-pointer transition-colors"
              onClick={() => { navigate(`/instances/${inst.instanceId}`); onClose() }}
            >
              <div className="h-2 w-2 rounded-full bg-green-500 animate-pulse flex-shrink-0" />
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium truncate">{inst.name}</p>
                <p className="text-xs text-muted-foreground">{formatElapsed(inst.startedAt, now)}</p>
              </div>
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8 flex-shrink-0 text-muted-foreground hover:text-destructive"
                onClick={e => { e.stopPropagation(); killInstance(inst.instanceId) }}
              >
                <FontAwesomeIcon icon={faStop} className="h-3.5 w-3.5" />
              </Button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
