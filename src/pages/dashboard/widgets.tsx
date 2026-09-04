import { useEffect, useState, useCallback, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { Check, ChevronDown, Megaphone, Play, User, X } from 'lucide-react'
import { cn } from '../../lib/utils.ts'
import { Button } from '../../components/ui'
import { getAccounts, setDefaultAccount } from '../../api/account.ts'
import { getSettings, onSettingsChange } from '../../api/settings.ts'
import { fetchAnnouncements, dismissAnnouncement } from '../../api/announcements.ts'
import { AnnouncementDialog } from '../../components/AnnouncementDialog.tsx'
import type { Announcement } from '../../api/announcements.ts'
import type { Account } from '../../types/index.ts'
import { AccountAvatar } from '../../components/AccountAvatar.tsx'
import { getAccountIcon, getAccountTypeLabel } from '../../components/AccountType.tsx'
import { InstanceIcon } from '../../components/InstanceIcon.tsx'
import { useI18n } from '../../i18n/index.tsx'
import { useDashboard, useWidgetSize } from './context.tsx'

export function WatermarkWidget() {
  const { t } = useI18n()
  const { h } = useWidgetSize()
  const [watermarkEnabled, setWatermarkEnabled] = useState(true)
  const [watermarkText, setWatermarkText] = useState('Qomicex')
  const [watermarkSubtext, setWatermarkSubtext] = useState(() => t('settings.appearance.watermarkSubtextPlaceholder'))

  useEffect(() => {
    function load(s = getSettings()) {
      setWatermarkEnabled(s.watermarkEnabled !== false)
      setWatermarkText(s.watermarkText || 'Qomicex')
      setWatermarkSubtext(s.watermarkSubtext || t('settings.appearance.watermarkSubtextPlaceholder'))
    }
    load()
    return onSettingsChange(load)
  }, [t])

  if (!watermarkEnabled) return null

  if (h < 2) {
    return (
      <div className="flex h-full select-none items-center justify-center gap-3">
        <span className="text-2xl font-bold tracking-widest text-foreground/90">{watermarkText}</span>
        <span className="text-xs font-semibold tracking-[0.3em] text-primary/60">{watermarkSubtext}</span>
      </div>
    )
  }

  return (
    <div className="flex h-full select-none flex-col items-center justify-center">
      <h1 className={cn('font-bold tracking-widest text-foreground/90', h >= 3 ? 'text-7xl' : 'text-6xl')}>{watermarkText}</h1>
      <p className="mt-2 text-xs font-semibold tracking-[0.5em] text-primary/60">{watermarkSubtext}</p>
    </div>
  )
}

export function AccountWidget() {
  const navigate = useNavigate()
  const { t } = useI18n()
  const { defaultAccount, refresh } = useDashboard()
  const { h } = useWidgetSize()
  const [allAccounts, setAllAccounts] = useState<Account[]>([])
  const [accountsOpen, setAccountsOpen] = useState(false)
  const accountRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (accountRef.current && !accountRef.current.contains(e.target as Node)) setAccountsOpen(false)
    }
    if (accountsOpen) document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [accountsOpen])

  const openAccountDropdown = useCallback(async () => {
    if (accountsOpen) { setAccountsOpen(false); return }
    try {
      const list = await getAccounts()
      setAllAccounts(list)
      setAccountsOpen(true)
    } catch { /* ignore */ }
  }, [accountsOpen])

  async function handleSwitchAccount(uuid: string) {
    try {
      await setDefaultAccount(uuid)
      refresh()
      setAccountsOpen(false)
    } catch { /* ignore */ }
  }

  return (
    <div className={cn(
      'glass-surface relative flex h-full flex-col rounded-xl border border-border/30 bg-card/70 backdrop-blur-md',
      h > 1 ? 'p-4' : 'justify-center px-3',
    )}>
      {h > 1 && <p className="mb-3 text-[10px] font-semibold uppercase tracking-widest text-muted-foreground/60">{t('dashboard.account')}</p>}
      <div ref={accountRef} className="flex items-center gap-3">
        {defaultAccount ? (
          <AccountAvatar account={defaultAccount} className={cn('shrink-0', h > 1 ? 'h-9 w-9' : 'h-8 w-8')} />
        ) : (
          <div className={cn('flex shrink-0 items-center justify-center rounded-full bg-muted', h > 1 ? 'h-9 w-9' : 'h-8 w-8')}>
            <User className="h-4 w-4 text-muted-foreground" />
          </div>
        )}
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium">{defaultAccount ? defaultAccount.name : t('dashboard.noDefaultAccount')}</p>
          {h > 1 && <p className="text-[10px] text-muted-foreground/60">{defaultAccount ? t('dashboard.defaultAccount') : t('dashboard.addInSettings')}</p>}
        </div>
        <Button variant="ghost" size="sm" onClick={openAccountDropdown} className="h-6 w-6 shrink-0 p-0">
          <ChevronDown className={cn('h-3 w-3 transition-transform duration-200', accountsOpen && 'rotate-180')} />
        </Button>
      </div>
      {accountsOpen && (
        <div className="no-drag absolute right-2 top-full z-50 mt-1 w-56 rounded-lg border bg-popover p-1 shadow-lg animate-in fade-in slide-in-from-top-2 zoom-in-95 duration-200">
          <div className="max-h-60 overflow-y-auto">
            {allAccounts.map((acc) => {
              const isDefault = acc.uuid === defaultAccount?.uuid
              const icon = getAccountIcon(acc.loginMethod)
              return (
                <button
                  key={acc.uuid}
                  onMouseDown={() => handleSwitchAccount(acc.uuid)}
                  className="flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left text-xs hover:bg-accent transition-colors"
                >
                  <AccountAvatar account={acc} className="h-6 w-6 shrink-0" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate">{acc.name}</span>
                    <span className="flex items-center gap-1 text-[10px] leading-none text-muted-foreground">
                      <span className={cn('flex h-3 w-3 shrink-0 items-center justify-center', icon.color)}>{icon.icon}</span>
                      {getAccountTypeLabel(acc.loginMethod, t)}
                    </span>
                  </span>
                  {isDefault && <Check className="h-3 w-3 shrink-0 text-primary" />}
                </button>
              )
            })}
          </div>
          <div className="mt-1 border-t border-border pt-1">
            <button
              onMouseDown={() => navigate('/accounts')}
              className="flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left text-xs text-muted-foreground hover:bg-accent transition-colors"
            >
              <User className="h-3 w-3" />
              {t('dashboard.manageAccounts')}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

export function InstanceWidget() {
  const navigate = useNavigate()
  const { t, lang } = useI18n()
  const { defaultInstance, launch } = useDashboard()
  const { w, h } = useWidgetSize()
  const compact = h < 2

  return (
    <div className={cn('glass-surface flex h-full items-center justify-between gap-4 rounded-xl border border-border/30 bg-card/70 backdrop-blur-md', compact ? 'px-4' : 'px-6')}>
      <div className="flex min-w-0 items-center gap-4">
        <InstanceIcon icon={defaultInstance?.icon} iconData={defaultInstance?.iconData} loader={defaultInstance?.loader} className={cn('shrink-0 rounded-xl', compact ? 'h-10 w-10' : 'h-12 w-12')} imgClassName="rounded-xl" />
        {defaultInstance ? (
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <button onClick={() => navigate(`/instances/${defaultInstance.id}`)} className="truncate text-base font-semibold hover:underline">
                {defaultInstance.name}
              </button>
              <span className="shrink-0 rounded bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium text-primary">
                {defaultInstance.loader || 'Vanilla'}
              </span>
            </div>
            {compact ? (
              <p className="mt-0.5 truncate text-xs text-muted-foreground/70">{defaultInstance.gameVersion}</p>
            ) : (
              <p className="mt-0.5 truncate text-xs text-muted-foreground/70">
                {defaultInstance.gameVersion}
                {defaultInstance.loader && ` · ${defaultInstance.loader} ${defaultInstance.loaderVersion}`}
                {defaultInstance.lastPlayed && ` · ${t('dashboard.lastPlayed', { date: new Date(defaultInstance.lastPlayed).toLocaleDateString(lang) })}`}
              </p>
            )}
          </div>
        ) : (
          <div className="min-w-0">
            <p className="truncate text-sm font-medium text-muted-foreground">{t('dashboard.noPinnedInstance')}</p>
            <button onClick={() => navigate('/instances')} className="text-xs text-muted-foreground/70 hover:text-foreground hover:underline">
              {t('dashboard.goToInstances')}
            </button>
          </div>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-4">
        {!compact && w >= 4 && (
          <div className="hidden text-right md:block">
            <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/60">{t('dashboard.status')}</p>
            <p className="text-sm text-muted-foreground">{t('dashboard.ready')}</p>
          </div>
        )}
        <Button
          onClick={() => defaultInstance && launch(defaultInstance)}
          disabled={!defaultInstance}
          className={cn('flex items-center gap-2 rounded-xl font-bold tracking-widest transition-all hover:brightness-110 active:scale-95', compact ? 'h-10 px-5 text-sm' : 'h-14 gap-3 px-10 text-lg')}
        >
          <Play className={compact ? 'h-4 w-4' : 'h-5 w-5'} />
          {t('dashboard.launch')}
        </Button>
      </div>
    </div>
  )
}

export function AnnouncementWidget() {
  const { h } = useWidgetSize()
  const [announcements, setAnnouncements] = useState<Announcement[]>([])
  const [index, setIndex] = useState(0)
  const [dialogOpen, setDialogOpen] = useState(false)
  const [loaded, setLoaded] = useState(false)

  useEffect(() => {
    fetchAnnouncements().then((data) => {
      setAnnouncements(data)
      setLoaded(true)
    })
  }, [])

  if (!loaded || announcements.length === 0) return null

  const current = announcements[index]
  const plainText = current.content.replace(/[#*_`\[\]()>~]/g, '').trim()
  const summary = plainText.length > 60 ? plainText.slice(0, 60) + '…' : plainText

  function handleClose(e: React.MouseEvent) {
    e.stopPropagation()
    dismissAnnouncement(current.id)
    const next = announcements.filter((a) => a.id !== current.id)
    setAnnouncements(next)
    setIndex((i) => Math.min(i, next.length - 1))
  }

  function handleNext() {
    setIndex((i) => Math.min(i + 1, announcements.length - 1))
  }

  function handlePrev() {
    setIndex((i) => Math.max(i - 1, 0))
  }

  return (
    <>
      <div
        onClick={() => setDialogOpen(true)}
        className={cn(
          'glass-surface flex h-full cursor-pointer flex-col rounded-xl border border-border/30 bg-card/70 backdrop-blur-md transition-colors hover:bg-card/80',
          h > 1 ? 'p-4' : 'justify-center px-4 py-2',
        )}
      >
        <div className="flex items-start gap-2">
          <Megaphone className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          <p className="min-w-0 flex-1 truncate text-sm font-medium">{current.title}</p>
          <button
            onClick={handleClose}
            className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-muted-foreground/50 hover:text-muted-foreground"
          >
            <X className="h-3 w-3" />
          </button>
        </div>
        {h > 1 && <p className="mt-1.5 line-clamp-3 text-xs text-muted-foreground">{summary}</p>}
      </div>
      <AnnouncementDialog
        open={dialogOpen}
        onClose={() => setDialogOpen(false)}
        announcement={current}
        onNext={handleNext}
        hasNext={index < announcements.length - 1}
        onPrev={handlePrev}
        hasPrev={index > 0}
      />
    </>
  )
}
