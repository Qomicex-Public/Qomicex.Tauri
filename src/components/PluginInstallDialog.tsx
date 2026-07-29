import type { PluginManifest } from '../plugins/types.ts'
import { PERMISSION_CATALOG } from '../plugins/types.ts'
import { Dialog, DialogHeader, DialogBody, DialogFooter, DialogTitle, DialogDescription } from './ui/dialog.tsx'
import { Button } from './ui/button.tsx'

interface PluginInstallDialogProps {
  open: boolean
  manifest: PluginManifest | null
  onConfirm: () => void
  onCancel: () => void
}

export function PluginInstallDialog({ open, manifest, onConfirm, onCancel }: PluginInstallDialogProps) {
  if (!manifest) return null

  const dangerPerms = manifest.permissions.filter(p => PERMISSION_CATALOG[p]?.risk === 'danger')
  const warningPerms = manifest.permissions.filter(p => PERMISSION_CATALOG[p]?.risk === 'warning')
  const normalPerms = manifest.permissions.filter(p => PERMISSION_CATALOG[p]?.risk === 'normal')

  return (
    <Dialog open={open} onClose={onCancel}>
      <DialogHeader onClose={onCancel}>
        <DialogTitle>安装插件</DialogTitle>
        <DialogDescription>
          {manifest.name} v{manifest.version}
        </DialogDescription>
      </DialogHeader>

      <DialogBody>
        <div className="space-y-4 py-4">
          <p className="text-sm text-muted-foreground">
            此插件申请以下权限：
          </p>

          {dangerPerms.length > 0 && (
            <div className="space-y-1">
              <p className="text-xs font-medium text-red-400">高危权限</p>
              {dangerPerms.map(p => (
                <p key={p} className="text-sm text-red-400">⚠ {PERMISSION_CATALOG[p]?.label ?? p}</p>
              ))}
            </div>
          )}

          {warningPerms.length > 0 && (
            <div className="space-y-1">
              <p className="text-xs font-medium text-yellow-400">需注意</p>
              {warningPerms.map(p => (
                <p key={p} className="text-sm text-yellow-400">• {PERMISSION_CATALOG[p]?.label ?? p}</p>
              ))}
            </div>
          )}

          {normalPerms.length > 0 && (
            <div className="space-y-1">
              <p className="text-xs font-medium text-muted-foreground">普通</p>
              {normalPerms.map(p => (
                <p key={p} className="text-sm text-muted-foreground">• {PERMISSION_CATALOG[p]?.label ?? p}</p>
              ))}
            </div>
          )}
        </div>
      </DialogBody>

      <DialogFooter>
        <Button variant="outline" onClick={onCancel}>取消</Button>
        <Button onClick={onConfirm}>确认安装</Button>
      </DialogFooter>
    </Dialog>
  )
}
