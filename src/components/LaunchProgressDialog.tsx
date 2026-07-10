import { useState } from 'react'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import { faRotate, faDownload, faSpinner } from '@fortawesome/free-solid-svg-icons'
import { Dialog, DialogHeader, DialogTitle, DialogBody } from './ui/dialog.tsx'
import { Button } from './ui/button.tsx'
import { useRunning } from '../contexts/RunningContext.tsx'
import { exportDiagnostics } from '../api/instance.ts'
import { cn } from '../lib/utils.ts'

const stageLabels: Record<string, string> = {
  starting: '准备中',
  checking: '检查文件完整性',
  repairing: '补全文件',
  'logging-in': '验证账户',
  authlib: '配置外置登录',
  natives: '解压原生库',
  building: '构建启动参数',
  launching: '启动游戏',
  running: '游戏运行中',
  crashed: '游戏异常退出',
  failed: '启动失败',
  completed: '游戏已退出',
}

export default function LaunchProgressDialog() {
  const { launchProgress, launchingInstanceId, cancelLaunch } = useRunning()
  const [exporting, setExporting] = useState(false)

  if (!launchProgress) return null

  const isFinal = ['completed', 'crashed', 'failed'].includes(launchProgress.stage)
  const isError = ['crashed', 'failed'].includes(launchProgress.stage)

  const handleExport = async () => {
    if (!launchingInstanceId || exporting) return
    setExporting(true)
    try { await exportDiagnostics(launchingInstanceId) } catch { /* ignore */ }
    finally { setExporting(false) }
  }

  return (
    <Dialog open onClose={() => cancelLaunch()} closeOnBackdrop={isFinal} closeOnEsc={isFinal}>
      <DialogHeader onClose={() => cancelLaunch()}>
        <DialogTitle>{isError ? '启动失败' : '启动游戏'}</DialogTitle>
      </DialogHeader>
      <DialogBody className="space-y-4">
        <div className="flex items-center justify-between text-sm">
          <span className={cn('font-medium', isError && 'text-destructive')}>
            {stageLabels[launchProgress.stage] || launchProgress.stage}
          </span>
          <span className="text-muted-foreground">{Math.round(launchProgress.progress)}%</span>
        </div>
        <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
          <div
            className={cn('h-full rounded-full transition-all', isError ? 'bg-destructive' : 'bg-primary')}
            style={{ width: `${launchProgress.progress}%` }}
          />
        </div>
        <p className="text-sm text-muted-foreground">{launchProgress.message}</p>
        {launchProgress.error && (
          <p className="rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">{launchProgress.error}</p>
        )}
        {launchProgress.crashReport && (
          <details className="rounded-lg border border-border bg-muted/30">
            <summary className="cursor-pointer px-3 py-2 text-xs font-medium text-muted-foreground hover:text-foreground">查看崩溃报告</summary>
            <pre className="max-h-48 overflow-auto px-3 pb-3 text-[11px] text-muted-foreground">{launchProgress.crashReport}</pre>
          </details>
        )}
        {launchProgress.stage === 'running' && launchProgress.processId && (
          <p className="text-xs text-muted-foreground">进程 ID: {launchProgress.processId}</p>
        )}
        {!isFinal ? (
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <FontAwesomeIcon icon={faRotate} className="h-3 w-3 animate-spin" />
            正在启动...
          </div>
        ) : (
          <div className="flex items-center justify-center gap-2 pt-2">
            {isError && launchingInstanceId && (
              <Button variant="outline" size="sm" onClick={handleExport} disabled={exporting} className="gap-1.5 h-7 text-xs">
                <FontAwesomeIcon icon={exporting ? faSpinner : faDownload} className={exporting ? 'h-3 w-3 animate-spin' : 'h-3 w-3'} />
                {exporting ? '导出中...' : '导出诊断报告'}
              </Button>
            )}
            <button onClick={() => cancelLaunch()} className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90">关闭</button>
          </div>
        )}
      </DialogBody>
    </Dialog>
  )
}
