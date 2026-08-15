import { useState } from 'react'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import { faFileLines, faMagnifyingGlass } from '@fortawesome/free-solid-svg-icons'
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

  const severityColor: Record<string, string> = {
    Critical: 'border-l-destructive',
    Error: 'border-l-red-500',
    Warning: 'border-l-yellow-500',
    Info: 'border-l-blue-500',
  }

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
          <CardTitle>
            <FontAwesomeIcon icon={faFileLines} className="mr-2 h-4 w-4" />
            {t('tools.analysis.inputTitle')}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <Textarea
            rows={12}
            value={logContent}
            onChange={(e) => setLogContent(e.target.value)}
            placeholder={t('tools.analysis.pastePlaceholder')}
            className="font-mono text-xs leading-relaxed"
          />
          <Button onClick={handleAnalyze} disabled={loading || !logContent.trim()}>
            <FontAwesomeIcon icon={faMagnifyingGlass} className="h-4 w-4" />
            {loading ? t('tools.analysis.analyzing') : t('tools.analysis.analyzeButton')}
          </Button>
          {error && <p className="text-sm text-destructive">{error}</p>}
        </CardContent>
      </Card>

      {result && (
        <Card>
          <CardHeader className="flex-row items-center justify-between">
            <CardTitle>{t('tools.analysis.title')}</CardTitle>
            <div className="flex items-center gap-2">
              {criticalCount > 0 && <Badge variant="destructive">{t('tools.analysis.criticalCount', { count: criticalCount })}</Badge>}
              {errorCount > 0 && <Badge variant="destructive">{t('tools.analysis.errorCount', { count: errorCount })}</Badge>}
              {warningCount > 0 && <Badge variant="secondary">{t('tools.analysis.warningCount', { count: warningCount })}</Badge>}
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            {(result.minecraftVersion || result.modLoader) && (
              <div className="flex gap-4 text-sm">
                {result.minecraftVersion && (
                  <div><span className="text-muted-foreground">{t('tools.analysis.gameVersion')} </span><span className="font-medium">{result.minecraftVersion}</span></div>
                )}
                {result.modLoader && (
                  <div><span className="text-muted-foreground">{t('tools.analysis.modLoader')} </span><span className="font-medium">{result.modLoader}</span></div>
                )}
              </div>
            )}

            {result.issues.length === 0 && (
              <p className="py-2 text-sm text-muted-foreground">{t('tools.analysis.noIssues')}</p>
            )}

            {result.issues.map((issue, i) => (
              <div
                key={i}
                className={`rounded-lg border-l-[3px] bg-background p-4 text-sm ${severityColor[issue.severity] || 'border-l-border'}`}
              >
                <div className="mb-1.5 flex items-center gap-2">
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
            ))}

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
