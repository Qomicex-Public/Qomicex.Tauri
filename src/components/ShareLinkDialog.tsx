// Copyright (C) 2026 Qomicex Launcher Contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { useEffect, useState } from 'react'
import { ExternalLink } from 'lucide-react'
import {
  Button,
  Dialog,
  DialogBody,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  useMessageBox,
} from './ui'
import { CopyActionIcon } from './CopyActionIcon.tsx'
import { useI18n } from '../i18n/index.tsx'

interface Props {
  open: boolean
  onClose: () => void
  title: string
  /** 已生成的分享链接；为空时弹窗只渲染标题（避免打开瞬间闪一个空框）。 */
  url: string
}

/** 分享链接弹窗：展示 + 复制 + 在系统浏览器打开。 */
export function ShareLinkDialog({ open, onClose, title, url }: Props) {
  const { t } = useI18n()
  const { notify } = useMessageBox()
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    if (!copied) return
    const timer = window.setTimeout(() => setCopied(false), 1500)
    return () => window.clearTimeout(timer)
  }, [copied])

  async function copyLink() {
    try {
      await navigator.clipboard.writeText(url)
      setCopied(true)
    } catch {
      notify(t('common.copyFailed'), 'error')
    }
  }

  async function openInBrowser() {
    try {
      const { openUrl } = await import('@tauri-apps/plugin-opener')
      await openUrl(url)
    } catch {
      notify(t('common.openInBrowserFailed'), 'error')
    }
  }

  return (
    <Dialog open={open} onClose={onClose} className="max-w-lg">
      <DialogHeader onClose={onClose}>
        <DialogTitle>{title}</DialogTitle>
      </DialogHeader>
      <DialogBody className="space-y-3">
        <DialogDescription>{t('common.shareLinkHint')}</DialogDescription>
        <code className="block max-h-40 overflow-y-auto break-all rounded-md bg-muted px-3 py-2 text-xs leading-relaxed">
          {url}
        </code>
      </DialogBody>
      <DialogFooter>
        <Button variant="ghost" onClick={openInBrowser}>
          <ExternalLink className="mr-2 h-4 w-4" />
          {t('common.openInBrowser')}
        </Button>
        <Button onClick={() => void copyLink()}>
          <CopyActionIcon copied={copied} className="mr-2 h-4 w-4" />
          {copied ? t('common.copied') : t('common.copyLink')}
        </Button>
      </DialogFooter>
    </Dialog>
  )
}
