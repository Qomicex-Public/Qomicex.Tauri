# CrashAnalysisDialog Implementation Plan

> **REQUIRED SUB-SKILL:** Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Merge ErrorReportDialog + LogAnalysis into one auto-triggered crash analysis dialog.

**Architecture:** Backend adds crash upload (mclo.gs) and QR code generation, plus a new `analyze-crash` endpoint. Frontend introduces `CrashAnalysisDialog` (combined), `AnalysisResults` (extracted), and auto-triggers analysis on crash detection in `RunningContext`.

**Tech Stack:** C# ASP.NET 10 / React 19 / Tailwind / QRCoder + SkiaSharp

## Global Constraints

- All TS/TSX imports must include file extensions (`.ts` / `.tsx`)
- Line endings: CRLF on Windows, keep existing file style
- No `.gitignore` changes needed
- SuggestedSolution field mapping fix: in new endpoint map `Description`→`description`, auto-gen `title` from first 30 chars of Description, map `ActionType`→`action`

---

### Task 1: Backend — Add NuGet packages + CrashUploadService

**Files:**
- Modify: `src-backend/Qomicex.Launcher.Backend/Qomicex.Launcher.Backend.csproj`
- Create: `src-backend/Qomicex.Launcher.Backend/Services/CrashUploadService.cs`
- Modify: `src-backend/Qomicex.Launcher.Backend/Program.cs`

**Interfaces:**
- Consumes: `IHttpClientFactory`, `ILogger<CrashUploadService>`
- Produces: `CrashUploadService.UploadCrashLogAsync(crashReport)` → `(string? url, byte[]? qrCodePng)`

- [ ] **Step 1: Add QRCoder + SkiaSharp to csproj**

Add after the last `PackageReference` in `Qomicex.Launcher.Backend.csproj`:
```xml
<PackageReference Include="QRCoder" Version="1.6.0" />
<PackageReference Include="SkiaSharp" Version="3.116.1" />
```

- [ ] **Step 2: Create CrashUploadService**

Create `src-backend/Qomicex.Launcher.Backend/Services/CrashUploadService.cs`:
```csharp
using System.Net.Http.Json;
using System.Text.Json;
using QRCoder;
using SkiaSharp;

namespace Qomicex.Launcher.Backend.Services;

public class CrashUploadService
{
    private readonly IHttpClientFactory _httpClientFactory;
    private readonly ILogger<CrashUploadService> _logger;

    public CrashUploadService(IHttpClientFactory httpClientFactory, ILogger<CrashUploadService> logger)
    {
        _httpClientFactory = httpClientFactory;
        _logger = logger;
    }

    public async Task<(string? Url, byte[]? QrCodePng)> UploadCrashLogAsync(string content)
    {
        try
        {
            var client = _httpClientFactory.CreateClient();
            var payload = new
            {
                content,
                source = "Qomicex-Launcher",
                metadata = new { launcher_version = "1.0.0", visible = true }
            };
            var response = await client.PostAsJsonAsync("https://api.mclo.gs/1/log", payload);
            response.EnsureSuccessStatusCode();
            var json = await response.Content.ReadFromJsonAsync<JsonElement>();
            var url = json.TryGetProperty("url", out var u) ? u.GetString() : null;
            if (string.IsNullOrEmpty(url)) return (null, null);
            var qrBytes = CreateQrCode(url);
            return (url, qrBytes);
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "Failed to upload crash log to mclo.gs");
            return (null, null);
        }
    }

    private static byte[] CreateQrCode(string url)
    {
        using var generator = new QRCodeGenerator();
        var qrData = generator.CreateQrCode(url, QRCodeGenerator.ECCLevel.Q);
        var modules = qrData.ModuleMatrix;
        int moduleSize = 20;
        int size = modules.Count * moduleSize;
        using var bitmap = new SKBitmap(size, size);
        using var canvas = new SKCanvas(bitmap);
        canvas.Clear(SKColors.White);
        for (int row = 0; row < modules.Count; row++)
        {
            for (int col = 0; col < modules[row].Count; col++)
            {
                if (modules[row][col])
                {
                    var rect = new SKRect(col * moduleSize, row * moduleSize, (col + 1) * moduleSize, (row + 1) * moduleSize);
                    canvas.DrawRect(rect, new SKPaint { Color = SKColors.Black, Style = SKPaintStyle.Fill });
                }
            }
        }
        using var image = SKImage.FromBitmap(bitmap);
        using var data = image.Encode(SKEncodedImageFormat.Png, 100);
        return data.ToArray();
    }
}
```

