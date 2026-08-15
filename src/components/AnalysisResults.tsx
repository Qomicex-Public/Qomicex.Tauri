import { Card, CardHeader, CardTitle, CardContent } from './ui'
import { Badge } from './ui'
import { Separator } from './ui'
import { useI18n } from '../i18n/index.tsx'
import type { LogAnalysisResult } from '../types/index.ts'

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

export function AnalysisResults({ result }: { result: LogAnalysisResult }) {
  const { t } = useI18n()
  const criticalCount = result.issues.filter((i) => i.severity === 'Critical').length
  const errorCount = result.issues.filter((i) => i.severity === 'Error').length
  const warningCount = result.issues.filter((i) => i.severity === 'Warning').length

  const categoryLabel = (category: string): string => t(categoryKey[category] || category)

  return (
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

        {result.errorMessage && (
          <p className="rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">{result.errorMessage}</p>
        )}

        {result.issues.length === 0 && !result.errorMessage && (
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
            {issue.name && (
              <p className="mb-0.5 text-sm font-semibold text-foreground">{issue.name}</p>
            )}
            <p className="font-mono text-[11px] leading-relaxed text-muted-foreground">{issue.matchedText}</p>
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
  )
}
