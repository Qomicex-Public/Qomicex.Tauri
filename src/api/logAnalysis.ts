// Copyright (C) 2026 Qomicex Launcher Contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { post } from './client.ts'
import type { LogAnalysisResult } from '../types'

export function analyzeLog(logContent: string): Promise<LogAnalysisResult> {
  return post('/loganalysis/analyze', { logContent })
}
