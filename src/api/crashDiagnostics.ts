// Copyright (C) 2026 Qomicex Launcher Contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { post } from './client.ts'
import type { CrashAnalysisResult } from '../types/index.ts'

export function analyzeCrash(instanceId: string): Promise<CrashAnalysisResult> {
  return post<CrashAnalysisResult>(`/loganalysis/analyze-crash/${instanceId}`)
}
