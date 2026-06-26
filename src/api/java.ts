import { get, post } from './client.ts'
import type { JavaRuntime } from '../types'

export function searchJava(): Promise<JavaRuntime[]> {
  return get<JavaRuntime[]>('/java/search')
}

export function getRecommendedJava(minecraftVersion: string, gameDir: string): Promise<JavaRuntime[]> {
  return post<JavaRuntime[]>('/java/recommended', { minecraftVersion, gameDir })
}

export function validateJavaPath(path: string): Promise<JavaRuntime> {
  return post<JavaRuntime>('/java/validate', { path })
}
