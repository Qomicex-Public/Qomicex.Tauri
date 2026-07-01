# Instance Files Metadata Enhancement Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire all Qomicex.Core Local module classes (Resourcepack, Shaders, Saves, Screenshots, DataPacks) into backend API and frontend UI, following the ModsTab metadata pattern.

**Architecture:** Backend adds `/metadata` endpoints calling Local classes. Frontend adds per-type card components with self-contained data loading (search, badge count, refresh, open folder), replacing the generic FileEntry-based tabs.

**Tech Stack:** ASP.NET Core (.NET 10) backend, React 19 + TypeScript + Tailwind frontend

## Global Constraints

- Backend: use `inst.GameVersion` directly as versionId, never concatenate Loader+LoaderVersion
- Backend: reuse `ResolveGameDir()` for directory resolution
- Frontend: all local imports must include `.tsx` / `.ts` extension
- Frontend: use `cn()` from `src/lib/utils.ts` for class merging
- Frontend: use existing UI components from `src/components/ui/`
- Frontend: each tab manages its own data loading (like ModsTab), not via parent `loadFiles`

---

## File Structure

```
src-backend/Qomicex.Launcher.Backend/
  Models/FileEntry.cs                          [MODIFY] add 5 DTOs + request models
  Controllers/InstanceFilesController.cs        [MODIFY] add 8 endpoints + datapacks to GetPath

src/
  types/index.ts                                [MODIFY] add 5 metadata interfaces
  api/instance-files.ts                         [MODIFY] add 9 API functions
  components/ResourcePackCard.tsx               [CREATE]
  components/ShaderCard.tsx                      [CREATE]
  components/SaveCard.tsx                        [CREATE]
  components/ScreenshotCard.tsx                  [CREATE]
  components/DataPackCard.tsx                    [CREATE]
  pages/InstanceDetail.tsx                       [MODIFY] replace tabs + add DataPacksTab
```

---

### Task 1: Backend — Add DTOs and request models

**Files:**
- Modify: `src-backend/Qomicex.Launcher.Backend/Models/FileEntry.cs`

**Produces:** `ResourcePackMetadataDto`, `ShaderMetadataDto`, `SaveMetadataDto`, `ScreenshotMetadataDto`, `DataPackMetadataDto`, `RenameSaveRequest`

- [ ] **Step 1: Add DTOs to FileEntry.cs**

Append after `ChangeModVersionRequest` (line 74):

```csharp
public class ResourcePackMetadataDto
{
    public string FileName { get; set; } = string.Empty;
    public string Name { get; set; } = string.Empty;
    public string Description { get; set; } = string.Empty;
    public string Version { get; set; } = string.Empty;
    public int PackFormat { get; set; }
    public string? IconBase64 { get; set; }
    public int? CurseForgeId { get; set; }
    public string? ModrinthId { get; set; }
    public string? Source { get; set; }
}

public class ShaderMetadataDto
{
    public string FileName { get; set; } = string.Empty;
    public string Name { get; set; } = string.Empty;
    public string Description { get; set; } = string.Empty;
    public string Version { get; set; } = string.Empty;
    public string? IconBase64 { get; set; }
    public int? CurseForgeId { get; set; }
    public string? ModrinthId { get; set; }
    public string? Source { get; set; }
}

public class SaveMetadataDto
{
    public string Name { get; set; } = string.Empty;
    public string FilePath { get; set; } = string.Empty;
    public long LastPlayed { get; set; }
    public string? IconBase64 { get; set; }
}

public class ScreenshotMetadataDto
{
    public string FileName { get; set; } = string.Empty;
    public string FilePath { get; set; } = string.Empty;
    public DateTime CreatedAt { get; set; }
    public long FileSize { get; set; }
}

public class DataPackMetadataDto
{
    public string FileName { get; set; } = string.Empty;
    public string Name { get; set; } = string.Empty;
    public string Description { get; set; } = string.Empty;
    public string Version { get; set; } = string.Empty;
    public int PackFormat { get; set; }
    public string? IconBase64 { get; set; }
    public int? CurseForgeId { get; set; }
    public string? ModrinthId { get; set; }
    public string? Source { get; set; }
}

public class RenameSaveRequest
{
    public string OldName { get; set; } = string.Empty;
    public string NewName { get; set; } = string.Empty;
}
```

- [ ] **Step 2: Build backend to verify**

```bash
dotnet build src-backend/Qomicex.Launcher.Backend/Qomicex.Launcher.Backend.csproj
```

Expected: 0 errors.

- [ ] **Step 3: Commit**

```bash
git add -f src-backend/Qomicex.Launcher.Backend/Models/FileEntry.cs
git commit -m "feat: add metadata DTOs for resourcepacks, shaders, saves, screenshots, datapacks"
```

---

### Task 2: Backend — ResourcePacks metadata endpoint

**Files:**
- Modify: `src-backend/Qomicex.Launcher.Backend/Controllers/InstanceFilesController.cs`

**Produces:** `GET api/instance/{instanceId}/files/resourcepacks/metadata`

- [ ] **Step 1: Add endpoint after existing `DeleteResourcePack` method (~line 409)**

```csharp
    [HttpGet("resourcepacks/metadata")]
    public async Task<ActionResult<List<ResourcePackMetadataDto>>> GetResourcePacksMetadata(string instanceId)
    {
        var inst = _repository.GetById(instanceId);
        if (inst == null) return NotFound();

        var baseDir = inst.GameDir;
        if (!Path.IsPathRooted(baseDir))
            baseDir = Path.GetFullPath(Path.Combine(Directory.GetCurrentDirectory(), baseDir));

        var versionSegmented = inst.VersionIsolation ?? true;
        var versionId = inst.GameVersion;
        var apiKey = _configuration["CurseForge:ApiKey"] ?? "";

        var rp = new Resourcepack(baseDir, versionId, versionSegmented, apiKey);
        var list = await rp.GetResourcePackList();

        var result = list.Select(m =>
        {
            string? source = null;
            if (m.CurseForgeId > 0) source = "curseforge";
            else if (!string.IsNullOrEmpty(m.ModrinthId)) source = "modrinth";

            return new ResourcePackMetadataDto
            {
                FileName = Path.GetFileName(m.FilePath),
                Name = m.Name,
                Description = m.Description ?? string.Empty,
                Version = m.Version ?? string.Empty,
                PackFormat = m.PackFormat,
                IconBase64 = string.IsNullOrEmpty(m.Icon) ? null : m.Icon,
                CurseForgeId = m.CurseForgeId > 0 ? m.CurseForgeId : null,
                ModrinthId = string.IsNullOrEmpty(m.ModrinthId) ? null : m.ModrinthId,
                Source = source,
            };
        }).ToList();

        return Ok(result);
    }
```

- [ ] **Step 2: Build backend to verify**

```bash
dotnet build src-backend/Qomicex.Launcher.Backend/Qomicex.Launcher.Backend.csproj
```

Expected: 0 errors.

