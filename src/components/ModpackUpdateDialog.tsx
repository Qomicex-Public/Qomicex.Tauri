import { useEffect, useState } from 'react'
import { RotateCw, AlertTriangle, ChevronDown, ChevronRight } from 'lucide-react'
import { Dialog, DialogHeader, DialogTitle, DialogBody, DialogFooter } from './ui'
import { Button } from './ui'
import { Checkbox } from './ui'
import { Separator } from './ui'
import { checkModpackUpdate, previewModpackUpdate, startModpackUpdate } from '../api/instance.ts'
import { ApiError } from '../api/client.ts'
import { addTask } from '../stores/downloadStore.ts'
import { useI18n } from '../i18n/index.tsx'
import { cn } from './ui'
import type {
  ModpackUpdateCheck,
  ModpackUpdateCandidate,
  ModpackUpdatePreview,
  ModpackNotEligibleReason,
} from '../types/index.ts'

interface ModpackUpdateDialogProps {
  open: boolean
  onClose: () => void
  instanceId: string
  instanceName: string
  onDone: () => void
}

/** 不可更新原因码 → i18n key（后端只给码，文案在前端）。 */
const REASON_KEY: Record<ModpackNotEligibleReason, string> = {
  NOT_RESOURCE_CENTER: 'dialogs.modpackUpdate.reason.notResourceCenter',
  UNSUPPORTED_SOURCE: 'dialogs.modpackUpdate.reason.unsupportedSource',
  MISSING_IDENTITY: 'dialogs.modpackUpdate.reason.missingIdentity',
  NOT_VERSION_ISOLATED: 'dialogs.modpackUpdate.reason.notVersionIsolated',
  MISSING_MANIFEST: 'dialogs.modpackUpdate.reason.missingManifest',
}

type Step = 'checking' | 'select' | 'preview'

/**
 * 整合包原地更新对话框（issue #118）。
 *
 * 四步：检查 → 选版本 → 预览变更 → 风险确认后开始更新。
 * 变更预览与风险确认是刻意强制的：更新会覆盖用户改过的整合包文件，
 * 且跨版本更新可能损坏存档，不能让用户一键无感触发。
 */
