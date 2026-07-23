import { get, post } from './client.ts'

export interface LicenseStatus {
  valid: boolean
  machineCode?: string
  licenseId?: string
  channel?: string
  expireAt?: string
  isPermanent: boolean
  error?: string
}

export interface LicenseActivateResponse {
  success: boolean
  licenseId?: string
  channel?: string
  expireAt?: string
  isPermanent: boolean
  error?: string
}

let cachedStatus: LicenseStatus | null = null

export function getCachedLicenseStatus() {
  return cachedStatus
}

export async function fetchLicenseStatus(): Promise<LicenseStatus> {
  cachedStatus = await get<LicenseStatus>('/license/status')
  return cachedStatus
}

export async function activateLicense(token: string): Promise<LicenseActivateResponse> {
  const result = await post<LicenseActivateResponse>('/license/activate', { licenseToken: token })
  if (result.success) {
    cachedStatus = null
  }
  return result
}
