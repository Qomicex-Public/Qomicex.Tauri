import { del, get, post } from './client.ts'
import type { JavaRuntime } from '../types/index.ts'

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
