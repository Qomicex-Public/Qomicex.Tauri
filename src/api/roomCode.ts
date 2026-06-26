import { post } from './client.ts'
import type { RoomCodeResponse } from '../types'

export function generateRoomCode(): Promise<RoomCodeResponse> {
  return post('/roomcode/generate')
}

export function validateRoomCode(code: string): Promise<{ valid: boolean }> {
  return post('/roomcode/validate', { code })
}
