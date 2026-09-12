/** 测试游戏的独立日志窗口 label（固定，重复点击先关旧的再开新的）。 */
const GAME_LOG_WINDOW_LABEL = 'game-log-window'

/** 独立日志窗口加载本 SPA 的地址（带 logWindow 分支参数）。 */
export function logWindowUrl(instanceId: string): string {
  return `${window.location.origin}/?logWindow=1&instance=${encodeURIComponent(instanceId)}`
}

/**
 * 打开独立的游戏实时日志窗口（Tauri 原生子窗口，加载本 SPA 的 `?logWindow=1` 分支，
 * 与主窗口共用主题/字体）。Windows 下隐藏系统标题栏并渲染自定义标题栏（同主窗口做法）；
 * 非 Windows 保留系统标题栏。
 * 非 Tauri（纯浏览器 dev）退回 `window.open`。
 */
export async function openLogWindow(instanceId: string): Promise<void> {
  try {
    const { WebviewWindow } = await import('@tauri-apps/api/webviewWindow')
    const existing = await WebviewWindow.getByLabel(GAME_LOG_WINDOW_LABEL)
    if (existing) await existing.close().catch(() => {})
    const isWindows = !navigator.userAgent.includes('Linux') && !navigator.userAgent.includes('Mac')
    // eslint-disable-next-line no-new
    new WebviewWindow(GAME_LOG_WINDOW_LABEL, {
      url: logWindowUrl(instanceId),
      title: '实时游戏日志',
      width: 780,
      height: 620,
      minWidth: 480,
      minHeight: 360,
      resizable: true,
      center: true,
      decorations: !isWindows,
    })
  } catch {
    window.open(logWindowUrl(instanceId), '_blank')
  }
}
