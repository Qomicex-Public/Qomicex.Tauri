# CrashAnalysisDialog：游戏崩溃错误分析改进设计

## 1. 背景与目标

当前游戏崩溃后，用户看到的是两个脱节的 Dialog：
- `LaunchProgressDialog` — 短暂展示崩溃信息后关闭
- `ErrorReportDialog` — 仅展示错误文本，无分析能力

`LogAnalysis` 页面虽实现了完整的日志分析能力，但未注册到路由，且与崩溃流程完全脱节。

**目标：** 游戏崩溃后自动触发日志分析，将错误信息、QR 码、分析结果整合为统一的 `CrashAnalysisDialog`，对标 Avalonia 版本的 `CrashAnalysisDialog` 体验。

## 2. 架构概览

```
┌─ 前端 ─────────────────────────────────────────┐
│  RunningContext                                 │
│    │ 轮询检测到 crashed/failed                  │
│    ├─→ POST analyze-crash/{id}                  │
│    └─→ setCrashDialogState()                    │
│         └─→ CrashAnalysisDialog 自动弹出         │
│               ├─ 错误信息 + QR 码（顶部）         │
│               └─ 分析结果列表（底部）             │
└────────────────────────────────────────────────┘
                        │
                        ▼
┌─ 后端 ─────────────────────────────────────────┐
│  LogAnalysisController.AnalyzeCrash()            │
│    ├─ 读取 LaunchProgress.CrashReport            │
│    ├─ MinecraftLogAnalyzer 分析                  │
│    ├─ CrashUploadService → mclo.gs               │
│    └─ 返回 { analysis, mcloGsUrl, qrCodeBase64 } │
└────────────────────────────────────────────────┘
```

## 3. 后端设计

### 3.1 新增端点

```http
POST /api/loganalysis/analyze-crash/{instanceId}
```

请求体：无（从 `LaunchService` 获取 crash report）

响应体：
```json
{
  "analysis": {
    "isSuccess": true,
    "minecraftVersion": "1.20.1",
    "modLoader": "Forge 47.1.0",
    "loadedMods": ["mod1", "mod2"],
    "stackTrace": "at net.minecraft...",
    "issues": [
      {
        "patternId": "out-of-memory-heap",
        "category": "Memory",
        "severity": "Critical",
        "lineNumber": 42,
        "matchedText": "OutOfMemoryError: Java heap space",
        "solutions": [
          { "title": "增加内存", "description": "将 -Xmx 设为 4G 以上", "action": "open-settings" }
        ]
      }
    ]
  },
  "mcloGsUrl": "https://api.mclo.gs/1/log/xxxxxx",
  "qrCodeBase64": "data:image/png;base64,..."
}
```

错误响应：标准 `ApiError` 格式。

### 3.2 新增服务：CrashUploadService

封装 mclo.gs 上传+QR码生成逻辑。

- `UploadCrashLogAsync(string content)` → `(string url, byte[] qrCodePng)`
- 使用 `HttpClient` POST 到 `https://api.mclo.gs/1/log`
- POST body: `{ "content": "...", "source": "Qomicex-Launcher", "metadata": { "launcher_version": "...", "visible": true } }`
- 使用 `QRCoder` v1.7+ `QRCodeGenerator` 生成 QR Code（ECC Level Q, 20px/模块）
- 使用 `SkiaSharp` 渲染为 PNG

异常处理：
- mclo.gs 不可用 → 记录警告，返回空 URL 和 null QR code，不影响本地分析

### 3.x SuggestedSolution 字段映射

当前存在前后端类型不匹配：C# `SuggestedSolution` 序列化为 `{ description, actionType }`，但前端 TS 类型为 `{ title, description, action }`。在 `analyze-crash` 端点中解决此问题：

在后端 Controller 中手动映射：
- `"title"` = `Description` 的第一句或前 30 字（截断加 `...`）
- `"description"` = `Description` 完整内容
- `"action"` = `ActionType`

返回给前端的 JSON 结构必须与 TS 类型 `SuggestedSolution` 一致。

### 3.3 新增端点：Controller 逻辑

`LogAnalysisController.AnalyzeCrash(string id)`：
1. 通过 IInstanceRepository 获取实例
2. 通过 ILaunchService 获取当前 LaunchProgress
3. 若 CrashReport 为 null/空 → 返回 `ApiException.NotFound("无崩溃报告可用")`
4. 执行 `MinecraftLogAnalyzer.AnalyzeContentAsync(crashReport)`
5. 执行 `CrashUploadService.UploadCrashLogAsync(crashReport)`
6. 组装返回结果