- [ ] **Step 3: Register CrashUploadService in Program.cs**

Add after line 85 (the `AccountService` registration) in `Program.cs`:
```csharp
builder.Services.AddSingleton<CrashUploadService>();
```

- [ ] **Step 4: Verify build**

Run: `cd src-backend/Qomicex.Launcher.Backend && dotnet build`
Expected: Build succeeded (0 errors, 0 warnings minimum)

---

### Task 2: Backend — Add AnalyzeCrash endpoint

**Files:**
- Modify: `src-backend/Qomicex.Launcher.Backend/Controllers/LogAnalysisController.cs`

**Interfaces:**
- Consumes: `CrashUploadService`, `IInstanceRepository`, `LaunchService`
- Produces: `POST /api/loganalysis/analyze-crash/{instanceId}` → `CrashAnalysisResponse`

- [ ] **Step 1: Create response model**

Add to `LogAnalysisController.cs` after the existing `LogAnalysisRequest` class:
```csharp
public class CrashAnalysisResponse
{
    public object? Analysis { get; set; }
    public string? McloGsUrl { get; set; }
    public string? QrCodeBase64 { get; set; }
}
```

- [ ] **Step 2: Add AnalyzeCrash endpoint**

Add to `LogAnalysisController` class:
```csharp
private readonly CrashUploadService _crashUploadService;
private readonly IInstanceRepository _instanceRepository;
private readonly LaunchService _launchService;

public LogAnalysisController(
    CrashUploadService crashUploadService,
    IInstanceRepository instanceRepository,
    LaunchService launchService)
{
    _crashUploadService = crashUploadService;
    _instanceRepository = instanceRepository;
    _launchService = launchService;
}

[HttpPost("analyze-crash/{instanceId}")]
public async Task<IActionResult> AnalyzeCrash(string instanceId)
{
    var instance = _instanceRepository.GetById(instanceId);
    if (instance == null)
        return NotFound(new { code = "INSTANCE_NOT_FOUND", message = "实例不存在" });

    var progress = _launchService.Get(instanceId);
    var crashReport = progress?.CrashReport;
    if (string.IsNullOrEmpty(crashReport))
        return BadRequest(new { code = "NO_CRASH_REPORT", message = "无可用崩溃报告" });

    var analyzer = new MinecraftLogAnalyzer();
    var analysis = await analyzer.AnalyzeAsync(crashReport);

    // Map SuggestedSolution fields to match frontend TS types
    var mapped = MapAnalysisForFrontend(analysis);

    var (url, qrPng) = await _crashUploadService.UploadCrashLogAsync(crashReport);

    return Ok(new CrashAnalysisResponse
    {
        Analysis = mapped,
        McloGsUrl = url,
        QrCodeBase64 = qrPng != null ? "data:image/png;base64," + Convert.ToBase64String(qrPng) : null
    });
}

private static object? MapAnalysisForFrontend(LogAnalysisResult? result)
{
    if (result == null) return null;
    return new
    {
        isSuccess = result.IsSuccess,
        minecraftVersion = result.MinecraftVersion,
        modLoader = result.ModLoader,
        loadedMods = result.LoadedMods,
        stackTrace = result.StackTrace,
        rawLogExcerpt = result.RawLogExcerpt,
        issues = result.Issues.Select(i => new
        {
            patternId = i.PatternId,
            category = i.Category,
            severity = i.Severity,
            lineNumber = i.LineNumber,
            matchedText = i.MatchedText,
            capturedGroups = i.CapturedGroups,
            solutions = i.Solutions.Select(s => new
            {
                title = s.Description.Length > 30 ? s.Description[..30] + "..." : s.Description,
                description = s.Description,
                action = s.ActionType
            }).ToArray()
        }).ToArray(),
        errorMessage = result.ErrorMessage
    };
}
```

