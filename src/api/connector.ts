import { ApiError, get, post } from './client.ts'
import type { ConnectorStatus, EasyTierStatus, NatTypeResult } from '../types/index.ts'

/** 建房/加入房间涉及 easytier 启动（≤30s）与 P2P 打洞重试（~50s），
 * 最坏数十秒；绕过全局 15s 超时（对齐 instance-files.ts enrichMods 先例）。
 * 后端对应整体超时 75s + 清理尾随，120s 保证总能收到后端真实响应。 */
const CONNECTOR_LONG_TIMEOUT_MS = 120_000

/** 长超时 POST：AbortError 转为友好中文错误（外部 signal 优先于全局 15s）。 */
function longPost<T>(path: string, body?: unknown): Promise<T> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), CONNECTOR_LONG_TIMEOUT_MS)
  return post<T>(path, body, { signal: controller.signal })
    .finally(() => clearTimeout(timer))
    .catch((e) => {
      if (controller.signal.aborted) {
        throw new ApiError({
          code: 'CONNECTOR_TIMEOUT',
          message: `联机操作超时（${CONNECTOR_LONG_TIMEOUT_MS / 1000}s），请检查网络后重试`,
          detail: path,
          traceId: '',
          timestamp: new Date().toISOString(),
          status: 0,
        })
      }
      throw e
    })
}

export function hostByPort(port: number): Promise<{ roomCode: string }> {
  return longPost<{ roomCode: string }>('/connector/host/port', { port })
}

export function hostByInstance(instanceId: string): Promise<{ status: string }> {
  return post('/connector/host/instance', { instanceId })
}

export function joinRoom(code: string): Promise<{ mcHost: string; mcPort: number }> {
  return longPost<{ mcHost: string; mcPort: number }>('/connector/join', { code })
}

export function getStatus(): Promise<ConnectorStatus> {
  return get<ConnectorStatus>('/connector/status')
}

export function leave(): Promise<{ status: string }> {
  return post('/connector/leave')
}

export function kickPlayer(machineId: string): Promise<{ status: string }> {
  return post('/connector/kick', { machineId })
}

export function decideKickReview(machineId: string, action: 'allow' | 'reject' | 'reject_silent'): Promise<{ status: string }> {
  return post('/connector/kick/review', { machineId, action })
}

export interface GameModEntry {
  source: string
  id: string
  hash: string
  name: string
}

export interface MatchedInstance {
  instanceId: string
  name: string
  gameVersion: string
  loader?: string | null
  loaderVersion?: string | null
  matched: boolean
  modCount: number
}

export interface MatchInstancesResponse {
  mods: GameModEntry[]
  /** 参考实例缺失的房主 mod 的 sha1（按房主 mods 顺序）；用于给房主 Mods 列表加"缺失"标记 */
  missingHashes: string[]
  /** 作为缺失判定参考的本地实例（覆盖房主 mods 最多）名称；无同版本实例时为 null */
  referenceInstance: string | null
  instances: MatchedInstance[]
}

export function matchInstances(): Promise<MatchInstancesResponse> {
  return get<MatchInstancesResponse>('/connector/match-instances')
}

export function getEasyTierStatus(): Promise<EasyTierStatus> {
  return get<EasyTierStatus>('/connector/easytier/status')
}

export function downloadEasyTier(): Promise<EasyTierStatus> {
  return post<EasyTierStatus>('/connector/easytier/download')
}

export function scanPorts(): Promise<{ port: number | null }> {
  return get('/connector/scan-ports')
}

export function getNatType(): Promise<NatTypeResult> {
  return get<NatTypeResult>('/connector/nat-type')
}
