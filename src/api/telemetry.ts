import { post } from './client.ts'

export type PluginErrorType = 'launch_crash' | 'plugin_load_failed' | 'plugin_runtime_error'

/**
 * 上报匿名插件错误（opt-in，默认关）。launcherVersion 由后端注入；
 * 仅匿名字段，禁路径/堆栈/隐私数据。上报失败静默（遥测不应影响主流程）。
 */
export function reportPluginError(
  pluginId: string,
  pluginVersion: string,
  errorType: PluginErrorType,
): Promise<unknown> {
  return post('/telemetry/plugin-error', { pluginId, pluginVersion, errorType }).catch(() => {})
}
