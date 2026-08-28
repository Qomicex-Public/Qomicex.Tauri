import { useState } from 'react'
import { FileText, Search, Trash2, AlertTriangle, AlertCircle, Info, XCircle, CheckCircle2 } from 'lucide-react'
import { Button } from '../components/ui'
import { Card, CardHeader, CardTitle, CardContent } from '../components/ui'
import { Badge } from '../components/ui'
import { Separator } from '../components/ui'
import { Textarea } from '../components/ui'
import { analyzeLog } from '../api/logAnalysis.ts'
import { PageHeader } from '../components/PageHeader.tsx'
import { PageShell } from '../components/PageShell.tsx'
import { useI18n } from '../i18n/index.tsx'
import type { LogAnalysisResult } from '../types/index.ts'

const severityIcons: Record<string, typeof AlertTriangle> = {
  Critical: XCircle,
  Error: AlertCircle,
  Warning: AlertTriangle,
  Info: Info,
}

const severityColors: Record<string, string> = {
  Critical: 'border-l-destructive bg-destructive/5',
  Error: 'border-l-red-500 bg-red-500/5',
  Warning: 'border-l-yellow-500 bg-yellow-500/5',
  Info: 'border-l-blue-500 bg-blue-500/5',
}

const severityBadgeColors: Record<string, string> = {
  Critical: 'bg-destructive/15 text-destructive border-destructive/20',
  Error: 'bg-red-500/15 text-red-500 border-red-500/20',
  Warning: 'bg-yellow-500/15 text-yellow-600 dark:text-yellow-400 border-yellow-500/20',
  Info: 'bg-blue-500/15 text-blue-500 border-blue-500/20',
}

