import { Dialog, DialogHeader, DialogTitle, DialogBody, DialogFooter } from '../components/ui'
import { Button } from '../components/ui'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import { faMicrosoft } from '@fortawesome/free-brands-svg-icons'
import { useI18n } from '../i18n/index.tsx'

interface Props {
  open: boolean
  onClose: () => void
  onReauth: () => void
}

export function MicrosoftReauthDialog({ open, onClose, onReauth }: Props) {
  const { t } = useI18n()
  return (
    <Dialog open={open} onClose={onClose} className="max-w-sm">
      <DialogHeader onClose={onClose}>
        <DialogTitle>{t('dialogs.microsoftReauth.title')}</DialogTitle>
      </DialogHeader>
      <DialogBody>
        <p className="text-sm text-muted-foreground">
          {t('dialogs.microsoftReauth.description')}
        </p>
      </DialogBody>
      <DialogFooter>
        <Button variant="secondary" onClick={onClose}>{t('common.cancel')}</Button>
        <Button onClick={onReauth} className="gap-1.5">
          <FontAwesomeIcon icon={faMicrosoft} className="h-4 w-4" />
          {t('dialogs.microsoftReauth.reauth')}
        </Button>
      </DialogFooter>
    </Dialog>
  )
}