### 3.4 修改文件

| 文件 | 变更 |
|------|------|
| `Controllers/LogAnalysisController.cs` | 新增 `AnalyzeCrash` 端点 |
| `Services/CrashUploadService.cs` | **新建** — mclo.gs 上传 + QR 码生成 |
| `Program.cs` | 注册 `CrashUploadService`（HttpClient + Singleton） |
| `.csproj` | 添加 `QRCoder`、`SkiaSharp` NuGet 包 |

## 4. 前端设计

### 4.1 组件结构

```
CrashAnalysisDialog              ← 合并 ErrorReportDialog + LogAnalysis
├─ Header: title + crash ID + close
├─ Body
│  ├─ Row: ErrorInfo (左) + QRCodeCard (右)
│  ├─ Collapse: 崩溃报告/错误详情
│  ├─ Separator: "分析结果"
│  ├─ AnalysisSummary (badge: 严重/错误/警告 计数)
│  ├─ AnalysisResults             ← 从 LogAnalysis.tsx 提取的纯渲染组件
│  │  └─ IssueCard[] (每条: 类别/行号/匹配文本/解决方案)
│  ├─ Collapse: 异常堆栈
│  └─ Collapse: 完整日志
└─ Footer: [复制全部] [导出诊断报告] [关闭]
```

### 4.2 新增/修改文件

| 文件 | 变更 |
|------|------|
| `src/components/CrashAnalysisDialog.tsx` | **新建** — 整合 Dialog |
| `src/components/AnalysisResults.tsx` | **新建** — 从 LogAnalysis.tsx 提取的问题列表组件 |
| `src/api/crashDiagnostics.ts` | **新建** — `analyzeCrash(id)` API 函数 |
| `src/contexts/RunningContext.tsx` | 新增 `crashDialogState` + auto-trigger 逻辑 |
| `src/pages/Dashboard.tsx` | 替换 `ErrorReportDialog` → `CrashAnalysisDialog` + 传 `instanceId` |
| `src/pages/InstanceDetail.tsx` | 同上 |
| `src/components/LaunchProgressDialog.tsx` | 移除崩溃专用 UI（已移到新 Dialog） |
| `src/types/index.ts` | 新增 `CrashAnalysisResult`、`CrashDialogState` 类型 |
| `src/components/ErrorReportDialog.tsx` | **删除**（功能合并到 CrashAnalysisDialog） |

### 4.3 类型定义

```typescript
// CrashAnalysisResult — 后端 /api/loganalysis/analyze-crash 返回
export interface CrashAnalysisResult {
  analysis: LogAnalysisResult
  mcloGsUrl: string
  qrCodeBase64: string
}

// CrashDialogState — RunningContext 中的崩溃对话框状态
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

### 4.4 API 层

```typescript
// src/api/crashDiagnostics.ts
export function analyzeCrash(instanceId: string): Promise<CrashAnalysisResult> {
  return post(`/loganalysis/analyze-crash/${instanceId}`)
}
```

### 4.5 RunningContext 变更

新增状态：
```typescript
const [crashDialogState, setCrashDialogState] = useState<CrashDialogState | null>(null)
```

轮询检测到 crashed/failed 时的处理逻辑（原文第58-63行修改）：

```
当 stage === "crashed" || stage === "failed":
  1. resolve launchingInstanceId 和 launchingInstanceName
  2. 设置 setCrashDialogState({
       instanceId, loading: true,
       title, message, detail, crashReport
     })
  3. 并行执行:
     - 调用 analyzeCrash(instanceId) → 获取分析结果 + QR码
     - 成功 → 更新 crashDialogState (loading=false, analysis, mcloGsUrl, qrCodeBase64)
     - 失败 → 更新 crashDialogState (loading=false, error)
  4. 原 toast 通知保留
  5. 不清除 crashDialogState（点击关闭按钮时清除）