- [ ] **Step 3: Commit**

```bash
git add -f src-backend/Qomicex.Launcher.Backend/Controllers/InstanceFilesController.cs
git commit -m "feat: add resourcepacks metadata endpoint"
```

---

### Task 3: Backend — Shaders metadata endpoint

**Files:**
- Modify: `src-backend/Qomicex.Launcher.Backend/Controllers/InstanceFilesController.cs`

**Produces:** `GET api/instance/{instanceId}/files/shaderpacks/metadata`

- [ ] **Step 1: Add endpoint after resourcepacks metadata endpoint**

```csharp
    [HttpGet("shaderpacks/metadata")]
    public async Task<ActionResult<List<ShaderMetadataDto>>> GetShaderPacksMetadata(string instanceId)
    {
        var inst = _repository.GetById(instanceId);
        if (inst == null) return NotFound();

        var baseDir = inst.GameDir;
        if (!Path.IsPathRooted(baseDir))
            baseDir = Path.GetFullPath(Path.Combine(Directory.GetCurrentDirectory(), baseDir));

        var versionSegmented = inst.VersionIsolation ?? true;
        var versionId = inst.GameVersion;
        var apiKey = _configuration["CurseForge:ApiKey"] ?? "";

        var shaders = new Shaders(baseDir, versionId, versionSegmented, apiKey);
        var list = await shaders.GetShaderList();

        var result = list.Select(m =>
        {
            string? source = null;
            if (m.CurseForgeId > 0) source = "curseforge";
            else if (!string.IsNullOrEmpty(m.ModrinthId)) source = "modrinth";

            return new ShaderMetadataDto
            {
                FileName = Path.GetFileName(m.FilePath),
                Name = m.Name ?? string.Empty,
                Description = m.Description ?? string.Empty,
                Version = m.Version ?? string.Empty,
                IconBase64 = string.IsNullOrEmpty(m.Icon) ? null : m.Icon,
                CurseForgeId = m.CurseForgeId > 0 ? m.CurseForgeId : null,
                ModrinthId = string.IsNullOrEmpty(m.ModrinthId) ? null : m.ModrinthId,
                Source = source,
            };
        }).ToList();

        return Ok(result);
    }
```

- [ ] **Step 2: Build and commit**

```bash
dotnet build src-backend/Qomicex.Launcher.Backend/Qomicex.Launcher.Backend.csproj && git add -f src-backend/Qomicex.Launcher.Backend/Controllers/InstanceFilesController.cs && git commit -m "feat: add shaderpacks metadata endpoint"
```

---

### Task 4: Backend — Saves metadata + rename + backup

**Files:**
- Modify: `src-backend/Qomicex.Launcher.Backend/Controllers/InstanceFilesController.cs`

**Produces:** `GET saves/metadata`, `POST saves/rename`, `POST saves/backup`

- [ ] **Step 1: Add 3 endpoints after shaderpacks metadata endpoint**

```csharp
    [HttpGet("saves/metadata")]
    public ActionResult<List<SaveMetadataDto>> GetSavesMetadata(string instanceId)
    {
        var inst = _repository.GetById(instanceId);
        if (inst == null) return NotFound();

        var baseDir = inst.GameDir;
        if (!Path.IsPathRooted(baseDir))
            baseDir = Path.GetFullPath(Path.Combine(Directory.GetCurrentDirectory(), baseDir));

        var versionSegmented = inst.VersionIsolation ?? true;
        var versionId = inst.GameVersion;
        var apiKey = _configuration["CurseForge:ApiKey"] ?? "";

        var saves = new Saves(baseDir, versionId, versionSegmented, apiKey);
        var list = saves.GetSaveList();

        var result = list.Select(s => new SaveMetadataDto
        {
            Name = s.Name,
            FilePath = s.FilePath,
            LastPlayed = s.LastPlayed,
            IconBase64 = string.IsNullOrEmpty(s.Icon) ? null : s.Icon,
        }).ToList();

        return Ok(result);
    }

    [HttpPost("saves/rename")]
    public IActionResult RenameSave(string instanceId, [FromBody] RenameSaveRequest request)
    {
        var gameDir = ResolveGameDir(instanceId);
        if (gameDir == null) return NotFound();
        var savesDir = Path.Combine(gameDir, "saves");

        var inst = _repository.GetById(instanceId);
        if (inst == null) return NotFound();
        var versionSegmented = inst.VersionIsolation ?? true;
        var apiKey = _configuration["CurseForge:ApiKey"] ?? "";
        var saves = new Saves(gameDir, inst.GameVersion, versionSegmented, apiKey);

        var savePath = Path.Combine(savesDir, request.OldName);
        if (!Directory.Exists(savePath)) return NotFound();
        saves.RenameSave(savePath, request.NewName);
        return NoContent();
    }

    [HttpPost("saves/backup")]
    public IActionResult BackupSave(string instanceId, [FromQuery] string name)
    {
        var gameDir = ResolveGameDir(instanceId);
        if (gameDir == null) return NotFound();
        var savesDir = Path.Combine(gameDir, "saves");

        var inst = _repository.GetById(instanceId);
        if (inst == null) return NotFound();
        var versionSegmented = inst.VersionIsolation ?? true;
        var apiKey = _configuration["CurseForge:ApiKey"] ?? "";
        var saves = new Saves(gameDir, inst.GameVersion, versionSegmented, apiKey);

        var savePath = Path.Combine(savesDir, name);
        if (!Directory.Exists(savePath)) return NotFound();
        saves.BackupSave(savePath);
        return NoContent();
    }
```

- [ ] **Step 2: Build and commit**

```bash
dotnet build src-backend/Qomicex.Launcher.Backend/Qomicex.Launcher.Backend.csproj && git add -f src-backend/Qomicex.Launcher.Backend/Controllers/InstanceFilesController.cs && git commit -m "feat: add saves metadata, rename, backup endpoints"
```

---

### Task 5: Backend — Screenshots metadata endpoint

**Files:**
- Modify: `src-backend/Qomicex.Launcher.Backend/Controllers/InstanceFilesController.cs`

**Produces:** `GET api/instance/{instanceId}/files/screenshots/metadata`

- [ ] **Step 1: Add endpoint after saves endpoints**

```csharp
    [HttpGet("screenshots/metadata")]
    public ActionResult<List<ScreenshotMetadataDto>> GetScreenshotsMetadata(string instanceId)
    {
        var inst = _repository.GetById(instanceId);
        if (inst == null) return NotFound();

        var baseDir = inst.GameDir;
        if (!Path.IsPathRooted(baseDir))
            baseDir = Path.GetFullPath(Path.Combine(Directory.GetCurrentDirectory(), baseDir));

        var versionSegmented = inst.VersionIsolation ?? true;
        var versionId = inst.GameVersion;
        var apiKey = _configuration["CurseForge:ApiKey"] ?? "";

        var screenshots = new Screenshots(baseDir, versionId, versionSegmented, apiKey);
        var list = screenshots.GetScreenshotList();

        var result = list.Select(s => new ScreenshotMetadataDto
        {
            FileName = s.FileName,
            FilePath = s.FilePath,
            CreatedAt = s.CreatedAt,
            FileSize = s.FileSize,
        }).ToList();

        return Ok(result);
    }
```

