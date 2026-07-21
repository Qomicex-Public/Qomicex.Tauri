import { useState, useEffect } from 'react'
import { Dialog, DialogHeader, DialogTitle, DialogBody, DialogFooter } from './ui/dialog.tsx'
import { Input } from './ui/input.tsx'
import { Label } from './ui/label.tsx'
import { Button } from './ui/button.tsx'
import { Tooltip } from './ui/tooltip.tsx'
import { fetchLicenseStatus, activateLicense } from '../api/license.ts'
import type { LicenseStatus } from '../api/license.ts'
import { faKey, faShieldHalved, faCopy, faCheck, faRightFromBracket } from '@fortawesome/free-solid-svg-icons'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import { exit } from '@tauri-apps/plugin-process'

interface Props {
  open: boolean
  onActivated?: () => void
  onClose?: () => void
}

export default function LicenseActivationDialog({ open, onActivated, onClose }: Props) {
  const [token, setToken] = useState('')
  const [machineCode, setMachineCode] = useState('')
  const [licenseStatus, setLicenseStatus] = useState<LicenseStatus | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    if (open) {
      setToken('')
      setError('')
      fetchLicenseStatus().then(s => {
        setMachineCode(s.machineCode || '')
        setLicenseStatus(s)
      }).catch(() => setMachineCode('加载失败'))
    }
  }, [open])

  async function handleActivate() {
    if (!token.trim()) return
    setLoading(true)
    setError('')
    try {
      const res = await activateLicense(token.trim())
      if (res.success) {
        onActivated?.()
      } else {
        setError(res.error || '激活失败')
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : '激活失败')
    } finally {
      setLoading(false)
    }
  }

  return (
    <Dialog open={open} onClose={onClose ?? (() => {})} closeOnBackdrop={!!onClose} closeOnEsc={!!onClose}>
      <DialogHeader onClose={onClose}>
        <DialogTitle>
          <FontAwesomeIcon icon={faShieldHalved} className="mr-2 h-4 w-4 text-primary" />
          激活许可证
        </DialogTitle>
      </DialogHeader>
      <DialogBody className="space-y-4">
        {licenseStatus && licenseStatus.valid && (
          <div className="flex items-center gap-2 rounded-lg border border-primary/20 bg-primary/5 p-3 text-sm text-primary">
            <FontAwesomeIcon icon={faKey} className="h-4 w-4 shrink-0" />
            <div>
              <div className="font-medium">许可证已激活</div>
              {licenseStatus.licenseId && (
                <div className="text-xs text-muted-foreground">
                  ID: {licenseStatus.licenseId}
                  {licenseStatus.expireAt && ` · 过期: ${licenseStatus.isPermanent ? '永久' : licenseStatus.expireAt}`}
                </div>
              )}
            </div>
          </div>
        )}
        <div className="rounded-lg bg-muted p-3 text-sm">
          <div className="flex items-center justify-between">
            <div className="text-xs text-muted-foreground">本机机器码</div>
            <Tooltip content={copied ? '已复制' : '复制机器码'}>
              <Button
                variant="ghost"
                size="sm"
                className="h-6 px-1.5"
                onClick={async () => {
                  if (!machineCode) return
                  await navigator.clipboard.writeText(machineCode)
                  setCopied(true)
                  setTimeout(() => setCopied(false), 2000)
                }}
              >
                <FontAwesomeIcon icon={copied ? faCheck : faCopy} className="h-3 w-3" />
              </Button>
            </Tooltip>
          </div>
          <div className="mt-1 font-mono text-xs break-all select-all">{machineCode || '加载中...'}</div>
        </div>
        <div className="space-y-2">
          <Label>许可证 Token</Label>
          <Input
            value={token}
            onChange={(e) => setToken(e.target.value)}
            placeholder="粘贴管理员提供的许可证 Token..."
            className="font-mono text-sm"
          />
          <p className="text-xs text-muted-foreground">联系管理员获取新许可证 Token。输入后点击激活按钮进行验证。</p>
        </div>
        {error && <p className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p>}
      </DialogBody>
      <DialogFooter>
        {onClose && (
          <Button variant="ghost" onClick={onClose}>关闭</Button>
        )}
        {!onClose && (
          <Button variant="ghost" onClick={() => exit(0)} className="gap-1.5 text-muted-foreground">
            <FontAwesomeIcon icon={faRightFromBracket} className="h-3 w-3" />
            退出启动器
          </Button>
        )}
        <Button onClick={handleActivate} disabled={!token.trim() || loading}>
          {loading ? '验证中...' : '激活'}
        </Button>
      </DialogFooter>
    </Dialog>
  )
}
