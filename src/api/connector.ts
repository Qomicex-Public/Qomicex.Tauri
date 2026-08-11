import { get, post } from './client.ts'
import type { ConnectorStatus, EasyTierStatus, NatTypeResult } from '../types/index.ts'

export function hostByPort(port: number): Promise<{ roomCode: string }> {
  return post('/connector/host/port', { port })
}

export function hostByInstance(instanceId: string): Promise<{ status: string }> {
  return post('/connector/host/instance', { instanceId })
}

export function joinRoom(code: string): Promise<{ mcHost: string; mcPort: number }> {
  return post('/connector/join', { code })
}

export function getStatus(): Promise<ConnectorStatus> {
  return get<ConnectorStatus>('/connector/status')
}

export function leave(): Promise<{ status: string }> {
  return post('/connector/leave')
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
