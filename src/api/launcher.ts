import { post } from './client.ts'
import type { LauncherRequest } from '../types'

export function buildLaunchArguments(data: LauncherRequest): Promise<{ arguments: string }> {
  return post('/launcher/build-arguments', data)
}
