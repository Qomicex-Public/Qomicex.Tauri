import type { PluginManifest } from '../plugins/types.ts'
import { PERMISSION_CATALOG } from '../plugins/types.ts'
import { Dialog, DialogHeader, DialogBody, DialogFooter, DialogTitle, DialogDescription } from './ui'
import { Button } from './ui'
import { useI18n } from '../i18n/index.tsx'

interface PluginInstallDialogProps {
  open: boolean
  manifest: PluginManifest | null
  onConfirm: () => void
  onCancel: () => void
}

export function PluginInstallDialog({ open, manifest, onConfirm, onCancel }: PluginInstallDialogProps) {
  const { t } = useI18n()
  if (!manifest) return null

  const dangerPerms = manifest.permissions.filter(p => PERMISSION_CATALOG[p]?.risk === 'danger')
  const warningPerms = manifest.permissions.filter(p => PERMISSION_CATALOG[p]?.risk === 'warning')
  const normalPerms = manifest.permissions.filter(p => PERMISSION_CATALOG[p]?.risk === 'normal')

  return (
    <Dialog open={open} onClose={onCancel}>
      <DialogHeader onClose={onCancel}>
        <DialogTitle>{t('plugins.installTitle')}</DialogTitle>
        <DialogDescription>
          {manifest.name} v{manifest.version}
        </DialogDescription>
      </DialogHeader>

      <DialogBody>
        <div className="space-y-4 py-4">
          <p className="text-sm text-muted-foreground">
            {t('plugins.permissionsRequest')}
          </p>

          {dangerPerms.length > 0 && (
            <div className="space-y-1">
              <p className="text-xs font-medium text-red-400">{t('plugins.highRisk')}</p>
              {dangerPerms.map(p => (
                <p key={p} className="text-sm text-red-400">⚠ {PERMISSION_CATALOG[p]?.key ? t(PERMISSION_CATALOG[p].key) : p}</p>
              ))}
            </div>
          )}

          {warningPerms.length > 0 && (
            <div className="space-y-1">
              <p className="text-xs font-medium text-yellow-400">{t('plugins.caution')}</p>
              {warningPerms.map(p => (
                <p key={p} className="text-sm text-yellow-400">• {PERMISSION_CATALOG[p]?.key ? t(PERMISSION_CATALOG[p].key) : p}</p>
              ))}
            </div>
          )}

          {normalPerms.length > 0 && (
            <div className="space-y-1">
              <p className="text-xs font-medium text-muted-foreground">{t('plugins.normal')}</p>
              {normalPerms.map(p => (
                <p key={p} className="text-sm text-muted-foreground">• {PERMISSION_CATALOG[p]?.key ? t(PERMISSION_CATALOG[p].key) : p}</p>
              ))}
            </div>
          )}
        </div>
      </DialogBody>

      <DialogFooter>
        <Button variant="outline" onClick={onCancel}>{t('plugins.cancel')}</Button>
        <Button onClick={onConfirm}>{t('plugins.confirmInstall')}</Button>
      </DialogFooter>
    </Dialog>
  )
}
