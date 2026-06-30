# Task 9 Report: 重写 ModsTab 组件

## 状态: 完成

## Commit: `b21c62d` — feat: rewrite ModsTab with metadata cards, context menu, batch ops

## 类型检查: 通过 (`npx tsc --noEmit` — 零错误)

## 变更内容

### 1. 更新 imports (line 19)
- 移除 `getMods, deleteMod`，替换为 `getModsMetadata, batchEnableMods, batchDisableMods, batchDeleteMods`
- 新增 `ModCard`、`VersionPickerDialog`、`ModMetadata` 导入

### 2. 替换 ModsTab 函数
- 旧版使用 `FileEntry[]` + `deleteMod` 逐个删除
- 新版使用 `ModMetadata[]` + `ModCard` 组件渲染，支持搜索（中文名/英文名/文件名）、批量启用/禁用/删除、版本选择对话框

### 3. 更新渲染调用
- 移除 `files`、`loading`、`onRefresh` props（新版自行管理加载）

### 4. 清理
- 从 `loadFiles` 函数中移除 `mods: getMods`（不再导入）
- 移除未使用的 `enterBatchMode`（避免 TS6133 错误）

## 注意事项
- `enterBatchMode` 在任务简报中存在但未被 JSX 引用，已移除以通过严格 TS 检查
- `install Mod` 按钮导航至 `/resource-center` 时传递 `loader.toLowerCase()`，与旧版保持一致
