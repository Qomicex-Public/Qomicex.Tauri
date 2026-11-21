// Copyright (C) 2026 Qomicex Launcher Contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { useSyncExternalStore } from 'react'
import { getTasks, subscribe } from '../stores/downloadStore.ts'
import type { DownloadTask } from '../types/index.ts'

/** 响应式读取下载任务：store 每次变更替换 `tasks` 引用，可直接作为快照。
 * 独立成文件是为了让 downloadStore 保持无 React 依赖（scripts/test-download-store-dedupe.mjs 直接编译它）。 */
export function useDownloadTasks(): DownloadTask[] {
  return useSyncExternalStore(subscribe, getTasks)
}
