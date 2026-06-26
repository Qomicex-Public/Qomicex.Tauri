import { post } from './client.ts'
import type { LogAnalysisResult } from '../types'

export function analyzeLog(logContent: string): Promise<LogAnalysisResult> {
  return post('/loganalysis/analyze', { logContent })
}
