import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import { faBug, faTriangleExclamation, faXmark, faCopy } from '@fortawesome/free-solid-svg-icons'
import { Button } from './ui/button.tsx'

export function ErrorReportDialog({ open, title, message, detail, args, onClose }: {
  open: boolean
  title: string
  message: string
  detail?: string | null
  args?: string | null
  onClose: () => void
}) {
  if (!open) return null

  const copyAll = () => {
    const text = [title, message, detail && `详情:\n${detail}`, args && `参数:\n${args}`].filter(Boolean).join('\n\n')
    navigator.clipboard.writeText(text)
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="w-full max-w-lg rounded-xl border bg-card shadow-2xl">
        <div className="flex items-center justify-between border-b px-5 py-4">
          <div className="flex items-center gap-2">
            <div className="flex h-8 w-8 items-center justify-center rounded-full bg-destructive/10">
              <FontAwesomeIcon icon={faBug} className="h-4 w-4 text-destructive" />
            </div>
            <h2 className="text-sm font-semibold">{title}</h2>
          </div>
          <button onClick={onClose} className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-muted">
            <FontAwesomeIcon icon={faXmark} className="h-4 w-4" />
          </button>
        </div>
        <div className="space-y-3 p-5">
          <div className="flex items-start gap-2 rounded-lg bg-destructive/5 p-3">
            <FontAwesomeIcon icon={faTriangleExclamation} className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
            <p className="text-sm whitespace-pre-wrap break-all">{message}</p>
          </div>
          {detail && (
            <div>
              <p className="mb-1 text-xs font-medium text-muted-foreground">错误详情</p>
              <pre className="max-h-40 overflow-auto rounded-lg bg-muted p-3 text-[11px] leading-relaxed whitespace-pre-wrap break-all">{detail}</pre>
            </div>
          )}
          {args && (
            <div>
              <p className="mb-1 text-xs font-medium text-muted-foreground">启动参数</p>
              <pre className="max-h-28 overflow-auto rounded-lg bg-muted p-3 text-[11px] leading-relaxed whitespace-pre-wrap break-all font-mono">{args}</pre>
            </div>
          )}
        </div>
        <div className="flex items-center justify-end gap-2 border-t px-5 py-3">
          <Button variant="outline" size="sm" onClick={copyAll} className="gap-1.5 h-7 text-xs">
            <FontAwesomeIcon icon={faCopy} className="h-3 w-3" />复制全部
          </Button>
          <Button size="sm" onClick={onClose} className="h-7 text-xs">关闭</Button>
        </div>
      </div>
    </div>
  )
}
