// src/components/LegalDialog.tsx
import ReactMarkdown from 'react-markdown'
import rehypeRaw from 'rehype-raw'
import remarkGfm from 'remark-gfm'
import { Dialog, DialogHeader, DialogTitle, DialogBody, DialogFooter } from './ui'
import { Button } from './ui'
import { COPYRIGHT_NOTICE } from '../constants/credits.ts'

interface LegalDialogProps {
  open: boolean
  onClose: () => void
}

export function LegalDialog({ open, onClose }: LegalDialogProps) {
  return (
    <Dialog open={open} onClose={onClose} className="max-w-xl">
      <DialogHeader onClose={onClose}>
        <DialogTitle>{COPYRIGHT_NOTICE.title}</DialogTitle>
      </DialogHeader>
      <DialogBody className="max-h-[60vh] overflow-y-auto">
        <article className="prose prose-invert prose-sm max-w-none prose-headings:mt-4 prose-headings:mb-2 prose-headings:font-semibold prose-h1:text-xl prose-h2:text-lg prose-h3:text-base prose-p:my-2 prose-p:leading-7 prose-ul:my-2 prose-ul:list-disc prose-ul:pl-5 prose-ol:my-2 prose-ol:pl-5 prose-li:my-1 prose-strong:text-foreground prose-code:rounded prose-code:bg-background prose-code:px-1 prose-code:py-0.5 prose-code:text-foreground prose-pre:rounded-xl prose-pre:border prose-pre:border-border/60 prose-pre:bg-background prose-a:text-primary hover:prose-a:text-primary/80 prose-blockquote:border-l-primary prose-blockquote:text-muted-foreground break-words">
          <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeRaw]}>
            {COPYRIGHT_NOTICE.content}
          </ReactMarkdown>
        </article>
      </DialogBody>
      <DialogFooter>
        <Button onClick={onClose}>关闭</Button>
      </DialogFooter>
    </Dialog>
  )
}