- [ ] **Step 2: Build and commit**

```bash
dotnet build src-backend/Qomicex.Launcher.Backend/Qomicex.Launcher.Backend.csproj && git add -f src-backend/Qomicex.Launcher.Backend/Controllers/InstanceFilesController.cs && git commit -m "feat: add screenshots metadata endpoint"
```

---

### Task 6: Backend — DataPacks endpoints + GetPath update

**Files:**
- Modify: `src-backend/Qomicex.Launcher.Backend/Controllers/InstanceFilesController.cs`

**Produces:** `GET datapacks`, `GET datapacks/metadata`, `DELETE datapacks`, `datapacks` in GetPath

- [ ] **Step 1: Add "datapacks" to GetPath switch**

In `GetPath()` method, add to the switch:
```csharp
"datapacks" => "datapacks",
```
Place it between `"mods"` and `"resourcepacks"`:

```csharp
"mods" => "mods",
"datapacks" => "datapacks",
"resourcepacks" => "resourcepacks",
```

- [ ] **Step 2: Add 3 endpoints after screenshots metadata endpoint**

```csharp
    [HttpGet("datapacks")]
    public ActionResult<List<FileEntry>> GetDataPacks(string instanceId)
    {
        var dir = GetPath(instanceId, "datapacks", out var _);
        if (dir == null) return NotFound();
        if (!Directory.Exists(dir)) return Ok(new List<FileEntry>());
        return Ok(Directory.GetFiles(dir).Select(f => new FileEntry
        {
            Name = Path.GetFileName(f),
            Size = new FileInfo(f).Length,
            LastModified = System.IO.Directory.GetLastWriteTime(f),
            Extension = Path.GetExtension(f).ToLower(),
        }).ToList());
    }

    [HttpGet("datapacks/metadata")]
    public async Task<ActionResult<List<DataPackMetadataDto>>> GetDataPacksMetadata(string instanceId)
    {
        var inst = _repository.GetById(instanceId);
        if (inst == null) return NotFound();

        var baseDir = inst.GameDir;
        if (!Path.IsPathRooted(baseDir))
            baseDir = Path.GetFullPath(Path.Combine(Directory.GetCurrentDirectory(), baseDir));

        var versionSegmented = inst.VersionIsolation ?? true;
        var versionId = inst.GameVersion;
        var apiKey = _configuration["CurseForge:ApiKey"] ?? "";

        var dp = new DataPacks(baseDir, versionId, versionSegmented, apiKey);
        var list = await dp.GetDataPackList();

        var result = list.Select(m =>
        {
            string? source = null;
            if (m.CurseForgeId > 0) source = "curseforge";
            else if (!string.IsNullOrEmpty(m.ModrinthId)) source = "modrinth";

            return new DataPackMetadataDto
            {
                FileName = Path.GetFileName(m.FilePath),
                Name = m.Name,
                Description = m.Description ?? string.Empty,
                Version = m.Version ?? string.Empty,
                PackFormat = m.PackFormat,
                IconBase64 = string.IsNullOrEmpty(m.Icon) ? null : m.Icon,
                CurseForgeId = m.CurseForgeId > 0 ? m.CurseForgeId : null,
                ModrinthId = string.IsNullOrEmpty(m.ModrinthId) ? null : m.ModrinthId,
                Source = source,
            };
        }).ToList();

        return Ok(result);
    }

    [HttpDelete("datapacks")]
    public IActionResult DeleteDataPack(string instanceId, [FromQuery] string name)
    {
        var dir = GetPath(instanceId, "datapacks", out var _);
        if (dir == null) return NotFound();
        var path = Path.Combine(dir, name);
        if (!System.IO.File.Exists(path)) return NotFound();
        System.IO.File.Delete(path);
        return NoContent();
    }
```

- [ ] **Step 3: Build and commit**

```bash
dotnet build src-backend/Qomicex.Launcher.Backend/Qomicex.Launcher.Backend.csproj && git add -f src-backend/Qomicex.Launcher.Backend/Controllers/InstanceFilesController.cs && git commit -m "feat: add datapacks endpoints (list, metadata, delete)"
```

---

### Task 7: Frontend — Add TypeScript types

**Files:**
- Modify: `src/types/index.ts`

**Produces:** `ResourcePackMetadata`, `ShaderMetadata`, `SaveMetadata`, `ScreenshotMetadata`, `DataPackMetadata`

- [ ] **Step 1: Find the ModMetadata interface in types/index.ts and add new interfaces after it**

Add near the `ModMetadata` interface (~line 374):

```ts
export interface ResourcePackMetadata {
  fileName: string
  name: string
  description: string
  version: string
  packFormat: number
  iconBase64?: string | null
  curseForgeId?: number | null
  modrinthId?: string | null
  source?: string | null
}

export interface ShaderMetadata {
  fileName: string
  name: string
  description: string
  version: string
  iconBase64?: string | null
  curseForgeId?: number | null
  modrinthId?: string | null
  source?: string | null
}

export interface SaveMetadata {
  name: string
  filePath: string
  lastPlayed: number
  iconBase64?: string | null
}

export interface ScreenshotMetadata {
  fileName: string
  filePath: string
  createdAt: string
  fileSize: number
}

export interface DataPackMetadata {
  fileName: string
  name: string
  description: string
  version: string
  packFormat: number
  iconBase64?: string | null
  curseForgeId?: number | null
  modrinthId?: string | null
  source?: string | null
}
```

- [ ] **Step 2: Commit**

```bash
git add -f src/types/index.ts && git commit -m "feat: add metadata types for resourcepacks, shaders, saves, screenshots, datapacks"
```

---

### Task 8: Frontend — Add API functions

**Files:**
- Modify: `src/api/instance-files.ts`

**Produces:** 9 new API functions

- [ ] **Step 1: Add new API functions after existing exports**

