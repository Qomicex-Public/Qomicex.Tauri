### Task 6 Report: ContextMenu 右键菜单组件

**状态:** 完成

**提交:** `5a5bccc` — `feat: add ContextMenu right-click menu component`

**类型检查:** `npx tsc --noEmit` — 无错误

**创建的文件:**
- `src/components/ContextMenu.tsx` — 80 行

**实现的 API:**
- `ContextMenuItem` 接口：`label`, `icon?`, `onClick`, `disabled?`, `danger?`
- `ContextMenuProps` 接口：`items`, `children`
- `<ContextMenu items={...}>{children}</ContextMenu>` — 在 children 上右键时显示菜单，点击外部自动关闭，自动避开视口边缘
