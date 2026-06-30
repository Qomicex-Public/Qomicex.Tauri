### Task 7 完成报告

**状态**: 已完成

**提交**: `d074610` — `feat: add ModCard component with toggle, context menu, delete`

**类型检查**: `npx tsc --noEmit` — 无错误

**创建文件**:
- `src/components/ModCard.tsx` — 单个 Mod 卡片组件，包含：
  - 启用/禁用切换开关（toggle）
  - 右键菜单（MC百科、查看详情、更换版本、删除）
  - 删除确认对话框
  - 批量模式支持（选中状态环）
  - Mod 图标、名称、中文名、版本、作者、描述展示