- [ ] **Step 3: Add using directives**

Make sure the file has:
```csharp
using Qomicex.Core.Modules.Helpers.LogAnalysis;
using Qomicex.Core.Modules.Helpers.LogAnalysis.Models;
using Qomicex.Launcher.Backend.Services;
```

- [ ] **Step 4: Verify build**

Run: `cd src-backend/Qomicex.Launcher.Backend && dotnet build`
Expected: Build succeeded

---

### Task 3: Frontend — Add types + API function

**Files:**
- Modify: `src/types/index.ts`
- Create: `src/api/crashDiagnostics.ts`

**Interfaces:**
- Consumes: `CrashAnalysisResult` (from API), `LogAnalysisResult` (existing)
- Produces: `CrashDialogState`, `analyzeCrash(id)` function

- [ ] **Step 1: Add types to index.ts**

Add before the `SystemInfo` export (line 1) or after `LogAnalysisResult` block (after line 143):
```typescript
export interface CrashAnalysisResult {
  analysis: LogAnalysisResult
  mcloGsUrl: string
  qrCodeBase64: string
}

export interface CrashDialogState {
  instanceId: string
  title: string
  message: string
  detail?: string | null
  crashReport?: string | null
  analysis?: LogAnalysisResult | null
  mcloGsUrl?: string
  qrCodeBase64?: string
  loading: boolean
  error?: string
}
```

- [ ] **Step 2: Create src/api/crashDiagnostics.ts**

```typescript
import { post } from './client.ts'
import type { CrashAnalysisResult } from '../types/index.ts'

export function analyzeCrash(instanceId: string): Promise<CrashAnalysisResult> {
  return post(`/loganalysis/analyze-crash/${instanceId}`)
}
```

---

### Task 4: Frontend — Create AnalysisResults component

**Files:**
- Create: `src/components/AnalysisResults.tsx`

**Interfaces:**
- Consumes: `LogAnalysisResult` prop
- Produces: Reusable analysis rendering component

- [ ] **Step 1: Create AnalysisResults.tsx**

```typescript
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import { faBug } from '@fortawesome/free-solid-svg-icons'
import { Card, CardHeader, CardTitle, CardContent } from './ui/card.tsx'
import { Badge } from './ui/badge.tsx'
import { Separator } from './ui/separator.tsx'
import type { LogAnalysisResult } from '../types/index.ts'

export function AnalysisResults({ result }: { result: LogAnalysisResult }) {
  const criticalCount = result.issues.filter((i) => i.severity === 'Critical').length
  const errorCount = result.issues.filter((i) => i.severity === 'Error').length
  const warningCount = result.issues.filter((i) => i.severity === 'Warning').length

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
    <Card>
      <CardHeader className="flex-row items-center justify-between">
        <CardTitle>
          <FontAwesomeIcon icon={faBug} className="mr-2 h-4 w-4" />
          分析结果
        </CardTitle>
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
  )
}
```

- [ ] **Step 2: Verify TypeScript**

Run: `npx tsc --noEmit`
Expected: No type errors

---

### Task 5: Frontend — Create CrashAnalysisDialog

**Files:**
- Create: `src/components/CrashAnalysisDialog.tsx`

**Interfaces:**
- Consumes: Props `{ open, instanceId, title, message, detail, crashReport, analysis, mcloGsUrl, qrCodeBase64, onClose }`
- Produces: `CrashDialogState` consumer + display

- [ ] **Step 1: Create CrashAnalysisDialog.tsx**

