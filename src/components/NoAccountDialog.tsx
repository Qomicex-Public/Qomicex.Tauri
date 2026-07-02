import { Dialog, DialogHeader, DialogTitle, DialogBody, DialogFooter } from '../components/ui/dialog.tsx'
import { Button } from '../components/ui/button.tsx'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import { faUser, faPlus } from '@fortawesome/free-solid-svg-icons'

interface Props {
  open: boolean
  onClose: () => void
  onAddAccount: () => void
  onGoToAccounts: () => void
}

export function NoAccountDialog({ open, onClose, onAddAccount, onGoToAccounts }: Props) {
  return (
    <Dialog open={open} onClose={onClose} className="max-w-sm">
      <DialogHeader onClose={onClose}>
        <DialogTitle>尚未设置账户</DialogTitle>
      </DialogHeader>
      <DialogBody>
        <p className="text-sm text-muted-foreground">
          启动游戏需要一个 Minecraft 账户，请先添加账户。
        </p>
      </DialogBody>
      <DialogFooter>
        <Button variant="secondary" onClick={onClose}>取消</Button>
        <Button variant="outline" onClick={onGoToAccounts} className="gap-1.5">
          <FontAwesomeIcon icon={faUser} className="h-3.5 w-3.5" />
          去账户管理
        </Button>
        <Button onClick={onAddAccount} className="gap-1.5">
          <FontAwesomeIcon icon={faPlus} className="h-3.5 w-3.5" />
          添加账户
        </Button>
      </DialogFooter>
    </Dialog>
  )
}
