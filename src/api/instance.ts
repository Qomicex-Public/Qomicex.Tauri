import { get, post, put, del, API_BASE, ApiError } from './client.ts'
import { uploadFile } from './ipc.ts'
import { hookable } from '../plugins/hookable.ts'
import type { GameInstance, CreateInstanceRequest, LaunchResult, LaunchProgress, InstallProgressResponse, VerifyResourcesResult, RepairResourcesResult, GameSettingDto, ModpackParseResult, ModpackInstallRequest, ModpackInstallDirectRequest, ModpackInstallDirectResult, ModpackExportRequest, ModpackExportFileNode, ScannedVersion, MultiMcParseResult, MultiMcImportRequest } from '../types/index.ts'

export async function getInstances(): Promise<GameInstance[]> {
  return get<GameInstance[]>('/instance')
}

/// 将前端扫描结果同步到后端，返回同步后的实例列表。
/// 这是实例列表的核心同步入口，所有使用实例列表的地方都应通过此方法或 getInstances 获取数据。
/// 可被插件 hook（`hook:syncScan`）：before 修改 gameDir/versions，after 修改返回的实例列表。
export const syncScan = hookable('syncScan', async (gameDir: string, versions: ScannedVersion[]): Promise<GameInstance[]> => {
  return post<GameInstance[]>('/instance/sync-scan', {
    gameDir,
    versions: versions.map(v => {
      // 复用 firstRealLoader 逻辑：取第一个非 Vanilla/非 Unknown 的加载器
      const realLoader = v.loaders?.find(l => l.type && l.type !== 'Vanilla' && l.type !== 'Unknown')
      return {
        name: v.name,
        gameVersion: v.gameVersion,
        loader: realLoader?.type,
        loaderVersion: realLoader?.version,
        iconData: v.iconData,
        modpackName: v.modpack?.modpackName,
        modpackVersion: v.modpack?.modpackVersion,
        modpackAuthor: v.modpack?.modpackAuthor,
        modpackSummary: v.modpack?.modpackSummary,
      }
    }),
  })
})

export async function getInstance(id: string): Promise<GameInstance> {
  return get<GameInstance>(`/instance/${id}`)
}

export async function getDefaultInstance(): Promise<GameInstance | null> {
  return get<GameInstance | null>('/instance/default')
}

export async function setDefaultInstance(id: string): Promise<GameInstance> {
  return put<GameInstance>(`/instance/${id}/default`)
}

export async function clearDefaultInstance(id: string): Promise<void> {
  await del(`/instance/${id}/default`)
}

export async function createInstance(data: CreateInstanceRequest): Promise<GameInstance> {
  return post<GameInstance>('/instance', data)
}

export async function updateInstance(id: string, data: Partial<CreateInstanceRequest>): Promise<GameInstance> {
  return put<GameInstance>(`/instance/${id}`, data)
}

export async function deleteInstance(id: string): Promise<void> {
  await del(`/instance/${id}`)
}

// --- 实例自定义分组 ---

export interface InstanceGroup {
  id: string
  name: string
  color: string
}

export function getInstanceGroups(): Promise<InstanceGroup[]> {
  return get<InstanceGroup[]>('/instance-groups')
}

export function createInstanceGroup(name: string, color: string): Promise<InstanceGroup> {
  return post<InstanceGroup>('/instance-groups', { name, color })
}

export function updateInstanceGroup(id: string, name: string, color: string): Promise<InstanceGroup> {
  return put<InstanceGroup>(`/instance-groups/${id}`, { name, color })
}

export function deleteInstanceGroup(id: string): Promise<void> {
  return del<void>(`/instance-groups/${id}`)
}

export interface LaunchInstanceOptions {
  joinServer?: string
  joinWorld?: string
  accountUuid?: string
}

/// 启动实例。可被插件 hook（`hook:launchInstance`）：before 修改 options
/// （注入 joinServer/accountUuid 等），prevent 阻止启动，after 修改返回结果。
export const launchInstance = hookable('launchInstance', async (id: string, options?: LaunchInstanceOptions): Promise<LaunchResult> => {
  return post<LaunchResult>(`/instance/${id}/launch`, options || {})
})

/** 实时游戏日志的一行。 */
export interface GameLogLine {
  timestamp: string
  /** "out" = stdout，"err" = stderr。 */
  stream: 'out' | 'err'
  text: string
}

/** GET /api/instance/{id}/logs — 该实例已缓冲的历史日志。 */
export async function getInstanceLogs(id: string): Promise<{ instanceId: string; running: boolean; lines: GameLogLine[] }> {
  return get(`/instance/${encodeURIComponent(id)}/logs`)
}

export async function getLaunchProgress(id: string): Promise<LaunchProgress> {
  return get<LaunchProgress>(`/instance/${id}/launch/progress`)
}

export async function cancelLaunch(id: string): Promise<void> {
  await post(`/instance/${id}/launch/cancel`)
}

export async function startInstall(id: string, loader?: string, loaderVersion?: string, addons?: string[], downloadThreads?: number, versionIsolation?: boolean, downloadSource?: number, downloadTimeout?: number, optifineVersion?: string): Promise<void> {
  await post(`/instance/${id}/install`, { loader, loaderVersion, addons, downloadThreads, versionIsolation, downloadSourceId: downloadSource, downloadTimeout, optifineVersion })
}

export async function getInstallProgress(id: string): Promise<InstallProgressResponse> {
  return get<InstallProgressResponse>(`/instance/${id}/install/progress`)
}

export async function pauseInstall(id: string): Promise<void> {
  await post(`/instance/${id}/install/pause`)
}

export async function resumeInstall(id: string): Promise<void> {
  await post(`/instance/${id}/install/resume`)
}

