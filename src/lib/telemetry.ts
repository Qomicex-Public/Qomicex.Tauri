// 匿名插件错误遥测（opt-in，默认关）。
//
// 开关跟随后端设置 telemetryEnabled（默认 false）；关闭时不触发、不上报。
// 去重：同 pluginId+version+errorType 在 60s 内只上报一次（内存 Map）。
//
// 上报字段白名单：
//   pluginId, pluginVersion, errorType（限 launch_crash/plugin_load_failed/plugin_runtime_error），
//   launcherVersion（后端注入）。
// 绝不包含路径/堆栈/设备信息/隐私数据。

import { getSettings, onSettingsChange } from '../api/settings.ts'
import { reportPluginError as apiReport } from '../api/telemetry.ts'
import type { PluginErrorType } from '../api/telemetry.ts'

let enabled = getSettings().telemetryEnabled === true
onSettingsChange((s) => {
  enabled = s.telemetryEnabled === true
})

const DEDUP_MS = 60_000
const dedup = new Map<string, number>()

function dedupKey(pluginId: string, version: string, errorType: string): string {
  return `${pluginId}@${version}@${errorType}`
}

/**
 * 仅当遥测开启且未在去重窗口内，才上报一次匿名插件错误。
 * 静默（不抛异常、不打印日志），遥测不应影响主流程。
 */
export function reportPluginError(
  pluginId: string,
  pluginVersion: string,
  errorType: PluginErrorType,
): void {
  if (!enabled) return
  const k = dedupKey(pluginId, pluginVersion, errorType)
  const now = Date.now()
  const last = dedup.get(k) ?? 0
  if (now - last < DEDUP_MS) return
  dedup.set(k, now)
  apiReport(pluginId, pluginVersion, errorType)
}