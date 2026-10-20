// Copyright (C) 2026 Qomicex Launcher Contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { get } from './client.ts'
import type { SystemInfo } from '../types'

export function getSystemInfo(): Promise<SystemInfo> {
  return get<SystemInfo>('/systeminfo')
}

/** 本机区域判定（后端按时区算，见 `services::region`）。 */
export interface RegionInfo {
  chinaMainland: boolean
  /** 当前是否禁止新增离线账户（中国大陆 + 风口期开关）。 */
  offlineLoginRestricted: boolean
}

export function getRegion(): Promise<RegionInfo> {
  return get<RegionInfo>('/system/region')
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
