// Copyright (C) 2026 Qomicex Launcher Contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { getSystemInfo } from '../../../api/system.ts'

let cached: string | null | undefined

/** 当前启动器版本；后端不可用时返回 null（自定义组件不做版本拦截）。 */
export async function getLauncherVersion(): Promise<string | null> {
  if (cached !== undefined) return cached
  try {
    const info = await getSystemInfo()
    cached = info.appVersion?.trim() || null
  } catch {
    cached = null
  }
  return cached
}