```typescript
import { useState } from 'react'
import { createPortal } from 'react-dom'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import { faBug, faTriangleExclamation, faXmark, faCopy, faDownload, faSpinner, faLink } from '@fortawesome/free-solid-svg-icons'
import { Button } from './ui/button.tsx'
import { Tooltip, TooltipTrigger, TooltipContent } from './ui/tooltip.tsx'
import { Separator } from './ui/separator.tsx'
import { exportDiagnostics } from '../api/instance.ts'
import { AnalysisResults } from './AnalysisResults.tsx'
import type { LogAnalysisResult } from '../types/index.ts'

export function CrashAnalysisDialog({ open, instanceId, title, message, detail, crashReport, analysis, mcloGsUrl, qrCodeBase64, onClose }: {
  open: boolean
  instanceId?: string
  title: string
  message: string
  detail?: string | null
  crashReport?: string | null
  analysis?: LogAnalysisResult | null
  mcloGsUrl?: string
  qrCodeBase64?: string
  onClose: () => void
}) {
  const [exporting, setExporting] = useState(false)
  const [exportErr, setExportErr] = useState('')

  if (!open) return null

  const copyAll = () => {
    const parts = [title, message]
    if (detail) parts.push(`详情:\n${detail}`)
    if (crashReport) parts.push(`崩溃报告:\n${crashReport}`)
    if (mcloGsUrl) parts.push(`完整日志: ${mcloGsUrl}`)
    navigator.clipboard.writeText(parts.join('\n\n'))
  }

  const handleExport = async () => {
    if (!instanceId || exporting) return
    setExporting(true)
    setExportErr('')
    try {
      await exportDiagnostics(instanceId)
    } catch (e: unknown) {
      setExportErr(e instanceof Error ? e.message : '导出失败')
    } finally {
      setExporting(false)
    }
  }

  const logId = mcloGsUrl ? mcloGsUrl.split('/').pop() : null

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="flex max-h-[85vh] w-full max-w-2xl flex-col rounded-xl border bg-card shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between border-b px-5 py-4">
          <div className="flex items-center gap-2">
            <div className="flex h-8 w-8 items-center justify-center rounded-full bg-destructive/10">
              <FontAwesomeIcon icon={faBug} className="h-4 w-4 text-destructive" />
            </div>
            <h2 className="text-sm font-semibold">{title}</h2>
            {logId && (
              <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-mono text-muted-foreground">
                {logId}
              </span>
            )}
          </div>
          <button onClick={onClose} className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-muted">
            <FontAwesomeIcon icon={faXmark} className="h-4 w-4" />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto space-y-4 p-5">
          {/* Error info + QR code row */}
          <div className="flex gap-4">
            <div className="min-w-0 flex-1">
              <div className="flex items-start gap-2 rounded-lg bg-destructive/5 p-3">
                <FontAwesomeIcon icon={faTriangleExclamation} className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
                <p className="text-sm whitespace-pre-wrap break-all">{message}</p>
              </div>
            </div>

            {/* QR code card */}
            {qrCodeBase64 && (
              <div className="shrink-0">
                <div className="flex flex-col items-center rounded-lg border bg-background p-3">
                  {mcloGsUrl ? (
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <button onClick={() => window.open(mcloGsUrl, '_blank')} className="cursor-pointer">
                          <img src={qrCodeBase64} alt="QR Code" width={120} height={120} className="rounded" />
                        </button>
                      </TooltipTrigger>
                      <TooltipContent>{mcloGsUrl}</TooltipContent>
                    </Tooltip>
                  ) : (
                    <img src={qrCodeBase64} alt="QR Code" width={120} height={120} className="rounded" />
                  )}
                  {mcloGsUrl && (
                    <button
                      onClick={() => window.open(mcloGsUrl, '_blank')}
                      className="mt-1.5 flex items-center gap-1 text-[10px] text-primary hover:underline"
                    >
                      <FontAwesomeIcon icon={faLink} className="h-2.5 w-2.5" />
                      mclo.gs/{logId}
                    </button>
                  )}
                  <p className="mt-1 text-[10px] text-muted-foreground">扫描查看完整日志</p>
                </div>
              </div>
            )}
          </div>

          {/* Detail */}
          {detail && (
            <details className="rounded-lg border border-border">
              <summary className="cursor-pointer px-3 py-2 text-xs font-medium text-muted-foreground hover:text-foreground">错误详情</summary>
              <pre className="max-h-48 overflow-auto px-3 pb-3 text-[11px] text-muted-foreground whitespace-pre-wrap break-all">{detail}</pre>
            </details>
          )}

          {/* Crash report */}
          {crashReport && (
            <details className="rounded-lg border border-border">
              <summary className="cursor-pointer px-3 py-2 text-xs font-medium text-muted-foreground hover:text-foreground">崩溃报告</summary>
              <pre className="max-h-48 overflow-auto px-3 pb-3 text-[11px] text-muted-foreground whitespace-pre-wrap break-all">{crashReport}</pre>
            </details>
          )}

          {/* Analysis results */}
          {analysis && (
            <>
              <Separator />
              <AnalysisResults result={analysis} />
            </>
          )}

          {/* Raw log */}
          {crashReport && (
            <details className="rounded-lg border border-border">
              <summary className="cursor-pointer px-3 py-2 text-xs font-medium text-muted-foreground hover:text-foreground">完整日志（自动分析源）</summary>
              <pre className="max-h-48 overflow-auto px-3 pb-3 text-[11px] text-muted-foreground whitespace-pre-wrap break-all">{crashReport}</pre>
            </details>
          )}

          {exportErr && (
            <p className="text-xs text-destructive">{exportErr}</p>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-2 border-t px-5 py-3">
          <Button variant="outline" size="sm" onClick={copyAll} className="gap-1.5 h-7 text-xs">
            <FontAwesomeIcon icon={faCopy} className="h-3 w-3" />复制全部
          </Button>
          {instanceId && (
            <Button variant="outline" size="sm" onClick={handleExport} disabled={exporting} className="gap-1.5 h-7 text-xs">
              <FontAwesomeIcon icon={exporting ? faSpinner : faDownload} className={exporting ? 'h-3 w-3 animate-spin' : 'h-3 w-3'} />
              {exporting ? '导出中...' : '导出诊断报告'}
            </Button>
          )}
          <Button size="sm" onClick={onClose} className="h-7 text-xs">关闭</Button>
        </div>
      </div>
    </div>,
    document.body
  )
}
```

