import { post } from './client.ts'

export type DropFileType = 'modpack' | 'mod' | 'resourcepack' | 'shaderpack' | 'unknown'

export interface ClassifyFileResult {
  fileType: DropFileType
  fileName: string
  packName?: string
  gameVersion?: string
  loader?: string
  summary?: string
  /** 文件字节数（后端 `fileSize`）：用于给后续导入请求分级放宽超时。 */
  fileSize?: number
}

const MB = 1024 * 1024

/**
 * 整合包导入请求的超时分级（issue #119）。
 *
 * 全局 15s 上限对大型整合包不够：解析 zip 索引 + 触发后台安装管的耗时随包体积 /
 * 条目数增长，越过 15s 会让前端误报「请求超时」并丢掉下载中心任务（后端其实仍在装，
 * 于是出现「实例装好了但下载中心查不到」）。按文件大小分级放宽，>512MB 给 2 分钟兜底。
 */
export function modpackRequestTimeout(fileSize?: number): number {
  if (fileSize && fileSize > 512 * MB) return 120_000
  return 60_000
}

/** POST /resource/classify-file — 探测拖入文件的安装类型与整合包元数据 */
export async function classifyFile(path: string, timeoutMs = 60_000): Promise<ClassifyFileResult> {
  // 大整合包的 zip 索引解析可能超过全局 15s：这里默认就放宽到 60s。
  return await post<ClassifyFileResult>('/resource/classify-file', { path }, { timeoutMs })
}

export interface ImportLocalResult {
  fileName: string
  targetPath: string
}

/** POST /instance/{id}/files/import-local — 把本地文件复制进实例的分类目录 */
export function importLocalFile(
  instanceId: string,
  category: 'mods' | 'resourcepacks' | 'shaderpacks',
  sourcePath: string,
): Promise<ImportLocalResult> {
  return post<ImportLocalResult>(`/instance/${encodeURIComponent(instanceId)}/files/import-local`, {
    category,
    sourcePath,
  })
}
