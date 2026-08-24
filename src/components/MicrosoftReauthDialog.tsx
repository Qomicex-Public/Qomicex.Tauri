import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Dialog, DialogHeader, DialogTitle, DialogBody, DialogFooter } from '../components/ui'
import { Button } from '../components/ui'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import { faMicrosoft } from '@fortawesome/free-brands-svg-icons'
import { useI18n } from '../i18n/index.tsx'
import { deleteAccount } from '../api/account.ts'
import { ApiError } from '../api/client.ts'
import { useMessageBox } from '../components/ui'

interface Props {
  open: boolean
  onClose: () => void
  /** 凭证过期的账号 uuid；若提供则在重新登录前先将其删除，避免过期账号残留。 */
  expiredAccountUuid?: string | null
  /** 自定义重新登录后的行为；不传则跳转到账户页并拉起微软登录流程。 */
  onReauth?: () => void | Promise<void>
}

export function MicrosoftReauthDialog({ open, onClose, expiredAccountUuid, onReauth }: Props) {
  const { t } = useI18n()
  const navigate = useNavigate()
  const { notify } = useMessageBox()
  const [busy, setBusy] = useState(false)

  async function handleReauth() {
    setBusy(true)
    try {
      if (expiredAccountUuid) {
        try {
          await deleteAccount(expiredAccountUuid)
        } catch (e) {
          // 仅当账号已不存在（确认 404）时忽略；其它失败（网络/临时 API 错误）需上报，
          // 避免过期凭据残留并允许添加重复账户。
          if (e instanceof ApiError && e.status === 404) {
            /* 账号已不存在，继续重新登录 */
          } else {
            notify(
              t('dialogs.common.deleteFailed', {
                error: e instanceof ApiError ? e.displayMessage : t('dialogs.common.unknownError'),
              }),
              'error',
            )
            return
          }
        }
      }
      if (onReauth) await onReauth()
      else navigate('/accounts?add=microsoft')
    } finally {
      setBusy(false)
    }
  }

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
        <Button variant="secondary" onClick={onClose} disabled={busy}>{t('common.cancel')}</Button>
        <Button onClick={handleReauth} disabled={busy} className="gap-1.5">
          <FontAwesomeIcon icon={faMicrosoft} className="h-4 w-4" />
          {t('dialogs.microsoftReauth.reauth')}
        </Button>
      </DialogFooter>
    </Dialog>
  )
}
