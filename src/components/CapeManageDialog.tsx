import { Dialog, DialogHeader, DialogTitle, DialogBody } from './ui'
import { capeDisplayName } from '../lib/cape-names.ts'
import { useI18n } from '../i18n/index.tsx'
import type { McCape } from '../types/index.ts'

interface Props {
  open: boolean
  onClose: () => void
  mcCapes: McCape[]
  capeImages: Map<string, string>
  capeBusy: boolean
  onToggle: (cape: McCape) => void
}

/** 披风管理弹窗（图库式网格：方形缩略图 + 名称 + 选中高亮）。 */
export function CapeManageDialog({ open, onClose, mcCapes, capeImages, capeBusy, onToggle }: Props) {
  const { t, lang } = useI18n()
  return (
    <Dialog open={open} onClose={onClose} className="max-w-lg">
      <DialogHeader onClose={onClose}>
        <DialogTitle>{t('dialogs.cape.title')}</DialogTitle>
      </DialogHeader>
      <DialogBody>
        {mcCapes.length === 0 ? (
          <p className="py-10 text-center text-sm text-muted-foreground">
            {capeBusy ? t('common.loading') : t('dialogs.cape.noCapes')}
          </p>
        ) : (
          <div className="grid grid-cols-3 gap-3 sm:grid-cols-4">
            {mcCapes.map((c) => {
              const active = c.state === 'ACTIVE'
              return (
                <button
                  key={c.id}
                  onClick={() => onToggle(c)}
                  disabled={capeBusy}
                  className={`group relative flex aspect-square flex-col overflow-hidden rounded-xl border bg-muted/40 transition-colors ${active ? 'border-primary ring-2 ring-primary/40' : 'border-input hover:border-primary/50'}`}
                >
                  <div className="flex min-h-0 flex-1 items-center justify-center p-1.5">
                    {capeImages.get(c.id) ? (
                      <img
                        src={capeImages.get(c.id)}
                        alt={capeDisplayName(c.id, c.alias, lang)}
                        className="h-full w-full object-contain"
                      />
                    ) : (
                      <span className="text-[10px] text-muted-foreground">
                        {t('dialogs.cape.loadingShort')}
                      </span>
                    )}
                  </div>
                  <span className="truncate px-1.5 pb-1.5 text-center text-[11px]">
                    {capeDisplayName(c.id, c.alias, lang)}
                  </span>
                  {active && (
                    <span className="absolute right-1.5 top-1.5 rounded-full bg-primary px-1.5 py-0.5 text-[10px] text-primary-foreground">
                      {t('dialogs.cape.inUse')}
                    </span>
                  )}
                  {!active && (
                    <span className="absolute inset-0 flex items-center justify-center bg-black/45 text-xs font-medium text-white opacity-0 transition-opacity group-hover:opacity-100">
                      {t('dialogs.cape.clickToEquip')}
                    </span>
                  )}
                </button>
              )
            })}
          </div>
        )}
      </DialogBody>
    </Dialog>
  )
}
