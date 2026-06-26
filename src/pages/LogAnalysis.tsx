import { useState } from 'react'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import { faFileLines, faMagnifyingGlass } from '@fortawesome/free-solid-svg-icons'
import { Button } from '../components/ui/button.tsx'
import { Card, CardHeader, CardTitle, CardContent } from '../components/ui/card.tsx'
import { Badge } from '../components/ui/badge.tsx'
import { Separator } from '../components/ui/separator.tsx'
import { Textarea } from '../components/ui/textarea.tsx'
import { analyzeLog } from '../api/logAnalysis.ts'
import type { LogAnalysisResult } from '../types/index.ts'

export default function LogAnalysis() {
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
      setError(e instanceof Error ? e.message : '分析失败')
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

  const categoryLabel: Record<string, string> = {
    Memory: '内存',
    ModConflict: '模组冲突',
    JavaRelated: 'Java 相关',
    Resource: '资源',
    Performance: '性能',
    Network: '网络',
    Unknown: '未知',
  }

  return (
    <div className="animate-in space-y-6 p-8">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">日志分析</h1>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>
            <FontAwesomeIcon icon={faFileLines} className="mr-2 h-4 w-4" />
            输入 Minecraft 日志
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <Textarea
            rows={12}
            value={logContent}
            onChange={(e) => setLogContent(e.target.value)}
            placeholder="粘贴 Minecraft 日志内容..."
            className="font-mono text-xs leading-relaxed"
          />
          <Button onClick={handleAnalyze} disabled={loading || !logContent.trim()}>
            <FontAwesomeIcon icon={faMagnifyingGlass} className="h-4 w-4" />
            {loading ? '分析中...' : '分析日志'}
          </Button>
          {error && <p className="text-sm text-destructive">{error}</p>}
        </CardContent>
      </Card>

      {result && (
        <Card>
          <CardHeader className="flex-row items-center justify-between">
            <CardTitle>分析结果</CardTitle>
            <div className="flex items-center gap-2">
              {criticalCount > 0 && <Badge variant="destructive">{criticalCount} 严重</Badge>}
              {errorCount > 0 && <Badge variant="destructive">{errorCount} 错误</Badge>}
              {warningCount > 0 && <Badge variant="secondary">{warningCount} 警告</Badge>}
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            {(result.minecraftVersion || result.modLoader) && (
              <div className="flex gap-4 text-sm">
                {result.minecraftVersion && (
                  <div><span className="text-muted-foreground">游戏版本 </span><span className="font-medium">{result.minecraftVersion}</span></div>
                )}
                {result.modLoader && (
                  <div><span className="text-muted-foreground">模组加载器 </span><span className="font-medium">{result.modLoader}</span></div>
                )}
              </div>
            )}

            {result.issues.length === 0 && (
              <p className="py-2 text-sm text-muted-foreground">未发现明显问题</p>
            )}

            {result.issues.map((issue, i) => (
              <div
                key={i}
                className={`rounded-lg border-l-[3px] bg-background p-4 text-sm ${severityColor[issue.severity] || 'border-l-border'}`}
              >
                <div className="mb-1.5 flex items-center gap-2">
                  <span className="text-xs font-medium text-muted-foreground">{categoryLabel[issue.category] || issue.category}</span>
                  <span className="text-[11px] text-muted-foreground/50">L{issue.lineNumber}</span>
                </div>
                <p className="font-mono text-xs leading-relaxed">{issue.matchedText}</p>
                {issue.solutions.length > 0 && (
                  <details className="mt-2">
                    <summary className="cursor-pointer text-xs font-medium text-primary">建议解决方案</summary>
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
                  <p className="mb-1 text-xs font-medium text-muted-foreground">异常堆栈</p>
                  <pre className="max-h-40 overflow-auto rounded-lg bg-background p-3 font-mono text-[11px] leading-relaxed text-muted-foreground">
                    {result.stackTrace}
                  </pre>
                </div>
              </>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  )
}
