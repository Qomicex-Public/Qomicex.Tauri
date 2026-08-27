import { Dialog, DialogHeader, DialogTitle, DialogBody, DialogFooter } from '../components/ui'
import { Button } from '../components/ui'
import { Plus, User } from 'lucide-react'
import { useI18n } from '../i18n/index.tsx'

interface Props {
  open: boolean
  onClose: () => void
  onAddAccount: () => void
  onGoToAccounts: () => void
}

export function NoAccountDialog({ open, onClose, onAddAccount, onGoToAccounts }: Props) {
  const { t } = useI18n()
  return (
    <Dialog open={open} onClose={onClose} className="max-w-sm">
      <DialogHeader onClose={onClose}>
        <DialogTitle>{t('dialogs.noAccount.title')}</DialogTitle>
      </DialogHeader>
      <DialogBody>
        <p className="text-sm text-muted-foreground">
          {t('dialogs.noAccount.description')}
        </p>
      </DialogBody>
      <DialogFooter>
        <Button variant="secondary" onClick={onClose}>{t('common.cancel')}</Button>
        <Button variant="outline" onClick={onGoToAccounts} className="gap-1.5">
          <User className="h-3.5 w-3.5" />
          {t('dialogs.noAccount.goToAccounts')}
        </Button>
        <Button onClick={onAddAccount} className="gap-1.5">
          <Plus className="h-3.5 w-3.5" />
          {t('dialogs.noAccount.addAccount')}
        </Button>
      </DialogFooter>
    </Dialog>
  )
}
