// 后端错误码 → 翻译 key 映射（前端统一映射，后端零改动）
import type { ApiError } from '../api/client.ts'
import { RESOURCES } from '../../qomicex-tauri-i18n/src/index.ts'
import type { Lang } from './types'

const CODE_TO_KEY: Record<string, string> = {
  NOT_FOUND: 'errors.notFound',
  FORBIDDEN: 'errors.forbidden',
  BAD_REQUEST: 'errors.badRequest',
  INTERNAL_ERROR: 'errors.internalError',
  UPSTREAM_ERROR: 'errors.upstreamError',
  REQUEST_TIMEOUT: 'errors.requestTimeout',
  UNKNOWN_ERROR: 'errors.unknown',
  LICENSE_NOT_FOUND: 'errors.licenseNotFound',
  LICENSE_DECRYPT_FAILED: 'errors.licenseDecryptFailed',
  LICENSE_SIGNATURE_INVALID: 'errors.licenseSignatureInvalid',
  LICENSE_PUBLIC_KEY_UNAVAILABLE: 'errors.licensePublicKeyUnavailable',
  LICENSE_EXPIRED: 'errors.licenseExpired',
  LICENSE_REMOTE_CHECK_FAILED: 'errors.licenseRemoteCheckFailed',
  LICENSE_IO_ERROR: 'errors.licenseIoError',
  TOKEN_EXPIRED: 'errors.tokenExpired',
  NETWORK_ERROR: 'errors.networkError',
  MC_API_ERROR: 'errors.mcApiError',
  FS_AUTHORIZATION_REQUIRED: 'errors.fsAuthRequired',
  PLUGIN_MISSING_DEPENDENCY: 'errors.pluginMissingDependency',
  CONNECTOR_TIMEOUT: 'errors.connectorTimeout',
  EXPORT_DIAGNOSTICS_FAILED: 'errors.exportDiagnosticsFailed',
  MODPACK_PARSE_FAILED: 'errors.modpackParseFailed',
  SKIN_UPLOAD_FAILED: 'errors.skinUploadFailed',
  SKIN_SAVE_FAILED: 'errors.skinSaveFailed',
  SKIN_RESET_FAILED: 'errors.skinResetFailed',
  PLUGIN_SIGNATURE_MISSING: 'errors.pluginSignatureMissing',
  PLUGIN_SIGNATURE_INVALID: 'errors.pluginSignatureInvalid',
  PLUGIN_SIGNATURE_CERT_INVALID: 'errors.pluginSignatureCertInvalid',
  PLUGIN_SIGNATURE_HASH_MISMATCH: 'errors.pluginSignatureHashMismatch',
  NO_ROLLBACK_SNAPSHOT: 'errors.noRollbackSnapshot',
}

/** 按语言翻译后端错误；未映射的错误码返回 null（调用方回退后端 message） */
export function translateApiError(e: ApiError, lang: Lang): string | null {
  const key = CODE_TO_KEY[e.code]
  if (!key) return null
  const dict = RESOURCES[lang] as unknown as Record<string, unknown>
  let val: unknown = dict
  for (const part of key.split('.')) {
    if (val && typeof val === 'object' && part in val) {
      val = (val as Record<string, unknown>)[part]
    } else {
      return null
    }
  }
  return typeof val === 'string' ? val : null
}
