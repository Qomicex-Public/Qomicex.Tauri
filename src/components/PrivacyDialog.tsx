import ReactMarkdown from 'react-markdown'
import rehypeRaw from 'rehype-raw'
import remarkGfm from 'remark-gfm'
import { Dialog, DialogHeader, DialogTitle, DialogBody, DialogFooter } from './ui'
import { Button } from './ui'
import { useI18n } from '../i18n/index.tsx'

interface PrivacyDialogProps {
  open: boolean
  onClose: () => void
}

export function PrivacyDialog({ open, onClose }: PrivacyDialogProps) {
  const { t } = useI18n()
  return (
    <Dialog open={open} onClose={onClose} className="max-w-2xl">
      <DialogHeader onClose={onClose}>
        <DialogTitle>{t('dialogs.privacy.title')}</DialogTitle>
      </DialogHeader>
      <DialogBody className="max-h-[70vh] overflow-y-auto">
        <article className="prose prose-invert prose-sm max-w-none prose-headings:mt-6 prose-headings:mb-3 prose-headings:font-bold prose-headings:text-primary prose-h1:text-2xl prose-h2:text-lg prose-h3:text-base prose-p:my-3 prose-p:leading-relaxed prose-ul:my-2 prose-ul:list-disc prose-ul:pl-5 prose-ol:my-2 prose-ol:pl-5 prose-li:my-1.5 prose-strong:text-foreground prose-code:rounded prose-code:bg-background prose-code:px-1 prose-code:py-0.5 prose-code:text-foreground prose-pre:rounded-xl prose-pre:border prose-pre:border-border/60 prose-pre:bg-background prose-a:text-primary hover:prose-a:text-primary/80 prose-blockquote:border-l-primary prose-blockquote:text-muted-foreground break-words">
          <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeRaw]}>
            {t('dialogs.privacy.content')}
          </ReactMarkdown>
        </article>
      </DialogBody>
      <DialogFooter>
        <Button onClick={onClose}>{t('common.close')}</Button>
      </DialogFooter>
    </Dialog>
  )
}
