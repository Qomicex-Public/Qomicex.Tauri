import { useEffect, useRef, useState } from 'react'
import { listen } from '@tauri-apps/api/event'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import { faFileArrowDown } from '@fortawesome/free-solid-svg-icons'
import { useMessageBox } from './ui'
import { useI18n } from '../i18n/index.tsx'
import { classifyFile } from '../api/drop-install.ts'
import type { ClassifyFileResult } from '../api/drop-install.ts'
import DropInstallDialog from './DropInstallDialog.tsx'
import type { DropFileItem, DropGroup } from './DropInstallDialog.tsx'

const INSTALLABLE: ReadonlySet<string> = new Set(['modpack', 'mod', 'resourcepack', 'shaderpack'])

export default function GlobalDropInstaller() {
  const { t } = useI18n()
  const { notify } = useMessageBox()
  const [hover, setHover] = useState(false)
  const [group, setGroup] = useState<DropGroup | null>(null)
  const busyRef = useRef(false)

  useEffect(() => {
    const unlisteners: Array<() => void> = []
    listen<boolean>('file-drop-hover', e => {
      if (!busyRef.current) setHover(!!e.payload)
    })
      .then(fn => unlisteners.push(fn))
      .catch(() => {})
    listen<string[]>('file-drop', e => {
      setHover(false)
      if (busyRef.current) return
      const paths = e.payload
      if (!paths?.length) return
      busyRef.current = true
      handleDrop(paths).finally(() => {
        busyRef.current = false
      })
    })
      .then(fn => unlisteners.push(fn))
      .catch(() => {})
    return () => { unlisteners.forEach(fn => fn()) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function handleDrop(paths: string[]) {
    const results = await Promise.all(
      paths.map(async p => {
        try {
          const info: ClassifyFileResult = await classifyFile(p)
          return { ...info, path: p } as DropFileItem
        } catch {
          return null
        }
      }),
    )
    const items = results.filter((r): r is DropFileItem => r !== null)
    if (items.length === 0) {
      notify(t('dialogs.dropInstall.classifyFailed'), 'error')
      return
    }

    const installable = items.filter(i => INSTALLABLE.has(i.fileType) && i.fileType !== 'unknown')
    const unsupported = items.filter(i => i.fileType === 'unknown')
    if (unsupported.length > 0) {
      notify(t('dialogs.dropInstall.unsupportedHint', { names: unsupported.map(u => u.fileName).join(', ') }), 'warning')
    }
    if (installable.length === 0) return

    const kinds = [...new Set(installable.map(i => i.fileType))]
    if (kinds.length > 1) {
      notify(t('dialogs.dropInstall.mixedTypesHint'), 'warning')
      return
    }
    const kind = kinds[0] as DropGroup['kind']
    if (kind === 'modpack') {
      const skipped = installable.slice(1)
      if (skipped.length > 0) {
        notify(t('dialogs.dropInstall.modpackSingleHint', { count: skipped.length }), 'warning')
      }
      setGroup({ kind, files: [installable[0]] })
      return
    }
    setGroup({ kind, files: installable })
  }

  return (
    <>
      {hover && !group && (
        <div className="pointer-events-none fixed inset-0 z-[200] flex items-center justify-center bg-background/70 backdrop-blur-sm">
          <div className="flex flex-col items-center gap-3 rounded-2xl border-2 border-dashed border-primary/60 bg-background/80 px-16 py-12 shadow-2xl">
            <FontAwesomeIcon icon={faFileArrowDown} className="h-10 w-10 text-primary" />
            <span className="text-lg font-semibold text-foreground">{t('dialogs.dropInstall.dropHere')}</span>
            <span className="text-xs text-muted-foreground">{t('dialogs.dropInstall.dropHint')}</span>
          </div>
        </div>
      )}
      <DropInstallDialog group={group} onClose={() => setGroup(null)} />
    </>
  )
}
