### Task 5: 前端 — API 函数

**Files:**
- Modify: `src/api/instance-files.ts`

**Interfaces:**
- Consumes: `ModMetadata` (Task 4)
- Produces: `getModsMetadata`, `enableMod`, `disableMod`, `changeModVersion`, `batchEnableMods`, `batchDisableMods`, `batchDeleteMods`

- [ ] **Step 1: 添加 API 函数**

在文件末尾追加。确保文件第一行的 `import { get, del, post } from './client.ts'` 已包含 `post`（当前文件已有 `post` import，无需修改）。

```ts
import type { ModMetadata } from '../types/index.ts'

export function getModsMetadata(instanceId: string): Promise<ModMetadata[]> {
  return get<ModMetadata[]>(`/instance/${instanceId}/files/mods/metadata`)
}

export function enableMod(instanceId: string, name: string): Promise<void> {
  return post(`/instance/${instanceId}/files/mods/enable?name=${encodeURIComponent(name)}`)
}

export function disableMod(instanceId: string, name: string): Promise<void> {
  return post(`/instance/${instanceId}/files/mods/disable?name=${encodeURIComponent(name)}`)
}

export function changeModVersion(instanceId: string, fileName: string, downloadUrl: string, newFileName: string): Promise<void> {
  return post(`/instance/${instanceId}/files/mods/change-version`, { fileName, downloadUrl, newFileName })
}

export function batchEnableMods(instanceId: string, names: string[]): Promise<void> {
  return post(`/instance/${instanceId}/files/mods/batch-enable`, names)
}

export function batchDisableMods(instanceId: string, names: string[]): Promise<void> {
  return post(`/instance/${instanceId}/files/mods/batch-disable`, names)
}

export function batchDeleteMods(instanceId: string, names: string[]): Promise<void> {
  return post(`/instance/${instanceId}/files/mods/batch-delete`, names)
}
```

注意：这些函数需要追加到文件末尾（`export function getInstalledFileNames` 之后）。`mod` import 放在文件顶部，紧跟其他 import 行。

- [ ] **Step 2: 类型检查**

Run: `npx tsc --noEmit`
Expected: No new errors

- [ ] **Step 3: Commit**

```bash
git add src/api/instance-files.ts
git commit -m "feat: add mod metadata and management API functions"
```