```

暴露 `clearCrashDialog()` 方法供 Dialog 关闭时调用。

### 4.6 UI 布局细节

**Dialog 规格：**
- 宽度: `max-w-2xl` (对比旧 ErrorReportDialog 的 `max-w-lg`)
- 内容区: `max-h-[70vh] overflow-y-auto`
- 关闭方式: 点击关闭按钮 / Footer 关闭按钮 / Esc 键

**二维码卡片：**
- 尺寸: 140×140px Border，内部 120×120px QR Code
- 加载中: Skeleton（灰块 + 脉冲动画）
- 加载完成: 显示 QR Code Image
- 加载失败: 显示文字链接（mcloGsUrl），不展示二维码
- 二维码下方显示 URL 简写（如 `mclo.gs/xxxxxx`），提取自 `mcloGsUrl` 的路径部分
- 点击: `window.open(mcloGsUrl, '_blank')`
- Hover Tooltip: 显示完整 URL

**分析结果：**
- 顶部汇总 Badge（严重 Count → `variant="destructive"`，错误 → `variant="default"`，警告 → `variant="secondary"`）
- 每条 Issue：
  - 左框线颜色: Critical=destructive, Error=red-500, Warning=yellow-500, Info=blue-500
  - 行: 类别标签 | 行号 | 匹配文本
  - 可折叠: 建议解决方案
- 无问题 → "未发现明显问题"

**错误详情/崩溃报告：**
- 默认折叠
- summary: "崩溃报告" / "错误详情"
- content: `<pre>` 标签，`max-h-48 overflow-auto`

**完整日志：**
- 默认折叠
- 放置在异常堆栈下方（若有），或分析结果最下方
- 标题: "完整日志（自动分析源）"

**加载状态：**
- 二维码区域: Skeleton 脉冲
- 分析结果区域: "正在分析日志..." + Spinner
- 整体 Dialog 不会因加载而阻塞，用户可以先看错误信息

**Tauri 集成：**
- QR 码点击使用 `window.open(mcloGsUrl, '_blank')`（外部链接，符合 AGENTS.md 规范）
- 导出诊断报告沿用现有 `exportDiagnostics(instanceId)`

### 4.7 边界情况处理

| 场景 | 行为 |
|------|------|
| 崩溃报告为空 | 调用 `analyzeLog(message)` 代替，或无分析结果 |
| mclo.gs 上传失败 | 返回空 URL，二维码区域显示"上传失败"，不阻塞分析结果展示 |
| 后端分析超时/失败 | analysis 字段为 null，显示"分析服务暂不可用，请稍后重试" |
| 实例已删除后崩溃 | instanceId 无效，API 返回 404，Dialog 显示基础错误信息 |
| 连续快速崩溃 | 每次崩溃都独立触发，后一次覆盖前一次的状态 |
| 网络断开 | 分析请求失败，Dialog 保留基础错误信息，显示"网络连接异常" |
| 窗口关闭后再打开 | 当前 `crashDialogState` 不清除，除非用户主动关闭 |

## 5. 渐进式实施计划

### Phase 1：后端（CrashUploadService + 新端点）
1. 添加 QRCoder + SkiaSharp 依赖
2. 实现 `CrashUploadService`
3. 在 `LogAnalysisController` 添加 `AnalyzeCrash` 端点
4. 在 `Program.cs` 注册服务

### Phase 2：前端基础组件
1. 创建 `types/index.ts` 新类型
2. 创建 `api/crashDiagnostics.ts`
3. 从 `LogAnalysis.tsx` 提取 `AnalysisResults.tsx`
4. 创建 `CrashAnalysisDialog.tsx`

### Phase 3：集成
1. 修改 `RunningContext.tsx` — 崩溃自动触发分析
2. 修改 `Dashboard.tsx` 和 `InstanceDetail.tsx` — 替换 Dialog
3. 清理 `LaunchProgressDialog.tsx` 中崩溃相关 UI
4. 删除 `ErrorReportDialog.tsx`

## 6. 文件变更完整清单

### 后端（新增 2，修改 3）

| 操作 | 文件 |
|------|------|
| **新建** | `Services/CrashUploadService.cs` |
| **修改** | `Controllers/LogAnalysisController.cs` |
| **修改** | `Program.cs` |
| **修改** | `Qomicex.Launcher.Backend.csproj` |

### 前端（新增 3，删除 1，修改 5）

| 操作 | 文件 |
|------|------|
| **新建** | `src/components/CrashAnalysisDialog.tsx` |
| **新建** | `src/components/AnalysisResults.tsx` |
| **新建** | `src/api/crashDiagnostics.ts` |
| **删除** | `src/components/ErrorReportDialog.tsx` |
| **修改** | `src/types/index.ts` |
| **修改** | `src/contexts/RunningContext.tsx` |
| **修改** | `src/pages/Dashboard.tsx` |
| **修改** | `src/pages/InstanceDetail.tsx` |
| **修改** | `src/components/LaunchProgressDialog.tsx` |
| **修改** | `src/App.tsx` | 渲染 CrashAnalysisDialog（与 LaunchProgressDialog 同级） |