- [ ] **Step 2: Verify TypeScript**

Run: `npx tsc --noEmit`
Expected: No type errors

---

### Task 6: Frontend — RunningContext + page integration

**Files:**
- Modify: `src/contexts/RunningContext.tsx`
- Modify: `src/pages/Dashboard.tsx`
- Modify: `src/pages/InstanceDetail.tsx`
- Modify: `src/components/LaunchProgressDialog.tsx`
- Modify: `src/App.tsx`
- Delete: `src/components/ErrorReportDialog.tsx`

**Interfaces:**
- Consumes: `CrashDialogState`, `analyzeCrash()`, `CrashAnalysisDialog`
- Produces: Wired crash analysis flow

- [ ] **Step 1: Modify RunningContext**

Add import:
```typescript
import { analyzeCrash } from '../api/crashDiagnostics.ts'
import type { LaunchResult, LaunchProgress, CrashDialogState } from '../types/index.ts'
```

Add to `RunningContextValue` interface:
```typescript
crashDialogState: CrashDialogState | null
clearCrashDialog: () => void
```

Add state in `RunningProvider`:
```typescript
const [crashDialogState, setCrashDialogState] = useState<CrashDialogState | null>(null)
```

Add `clearCrashDialog`:
```typescript
const clearCrashDialog = useCallback(() => setCrashDialogState(null), [])
```

Modify the crash detection block in `poll` (lines 58-63):
```typescript
if (p.stage === 'crashed' || p.stage === 'failed') {
  setLaunchProgress(p)
  clearInstancePoll(id)
  setRunningInstances(prev => prev.filter(r => r.instanceId !== id))
  setLaunchingInstanceId(null)
  notifyRef.current?.('游戏已崩溃', 'error')

  // Auto-trigger crash analysis dialog
  setCrashDialogState({
    instanceId: id,
    title: p.stage === 'crashed' ? '游戏崩溃' : '启动失败',
    message: p.error || (p.stage === 'crashed' ? `游戏异常退出 (代码: ${p.exitCode ?? '?'})` : '启动过程中出现错误'),
    detail: p.error || null,
    crashReport: p.crashReport || null,
    loading: true,
  })
  analyzeCrash(id)
    .then(res => {
      setCrashDialogState(prev => prev ? {
        ...prev,
        analysis: res.analysis,
        mcloGsUrl: res.mcloGsUrl,
        qrCodeBase64: res.qrCodeBase64,
        loading: false,
      } : null)
    })
    .catch(() => {
      setCrashDialogState(prev => prev ? {
        ...prev,
        loading: false,
        error: '分析服务暂不可用',
      } : null)
    })
}
```