```ts
export async function getResourcePacksMetadata(instanceId: string): Promise<ResourcePackMetadata[]> {
  return get<ResourcePackMetadata[]>(`/instance/${instanceId}/files/resourcepacks/metadata`)
}

export async function getShadersMetadata(instanceId: string): Promise<ShaderMetadata[]> {
  return get<ShaderMetadata[]>(`/instance/${instanceId}/files/shaderpacks/metadata`)
}

export async function getSavesMetadata(instanceId: string): Promise<SaveMetadata[]> {
  return get<SaveMetadata[]>(`/instance/${instanceId}/files/saves/metadata`)
}

export async function renameSave(instanceId: string, oldName: string, newName: string): Promise<void> {
  await post(`/instance/${instanceId}/files/saves/rename`, { oldName, newName })
}

export async function backupSave(instanceId: string, name: string): Promise<void> {
  await post(`/instance/${instanceId}/files/saves/backup?name=${encodeURIComponent(name)}`)
}

export async function getScreenshotsMetadata(instanceId: string): Promise<ScreenshotMetadata[]> {
  return get<ScreenshotMetadata[]>(`/instance/${instanceId}/files/screenshots/metadata`)
}

export async function getDataPacks(instanceId: string): Promise<FileEntry[]> {
  return get<FileEntry[]>(`/instance/${instanceId}/files/datapacks`)
}

export async function getDataPacksMetadata(instanceId: string): Promise<DataPackMetadata[]> {
  return get<DataPackMetadata[]>(`/instance/${instanceId}/files/datapacks/metadata`)
}

export async function deleteDataPack(instanceId: string, name: string): Promise<void> {
  await del(`/instance/${instanceId}/files/datapacks?name=${encodeURIComponent(name)}`)
}
```

- [ ] **Step 2: Add necessary imports at top of instance-files.ts**

Add to existing import from types:
```ts
import type { FileEntry, ModMetadata, ResourcePackMetadata, ShaderMetadata, SaveMetadata, ScreenshotMetadata, DataPackMetadata } from '../types/index.ts'
```

- [ ] **Step 3: Commit**

```bash
git add -f src/api/instance-files.ts && git commit -m "feat: add API functions for resourcepacks, shaders, saves, screenshots, datapacks metadata"
```

---

### Task 9: Frontend — Create ResourcePackCard component

**Files:**
- Create: `src/components/ResourcePackCard.tsx`

- [ ] **Step 1: Create the component file**

```tsx
import { useState, useCallback } from 'react'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import { faBox } from '@fortawesome/free-solid-svg-icons'
import { Card, CardContent } from './ui/card.tsx'
import { Tooltip } from './ui/tooltip.tsx'
import type { ResourcePackMetadata } from '../types/index.ts'

interface Props {
  pack: ResourcePackMetadata
  instanceId: string
  onDelete: (fileName: string) => void
}

export default function ResourcePackCard({ pack, instanceId, onDelete }: Props) {
  const [deleting, setDeleting] = useState(false)

  const handleDelete = useCallback(async () => {
    setDeleting(true)
    try {
      const { deleteResourcePack } = await import('../api/instance-files.ts')
      await deleteResourcePack(instanceId, pack.fileName)
      onDelete(pack.fileName)
    } catch { setDeleting(false) }
  }, [instanceId, pack.fileName, onDelete])

  return (
    <Card className="group border-border/60 bg-card/95 transition-all hover:border-primary/20 hover:shadow-sm">
      <CardContent className="flex items-center gap-4 p-4">
        <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-muted text-muted-foreground overflow-hidden">
          {pack.iconBase64 ? (
            <img src={`data:image/png;base64,${pack.iconBase64}`} alt={pack.name} className="h-full w-full object-cover" loading="lazy" />
          ) : (
            <FontAwesomeIcon icon={faBox} className="h-5 w-5 opacity-50" />
          )}
        </div>
        <div className="min-w-0 flex-1">
          <h3 className="truncate text-sm font-semibold text-foreground">{pack.name}</h3>
          <div className="mt-0.5 flex items-center gap-2 text-xs text-muted-foreground">
            {pack.version && <span>{pack.version}</span>}
            {pack.version && pack.packFormat > 0 && <span className="text-border">·</span>}
            {pack.packFormat > 0 && <span>format {pack.packFormat}</span>}
          </div>
          {pack.description && (
            <p className="mt-1 line-clamp-1 text-xs text-muted-foreground/70">{pack.description}</p>
          )}
        </div>
        <Tooltip content="删除">
          <button
            onClick={(e) => { e.stopPropagation(); handleDelete() }}
            disabled={deleting}
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md opacity-0 group-hover:opacity-100 transition-opacity text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
          >
            <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" /></svg>
          </button>
        </Tooltip>
      </CardContent>
    </Card>
  )
}
```

- [ ] **Step 2: Commit**

```bash
git add -f src/components/ResourcePackCard.tsx && git commit -m "feat: add ResourcePackCard component"
```

---

### Task 10: Frontend — Create ShaderCard component

**Files:**
- Create: `src/components/ShaderCard.tsx`

- [ ] **Step 1: Create the component file**

```tsx
import { useState, useCallback } from 'react'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import { faSun } from '@fortawesome/free-solid-svg-icons'
import { Card, CardContent } from './ui/card.tsx'
import { Tooltip } from './ui/tooltip.tsx'
import type { ShaderMetadata } from '../types/index.ts'

interface Props {
  shader: ShaderMetadata
  instanceId: string
  onDelete: (fileName: string) => void
}

export default function ShaderCard({ shader, instanceId, onDelete }: Props) {
  const [deleting, setDeleting] = useState(false)

  const handleDelete = useCallback(async () => {
    setDeleting(true)
    try {
      const { deleteShaderPack } = await import('../api/instance-files.ts')
      await deleteShaderPack(instanceId, shader.fileName)
      onDelete(shader.fileName)
    } catch { setDeleting(false) }
  }, [instanceId, shader.fileName, onDelete])

  return (
    <Card className="group border-border/60 bg-card/95 transition-all hover:border-primary/20 hover:shadow-sm">
      <CardContent className="flex items-center gap-4 p-4">
        <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-muted text-muted-foreground overflow-hidden">
          {shader.iconBase64 ? (
            <img src={`data:image/png;base64,${shader.iconBase64}`} alt={shader.name} className="h-full w-full object-cover" loading="lazy" />
          ) : (
            <FontAwesomeIcon icon={faSun} className="h-5 w-5 opacity-50" />
          )}
        </div>
        <div className="min-w-0 flex-1">
          <h3 className="truncate text-sm font-semibold text-foreground">{shader.name}</h3>
          <div className="mt-0.5 flex items-center gap-2 text-xs text-muted-foreground">
            {shader.version && <span>{shader.version}</span>}
          </div>
          {shader.description && (
            <p className="mt-1 line-clamp-1 text-xs text-muted-foreground/70">{shader.description}</p>
          )}
        </div>
        <Tooltip content="删除">
          <button
            onClick={(e) => { e.stopPropagation(); handleDelete() }}
            disabled={deleting}
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md opacity-0 group-hover:opacity-100 transition-opacity text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
          >
            <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" /></svg>
          </button>
        </Tooltip>
      </CardContent>
    </Card>
  )
}
```

- [ ] **Step 2: Commit**

```bash
git add -f src/components/ShaderCard.tsx && git commit -m "feat: add ShaderCard component"
```

---

### Task 11: Frontend — Create SaveCard component

**Files:**
- Create: `src/components/SaveCard.tsx`

- [ ] **Step 1: Create the component file**

