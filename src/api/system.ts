import { get } from './client.ts'
import type { SystemInfo } from '../types'

export function getSystemInfo(): Promise<SystemInfo> {
  return get<SystemInfo>('/systeminfo')
}

export interface ProcessResourceUsage {
  pid: number
  cpuUsage: number
  memoryUsage: number
  memoryUsageMb: number
}

export function getProcessResourceUsage(pid: number): Promise<ProcessResourceUsage> {
  return get<ProcessResourceUsage>(`/process/${pid}/resource-usage`)
}
