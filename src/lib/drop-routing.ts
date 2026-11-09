// Copyright (C) 2026 Qomicex Launcher Contributors
// SPDX-License-Identifier: GPL-3.0-or-later

/** 全局拖放路由协调：导入对话框打开时，全局 file-drop 事件让位给对话框。
 * 避免 GlobalDropInstaller 与 ImportDialog 对同一次拖放双重处理。 */
export const importDialogActive = { current: false }

/**
 * 从当前路由 pathname 解析正在查看的实例 id（`/instances/:id`）。
 *
 * 拖拽安装时用它优先选中「当前实例」：用户在看 GTNH 实例时拖入模组，
 * 不该默认装到固定（isDefault）的另一个实例上。其他页面返回 null，
 * 调用方据此回退到固定实例。
 */
export function instanceIdFromPath(pathname: string): string | null {
  const match = /^\/instances\/([^/?#]+)/.exec(pathname)
  if (!match) return null
  try {
    const id = decodeURIComponent(match[1])
    return id || null
  } catch {
    // 非法百分号编码：宁可不选，也不要抛异常打断拖放流程。
    return null
  }
}
