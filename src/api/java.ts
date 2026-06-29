import { del, get, post } from './client.ts'
import type {
  JavaRuntime,
  JavaDownloadCatalogResponse,
  JavaDownloadStartRequest,
  JavaDownloadStartResponse,
  JavaDownloadProgressResponse,
} from '../types/index.ts'

export type JavaSearchMode = 'quick' | 'deep'

export function searchJava(mode: JavaSearchMode = 'quick'): Promise<JavaRuntime[]> {
  return get<JavaRuntime[]>(`/java/search?mode=${mode}`)
}

export function getJavaList(mode: JavaSearchMode = 'quick'): Promise<JavaRuntime[]> {
  return get<JavaRuntime[]>(`/java/list?mode=${mode}`)
}

export function getCustomJavaRuntimes(): Promise<JavaRuntime[]> {
  return get<JavaRuntime[]>('/java/custom')
}

export function addCustomJavaRuntime(path: string): Promise<JavaRuntime> {
  return post<JavaRuntime>('/java/custom', { path })
}

export function removeCustomJavaRuntime(path: string): Promise<void> {
  return del<void>('/java/custom', { path })
}

export function getRecommendedJava(minecraftVersion: string, gameDir: string): Promise<JavaRuntime[]> {
  return post<JavaRuntime[]>('/java/recommended', { minecraftVersion, gameDir })
}

export function validateJavaPath(path: string): Promise<JavaRuntime> {
  return post<JavaRuntime>('/java/validate', { path })
}

export function getJavaDownloadCatalog(): Promise<JavaDownloadCatalogResponse> {
  return get<JavaDownloadCatalogResponse>('/java/download/catalog')
}

export function startJavaDownload(body: JavaDownloadStartRequest): Promise<JavaDownloadStartResponse> {
  return post<JavaDownloadStartResponse>('/java/download/start', body)
}

export function getJavaDownloadProgress(taskId: string): Promise<JavaDownloadProgressResponse> {
  return get<JavaDownloadProgressResponse>(`/java/download/progress/${taskId}`)
}

export function cancelJavaDownload(taskId: string): Promise<void> {
  return del<void>(`/java/download/${taskId}`)
}

export function pauseJavaDownload(taskId: string): Promise<void> {
  return post<void>(`/java/download/${taskId}/pause`)
}

export function resumeJavaDownload(taskId: string): Promise<void> {
  return post<void>(`/java/download/${taskId}/resume`)
}
