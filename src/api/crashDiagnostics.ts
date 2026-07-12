import { post } from './client.ts'
import type { CrashAnalysisResult } from '../types/index.ts'

export function analyzeCrash(instanceId: string): Promise<CrashAnalysisResult> {
  return post<CrashAnalysisResult>(`/loganalysis/analyze-crash/${instanceId}`)
}
