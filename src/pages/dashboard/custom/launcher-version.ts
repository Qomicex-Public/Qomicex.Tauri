// Copyright (C) 2026 Qomicex Launcher Contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { getSystemInfo } from '../../../api/system.ts'

let pending: Promise<string | null> | undefined

/** 当前启动器版本；后端不可用时返回 null（自定义组件不做版本拦截）。 */
export function getLauncherVersion(): Promise<string | null> {
  if (!pending) {
    pending = getSystemInfo()
      .then((info) => info.appVersion?.trim() || null)
      .catch(() => {
        pending = undefined
        return null
      })
  }
  return pending
}
