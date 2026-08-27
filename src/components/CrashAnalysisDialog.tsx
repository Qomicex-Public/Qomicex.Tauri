import { useState } from 'react'
import { createPortal } from 'react-dom'
import { Bug, Copy, Download, Link, Loader2, TriangleAlert, X } from 'lucide-react'
import { Button } from './ui'
import { Tooltip } from './ui'
import { Separator } from './ui'
import { exportDiagnostics } from '../api/instance.ts'
import { ApiError } from '../api/client.ts'
import { AnalysisResults } from './AnalysisResults.tsx'
import { useI18n } from '../i18n/index.tsx'
import type { LogAnalysisResult } from '../types/index.ts'

export function CrashAnalysisDialog({ open, instanceId, title, message, detail, crashReport, args, analysis, analysisLoading, mcloGsUrl, qrCodeBase64, error, onClose }: {
  open: boolean
  instanceId?: string
  title: string
  message: string
  detail?: string | null
  crashReport?: string | null
  args?: string | null
  analysis?: LogAnalysisResult | null
  analysisLoading?: boolean
  mcloGsUrl?: string | null
  qrCodeBase64?: string | null
  error?: string | null
  onClose: () => void
}) {
  const { t } = useI18n()
  const [exporting, setExporting] = useState(false)
  const [exportErr, setExportErr] = useState('')

  if (!open) return null

  const logId = mcloGsUrl ? new URL(mcloGsUrl).pathname.replace(/^\//, '') : null

  const copyAll = () => {
    const text = [title, message, detail && t('dialogs.crashAnalysis.copyDetail', { detail }), args && t('dialogs.crashAnalysis.copyArgs', { args }), crashReport && t('dialogs.crashAnalysis.copyCrashReport', { crashReport }), mcloGsUrl && t('dialogs.crashAnalysis.copyLogLink', { url: mcloGsUrl })].filter(Boolean).join('\n\n')
    navigator.clipboard.writeText(text)
  }

  const handleExport = async () => {
    if (!instanceId || exporting) return
    setExporting(true)
    setExportErr('')
    try {
      await exportDiagnostics(instanceId)
    } catch (e: unknown) {
      setExportErr(e instanceof ApiError ? e.displayMessage : e instanceof Error ? e.message : t('dialogs.crashAnalysis.exportFailed'))
    } finally {
      setExporting(false)
    }
  }

  const handleQrClick = () => {
    if (mcloGsUrl) window.open(mcloGsUrl, '_blank')
  }

  const collapsibleSection = (label: string, content?: string | null) => {
    if (!content) return null
    return (
      <details className="group rounded-lg border bg-background">
        <summary className="flex cursor-pointer items-center gap-2 px-3 py-2 text-xs font-medium text-muted-foreground hover:text-foreground [&::-webkit-details-marker]:hidden">
          <svg className="h-3 w-3 transition-transform group-open:rotate-90" viewBox="0 0 12 12" fill="none">
            <path d="M4 2l4 4-4 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
          {label}
        </summary>
        <div className="border-t">
          <pre className="max-h-48 overflow-auto p-3 text-[11px] leading-relaxed whitespace-pre-wrap break-all font-mono">{content}</pre>
        </div>
      </details>
    )
  }

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="flex w-full max-w-2xl flex-col rounded-xl border bg-card shadow-2xl max-h-[85vh]">
        <div className="flex items-center justify-between border-b px-5 py-4">
          <div className="flex items-center gap-2">
            <div className="flex h-8 w-8 items-center justify-center rounded-full bg-destructive/10">
              <Bug className="h-4 w-4 text-destructive" />
            </div>
            <h2 className="text-sm font-semibold">{title}</h2>
            {logId && (
              <Tooltip content={mcloGsUrl as string}>
                <span className="inline-flex items-center gap-1 rounded-md bg-muted px-1.5 py-0.5 text-[10px] font-mono text-muted-foreground">
                  <Link className="h-2.5 w-2.5" />
                  {logId}
                </span>
              </Tooltip>
            )}
          </div>
          <button onClick={onClose} className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-muted">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto space-y-4 p-5">
          <div className="flex gap-4">
            <div className="flex-1 flex items-start gap-2 rounded-lg bg-destructive/5 p-3">
              <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
              <p className="text-sm whitespace-pre-wrap break-all">{message}</p>
            </div>
            {qrCodeBase64 && (
              <div className="shrink-0">
                <button
                  onClick={handleQrClick}
                  className="flex flex-col items-center gap-1 rounded-lg border bg-background p-2 hover:bg-muted transition-colors"
                  disabled={!mcloGsUrl}
                >
                  <img src={qrCodeBase64} alt="QR Code" className="h-[120px] w-[120px] object-contain" />
                  {logId && <span className="text-[11px] font-mono text-muted-foreground">mclo.gs/{logId}</span>}
                  <span className="text-[10px] text-muted-foreground">{t('dialogs.crashAnalysis.scanQr')}</span>
                </button>
              </div>
            )}
          </div>

          {collapsibleSection(t('dialogs.crashAnalysis.detail'), detail)}

          {collapsibleSection(t('dialogs.crashAnalysis.crashReport'), crashReport)}

          {collapsibleSection(t('dialogs.crashAnalysis.launchArgs'), args)}

          {analysisLoading && (
            <div className="flex items-center gap-2 text-sm text-muted-foreground py-2">
              <Loader2 className="h-3 w-3 animate-spin" />
              {t('dialogs.crashAnalysis.analyzing')}
            </div>
          )}

          {!analysis && !analysisLoading && error && (
            <p className="rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">{error}</p>
          )}

          {(analysis || analysisLoading || detail) && (
            <>
              <Separator />
              {analysisLoading ? (
                <p className="text-sm text-muted-foreground">{t('dialogs.crashAnalysis.noResult')}</p>
              ) : analysis ? (
                <AnalysisResults result={analysis} />
              ) : (
                <p className="text-sm text-muted-foreground">{t('dialogs.crashAnalysis.noResult')}</p>
              )}
            </>
          )}

          {exportErr && (
            <p className="text-xs text-destructive">{exportErr}</p>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 border-t px-5 py-3">
          <Button variant="outline" size="sm" onClick={copyAll} className="gap-1.5 h-7 text-xs">
            <Copy className="h-3 w-3" />{t('dialogs.crashAnalysis.copyAll')}
          </Button>
          {instanceId && (
            <Button variant="outline" size="sm" onClick={handleExport} disabled={exporting} className="gap-1.5 h-7 text-xs">
              {exporting ? <Loader2 className="h-3 w-3 animate-spin" /> : <Download className="h-3 w-3" />}
              {exporting ? t('dialogs.crashAnalysis.exporting') : t('dialogs.crashAnalysis.exportReport')}
            </Button>
          )}
          <Button size="sm" onClick={onClose} className="h-7 text-xs">{t('common.close')}</Button>
        </div>
      </div>
    </div>,
    document.body
  )
}