export default function LogAnalysis() {
  const { t } = useI18n()
  const [logContent, setLogContent] = useState('')
  const [result, setResult] = useState<LogAnalysisResult | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  async function handleAnalyze() {
    if (!logContent.trim()) return
    setLoading(true)
    setError('')
    setResult(null)
    try {
      const res = await analyzeLog(logContent)
      setResult(res)
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : t('tools.analysis.analyzeFailed'))
    } finally {
      setLoading(false)
    }
  }

  const criticalCount = result?.issues.filter((i) => i.severity === 'Critical').length ?? 0
  const errorCount = result?.issues.filter((i) => i.severity === 'Error').length ?? 0
  const warningCount = result?.issues.filter((i) => i.severity === 'Warning').length ?? 0
  const infoCount = result?.issues.filter((i) => i.severity === 'Info').length ?? 0

  const categoryKey: Record<string, string> = {
    Memory: 'tools.analysis.categoryMemory',
    ModConflict: 'tools.analysis.categoryModConflict',
    JavaRelated: 'tools.analysis.categoryJavaRelated',
    Resource: 'tools.analysis.categoryResource',
    Performance: 'tools.analysis.categoryPerformance',
    Network: 'tools.analysis.categoryNetwork',
    Unknown: 'common.unknown',
  }

  const categoryLabel = (category: string): string => t(categoryKey[category] || category)

  return (
    <PageShell className="p-8 space-y-6 overflow-y-auto">
      <PageHeader title={t('tools.analysis.pageTitle')} />

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <FileText className="h-4 w-4 text-muted-foreground" />
            {t('tools.analysis.inputTitle')}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <Textarea
            rows={12}
            value={logContent}
            onChange={(e) => setLogContent(e.target.value)}
            placeholder={t('tools.analysis.pastePlaceholder')}
            className="font-mono text-xs leading-relaxed resize-y"
          />
          <div className="flex items-center gap-2">
            <Button onClick={handleAnalyze} disabled={loading || !logContent.trim()}>
              {loading ? (
                <span className="flex items-center gap-2">
                  <span className="h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent" />
                  {t('tools.analysis.analyzing')}
                </span>
              ) : (
                <span className="flex items-center gap-2">
                  <Search className="h-4 w-4" />
                  {t('tools.analysis.analyzeButton')}
                </span>
              )}
            </Button>
            {logContent && (
              <Button variant="ghost" size="sm" onClick={() => { setLogContent(''); setResult(null); setError('') }}>
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            )}
          </div>
          {error && <p className="text-sm text-destructive">{error}</p>}
        </CardContent>
      </Card>

      {result && (
        <Card>
          <CardHeader className="flex-row items-center justify-between">
            <CardTitle>{t('tools.analysis.title')}</CardTitle>
            <div className="flex items-center gap-2">
              {criticalCount > 0 && <Badge className={severityBadgeColors.Critical}>{t('tools.analysis.criticalCount', { count: criticalCount })}</Badge>}
              {errorCount > 0 && <Badge className={severityBadgeColors.Error}>{t('tools.analysis.errorCount', { count: errorCount })}</Badge>}
              {warningCount > 0 && <Badge className={severityBadgeColors.Warning}>{t('tools.analysis.warningCount', { count: warningCount })}</Badge>}
              {infoCount > 0 && <Badge className={severityBadgeColors.Info}>{t('tools.analysis.infoCount', { count: infoCount })}</Badge>}
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            {(result.minecraftVersion || result.modLoader) && (
              <div className="flex gap-4 text-sm">
                {result.minecraftVersion && (
                  <div className="flex items-center gap-1.5">
                    <span className="text-muted-foreground">{t('tools.analysis.gameVersion')}</span>
                    <Badge variant="secondary" className="font-mono">{result.minecraftVersion}</Badge>
                  </div>
                )}
                {result.modLoader && (
                  <div className="flex items-center gap-1.5">
                    <span className="text-muted-foreground">{t('tools.analysis.modLoader')}</span>
                    <Badge variant="secondary" className="font-mono">{result.modLoader}</Badge>
                  </div>
                )}
              </div>
            )}

            {result.issues.length === 0 && (
              <div className="flex items-center gap-2 rounded-lg border border-green-500/20 bg-green-500/5 p-4 text-sm text-green-600 dark:text-green-400">
                <CheckCircle2 className="h-4 w-4 shrink-0" />
                {t('tools.analysis.noIssues')}
              </div>
            )}

            {result.issues.map((issue, i) => {
              const Icon = severityIcons[issue.severity] || Info
              return (
                <div
                  key={i}
                  className={`rounded-lg border-l-[3px] p-4 text-sm ${severityColors[issue.severity] || 'border-l-border'}`}
                >
                  <div className="mb-1.5 flex items-center gap-2">
                    <Icon className="h-3.5 w-3.5 shrink-0" />
                    <span className="text-xs font-medium text-muted-foreground">{categoryLabel(issue.category)}</span>
                    <span className="text-[11px] text-muted-foreground/50">L{issue.lineNumber}</span>
                  </div>
                  <p className="font-mono text-xs leading-relaxed">{issue.matchedText}</p>
                  {issue.solutions.length > 0 && (
                    <details className="mt-2">
                      <summary className="cursor-pointer text-xs font-medium text-primary">{t('tools.analysis.suggestedSolutions')}</summary>
                      <div className="mt-1.5 space-y-2">
                        {issue.solutions.map((s, si) => (
                          <div key={si}>
                            <p className="text-xs font-medium text-foreground">{s.title}</p>
                            {s.description && <p className="text-xs text-muted-foreground">{s.description}</p>}
                          </div>
                        ))}
                      </div>
                    </details>
                  )}
                </div>
              )
            })}

            {result.stackTrace && (
              <>
                <Separator />
                <div>
                  <p className="mb-1 text-xs font-medium text-muted-foreground">{t('tools.analysis.stackTrace')}</p>
                  <pre className="max-h-40 overflow-auto rounded-lg bg-background p-3 font-mono text-[11px] leading-relaxed text-muted-foreground">
                    {result.stackTrace}
                  </pre>
                </div>
              </>
            )}
          </CardContent>
        </Card>
      )}
    </PageShell>
  )
}
