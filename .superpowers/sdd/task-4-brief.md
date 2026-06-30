### Task 4: 前端 — 类型定义

**Files:**
- Modify: `src/types/index.ts`

**Interfaces:**
- Produces: `ModMetadata` interface

- [ ] **Step 1: 在 types/index.ts 中添加 ModMetadata 类型**

在 `FileEntry` 接口附近添加。找到 `export interface FileEntry {` 块之后，添加：

```ts
export interface ModMetadata {
  fileName: string
  name: string
  version: string
  description: string
  authors: string[]
  iconUrl?: string | null
  curseForgeId?: number | null
  modrinthId?: string | null
  source?: string | null
  mcmodId?: number | null
  chineseName?: string | null
  active: boolean
}
```

- [ ] **Step 2: 类型检查**

Run: `npx tsc --noEmit`
Expected: No new errors related to types

- [ ] **Step 3: Commit**

```bash
git add src/types/index.ts
git commit -m "feat: add ModMetadata type"
```
