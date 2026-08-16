// src/components/AnnouncementDialog.tsx
import ReactMarkdown from 'react-markdown'
import rehypeRaw from 'rehype-raw'
import remarkGfm from 'remark-gfm'
import { Dialog, DialogHeader, DialogTitle, DialogBody, DialogFooter } from './ui'
import { Button } from './ui'
import { useI18n } from '../i18n/index.tsx'
import type { Announcement } from '../api/announcements.ts'

interface AnnouncementDialogProps {
  open: boolean
  onClose: () => void
  announcement: Announcement | null
  onNext?: () => void
  hasNext?: boolean
  onPrev?: () => void
  hasPrev?: boolean
}

export function AnnouncementDialog({ open, onClose, announcement, onNext, hasNext, onPrev, hasPrev }: AnnouncementDialogProps) {
  const { t, lang } = useI18n()
  if (!announcement) return null

  const date = new Date(announcement.createdAt).toLocaleDateString(lang, {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  })

  return (
    <Dialog open={open} onClose={onClose} className="max-w-xl">
      <DialogHeader onClose={onClose}>
        <div>
          <DialogTitle>{announcement.title}</DialogTitle>
          <p className="mt-1 text-xs text-muted-foreground">{date}</p>
        </div>
      </DialogHeader>
      <DialogBody className="max-h-[60vh] overflow-y-auto">
        <article className="prose prose-invert prose-sm max-w-none prose-headings:mt-4 prose-headings:mb-2 prose-headings:font-semibold prose-h1:text-xl prose-h2:text-lg prose-h3:text-base prose-p:my-2 prose-p:leading-7 prose-ul:my-2 prose-ul:list-disc prose-ul:pl-5 prose-ol:my-2 prose-ol:pl-5 prose-li:my-1 prose-strong:text-foreground prose-code:rounded prose-code:bg-background prose-code:px-1 prose-code:py-0.5 prose-code:text-foreground prose-pre:rounded-xl prose-pre:border prose-pre:border-border/60 prose-pre:bg-background prose-a:text-primary hover:prose-a:text-primary/80 prose-blockquote:border-l-primary prose-blockquote:text-muted-foreground break-words">
          <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeRaw]}>
            {announcement.content}
          </ReactMarkdown>
        </article>
      </DialogBody>
      <DialogFooter>
        {hasPrev && onPrev && (
          <Button variant="secondary" onClick={onPrev}>{t('common.prev')}</Button>
        )}
        {hasNext && onNext && (
          <Button variant="secondary" onClick={onNext}>{t('common.next')}</Button>
        )}
        <Button onClick={onClose}>{t('dialogs.announcement.gotIt')}</Button>
      </DialogFooter>
    </Dialog>
  )
}
