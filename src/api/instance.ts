import { get, post, put, del, API_BASE, ApiError } from './client.ts'
import { uploadFile } from './ipc.ts'
import { MODPACK_REQUEST_TIMEOUT_MS } from './drop-install.ts'
import { hookable } from '../plugins/hookable.ts'
import type { GameInstance, CreateInstanceRequest, LaunchResult, LaunchProgress, InstallProgressResponse, VerifyResourcesResult, RepairResourcesResult, GameSettingDto, ModpackParseResult, ModpackInstallRequest, ModpackInstallDirectRequest, ModpackInstallDirectResult, ModpackExportRequest, ModpackExportFileNode, ScannedVersion, MultiMcParseResult, MultiMcImportRequest, ModpackUpdateCheck, ModpackUpdatePreview } from '../types/index.ts'

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

/** 维护类长任务（修复/校验）的超时宽限：会遍历并下载大量游戏文件，全局默认远不够。 */
const LONG_MAINTENANCE_TIMEOUT_MS = 30 * 60_000

export async function repairInstance(id: string, threads?: number): Promise<void> {
  // 修复会真实下载缺失文件（可能有几百 MB），全局默认超时远不够；用长超时信号。
  await post(`/instance/${id}/repair${threads ? `?threads=${threads}` : ''}`, undefined, { timeoutMs: LONG_MAINTENANCE_TIMEOUT_MS })
}

export async function verifyResources(id: string): Promise<VerifyResourcesResult> {
  // 完整性校验要遍历+哈希全部游戏文件，冷盘上远超默认超时。
  return get<VerifyResourcesResult>(`/instance/${id}/verify-resources`, { timeoutMs: LONG_MAINTENANCE_TIMEOUT_MS })
}

export async function repairResources(id: string): Promise<RepairResourcesResult> {
  // 同 repairInstance：后台任务会在下载，这里放宽以免前端误报「请求超时」。
  return post<RepairResourcesResult>(`/instance/${id}/repair-resources`, undefined, { timeoutMs: LONG_MAINTENANCE_TIMEOUT_MS })
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

/** 按本地路径解析整合包（Tauri file-drop 场景）。大文件解析耗时长，用整合包宽限期。 */
export async function parseModpackFileByPath(path: string): Promise<ModpackParseResult> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), MODPACK_REQUEST_TIMEOUT_MS)
  try {
    const res = await post<ModpackParseResult>('/modpack/parse-path', { path }, { signal: controller.signal })
    return res
  } finally {
    clearTimeout(timer)
  }
}

export async function resolveModpack(source: string, projectId: string, versionId: string): Promise<ModpackParseResult> {
  return post<ModpackParseResult>('/modpack/resolve', { source, projectId, versionId })
}

export async function startModpackInstall(data: ModpackInstallRequest): Promise<{ message: string; instanceId: string }> {
  const res = await post<{ message: string; versionId: string }>('/modpack/install', data)
  return { message: res.message, instanceId: res.versionId }
}

// --- 整合包原地更新（issue #118）---

/**
 * 检查该实例是否有可用的整合包更新。
 *
 * 后端按「平台 id 定身份、datePublished 定先后」判定；`eligible: false` 时
 * `reason` 给出不可更新的原因码；`incomplete: true` 表示平台版本列表可能缺项
 * （此时「没有更新」不可信，UI 必须提示）。
 */
export async function checkModpackUpdate(id: string): Promise<ModpackUpdateCheck> {
  return get<ModpackUpdateCheck>(`/instance/${encodeURIComponent(id)}/modpack/update-check`)
}

/** 预览某目标版本将带来的变更（只读，不改实例）。 */
export async function previewModpackUpdate(id: string, targetVersionId: string): Promise<ModpackUpdatePreview> {
  return post<ModpackUpdatePreview>(
    `/instance/${encodeURIComponent(id)}/modpack/update-preview`,
    { targetVersionId },
    { timeoutMs: MODPACK_REQUEST_TIMEOUT_MS },
  )
}

/**
 * 启动原地更新（后台任务，进度走 install tracker / SSE）。
 *
 * 与安装的关键区别：更新**绝不**删除实例，失败时后端按 journal 回滚到更新前状态。
 */
export async function startModpackUpdate(id: string, targetVersionId: string): Promise<void> {
  await post(
    `/instance/${encodeURIComponent(id)}/modpack/update`,
    { targetVersionId },
    { timeoutMs: MODPACK_REQUEST_TIMEOUT_MS },
  )
}

/**
 * 一键导入整合包（拖拽导入链路）。
 *
 * `timeoutMs` 默认 60s：该请求要先解析本地 zip（索引探测），大包上超过全局 15s 会误报
 * 「请求超时」并丢掉下载中心任务（issue #119）；超大包由调用方按文件大小进一步放宽。
 */
export async function installModpackDirect(
  data: ModpackInstallDirectRequest,
  timeoutMs = MODPACK_REQUEST_TIMEOUT_MS,
): Promise<ModpackInstallDirectResult> {
  return post<ModpackInstallDirectResult>('/modpack/install-direct', data, { timeoutMs })
}

/** 解析 MultiMC 实例文件夹（Tauri 目录选择器选中）。 */
export async function parseMultiMcFolder(path: string): Promise<MultiMcParseResult> {
  return post<MultiMcParseResult>('/modpack/multimc/parse-folder', { path })
}

/**
 * 开始 MultiMC 导入（后台任务，进度走 /modpack/progress/{instanceId}）。
 *
 * sourcePath 指向 zip 时同样要先解析 zip 索引：与 parse-path 一致放宽到 60s，
 * 避免大型 MultiMC 包在导入对话框里触发 15s 超时（issue #119）。
 */
export async function startMultiMcImport(data: MultiMcImportRequest): Promise<{ instanceId: string }> {
  return post<{ instanceId: string }>('/modpack/multimc/import', data, { timeoutMs: MODPACK_REQUEST_TIMEOUT_MS })
}

/** Technic 导入请求（issue #123 期1；sourcePath = SingleZip 包体绝对路径）。 */
export interface TechnicImportRequest {
  sourcePath: string
  name: string
  gameDir: string
  versionIsolation?: boolean
}

/**
 * 开始 Technic SingleZip 导入（后台任务，进度走 /modpack/progress/{instanceId}）。
 * sourcePath 指向 zip：同 MultiMC zip 导入放宽到 60s，避免大型包 15s 超时（issue #119）。
 */
export async function startTechnicImport(data: TechnicImportRequest): Promise<{ instanceId: string }> {
  return post<{ instanceId: string }>('/modpack/technic/import', data, { timeoutMs: MODPACK_REQUEST_TIMEOUT_MS })
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
