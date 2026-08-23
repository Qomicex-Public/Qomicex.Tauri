import { post } from './client.ts'

export type DropFileType = 'modpack' | 'mod' | 'resourcepack' | 'shaderpack' | 'unknown'

export interface ClassifyFileResult {
  fileType: DropFileType
  fileName: string
  packName?: string
  gameVersion?: string
  loader?: string
  summary?: string
}

/** POST /resource/classify-file — 探测拖入文件的安装类型与整合包元数据 */
export function classifyFile(path: string): Promise<ClassifyFileResult> {
  return post<ClassifyFileResult>('/resource/classify-file', { path })
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
