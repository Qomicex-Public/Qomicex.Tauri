import { get, post } from './client.ts'
import type { ConnectorStatus, EasyTierStatus } from '../types/index.ts'

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

export function getEasyTierStatus(): Promise<EasyTierStatus> {
  return get<EasyTierStatus>('/connector/easytier/status')
}

export function downloadEasyTier(): Promise<EasyTierStatus> {
  return post<EasyTierStatus>('/connector/easytier/download')
}