export default function ModpackUpdateDialog({ open, onClose, instanceId, instanceName, onDone }: ModpackUpdateDialogProps) {
  const { t } = useI18n()
  const [step, setStep] = useState<Step>('checking')
  const [check, setCheck] = useState<ModpackUpdateCheck | null>(null)
  const [error, setError] = useState('')
  const [selected, setSelected] = useState<ModpackUpdateCandidate | null>(null)
  const [preview, setPreview] = useState<ModpackUpdatePreview | null>(null)
  const [previewLoading, setPreviewLoading] = useState(false)
  const [riskAccepted, setRiskAccepted] = useState(false)
  const [starting, setStarting] = useState(false)
  const [showRemoved, setShowRemoved] = useState(false)
  const [showModified, setShowModified] = useState(false)

  useEffect(() => {
    if (!open) return
    setStep('checking')
    setCheck(null)
    setError('')
    setSelected(null)
    setPreview(null)
    setRiskAccepted(false)
    setStarting(false)
    setShowRemoved(false)
    setShowModified(false)
    let cancelled = false
    ;(async () => {
      try {
        const res = await checkModpackUpdate(instanceId)
        if (cancelled) return
        setCheck(res)
        // 只有一个候选时直接预选，减少一次点击。
        if (res.eligible && res.updates.length === 1) setSelected(res.updates[0])
        setStep('select')
      } catch (e) {
        if (cancelled) return
        setError(e instanceof ApiError ? e.displayMessage : t('dialogs.modpackUpdate.checkFailed'))
        setStep('select')
      }
    })()
    return () => { cancelled = true }
  }, [open, instanceId, t])

  /** 选中版本后拉取变更预览（进入预览步）。 */
  const handleSelectVersion = async (v: ModpackUpdateCandidate) => {
    setSelected(v)
    setPreview(null)
    setPreviewLoading(true)
    setRiskAccepted(false)
    setError('')
    setStep('preview')
    try {
      const p = await previewModpackUpdate(instanceId, v.versionId)
      setPreview(p)
    } catch (e) {
      setError(e instanceof ApiError ? e.displayMessage : t('dialogs.modpackUpdate.previewFailed'))
    } finally {
      setPreviewLoading(false)
    }
  }

  const handleStart = async () => {
    if (!selected) return
    setStarting(true)
    setError('')
    try {
      await startModpackUpdate(instanceId, selected.versionId)
      // 登记到下载中心：后端把进度经 install tracker / SSE 下发。
      //
      // `id` 必须与安装任务区分：安装任务用裸 instanceId 作 id，若这里也沿用，
      // 同一实例「先安装、后更新」就会产生两个同 id 任务 → React 列表 key 冲突
      // （count 报 "Encountered two children with the same key"）。
      // 注意 `instanceId` 字段仍是裸 id —— 进度同步与取消都按它匹配，
      // `id` 只作 store 索引与 React key。
      addTask({
        id: `modpack-update-${instanceId}`,
        name: instanceName,
        type: 'modpack-update',
        gameVersion: selected.gameVersions[0] || '',
        loader: selected.loaders[0] || undefined,
        status: 'downloading',
        progress: 0,
        createdAt: new Date().toISOString(),
        instanceId,
      })
      onDone()
      onClose()
    } catch (e) {
      setError(e instanceof ApiError ? e.displayMessage : t('dialogs.modpackUpdate.updateFailed'))
    } finally {
      setStarting(false)
    }
  }

  const totalChanges = preview
    ? preview.added.length + preview.updated.length + preview.locallyModified.length + preview.removed.length
    : 0

  return (
    <Dialog open={open} onClose={() => { if (!starting) onClose() }}>
      <DialogHeader onClose={() => { if (!starting) onClose() }}>
        <DialogTitle>{t('dialogs.modpackUpdate.title')}</DialogTitle>
      </DialogHeader>

      <DialogBody className="space-y-4">
        {/* ① 检查中 */}
        {step === 'checking' && (
          <div className="flex items-center justify-center gap-2 py-8 text-sm text-muted-foreground">
            <RotateCw className="h-4 w-4 animate-spin" />
            {t('dialogs.modpackUpdate.checking')}
          </div>
        )}

        {/* ② 选版本 */}
        {step === 'select' && (
          <>
            {error && <p className="text-destructive text-sm">{error}</p>}
            {!error && check && !check.eligible && (
              <p className="py-4 text-center text-sm text-muted-foreground">
                {check.reason ? t(REASON_KEY[check.reason]) : t('dialogs.modpackUpdate.notEligible')}
              </p>
            )}
            {!error && check?.eligible && check.updates.length === 0 && (
              <p className="py-4 text-center text-sm text-muted-foreground">
                {t('dialogs.modpackUpdate.upToDate')}
              </p>
            )}
            {/* 列表不完整时「没有更新」不可信，必须如实提示 */}
            {!error && check?.incomplete && (
              <p className="flex items-start gap-2 rounded-md bg-amber-500/10 p-2 text-xs text-amber-600 dark:text-amber-400">
                <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                {t('dialogs.modpackUpdate.incomplete')}
              </p>
            )}
            {!error && check?.eligible && check.updates.length > 0 && (
              <div className="max-h-80 space-y-1 overflow-y-auto">
                {check.updates.map((v) => (
                  <button
                    key={v.versionId}
                    onClick={() => handleSelectVersion(v)}
                    className="flex w-full items-start gap-3 rounded-md px-3 py-2 text-left text-sm transition-colors hover:bg-accent/50"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="truncate font-medium">{v.name}</div>
                      <div className="text-xs text-muted-foreground">
                        {v.publishedAt ? new Date(v.publishedAt).toLocaleDateString() : ''}
                        {v.gameVersions.length > 0 && ` · MC ${v.gameVersions.join(', ')}`}
                      </div>
                      {/* 跨 MC / 加载器版本必须显式标记（issue #118 决策：允许但强警告） */}
                      {(v.changesGameVersion || v.changesLoader) && (
                        <div className="mt-1 flex flex-wrap items-center gap-1.5">
                          {v.changesGameVersion && (
                            <span className="inline-flex items-center gap-1 rounded bg-destructive/10 px-1.5 py-0.5 text-[10px] font-medium text-destructive">
                              <AlertTriangle className="h-3 w-3" />
                              {t('dialogs.modpackUpdate.gameVersionChanged')}
                            </span>
                          )}
                          {v.changesLoader && (
                            <span className="inline-flex items-center gap-1 rounded bg-destructive/10 px-1.5 py-0.5 text-[10px] font-medium text-destructive">
                              <AlertTriangle className="h-3 w-3" />
                              {t('dialogs.modpackUpdate.loaderChanged')}
                            </span>
                          )}
                        </div>
                      )}
                    </div>
                  </button>
                ))}
              </div>
            )}
          </>
        )}

        {/* ③ 预览变更 + ④ 风险确认 */}
        {step === 'preview' && (
          <>
            {previewLoading && (
              <div className="flex items-center justify-center gap-2 py-8 text-sm text-muted-foreground">
                <RotateCw className="h-4 w-4 animate-spin" />
                {t('dialogs.modpackUpdate.checking')}
              </div>
            )}
            {!previewLoading && error && <p className="text-destructive text-sm">{error}</p>}
            {!previewLoading && !error && preview && (
              <>
                <div>
                  <p className="mb-2 text-sm font-medium">{t('dialogs.modpackUpdate.preview.title')}</p>
                  <div className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-4">
                    {[
                      ['added', t('dialogs.modpackUpdate.preview.added'), preview.added.length, 'text-emerald-500'],
                      ['updated', t('dialogs.modpackUpdate.preview.updated'), preview.updated.length, 'text-primary'],
                      ['modified', t('dialogs.modpackUpdate.preview.locallyModified'), preview.locallyModified.length, 'text-amber-500'],
                      ['removed', t('dialogs.modpackUpdate.preview.removed'), preview.removed.length, 'text-destructive'],
                    ].map(([, label, count, cls]) => (
                      <div key={String(label)} className="rounded-md border p-2">
                        <div className={cn('text-lg font-semibold', String(cls))}>{String(count)}</div>
                        <div className="text-[11px] leading-tight text-muted-foreground">{String(label)}</div>
                      </div>
                    ))}
                  </div>
                  {totalChanges === 0 && (
                    <p className="mt-2 text-xs text-muted-foreground">{t('dialogs.modpackUpdate.preview.none')}</p>
                  )}
                </div>

                {/* 保留项：新包已移除但用户改过 → 不会被删除，需让用户知道 */}
                {preview.keptModified.length > 0 && (
                  <p className="text-xs text-muted-foreground">
                    {t('dialogs.modpackUpdate.preview.keptModified')}: {preview.keptModified.length}
                  </p>
                )}

                {/* 可展开：本地已修改（先备份再覆盖） */}
                {preview.locallyModified.length > 0 && (
                  <div className="rounded-md border">
                    <button
                      onClick={() => setShowModified((v) => !v)}
                      className="flex w-full items-center gap-1.5 px-2 py-1.5 text-left text-xs font-medium hover:bg-accent/40"
                    >
                      {showModified ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
                      {t('dialogs.modpackUpdate.preview.locallyModified')} ({preview.locallyModified.length})
                    </button>
                    {showModified && (
                      <div className="max-h-40 overflow-y-auto border-t px-2 py-1">
                        {preview.locallyModified.map((e) => (
                          <div key={e.path} className="truncate py-0.5 font-mono text-[11px] text-muted-foreground">{e.path}</div>
                        ))}
                      </div>
                    )}
                  </div>
                )}

                {/* 可展开：将被删除的文件 */}
                {preview.removed.length > 0 && (
                  <div className="rounded-md border">
                    <button
                      onClick={() => setShowRemoved((v) => !v)}
                      className="flex w-full items-center gap-1.5 px-2 py-1.5 text-left text-xs font-medium hover:bg-accent/40"
                    >
                      {showRemoved ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
                      {t('dialogs.modpackUpdate.preview.removed')} ({preview.removed.length})
                    </button>
                    {showRemoved && (
                      <div className="max-h-40 overflow-y-auto border-t px-2 py-1">
                        {preview.removed.map((e) => (
                          <div key={e.path} className="truncate py-0.5 font-mono text-[11px] text-muted-foreground">{e.path}</div>
                        ))}
                      </div>
                    )}
                  </div>
                )}

                <Separator />

                {/* ④ 风险确认 */}
                <div className="space-y-2 rounded-md border border-destructive/30 bg-destructive/5 p-3">
                  <p className="flex items-center gap-1.5 text-sm font-medium text-destructive">
                    <AlertTriangle className="h-4 w-4" />
                    {t('dialogs.modpackUpdate.risk.title')}
                  </p>
                  <ul className="space-y-1 text-xs text-muted-foreground">
                    <li>• {t('dialogs.modpackUpdate.risk.compat')}</li>
                    <li>• {t('dialogs.modpackUpdate.risk.saves')}</li>
                    <li>• {t('dialogs.modpackUpdate.risk.backup')}</li>
                    <li>• {t('dialogs.modpackUpdate.risk.test')}</li>
                  </ul>
                  <label className="flex cursor-pointer items-center gap-2 pt-1 text-sm">
                    <Checkbox
                      checked={riskAccepted}
                      onCheckedChange={(v) => setRiskAccepted(v === true)}
                    />
                    {t('dialogs.modpackUpdate.risk.confirm')}
                  </label>
                </div>
              </>
            )}
          </>
        )}
      </DialogBody>

      <DialogFooter>
        <Button variant="outline" onClick={onClose} disabled={starting}>{t('common.cancel')}</Button>
        {step === 'preview' && (
          <Button
            onClick={handleStart}
            disabled={!riskAccepted || starting || previewLoading || !!error || !preview}
          >
            {starting ? t('dialogs.modpackUpdate.updating') : t('dialogs.modpackUpdate.startUpdate')}
          </Button>
        )}
      </DialogFooter>
    </Dialog>
  )
}
