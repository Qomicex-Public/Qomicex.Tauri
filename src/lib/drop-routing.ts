/** 全局拖放路由协调：导入对话框打开时，全局 file-drop 事件让位给对话框。
 * 避免 GlobalDropInstaller 与 ImportDialog 对同一次拖放双重处理。 */
export const importDialogActive = { current: false }