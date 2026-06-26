import { get } from './client.ts'
import type { SystemInfo } from '../types'

export function getSystemInfo(): Promise<SystemInfo> {
  return get<SystemInfo>('/systeminfo')
}
