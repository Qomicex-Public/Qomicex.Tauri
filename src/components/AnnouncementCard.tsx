// src/components/AnnouncementCard.tsx
import { useEffect, useState } from 'react'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import { faBullhorn, faXmark } from '@fortawesome/free-solid-svg-icons'
import { fetchAnnouncements, dismissAnnouncement } from '../api/announcements.ts'
import { AnnouncementDialog } from './AnnouncementDialog.tsx'
import type { Announcement } from '../api/announcements.ts'

export function AnnouncementCard() {
  const [announcements, setAnnouncements] = useState<Announcement[]>([])
  const [dialogOpen, setDialogOpen] = useState(false)
  const [loaded, setLoaded] = useState(false)

  useEffect(() => {
    fetchAnnouncements().then((data) => {
      setAnnouncements(data)
      setLoaded(true)
    })
  }, [])

  // 未加载完成或无公告时不渲染
  if (!loaded || announcements.length === 0) return null

  const current = announcements[0]

  // 摘要：取 content 前 60 字符，去除 Markdown 标记
  const plainText = current.content.replace(/[#*_`\[\]()>~]/g, '').trim()
  const summary = plainText.length > 60 ? plainText.slice(0, 60) + '…' : plainText

  function handleClose(e: React.MouseEvent) {
    e.stopPropagation()
    dismissAnnouncement(current.id)
    setAnnouncements((prev) => prev.slice(1))
  }

  return (
    <>
      <div
        onClick={() => setDialogOpen(true)}
        className="cursor-pointer rounded-xl border border-border/30 bg-card/70 p-4 backdrop-blur-md transition-colors hover:bg-card/80"
      >
        <div className="flex items-start gap-2">
          <FontAwesomeIcon icon={faBullhorn} className="mt-0.5 h-3.5 w-3.5 shrink-0 text-primary/70" />
          <p className="flex-1 truncate text-sm font-medium">{current.title}</p>
          <button
            onClick={handleClose}
            className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-muted-foreground/50 hover:text-muted-foreground"
          >
            <FontAwesomeIcon icon={faXmark} className="h-3 w-3" />
          </button>
        </div>
        <p className="mt-1.5 truncate text-xs text-muted-foreground">{summary}</p>
      </div>
      <AnnouncementDialog
        open={dialogOpen}
        onClose={() => setDialogOpen(false)}
        announcement={current}
      />
    </>
  )
}
