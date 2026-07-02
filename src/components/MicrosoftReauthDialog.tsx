import { Dialog, DialogHeader, DialogTitle, DialogBody, DialogFooter } from '../components/ui/dialog.tsx'
import { Button } from '../components/ui/button.tsx'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import { faMicrosoft } from '@fortawesome/free-brands-svg-icons'

interface Props {
  open: boolean
  onClose: () => void
  onReauth: () => void
}

export function MicrosoftReauthDialog({ open, onClose, onReauth }: Props) {
  return (
    <Dialog open={open} onClose={onClose} className="max-w-sm">
      <DialogHeader onClose={onClose}>
        <DialogTitle>Microsoft 账户凭证已过期</DialogTitle>
      </DialogHeader>
      <DialogBody>
        <p className="text-sm text-muted-foreground">
          你的 Microsoft 账户凭证已过期，需要重新登录才能启动游戏。
        </p>
      </DialogBody>
      <DialogFooter>
        <Button variant="secondary" onClick={onClose}>取消</Button>
        <Button onClick={onReauth} className="gap-1.5">
          <FontAwesomeIcon icon={faMicrosoft} className="h-4 w-4" />
          重新登录 Microsoft
        </Button>
      </DialogFooter>
    </Dialog>
  )
}