```tsx
import { useState, useCallback } from 'react'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import { faSave, faCopy, faPen, faTrashCan } from '@fortawesome/free-solid-svg-icons'
import { Card, CardContent } from './ui/card.tsx'
import { Tooltip } from './ui/tooltip.tsx'
import { Input } from './ui/input.tsx'
import { Button } from './ui/button.tsx'
import type { SaveMetadata } from '../types/index.ts'

interface Props {
  save: SaveMetadata
  instanceId: string
  onRefresh: () => void
}

export default function SaveCard({ save, instanceId, onRefresh }: Props) {
  const [deleting, setDeleting] = useState(false)
  const [renaming, setRenaming] = useState(false)
  const [renameValue, setRenameValue] = useState(save.name)
  const [backingUp, setBackingUp] = useState(false)

  const handleBackup = useCallback(async () => {
    setBackingUp(true)
    try {
      const { backupSave } = await import('../api/instance-files.ts')
      await backupSave(instanceId, save.name)
      onRefresh()
    } catch { }
    setBackingUp(false)
  }, [instanceId, save.name, onRefresh])

  const handleRename = useCallback(async () => {
    if (!renameValue.trim() || renameValue === save.name) { setRenaming(false); return }
    try {
      const { renameSave } = await import('../api/instance-files.ts')
      await renameSave(instanceId, save.name, renameValue.trim())
      onRefresh()
    } catch { }
    setRenaming(false)
  }, [instanceId, save.name, renameValue, onRefresh])

  const handleDelete = useCallback(async () => {
    setDeleting(true)
    try {
      const { deleteSave } = await import('../api/instance-files.ts')
      await deleteSave(instanceId, save.name)
      onRefresh()
    } catch { setDeleting(false) }
  }, [instanceId, save.name, onRefresh])

  return (
    <Card className="group border-border/60 bg-card/95 transition-all hover:border-primary/20 hover:shadow-sm">
      <CardContent className="flex items-center gap-4 p-4">
        <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-muted text-muted-foreground overflow-hidden">
          {save.iconBase64 ? (
            <img src={`data:image/png;base64,${save.iconBase64}`} alt={save.name} className="h-full w-full object-cover" loading="lazy" />
          ) : (
            <FontAwesomeIcon icon={faSave} className="h-5 w-5 opacity-50" />
          )}
        </div>
        <div className="min-w-0 flex-1">
          {renaming ? (
            <div className="flex items-center gap-2" onClick={(e) => e.stopPropagation()}>
              <Input
                value={renameValue}
                onChange={(e) => setRenameValue(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') handleRename(); if (e.key === 'Escape') setRenaming(false) }}
                className="h-7 text-sm"
                autoFocus
              />
              <Button size="sm" onClick={handleRename} className="h-7 text-xs">确定</Button>
              <Button size="sm" variant="ghost" onClick={() => setRenaming(false)} className="h-7 text-xs">取消</Button>
            </div>
          ) : (
            <>
              <h3 className="truncate text-sm font-semibold text-foreground">{save.name}</h3>
              {save.lastPlayed > 0 && (
                <p className="mt-0.5 text-xs text-muted-foreground">上次游玩: {new Date(save.lastPlayed).toLocaleDateString('zh-CN')}</p>
              )}
            </>
          )}
        </div>
        <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
          <Tooltip content="备份">
            <button onClick={() => handleBackup()} disabled={backingUp} className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground">
              <FontAwesomeIcon icon={faCopy} className="h-3.5 w-3.5" />
            </button>
          </Tooltip>
          <Tooltip content="重命名">
            <button onClick={() => { setRenameValue(save.name); setRenaming(true) }} className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground">
              <FontAwesomeIcon icon={faPen} className="h-3.5 w-3.5" />
            </button>
          </Tooltip>
          <Tooltip content="删除">
            <button onClick={() => handleDelete()} disabled={deleting} className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-destructive/10 hover:text-destructive">
              <FontAwesomeIcon icon={faTrashCan} className="h-3.5 w-3.5" />
            </button>
          </Tooltip>
        </div>
      </CardContent>
    </Card>
  )
}
```

- [ ] **Step 2: Commit**

```bash
git add -f src/components/SaveCard.tsx && git commit -m "feat: add SaveCard component with rename and backup"
```

---

### Task 12: Frontend — Create ScreenshotCard component

**Files:**
- Create: `src/components/ScreenshotCard.tsx`

- [ ] **Step 1: Create the component file**

```tsx
import { useState, useCallback } from 'react'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import { faImage, faTrashCan } from '@fortawesome/free-solid-svg-icons'
import { Tooltip } from './ui/tooltip.tsx'
import type { ScreenshotMetadata } from '../types/index.ts'

interface Props {
  screenshot: ScreenshotMetadata
  instanceId: string
  onRefresh: () => void
}

export default function ScreenshotCard({ screenshot, instanceId, onRefresh }: Props) {
  const [deleting, setDeleting] = useState(false)
  const [preview, setPreview] = useState(false)

  const handleDelete = useCallback(async () => {
    setDeleting(true)
    try {
      const { deleteScreenshot } = await import('../api/instance-files.ts')
      await deleteScreenshot(instanceId, screenshot.fileName)
      onRefresh()
    } catch { setDeleting(false) }
  }, [instanceId, screenshot.fileName, onRefresh])

  const filePath = screenshot.filePath.replace(/\\/g, '/')
  const imgSrc = `file:///${filePath.replace(/^\//, '')}`

  return (
    <>
      <div className="group relative overflow-hidden rounded-lg border border-border/60 bg-card/95 transition-all hover:border-primary/20 hover:shadow-sm">
        <div className="aspect-video flex items-center justify-center bg-muted cursor-pointer overflow-hidden" onClick={() => setPreview(true)}>
          <img src={imgSrc} alt={screenshot.fileName} className="h-full w-full object-cover" loading="lazy" />
        </div>
        <div className="p-2">
          <p className="truncate text-xs">{screenshot.fileName}</p>
          <p className="text-[11px] text-muted-foreground">
            {(screenshot.fileSize / 1024 / 1024).toFixed(1)} MB
          </p>
        </div>
        <div className="absolute right-1 top-1 opacity-0 group-hover:opacity-100 transition-opacity">
          <Tooltip content="删除">
            <button onClick={() => handleDelete()} disabled={deleting} className="flex h-7 w-7 items-center justify-center rounded-md bg-background/80 text-muted-foreground hover:bg-destructive hover:text-destructive-foreground">
              <FontAwesomeIcon icon={faTrashCan} className="h-3.5 w-3.5" />
            </button>
          </Tooltip>
        </div>
      </div>

      {preview && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4" onClick={() => setPreview(false)}>
          <img src={imgSrc} alt={screenshot.fileName} className="max-h-full max-w-full rounded-lg object-contain" />
          <button onClick={() => setPreview(false)} className="absolute top-4 right-4 h-8 w-8 rounded-full bg-white/10 flex items-center justify-center text-white hover:bg-white/20">×</button>
        </div>
      )}
    </>
  )
}
```

- [ ] **Step 2: Commit**

```bash
git add -f src/components/ScreenshotCard.tsx && git commit -m "feat: add ScreenshotCard component with preview"
```

---

### Task 13: Frontend — Create DataPackCard component

**Files:**
- Create: `src/components/DataPackCard.tsx`

- [ ] **Step 1: Create the component file**

```tsx
import { useState, useCallback } from 'react'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import { faDatabase } from '@fortawesome/free-solid-svg-icons'
import { Card, CardContent } from './ui/card.tsx'
import { Tooltip } from './ui/tooltip.tsx'
import type { DataPackMetadata } from '../types/index.ts'