Update context value in render (line 118):
```typescript
value={{ runningInstances, launchProgress, launchingInstanceId, launchInstance, cancelLaunch, killInstance, setNotifyImpl, crashDialogState, clearCrashDialog }}
```

- [ ] **Step 2: Update Dashboard.tsx**

Remove `ErrorReportDialog` import, add:
```typescript
import { CrashAnalysisDialog } from '../components/CrashAnalysisDialog.tsx'
import { useRunning } from '../contexts/RunningContext.tsx'
```

At the top of the component body, read crash state:
```typescript
const { crashDialogState, clearCrashDialog } = useRunning()
```

Replace `<ErrorReportDialog ...>` with:
```typescript
<CrashAnalysisDialog
  open={!!launchError || !!crashDialogState}
  title={crashDialogState?.title || launchError?.title || ''}
  message={crashDialogState?.message || launchError?.message || ''}
  detail={crashDialogState?.detail || launchError?.detail}
  crashReport={crashDialogState?.crashReport}
  analysis={crashDialogState?.analysis}
  mcloGsUrl={crashDialogState?.mcloGsUrl}
  qrCodeBase64={crashDialogState?.qrCodeBase64}
  instanceId={crashDialogState?.instanceId || id}
  onClose={() => { setLaunchError(null); clearCrashDialog() }}
/>
```

Note: need `id` variable accessible — Dashboard already has `defaultInstance.id`, use `defaultInstance?.id`.

- [ ] **Step 3: Update InstanceDetail.tsx**

Remove `ErrorReportDialog` import, add:
```typescript
import { CrashAnalysisDialog } from '../components/CrashAnalysisDialog.tsx'
import { useRunning } from '../contexts/RunningContext.tsx'
```

At the top, read crash state:
```typescript
const { crashDialogState, clearCrashDialog } = useRunning()
```

Replace `<ErrorReportDialog ...>` with:
```typescript
<CrashAnalysisDialog
  open={!!launchError || !!crashDialogState}
  title={crashDialogState?.title || launchError?.title || ''}
  message={crashDialogState?.message || launchError?.message || ''}
  detail={crashDialogState?.detail || launchError?.detail}
  crashReport={crashDialogState?.crashReport}
  analysis={crashDialogState?.analysis}
  mcloGsUrl={crashDialogState?.mcloGsUrl}
  qrCodeBase64={crashDialogState?.qrCodeBase64}
  instanceId={crashDialogState?.instanceId || id}
  onClose={() => { setLaunchError(null); clearCrashDialog() }}
/>
```

- [ ] **Step 4: Modify LaunchProgressDialog.tsx**

Keep crash state display minimal — remove the export button (since CrashAnalysisDialog handles it), but keep crash notification. Or remove crash-specific sections entirely since CrashAnalysisDialog replaces it. The `isError` check can remain for visual indication but the export button can be removed.

- [ ] **Step 5: Update App.tsx**

Remove `ErrorReportDialog` — not imported here so no change needed.
Keep `LaunchProgressDialog` as is.

- [ ] **Step 6: Delete ErrorReportDialog.tsx**

`git rm src/components/ErrorReportDialog.tsx` or simply delete the file.

- [ ] **Step 7: Verify TypeScript build**

Run: `npx tsc --noEmit`
Expected: No type errors

---

### Task 7: Final verification

- [ ] **Step 1: Verify backend build**

Run: `cd src-backend/Qomicex.Launcher.Backend && dotnet build`

- [ ] **Step 2: Verify frontend build**

Run: `npm run build`
Expected: Build succeeds

- [ ] **Step 3: Verify frontend dev server**

Run: `npm run dev`
Expected: Vite starts on port 1420, no console errors
