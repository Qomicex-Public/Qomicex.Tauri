/**
 * 插件设置页跳转协调：`openPluginSettings` API 的 pending 目标 + 全局事件。
 * pending 兜底挂载时序——Settings/PluginStoreTab/PluginSettingsTab 未挂载时
 * 错过事件，挂载后经 peek/consume 读取；已挂载则直接监听事件实时响应。
 */
let pendingTarget: string | null = null

export function requestPluginSettings(pluginId: string | null) {
  pendingTarget = pluginId
  window.dispatchEvent(new CustomEvent('plugin:open-settings'))
}

/** 读取待跳转目标（不清除），供 tab 层初始化判断。 */
export function peekPluginSettings(): string | null {
  return pendingTarget
}

/** 读取并清除待跳转目标，供 PluginSettingsTab 定位到具体插件。 */
export function consumePluginSettings(): string | null {
  const v = pendingTarget
  pendingTarget = null
  return v
}
