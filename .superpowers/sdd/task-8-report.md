### Task 8: Report — VersionPickerDialog 组件

**状态:** 完成

**Commit:** `ec7b80b` — `feat: add VersionPickerDialog for mod version switching`

**类型检查:** `npx tsc --noEmit` — 零错误通过

**创建文件:**
- `src/components/VersionPickerDialog.tsx` (121 lines)

**依赖验证:**
- `ModMetadata`, `ResourceVersion`, `ResourceFile` — 存在于 `src/types/index.ts`
- `getResourceVersions`, `getResourceVersionDownloads` — 存在于 `src/api/resource.ts`
- `changeModVersion` — 存在于 `src/api/instance-files.ts`
- `Dialog`, `DialogHeader`, `DialogTitle`, `DialogBody`, `DialogFooter` — 存在于 `src/components/ui/dialog.tsx`