interface Props {
  pack: DataPackMetadata
  instanceId: string
  onDelete: (fileName: string) => void
}

export default function DataPackCard({ pack, instanceId, onDelete }: Props) {
  const [deleting, setDeleting] = useState(false)

  const handleDelete = useCallback(async () => {
    setDeleting(true)
    try {
      const { deleteDataPack } = await import('../api/instance-files.ts')
      await deleteDataPack(instanceId, pack.fileName)
      onDelete(pack.fileName)
    } catch { setDeleting(false) }
  }, [instanceId, pack.fileName, onDelete])

  return (
    <Card className="group border-border/60 bg-card/95 transition-all hover:border-primary/20 hover:shadow-sm">
      <CardContent className="flex items-center gap-4 p-4">
        <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-muted text-muted-foreground overflow-hidden">
          {pack.iconBase64 ? (
            <img src={`data:image/png;base64,${pack.iconBase64}`} alt={pack.name} className="h-full w-full object-cover" loading="lazy" />
          ) : (
            <FontAwesomeIcon icon={faDatabase} className="h-5 w-5 opacity-50" />
          )}
        </div>
        <div className="min-w-0 flex-1">
          <h3 className="truncate text-sm font-semibold text-foreground">{pack.name}</h3>
          <div className="mt-0.5 flex items-center gap-2 text-xs text-muted-foreground">
            {pack.version && <span>{pack.version}</span>}
            {pack.version && pack.packFormat > 0 && <span className="text-border">·</span>}
            {pack.packFormat > 0 && <span>format {pack.packFormat}</span>}
          </div>
          {pack.description && (
            <p className="mt-1 line-clamp-1 text-xs text-muted-foreground/70">{pack.description}</p>
          )}
        </div>
        <Tooltip content="删除">
          <button
            onClick={(e) => { e.stopPropagation(); handleDelete() }}
            disabled={deleting}
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md opacity-0 group-hover:opacity-100 transition-opacity text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
          >
            <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" /></svg>
          </button>
        </Tooltip>
      </CardContent>
    </Card>
  )
}
```

- [ ] **Step 2: Commit**

```bash
git add -f src/components/DataPackCard.tsx && git commit -m "feat: add DataPackCard component"
```

---

### Task 14: Frontend — Upgrade InstanceDetail tabs and add DataPacksTab

**Files:**
- Modify: `src/pages/InstanceDetail.tsx`

**Changes:**
1. Replace `SavesTab` with new metadata-based version
2. Replace `ScreenshotsTab` with new metadata-based version
3. Replace `GenericFileTab` (resourcepacks) with `ResourcePacksTab`
4. Replace `GenericFileTab` (shaderpacks) with `ShadersTab`
5. Add `DataPacksTab` and register in TABS array
6. Remove obsolete entries from `loadFiles`

- [ ] **Step 1: Add imports for new card components and API functions**

After existing imports, add:
```tsx
import ResourcePackCard from '../components/ResourcePackCard.tsx'
import ShaderCard from '../components/ShaderCard.tsx'
import SaveCard from '../components/SaveCard.tsx'
import ScreenshotCard from '../components/ScreenshotCard.tsx'
import DataPackCard from '../components/DataPackCard.tsx'
import { getResourcePacksMetadata, getShadersMetadata, getSavesMetadata, getScreenshotsMetadata, getDataPacksMetadata, deleteDataPack } from '../api/instance-files.ts'
import type { ResourcePackMetadata, ShaderMetadata, SaveMetadata, ScreenshotMetadata, DataPackMetadata } from '../types/index.ts'
```

Add `faDatabase` to the existing fontawesome import:
```tsx
import { ... faDatabase ... } from '@fortawesome/free-solid-svg-icons'
```

- [ ] **Step 2: Add "datapacks" to TABS array**

Add after `shaderpacks`:
```tsx
{ id: 'datapacks', label: '数据包', icon: faDatabase },
```

- [ ] **Step 3: Create new ResourcePacksTab component at file scope**

Add before `ServersTab`:

```tsx
function ResourcePacksTab({ instanceId, gameDir }: { instanceId: string; gameDir: string }) {
  const [search, setSearch] = useState('')
  const [packs, setPacks] = useState<ResourcePackMetadata[]>([])
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    setLoading(true)
    try { const data = await getResourcePacksMetadata(instanceId); setPacks(data) }
    catch { setPacks([]) }
    setLoading(false)
  }, [instanceId])

  useEffect(() => { load() }, [load])

  const filtered = useMemo(() => {
    if (!search) return packs
    const q = search.toLowerCase()
    return packs.filter(p => p.name.toLowerCase().includes(q) || p.fileName.toLowerCase().includes(q))
  }, [packs, search])

  const handleDelete = useCallback((fileName: string) => {
    setPacks(prev => prev.filter(p => p.fileName !== fileName))
  }, [])

  return (
    <Card>
      <CardContent className="p-5">
        <div className="mb-3 flex items-center justify-between gap-3">
          <h3 className="text-sm font-medium shrink-0">
            <FontAwesomeIcon icon={faBox} className="mr-2 h-4 w-4 text-primary" />资源包
            {packs.length > 0 && <span className="ml-1.5 text-xs font-normal text-muted-foreground">({packs.length})</span>}
          </h3>
          <div className="flex items-center gap-2 flex-1 max-w-sm">
            <div className="relative flex-1">
              <FontAwesomeIcon icon={faMagnifyingGlass} className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="搜索资源包..." className="h-8 pl-8 text-xs" />
            </div>
          </div>
          <div className="flex items-center gap-1.5">
            <Button size="sm" variant="ghost" onClick={() => openPath(gameDir + '/resourcepacks').catch(() => {})} className="gap-1.5 h-7 text-xs">
              <FontAwesomeIcon icon={faFolderOpen} className="h-3.5 w-3.5" />打开文件夹
            </Button>
          </div>
        </div>
        {loading ? (
          <div className="flex items-center justify-center gap-2 py-8 text-sm text-muted-foreground">
            <FontAwesomeIcon icon={faRotate} className="h-4 w-4 animate-spin" />加载中...
          </div>
        ) : filtered.length === 0 ? (
          <div className="py-8 text-center text-sm text-muted-foreground">
            {search ? '无匹配资源包' : '暂无资源包'}
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            {filtered.map((pack) => (
              <ResourcePackCard key={pack.fileName} pack={pack} instanceId={instanceId} onDelete={handleDelete} />
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  )
}
```

- [ ] **Step 4: Create new ShadersTab component at file scope**

```tsx
function ShadersTab({ instanceId, gameDir }: { instanceId: string; gameDir: string }) {
  const [search, setSearch] = useState('')
  const [shaders, setShaders] = useState<ShaderMetadata[]>([])
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    setLoading(true)
    try { const data = await getShadersMetadata(instanceId); setShaders(data) }
    catch { setShaders([]) }
    setLoading(false)
  }, [instanceId])

  useEffect(() => { load() }, [load])

  const filtered = useMemo(() => {
    if (!search) return shaders
    const q = search.toLowerCase()
    return shaders.filter(s => s.name.toLowerCase().includes(q) || s.fileName.toLowerCase().includes(q))
  }, [shaders, search])

  const handleDelete = useCallback((fileName: string) => {
    setShaders(prev => prev.filter(s => s.fileName !== fileName))
  }, [])

  return (
    <Card>
      <CardContent className="p-5">
        <div className="mb-3 flex items-center justify-between gap-3">
          <h3 className="text-sm font-medium shrink-0">
            <FontAwesomeIcon icon={faSun} className="mr-2 h-4 w-4 text-primary" />光影包
            {shaders.length > 0 && <span className="ml-1.5 text-xs font-normal text-muted-foreground">({shaders.length})</span>}
          </h3>
          <div className="flex items-center gap-2 flex-1 max-w-sm">
            <div className="relative flex-1">
              <FontAwesomeIcon icon={faMagnifyingGlass} className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="搜索光影包..." className="h-8 pl-8 text-xs" />
            </div>
          </div>
          <div className="flex items-center gap-1.5">
            <Button size="sm" variant="ghost" onClick={() => openPath(gameDir + '/shaderpacks').catch(() => {})} className="gap-1.5 h-7 text-xs">
              <FontAwesomeIcon icon={faFolderOpen} className="h-3.5 w-3.5" />打开文件夹
            </Button>
          </div>
        </div>
        {loading ? (
          <div className="flex items-center justify-center gap-2 py-8 text-sm text-muted-foreground">
            <FontAwesomeIcon icon={faRotate} className="h-4 w-4 animate-spin" />加载中...
          </div>
        ) : filtered.length === 0 ? (
          <div className="py-8 text-center text-sm text-muted-foreground">
            {search ? '无匹配光影包' : '暂无光影包'}
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            {filtered.map((shader) => (
              <ShaderCard key={shader.fileName} shader={shader} instanceId={instanceId} onDelete={handleDelete} />
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  )
}
```

- [ ] **Step 5: Replace SavesTab with new metadata-based version**

Replace the entire `SavesTab` function (lines 98-151) with:

```tsx
function SavesTab({ instanceId }: { instanceId: string }) {
  const [search, setSearch] = useState('')
  const [saves, setSaves] = useState<SaveMetadata[]>([])
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    setLoading(true)
    try { const data = await getSavesMetadata(instanceId); setSaves(data) }
    catch { setSaves([]) }
    setLoading(false)
  }, [instanceId])

  useEffect(() => { load() }, [load])

  const filtered = useMemo(() => {
    if (!search) return saves
    const q = search.toLowerCase()
    return saves.filter(s => s.name.toLowerCase().includes(q))
  }, [saves, search])

  return (
    <Card>
      <CardContent className="p-5">
        <div className="mb-3 flex items-center justify-between gap-3">
          <h3 className="text-sm font-medium shrink-0">
            <FontAwesomeIcon icon={faSave} className="mr-2 h-4 w-4 text-primary" />存档
            {saves.length > 0 && <span className="ml-1.5 text-xs font-normal text-muted-foreground">({saves.length})</span>}
          </h3>
          <div className="flex items-center gap-2 flex-1 max-w-sm">
            <div className="relative flex-1">
              <FontAwesomeIcon icon={faMagnifyingGlass} className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="搜索存档..." className="h-8 pl-8 text-xs" />
            </div>
          </div>
        </div>
        {loading ? (
          <div className="flex items-center justify-center gap-2 py-8 text-sm text-muted-foreground">
            <FontAwesomeIcon icon={faRotate} className="h-4 w-4 animate-spin" />加载中...
          </div>
        ) : filtered.length === 0 ? (
          <div className="py-8 text-center text-sm text-muted-foreground">
            {search ? '无匹配存档' : '暂无存档'}
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            {filtered.map((save) => (
              <SaveCard key={save.filePath} save={save} instanceId={instanceId} onRefresh={load} />
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  )
}
```

- [ ] **Step 6: Replace ScreenshotsTab with new metadata-based version**

Replace the entire `ScreenshotsTab` function (lines 153-206) with:

```tsx
function ScreenshotsTab({ instanceId }: { instanceId: string }) {
  const [search, setSearch] = useState('')
  const [screenshots, setScreenshots] = useState<ScreenshotMetadata[]>([])
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    setLoading(true)
    try { const data = await getScreenshotsMetadata(instanceId); setScreenshots(data) }
    catch { setScreenshots([]) }
    setLoading(false)
  }, [instanceId])

  useEffect(() => { load() }, [load])

  const filtered = useMemo(() => {
    if (!search) return screenshots
    const q = search.toLowerCase()
    return screenshots.filter(s => s.fileName.toLowerCase().includes(q))
  }, [screenshots, search])

  return (
    <Card>
      <CardContent className="p-5">
        <div className="mb-3 flex items-center justify-between gap-3">
          <h3 className="text-sm font-medium shrink-0">
            <FontAwesomeIcon icon={faCamera} className="mr-2 h-4 w-4 text-primary" />截图
            {screenshots.length > 0 && <span className="ml-1.5 text-xs font-normal text-muted-foreground">({screenshots.length})</span>}
          </h3>
          <div className="flex items-center gap-2 flex-1 max-w-sm">
            <div className="relative flex-1">
              <FontAwesomeIcon icon={faMagnifyingGlass} className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="搜索截图..." className="h-8 pl-8 text-xs" />
            </div>
          </div>
        </div>
        {loading ? (
          <div className="flex items-center justify-center gap-2 py-8 text-sm text-muted-foreground">
            <FontAwesomeIcon icon={faRotate} className="h-4 w-4 animate-spin" />加载中...
          </div>
        ) : filtered.length === 0 ? (
          <div className="py-8 text-center text-sm text-muted-foreground">
            {search ? '无匹配截图' : '暂无截图'}
          </div>
        ) : (
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
            {filtered.map((s) => (
              <ScreenshotCard key={s.filePath} screenshot={s} instanceId={instanceId} onRefresh={load} />
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  )
}
```

- [ ] **Step 7: Add DataPacksTab component at file scope**

Add before `ServersTab`:

```tsx
function DataPacksTab({ instanceId, gameDir }: { instanceId: string; gameDir: string }) {
  const [search, setSearch] = useState('')
  const [packs, setPacks] = useState<DataPackMetadata[]>([])
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    setLoading(true)
    try { const data = await getDataPacksMetadata(instanceId); setPacks(data) }
    catch { setPacks([]) }
    setLoading(false)
  }, [instanceId])

  useEffect(() => { load() }, [load])

  const filtered = useMemo(() => {
    if (!search) return packs
    const q = search.toLowerCase()
    return packs.filter(p => p.name.toLowerCase().includes(q) || p.fileName.toLowerCase().includes(q))
  }, [packs, search])

  const handleDelete = useCallback((fileName: string) => {
    setPacks(prev => prev.filter(p => p.fileName !== fileName))
  }, [])

  return (
    <Card>
      <CardContent className="p-5">
        <div className="mb-3 flex items-center justify-between gap-3">
          <h3 className="text-sm font-medium shrink-0">
            <FontAwesomeIcon icon={faDatabase} className="mr-2 h-4 w-4 text-primary" />数据包
            {packs.length > 0 && <span className="ml-1.5 text-xs font-normal text-muted-foreground">({packs.length})</span>}
          </h3>
          <div className="flex items-center gap-2 flex-1 max-w-sm">
            <div className="relative flex-1">
              <FontAwesomeIcon icon={faMagnifyingGlass} className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="搜索数据包..." className="h-8 pl-8 text-xs" />
            </div>
          </div>
          <div className="flex items-center gap-1.5">
            <Button size="sm" variant="ghost" onClick={() => openPath(gameDir + '/datapacks').catch(() => {})} className="gap-1.5 h-7 text-xs">
              <FontAwesomeIcon icon={faFolderOpen} className="h-3.5 w-3.5" />打开文件夹
            </Button>
          </div>
        </div>
        {loading ? (
          <div className="flex items-center justify-center gap-2 py-8 text-sm text-muted-foreground">
            <FontAwesomeIcon icon={faRotate} className="h-4 w-4 animate-spin" />加载中...
          </div>
        ) : filtered.length === 0 ? (
          <div className="py-8 text-center text-sm text-muted-foreground">
            {search ? '无匹配数据包' : '暂无数据包'}
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            {filtered.map((pack) => (
              <DataPackCard key={pack.fileName} pack={pack} instanceId={instanceId} onDelete={handleDelete} />
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  )
}
```

- [ ] **Step 8: Update tab rendering in the JSX (lines ~1103-1108)**

Replace:
```tsx
{tab === 'saves' && <SavesTab instanceId={id!} files={fileData['saves'] as FileEntry[] | null} loading={fileLoading['saves']} onRefresh={() => loadFiles('saves')} />}
{tab === 'screenshots' && <ScreenshotsTab instanceId={id!} files={fileData['screenshots'] as FileEntry[] | null} loading={fileLoading['screenshots']} onRefresh={() => loadFiles('screenshots')} />}
{tab === 'mods' && <ModsTab instanceId={id!} gameVersion={instance.gameVersion} loader={instance.loader || undefined} gameDir={instance.gameDir} />}
{tab === 'resourcepacks' && <GenericFileTab instanceId={id!} type="resourcepacks" icon={faBox} label="资源包" files={fileData['resourcepacks'] as FileEntry[] | null} loading={fileLoading['resourcepacks']} onRefresh={() => loadFiles('resourcepacks')} showSize emptyText="暂无资源包" />}
{tab === 'shaderpacks' && <GenericFileTab instanceId={id!} type="shaderpacks" icon={faSun} label="光影包" files={fileData['shaderpacks'] as FileEntry[] | null} loading={fileLoading['shaderpacks']} onRefresh={() => loadFiles('shaderpacks')} showSize emptyText="暂无光影包" />}
{tab === 'servers' && <ServersTab instanceId={id!} servers={fileData['servers'] as ServerEntry[] | null} loading={fileLoading['servers']} onRefresh={() => loadFiles('servers')} />}
```

With:
```tsx
{tab === 'saves' && <SavesTab instanceId={id!} />}
{tab === 'screenshots' && <ScreenshotsTab instanceId={id!} />}
{tab === 'mods' && <ModsTab instanceId={id!} gameVersion={instance.gameVersion} loader={instance.loader || undefined} gameDir={instance.gameDir} />}
{tab === 'resourcepacks' && <ResourcePacksTab instanceId={id!} gameDir={instance.gameDir} />}
{tab === 'shaderpacks' && <ShadersTab instanceId={id!} gameDir={instance.gameDir} />}
{tab === 'datapacks' && <DataPacksTab instanceId={id!} gameDir={instance.gameDir} />}
{tab === 'servers' && <ServersTab instanceId={id!} servers={fileData['servers'] as ServerEntry[] | null} loading={fileLoading['servers']} onRefresh={() => loadFiles('servers')} />}
```

- [ ] **Step 9: Clean up loadFiles — remove obsolete entries**

In the `loadFiles` function, remove `saves`, `screenshots`, `resourcepacks`, `shaderpacks` from the loaders object since each tab now manages its own loading:

```tsx
const loaders: Record<string, (id: string) => Promise<FileEntry[] | ServerEntry[]>> = {
  servers: getServers,
}
```

- [ ] **Step 10: Build frontend to verify**

```bash
npm run build
```

Expected: 0 errors. Fix any unused import warnings.

- [ ] **Step 11: Commit**

```bash
git add -f src/pages/InstanceDetail.tsx && git commit -m "feat: upgrade all instance tabs to metadata-based cards, add DataPacksTab"
```

---

### Task 15: Remove unused GenericFileTab

**Files:**
- Modify: `src/pages/InstanceDetail.tsx`

Since `GenericFileTab` is no longer used, remove it from the file.

- [ ] **Step 1: Remove GenericFileTab function (lines ~421-479)**

Delete the entire `GenericFileTab` component.

- [ ] **Step 2: Commit**

```bash
git add -f src/pages/InstanceDetail.tsx && git commit -m "chore: remove unused GenericFileTab component"
```

---

### Task 16: Final verification

- [ ] **Step 1: Build entire project**

```bash
dotnet build src-backend/Qomicex.Launcher.Backend/Qomicex.Launcher.Backend.csproj && npm run build
```

Expected: 0 errors in both.

- [ ] **Step 2: Verify no unused imports or dead code**

Check imports in InstanceDetail.tsx — remove any that are no longer used (e.g., `GenericFileTab` was removed, `FileEntry` may still be needed for servers).

- [ ] **Step 3: Run and verify**

```bash
dotnet run --project src-backend/Qomicex.Launcher.Backend
```

In another terminal:
```bash
npm run tauri dev
```

Navigate to instance detail page. Verify:
- Saves tab: shows save icons, names, last played, rename/backup/delete
- Screenshots tab: shows thumbnails, click for preview, delete
- Mods tab: unchanged
- Resource packs tab: shows icons, names, format, description, search, delete
- Shaders tab: shows icons, names, version, search, delete
- DataPacks tab: new tab, shows icons, names, format, search, delete
- Servers tab: unchanged