export async function cancelInstall(id: string): Promise<void> {
  await post(`/instance/${id}/install/cancel`)
}

export async function repairInstance(id: string, threads?: number): Promise<void> {
  await post(`/instance/${id}/repair${threads ? `?threads=${threads}` : ''}`)
}

export async function verifyResources(id: string): Promise<VerifyResourcesResult> {
  return get<VerifyResourcesResult>(`/instance/${id}/verify-resources`)
}

export async function repairResources(id: string): Promise<RepairResourcesResult> {
  return post<RepairResourcesResult>(`/instance/${id}/repair-resources`)
}

export async function getGameSettings(id: string): Promise<GameSettingDto[]> {
  return get<GameSettingDto[]>(`/instance/${id}/files/options`)
}

export async function setGameSetting(id: string, name: string, value: string): Promise<void> {
  await put(`/instance/${id}/files/options/` + encodeURIComponent(name), { value })
}

export async function exportDiagnostics(id: string): Promise<void> {
  const res = await fetch(`${API_BASE}/instance/${id}/export-diagnostics`, { method: 'POST' })
  if (!res.ok) throw new ApiError({ code: 'EXPORT_DIAGNOSTICS_FAILED', message: '导出诊断报告失败', detail: null, traceId: '', timestamp: new Date().toISOString(), status: res.status })
  const blob = await res.blob()
  const disposition = res.headers.get('content-disposition')
  const match = disposition?.match(/filename="?(.+?)"?$/)
  const filename = match?.[1] || `diagnostics-${id}.zip`
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url; a.download = filename
  document.body.appendChild(a); a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}

export async function parseModpackFile(file: File): Promise<ModpackParseResult> {
  try {
    // IPC 模式下 multipart 走 ipc_stream 通道（WebView2 custom protocol 会丢 multipart body）
    const res = await uploadFile('/modpack/parse', file)
    if (!res.ok) {
      const err = await res.json().catch(() => ({}))
      if (err.message) throw new Error(String(err.message))
      throw new ApiError({ code: 'MODPACK_PARSE_FAILED', message: '解析失败', detail: typeof err.error === 'string' ? err.error : null, traceId: '', timestamp: new Date().toISOString(), status: res.status })
    }
    return res.json()
  } catch (e) {
    if (e instanceof ApiError) throw e
    throw new ApiError({ code: 'MODPACK_UPLOAD_FAILED', message: '上传中断/连接失败，请重试', detail: e instanceof Error ? e.message : null, traceId: '', timestamp: new Date().toISOString(), status: 0 })
  }
}

export async function resolveModpack(source: string, projectId: string, versionId: string): Promise<ModpackParseResult> {
  return post<ModpackParseResult>('/modpack/resolve', { source, projectId, versionId })
}

export async function startModpackInstall(data: ModpackInstallRequest): Promise<{ message: string; instanceId: string }> {
  const res = await post<{ message: string; versionId: string }>('/modpack/install', data)
  return { message: res.message, instanceId: res.versionId }
}

export async function installModpackDirect(data: ModpackInstallDirectRequest): Promise<ModpackInstallDirectResult> {
  return post<ModpackInstallDirectResult>('/modpack/install-direct', data)
}

/** 解析 MultiMC 实例文件夹（Tauri 目录选择器选中）。 */
export async function parseMultiMcFolder(path: string): Promise<MultiMcParseResult> {
  return post<MultiMcParseResult>('/modpack/multimc/parse-folder', { path })
}

/** 开始 MultiMC 导入（后台任务，进度走 /modpack/progress/{instanceId}）。 */
export async function startMultiMcImport(data: MultiMcImportRequest): Promise<{ instanceId: string }> {
  return post<{ instanceId: string }>('/modpack/multimc/import', data)
}

/** 读取实例可导出文件树（HMCL 风格勾选列表）。 */
export async function listExportFiles(instanceId: string): Promise<ModpackExportFileNode[]> {
  return get<ModpackExportFileNode[]>(`/modpack/export/files/${encodeURIComponent(instanceId)}`)
}

/** 导出任务状态（GET /modpack/export/task/{taskId}）。 */
export interface ExportTaskProgress {
  taskId: string
  instanceId: string
  status: 'running' | 'completed' | 'cancelled' | 'failed'
  /** lookup（识别文件指纹）/ manifest（生成配置文件）/ packing（打包游戏文件） */
  stage: string
  percent: number
  currentFile?: string
  error?: string
}

/** 启动导出任务（异步），返回 taskId。 */
export async function startExportTask(instanceId: string, req: ModpackExportRequest): Promise<string> {
  const res = await post<{ taskId: string }>(`/modpack/export/${encodeURIComponent(instanceId)}`, req)
  return res.taskId
}

/** 轮询导出任务进度。 */
export async function getExportTask(taskId: string): Promise<ExportTaskProgress> {
  return get<ExportTaskProgress>(`/modpack/export/task/${encodeURIComponent(taskId)}`)
}

/** 取消导出任务。 */
export async function cancelExportTask(taskId: string): Promise<void> {
  await post(`/modpack/export/task/${encodeURIComponent(taskId)}/cancel`, {})
}

/** 下载导出任务产物（仅未传 targetPath 的任务；取走后任务清理）。 */
export async function downloadExportTask(taskId: string): Promise<{ blob: Blob; filename: string }> {
  const res = await fetch(`${API_BASE}/modpack/export/task/${encodeURIComponent(taskId)}/download`)
  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    throw new Error(err.message || err.error || `导出下载失败 (${res.status})`)
  }
  const blob = await res.blob()
  const disposition = res.headers.get('content-disposition')
  const match = disposition?.match(/filename="?(.+?)"?$/)
  const filename = match?.[1] || 'modpack.zip'
  return { blob, filename }
}
