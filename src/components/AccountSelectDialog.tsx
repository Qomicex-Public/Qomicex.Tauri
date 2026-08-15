import { useState, useEffect } from 'react'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import { faStar, faUser } from '@fortawesome/free-solid-svg-icons'
import { Dialog, DialogHeader, DialogTitle, DialogBody, DialogFooter } from '../components/ui'
import { Button } from '../components/ui'
import { AccountAvatar } from '../components/AccountAvatar.tsx'
import * as accountApi from '../api/account.ts'
import { useI18n } from '../i18n/index.tsx'
import type { Account } from '../types/index.ts'

interface Props {
  open: boolean
  onClose: () => void
  onSelect: (account: Account) => void
}

export function AccountSelectDialog({ open, onClose, onSelect }: Props) {
  const { t } = useI18n()
  const [accounts, setAccounts] = useState<Account[]>([])
  const [selectedUuid, setSelectedUuid] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    async function load() {
      try {
        const list = await accountApi.getAccounts()
        setAccounts(list)
        const def = list.find(a => a.isDefault)
        setSelectedUuid(def?.uuid ?? null)
      } catch { /* ignore */ }
      finally { setLoading(false) }
    }
    load()
  }, [])

  const handleConfirm = async () => {
    if (!selectedUuid) return
    try {
      await accountApi.setDefaultAccount(selectedUuid)
      const acc = accounts.find(a => a.uuid === selectedUuid)
      if (acc) onSelect(acc)
    } catch { /* ignore */ }
    onClose()
  }

  return (
    <Dialog open={open} onClose={onClose} className="max-w-sm">
      <DialogHeader onClose={onClose}>
        <DialogTitle>{t('dialogs.accountSelect.title')}</DialogTitle>
      </DialogHeader>
      <DialogBody>
        <p className="mb-4 text-xs text-muted-foreground">{t('dialogs.accountSelect.description')}</p>
        {loading ? (
          <div className="py-8 text-center text-sm text-muted-foreground">{t('common.loading')}</div>
        ) : accounts.length === 0 ? (
          <div className="py-8 text-center text-sm text-muted-foreground">{t('dialogs.accountSelect.noAccounts')}</div>
        ) : (
          <div className="space-y-1.5 max-h-60 overflow-y-auto">
            {accounts.map((acc) => {
              const isSelected = acc.uuid === selectedUuid
              return (
                <button
                  key={acc.uuid}
                  onClick={() => setSelectedUuid(acc.uuid)}
                  className={cn(
                    'flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left transition-colors',
                    isSelected ? 'bg-primary/10 ring-1 ring-primary/30' : 'hover:bg-accent'
                  )}
                >
                  <AccountAvatar account={acc} className="h-9 w-9 shrink-0" />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium">{acc.name}</div>
                    <div className="flex items-center gap-1">
                      <FontAwesomeIcon icon={acc.loginMethod === 'Microsoft' ? faStar : faUser} className="h-2 w-2 text-muted-foreground" />
                      <span className="text-[10px] text-muted-foreground">{acc.loginMethod}</span>
                    </div>
                  </div>
                  {isSelected && (
                    <FontAwesomeIcon icon={faStar} className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                  )}
                </button>
              )
            })}
          </div>
        )}
      </DialogBody>
      <DialogFooter>
        <Button variant="secondary" onClick={onClose}>{t('common.cancel')}</Button>
        <Button onClick={handleConfirm} disabled={!selectedUuid || loading}>
          {t('common.confirm')}
        </Button>
      </DialogFooter>
    </Dialog>
  )
}

function cn(...classes: (string | boolean | undefined | null)[]): string { return classes.filter(Boolean).join(' ') }
