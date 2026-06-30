# 实例 Mod 管理优化 — 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将实例详情 Mod Tab 从简单文件列表升级为带元数据的丰富模组卡片，支持启用/禁用、右键菜单操作、版本更换、MC百科跳转。

**Architecture:** 后端调用 Qomicex.Core 的 `Mods` 类解析元数据，新增 API 端点返回 `ModMetadataDto[]` 及操作接口。前端新增 ContextMenu/ModCard/VersionPickerDialog 组件，重写 ModsTab。

**Tech Stack:** ASP.NET Core (.NET 10), React 19 + TypeScript, Tailwind CSS

## Global Constraints

- Qomicex.Core 已在 `.csproj` 中引用，无需添加
- 前端所有 import 必须带文件扩展名
- 使用已有的 `cn()` 工具函数、`Card`/`Button`/`Input`/`Tooltip` 等 UI 组件
- 错误处理遵循现有惯例：后端异常冒泡到 middleware，前端用 toast 提示
- `mcmod_data.json` 已含 `id` 字段，只需扩展 `McmodService` 读取

---

### Task 1: McmodService 扩展 — 支持读取 mcmod ID

**Files:**
- Modify: `src-backend/Qomicex.Launcher.Backend/Services/McmodService.cs`

**Interfaces:**
- Produces: `McmodEntry` 新增 `Id?` 属性；`BatchLookupWithIds(List<string>)` → `Dictionary<string, (string? cnName, int? id)>`

- [ ] **Step 1: 修改 McmodEntry，添加 Id 字段**

在 `private sealed class McmodEntry` 中添加：

```csharp
private sealed class McmodEntry
{
    public int? Id { get; set; }
    public string? EnName { get; set; }
    public string? CnName { get; set; }
}
```

- [ ] **Step 2: 修改数据加载逻辑，存储 Id 映射**

修改构造函数中的加载逻辑，将 `_map` 从 `Dictionary<string, string>` 改为 `Dictionary<string, (string cnName, int? id)>`：

```csharp
private readonly Dictionary<string, (string CnName, int? Id)> _map;

public McmodService()
{
    _map = [];

    try
    {
        var json = TryLoadRuntimeOverride() ?? TryLoadEmbedded();
        if (json == null) return;
        var doc = JsonSerializer.Deserialize<McmodData>(json, JsonOptions);
        if (doc?.Mods == null) return;
        foreach (var entry in doc.Mods)
        {
            var key = Normalize(entry.EnName ?? "");
            if (key.Length > 0 && !_map.ContainsKey(key))
                _map[key] = (entry.CnName ?? entry.EnName ?? "", entry.Id);
        }
    }
    catch { }
}
```

- [ ] **Step 3: 更新查找和批量查找方法**

修改 `Lookup` 和 `BatchLookup` 以适配新的数据结构：

```csharp
public string? Lookup(string enName)
{
    var key = Normalize(enName);
    if (key.Length == 0) return null;
    if (_map.TryGetValue(key, out var entry)) return entry.CnName;
    foreach (var (k, v) in _map)
        if (k.Contains(key) || key.Contains(k)) return v.CnName;
    var words = key.Split(' ', StringSplitOptions.RemoveEmptyEntries);
    foreach (var (k, v) in _map)
        foreach (var w in words)
            if (w.Length > 2 && k.Contains(w)) return v.CnName;
    return null;
}

public Dictionary<string, string?> BatchLookup(List<string> names)
{
    var result = new Dictionary<string, string?>(names.Count);
    foreach (var name in names)
        result[name] = Lookup(name);
    return result;
}
```

- [ ] **Step 4: 新增 BatchLookupWithIds 方法**

```csharp
public Dictionary<string, (string? CnName, int? Id)> BatchLookupWithIds(List<string> names)
{
    var result = new Dictionary<string, (string? CnName, int? Id)>(names.Count);
    foreach (var name in names)
    {
        var key = Normalize(name);
        if (key.Length > 0 && _map.TryGetValue(key, out var entry))
            result[name] = (entry.CnName, entry.Id);
        else
            result[name] = (null, null);
    }
    return result;
}
```

- [ ] **Step 5: 编译验证**

Run: `dotnet build src-backend/Qomicex.Launcher.Backend/Qomicex.Launcher.Backend.csproj`
Expected: Build succeeded

- [ ] **Step 6: Commit**

```bash
git add src-backend/Qomicex.Launcher.Backend/Services/McmodService.cs
git commit -m "feat: extend McmodService to read mcmod ID from data"
```

---

### Task 2: 创建 ModMetadataDto

**Files:**
- Modify: `src-backend/Qomicex.Launcher.Backend/Models/FileEntry.cs` (在文件末尾追加)

**Interfaces:**
- Produces: `ModMetadataDto` class, `ChangeModVersionRequest` class

- [ ] **Step 1: 在 FileEntry.cs 末尾添加 DTO 类**

```csharp
public class ModMetadataDto
{
    public string FileName { get; set; } = string.Empty;
    public string Name { get; set; } = string.Empty;
    public string Version { get; set; } = string.Empty;
    public string Description { get; set; } = string.Empty;
    public string[] Authors { get; set; } = [];
    public string? IconUrl { get; set; }
    public int? CurseForgeId { get; set; }
    public string? ModrinthId { get; set; }
    public string? Source { get; set; }
    public int? McmodId { get; set; }
    public string? ChineseName { get; set; }
    public bool Active { get; set; }
}

public class ChangeModVersionRequest
{
    public string FileName { get; set; } = string.Empty;
    public string DownloadUrl { get; set; } = string.Empty;
    public string NewFileName { get; set; } = string.Empty;
}
```

- [ ] **Step 2: 编译验证**

Run: `dotnet build src-backend/Qomicex.Launcher.Backend/Qomicex.Launcher.Backend.csproj`
Expected: Build succeeded

- [ ] **Step 3: Commit**

```bash
git add src-backend/Qomicex.Launcher.Backend/Models/FileEntry.cs
git commit -m "feat: add ModMetadataDto and ChangeModVersionRequest models"
```

---

### Task 3: InstanceFilesController — 新增 Mod 管理端点

**Files:**
- Modify: `src-backend/Qomicex.Launcher.Backend/Controllers/InstanceFilesController.cs`

**Interfaces:**
- Consumes: `ModMetadataDto`, `ChangeModVersionRequest` (Task 2); `McmodService_BatchLookupWithIds` (Task 1)
- Produces: `GET .../mods/metadata`, `POST .../mods/enable`, `POST .../mods/disable`, `POST .../mods/change-version`, `POST .../mods/batch-enable`, `POST .../mods/batch-disable`, `POST .../mods/batch-delete`

- [ ] **Step 1: 添加 McmodService 和 IConfiguration 注入**

修改构造函数：

```csharp
private readonly IInstanceRepository _repository;
private readonly IHttpClientFactory _httpClientFactory;
private readonly McmodService _mcmod;
private readonly IConfiguration _configuration;

public InstanceFilesController(
    IInstanceRepository repository,
    IHttpClientFactory httpClientFactory,
    McmodService mcmod,
    IConfiguration configuration)
{
    _repository = repository;
    _httpClientFactory = httpClientFactory;
    _mcmod = mcmod;
    _configuration = configuration;
}
```

添加 using:

```csharp
using Qomicex.Core.Modules.Helpers.Resources.Expansion.Local;
```

- [ ] **Step 2: 添加 GET mods/metadata 端点**

在现有 `mods` 相关方法后添加：

```csharp
[HttpGet("mods/metadata")]
public async Task<ActionResult<List<ModMetadataDto>>> GetModsMetadata(string instanceId)
{
    var inst = _repository.GetById(instanceId);
    if (inst == null) return NotFound();

    var gameDir = ResolveGameDir(instanceId);
    if (gameDir == null) return NotFound();

    var versionSegmented = inst.VersionIsolation ?? true;
    var apiKey = _configuration["CurseForge:ApiKey"] ?? "";

    var mods = new Mods(gameDir, inst.GameVersion, versionSegmented, apiKey);
    var modList = await mods.GetModList();

    var names = modList.Select(m => m.Name).Distinct().ToList();
    var lookupResult = _mcmod.BatchLookupWithIds(names);

    var result = modList.Select(m =>
    {
        var (cnName, mcmodId) = lookupResult.GetValueOrDefault(m.Name, (null, null));
        string? source = null;
        if (m.CurseForgeId > 0) source = "curseforge";
        else if (!string.IsNullOrEmpty(m.ModrinthId)) source = "modrinth";

        return new ModMetadataDto
        {
            FileName = Path.GetFileName(m.FilePath),
            Name = m.Name,
            Version = m.Version,
            Description = m.Description ?? "",
            Authors = m.Authors ?? [],
            IconUrl = m.CurseFoegeMeta?.IconUrl ?? m.ModrinthMeta?.IconUrl ?? null,
            CurseForgeId = m.CurseForgeId > 0 ? m.CurseForgeId : null,
            ModrinthId = m.ModrinthId,
            Source = source,
            McmodId = mcmodId,
            ChineseName = cnName,
            Active = m.Active,
        };
    }).ToList();

    return Ok(result);
}
```

- [ ] **Step 3: 添加 POST mods/enable 端点**

```csharp
[HttpPost("mods/enable")]
public IActionResult EnableMod(string instanceId, [FromQuery] string name)
{
    var gameDir = ResolveGameDir(instanceId);
    if (gameDir == null) return NotFound();
    var modsDir = Path.Combine(gameDir, "mods");
    var fileName = name.EndsWith(".disabled", StringComparison.OrdinalIgnoreCase) ? name : name + ".disabled";
    var filePath = Path.Combine(modsDir, fileName);
    if (!System.IO.File.Exists(filePath))
    {
        var altPath = Path.Combine(modsDir, name);
        if (!System.IO.File.Exists(altPath)) return NotFound();
        return NoContent(); // already enabled
    }

    var versionSegmented = _repository.GetById(instanceId)?.VersionIsolation ?? true;
    var apiKey = _configuration["CurseForge:ApiKey"] ?? "";
    var inst = _repository.GetById(instanceId)!;
    var mods = new Mods(gameDir, inst.GameVersion, versionSegmented, apiKey);
    mods.EnableMod(filePath);
    return NoContent();
}
```

- [ ] **Step 4: 添加 POST mods/disable 端点**

```csharp
[HttpPost("mods/disable")]
public IActionResult DisableMod(string instanceId, [FromQuery] string name)
{
    var gameDir = ResolveGameDir(instanceId);
    if (gameDir == null) return NotFound();
    var modsDir = Path.Combine(gameDir, "mods");
    var filePath = Path.Combine(modsDir, name);
    if (!System.IO.File.Exists(filePath)) return NotFound();

    var versionSegmented = _repository.GetById(instanceId)?.VersionIsolation ?? true;
    var apiKey = _configuration["CurseForge:ApiKey"] ?? "";
    var inst = _repository.GetById(instanceId)!;
    var mods = new Mods(gameDir, inst.GameVersion, versionSegmented, apiKey);
    mods.DisableMod(filePath);
    return NoContent();
}
```

- [ ] **Step 5: 添加 POST mods/change-version 端点**

```csharp
[HttpPost("mods/change-version")]
public async Task<IActionResult> ChangeModVersion(string instanceId, [FromBody] ChangeModVersionRequest request)
{
    var gameDir = ResolveGameDir(instanceId);
    if (gameDir == null) return NotFound();
    var modsDir = Path.Combine(gameDir, "mods");

    // 删除旧文件（可能是 .jar 或 .jar.disabled）
    var oldPath = Path.Combine(modsDir, request.FileName);
    if (System.IO.File.Exists(oldPath))
        System.IO.File.Delete(oldPath);
    var disabledPath = Path.Combine(modsDir, request.FileName + ".disabled");
    if (System.IO.File.Exists(disabledPath))
        System.IO.File.Delete(disabledPath);

    // 下载新文件
    var newPath = Path.Combine(modsDir, request.NewFileName);
    using var client = _httpClientFactory.CreateClient();
    var response = await client.GetAsync(request.DownloadUrl);
    if (!response.IsSuccessStatusCode)
        return BadRequest(new { error = "下载失败" });
    await using var stream = await response.Content.ReadAsStreamAsync();
    await using var file = System.IO.File.Create(newPath);
    await stream.CopyToAsync(file);

    return NoContent();
}
```

- [ ] **Step 6: 添加批量操作端点**

```csharp
[HttpPost("mods/batch-enable")]
public IActionResult BatchEnableMods(string instanceId, [FromBody] List<string> names)
{
    var gameDir = ResolveGameDir(instanceId);
    if (gameDir == null) return NotFound();
    var modsDir = Path.Combine(gameDir, "mods");
    var apiKey = _configuration["CurseForge:ApiKey"] ?? "";
    var inst = _repository.GetById(instanceId)!;
    var versionSegmented = inst.VersionIsolation ?? true;
    var mods = new Mods(gameDir, inst.GameVersion, versionSegmented, apiKey);

    foreach (var name in names)
    {
        var fileName = name.EndsWith(".disabled", StringComparison.OrdinalIgnoreCase) ? name : name + ".disabled";
        var path = Path.Combine(modsDir, fileName);
        if (System.IO.File.Exists(path))
            mods.EnableMod(path);
    }
    return NoContent();
}

[HttpPost("mods/batch-disable")]
public IActionResult BatchDisableMods(string instanceId, [FromBody] List<string> names)
{
    var gameDir = ResolveGameDir(instanceId);
    if (gameDir == null) return NotFound();
    var modsDir = Path.Combine(gameDir, "mods");
    var apiKey = _configuration["CurseForge:ApiKey"] ?? "";
    var inst = _repository.GetById(instanceId)!;
    var versionSegmented = inst.VersionIsolation ?? true;
    var mods = new Mods(gameDir, inst.GameVersion, versionSegmented, apiKey);

    foreach (var name in names)
    {
        var path = Path.Combine(modsDir, name);
        if (System.IO.File.Exists(path))
            mods.DisableMod(path);
    }
    return NoContent();
}

[HttpPost("mods/batch-delete")]
public IActionResult BatchDeleteMods(string instanceId, [FromBody] List<string> names)
{
    var modsDir = GetPath(instanceId, "mods", out var _);
    if (modsDir == null) return NotFound();

    foreach (var name in names)
    {
        var path = Path.Combine(modsDir, name);
        if (System.IO.File.Exists(path))
            System.IO.File.Delete(path);
        var disabledPath = Path.Combine(modsDir, name + ".disabled");
        if (System.IO.File.Exists(disabledPath))
            System.IO.File.Delete(disabledPath);
    }
    return NoContent();
}
```

- [ ] **Step 7: 编译验证**

Run: `dotnet build src-backend/Qomicex.Launcher.Backend/Qomicex.Launcher.Backend.csproj`
Expected: Build succeeded

- [ ] **Step 8: Commit**

```bash
git add src-backend/Qomicex.Launcher.Backend/Controllers/InstanceFilesController.cs
git commit -m "feat: add mod metadata, enable/disable, change-version, batch endpoints"
```

---

### Task 4: 前端 — 类型定义

**Files:**
- Modify: `src/types/index.ts`

**Interfaces:**
- Produces: `ModMetadata` interface

- [ ] **Step 1: 在 types/index.ts 中添加 ModMetadata 类型**

在 `FileEntry` 接口附近添加：

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

---

### Task 5: 前端 — API 函数

**Files:**
- Modify: `src/api/instance-files.ts`

**Interfaces:**
- Consumes: `ModMetadata` (Task 4)
- Produces: `getModsMetadata`, `enableMod`, `disableMod`, `changeModVersion`, `batchEnableMods`, `batchDisableMods`, `batchDeleteMods`

- [ ] **Step 1: 添加 API 函数**

在文件末尾追加：

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

需要确保 `post` 已从 `./client.ts` 导入（检查第一行是否已有，没有则加上）。

- [ ] **Step 2: 类型检查**

Run: `npx tsc --noEmit`
Expected: No new errors

- [ ] **Step 3: Commit**

```bash
git add src/api/instance-files.ts
git commit -m "feat: add mod metadata and management API functions"
```

---

### Task 6: 前端 — ContextMenu 右键菜单组件

**Files:**
- Create: `src/components/ContextMenu.tsx`

**Interfaces:**
- Produces: `<ContextMenu items targetRef>` — 在元素上右键时显示菜单，点击外部关闭

- [ ] **Step 1: 创建 ContextMenu 组件**

```tsx
import { useEffect, useRef, useState, useCallback } from 'react'
import { createPortal } from 'react-dom'
import { cn } from '../lib/utils.ts'

export interface ContextMenuItem {
  label: string
  icon?: any
  onClick: () => void
  disabled?: boolean
  danger?: boolean
}

export interface ContextMenuProps {
  items: ContextMenuItem[]
  children: React.ReactNode
}

export function ContextMenu({ items, children }: ContextMenuProps) {
  const [open, setOpen] = useState(false)
  const [pos, setPos] = useState({ x: 0, y: 0 })
  const menuRef = useRef<HTMLDivElement>(null)

  const onContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    setPos({ x: e.clientX, y: e.clientY })
    setOpen(true)
  }, [])

  useEffect(() => {
    if (!open) return
    const handler = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open])

  // 防止菜单超出视口
  useEffect(() => {
    if (!open || !menuRef.current) return
    const rect = menuRef.current.getBoundingClientRect()
    let { x, y } = pos
    if (x + rect.width > window.innerWidth) x = window.innerWidth - rect.width - 8
    if (y + rect.height > window.innerHeight) y = window.innerHeight - rect.height - 8
    menuRef.current.style.left = `${x}px`
    menuRef.current.style.top = `${y}px`
  }, [open, pos])

  return (
    <>
      <div onContextMenu={onContextMenu}>{children}</div>
      {open && createPortal(
        <div
          ref={menuRef}
          className="fixed z-50 min-w-[160px] rounded-lg border border-border bg-popover p-1 shadow-lg animate-in fade-in zoom-in-95"
          style={{ left: pos.x, top: pos.y }}
        >
          {items.map((item, i) => (
            <button
              key={i}
              onClick={() => { item.onClick(); setOpen(false) }}
              disabled={item.disabled}
              className={cn(
                'flex w-full items-center gap-2 rounded-md px-3 py-2 text-sm transition-colors',
                item.danger
                  ? 'text-destructive hover:bg-destructive/10'
                  : 'text-popover-foreground hover:bg-accent',
                item.disabled && 'cursor-not-allowed opacity-50 hover:bg-transparent'
              )}
            >
              {item.label}
            </button>
          ))}
        </div>,
        document.body
      )}
    </>
  )
}
```

- [ ] **Step 2: 类型检查**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add src/components/ContextMenu.tsx
git commit -m "feat: add ContextMenu right-click menu component"
```

---

### Task 7: 前端 — ModCard 组件

**Files:**
- Create: `src/components/ModCard.tsx`

**Interfaces:**
- Consumes: `ModMetadata` (Task 4); `ContextMenu` (Task 6); `Tooltip` (existing)
- Produces: `<ModCard mod instanceId gameVersion loader onRefresh onNavigate batchMode selected onSelect>` — 单个模组卡片

- [ ] **Step 1: 创建 ModCard 组件**

```tsx
import { useCallback, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import { faCube, faRotate } from '@fortawesome/free-solid-svg-icons'
import { Card, CardContent } from './ui/card.tsx'
import { Tooltip } from './ui/tooltip.tsx'
import { ContextMenu, ContextMenuItem } from './ContextMenu.tsx'
import { Dialog, DialogHeader, DialogTitle, DialogBody, DialogFooter } from './ui/dialog.tsx'
import { Button } from './ui/button.tsx'
import { cn } from '../lib/utils.ts'
import { enableMod, disableMod, deleteMod } from '../api/instance-files.ts'
import type { ModMetadata } from '../types/index.ts'

interface ModCardProps {
  mod: ModMetadata
  instanceId: string
  gameVersion?: string
  loader?: string
  onRefresh: () => void
  onChangeVersion: (mod: ModMetadata) => void
  batchMode?: boolean
  selected?: boolean
  onSelect?: (fileName: string) => void
}

export default function ModCard({
  mod, instanceId, gameVersion, loader, onRefresh, onChangeVersion,
  batchMode, selected, onSelect,
}: ModCardProps) {
  const navigate = useNavigate()
  const [toggling, setToggling] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [deleting, setDeleting] = useState(false)

  const handleToggle = useCallback(async () => {
    const wasActive = mod.active
    setToggling(true)
    try {
      if (wasActive) {
        await disableMod(instanceId, mod.fileName)
      } else {
        const disabledName = mod.fileName.endsWith('.disabled') ? mod.fileName : mod.fileName + '.disabled'
        await enableMod(instanceId, disabledName)
      }
      onRefresh()
    } catch {
      // toast handled by error middleware
    }
    setToggling(false)
  }, [instanceId, mod, onRefresh])

  const handleDelete = useCallback(async () => {
    setDeleting(true)
    setConfirmDelete(false)
    try {
      await deleteMod(instanceId, mod.fileName)
      onRefresh()
    } catch {}
    setDeleting(false)
  }, [instanceId, mod, onRefresh])

  const contextItems: ContextMenuItem[] = []
  if (mod.mcmodId) {
    contextItems.push({
      label: 'MC百科',
      onClick: () => window.open(`https://www.mcmod.cn/class/${mod.mcmodId}`, '_blank'),
    })
  }
  if (mod.curseForgeId || mod.modrinthId) {
    const params = new URLSearchParams()
    params.set('source', mod.source || 'modrinth')
    params.set('category', 'mod')
    if (gameVersion) params.set('gameVersion', gameVersion)
    if (loader) params.set('loader', loader.toLowerCase())
    if (instanceId) params.set('instanceId', instanceId)
    const id = mod.curseForgeId?.toString() ?? mod.modrinthId ?? ''
    contextItems.push({
      label: '查看详情',
      onClick: () => navigate(`/resource-center/${encodeURIComponent(id)}?${params.toString()}&expandBody=1`),
    })
  }
  contextItems.push(
    { label: '更换版本', onClick: () => onChangeVersion(mod) },
    { label: '删除', onClick: () => setConfirmDelete(true), danger: true },
  )

  return (
    <>
      <ContextMenu items={contextItems}>
        <Card
          className={cn(
            'group cursor-pointer select-none border-border/60 bg-card/95 transition-all hover:border-primary/20 hover:shadow-sm',
            !mod.active && 'opacity-50',
            batchMode && selected && 'ring-2 ring-primary border-primary/30'
          )}
          onClick={() => batchMode && onSelect?.(mod.fileName)}
        >
          <CardContent className="flex items-center gap-4 p-4">
            <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-muted text-muted-foreground overflow-hidden">
              {mod.iconUrl ? (
                <img src={mod.iconUrl} alt={mod.name} className="h-full w-full object-cover" loading="lazy" onError={(e) => { (e.target as HTMLImageElement).style.display = 'none' }} />
              ) : (
                <FontAwesomeIcon icon={faCube} className="h-5 w-5 opacity-50" />
              )}
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <h3 className="truncate text-sm font-semibold text-foreground">
                  {mod.chineseName ? <>{mod.chineseName}<span className="ml-1.5 text-xs font-normal text-muted-foreground/60">| {mod.name}</span></> : mod.name}
                </h3>
              </div>
              <div className="mt-0.5 flex items-center gap-2 text-xs text-muted-foreground">
                <span>{mod.version || '未知版本'}</span>
                {mod.authors.length > 0 && (
                  <>
                    <span className="text-border">·</span>
                    <span className="truncate">{mod.authors[0]}</span>
                  </>
                )}
              </div>
              {mod.description && mod.description !== 'No description available' && (
                <p className="mt-1 line-clamp-1 text-xs text-muted-foreground/70">{mod.description}</p>
              )}
            </div>
            <Tooltip content={mod.active ? '已启用' : '已禁用'}>
              <button
                onClick={(e) => { e.stopPropagation(); handleToggle() }}
                disabled={toggling}
                className={cn(
                  'relative inline-flex h-6 w-10 shrink-0 items-center rounded-full transition-colors',
                  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2',
                  mod.active ? 'bg-primary' : 'bg-muted-foreground/25',
                  toggling && 'opacity-50 cursor-wait'
                )}
              >
                <span
                  className={cn(
                    'inline-block h-4 w-4 rounded-full bg-white shadow-sm transition-transform',
                    mod.active ? 'translate-x-[22px]' : 'translate-x-[4px]'
                  )}
                />
                {toggling && <FontAwesomeIcon icon={faRotate} className="absolute left-1/2 top-1/2 h-3 w-3 -translate-x-1/2 -translate-y-1/2 animate-spin text-white/80" />}
              </button>
            </Tooltip>
          </CardContent>
        </Card>
      </ContextMenu>

      <Dialog open={confirmDelete} onClose={() => setConfirmDelete(false)}>
        <DialogHeader onClose={() => setConfirmDelete(false)}>
          <DialogTitle>删除 Mod</DialogTitle>
        </DialogHeader>
        <DialogBody>
          <p className="text-sm text-muted-foreground">确定要删除 Mod「{mod.name}」吗？此操作不可撤销。</p>
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" size="sm" onClick={() => setConfirmDelete(false)}>取消</Button>
          <Button size="sm" variant="destructive" onClick={handleDelete} disabled={deleting}>
            {deleting ? '删除中...' : '删除'}
          </Button>
        </DialogFooter>
      </Dialog>
    </>
  )
}
```

- [ ] **Step 2: 类型检查**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add src/components/ModCard.tsx
git commit -m "feat: add ModCard component with toggle, context menu, delete"
```

---

### Task 8: 前端 — VersionPickerDialog 组件

**Files:**
- Create: `src/components/VersionPickerDialog.tsx`

**Interfaces:**
- Consumes: `ModMetadata` (Task 4); `getResourceVersions`, `getResourceVersionDownloads` (existing `resource.ts`); `changeModVersion` (Task 5)
- Produces: `<VersionPickerDialog open onClose mod instanceId onDone>` — 版本选择并下载

- [ ] **Step 1: 创建 VersionPickerDialog 组件**

```tsx
import { useEffect, useState, useCallback } from 'react'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import { faRotate, faDownload } from '@fortawesome/free-solid-svg-icons'
import { Dialog, DialogHeader, DialogTitle, DialogBody, DialogFooter } from './ui/dialog.tsx'
import { Button } from './ui/button.tsx'
import { cn } from '../lib/utils.ts'
import { getResourceVersions, getResourceVersionDownloads } from '../api/resource.ts'
import { changeModVersion } from '../api/instance-files.ts'
import type { ModMetadata, ResourceVersion, ResourceFile } from '../types/index.ts'

interface VersionPickerDialogProps {
  open: boolean
  onClose: () => void
  mod: ModMetadata | null
  instanceId: string
  gameVersion?: string
  loader?: string
  onDone: () => void
}

export default function VersionPickerDialog({
  open, onClose, mod, instanceId, gameVersion, loader, onDone,
}: VersionPickerDialogProps) {
  const [versions, setVersions] = useState<ResourceVersion[]>([])
  const [loading, setLoading] = useState(false)
  const [installing, setInstalling] = useState<string | null>(null)
  const [downloadFile, setDownloadFile] = useState<ResourceFile | null>(null)

  useEffect(() => {
    if (!open || !mod || !mod.source) return
    const id = mod.curseForgeId?.toString() ?? mod.modrinthId
    if (!id) return
    setLoading(true)
    const loaderType = (loader || '').toLowerCase() || undefined
    getResourceVersions(id, mod.source, gameVersion, loaderType)
      .then(setVersions)
      .catch(() => setVersions([]))
      .finally(() => setLoading(false))
  }, [open, mod, gameVersion, loader])

  useEffect(() => {
    if (!downloadFile || !mod) return
    const id = mod.curseForgeId?.toString() ?? mod.modrinthId
    if (!id) return
    const doDownload = async () => {
      const newFileName = downloadFile.filename
      try {
        await changeModVersion(instanceId, mod.fileName, downloadFile.url, newFileName)
        onDone()
        onClose()
      } catch {}
      setInstalling(null)
      setDownloadFile(null)
    }
    doDownload()
  }, [downloadFile])

  const handleInstall = useCallback(async (version: ResourceVersion) => {
    if (!mod || !mod.source) return
    const id = mod.curseForgeId?.toString() ?? mod.modrinthId
    if (!id) return
    setInstalling(version.id)
    try {
      const files = await getResourceVersionDownloads(id, version.id, mod.source)
      const jarFile = files.find(f => f.filename.endsWith('.jar'))
      if (jarFile) {
        setDownloadFile(jarFile)
      } else {
        setInstalling(null)
      }
    } catch {
      setInstalling(null)
    }
  }, [mod, instanceId, onDone, onClose])

  return (
    <Dialog open={open} onClose={onClose}>
      <DialogHeader onClose={onClose}>
        <DialogTitle>更换版本 — {mod?.name}</DialogTitle>
      </DialogHeader>
      <DialogBody>
        {loading ? (
          <div className="flex items-center justify-center gap-2 py-8 text-sm text-muted-foreground">
            <FontAwesomeIcon icon={faRotate} className="h-4 w-4 animate-spin" />加载版本列表...
          </div>
        ) : versions.length === 0 ? (
          <div className="py-8 text-center text-sm text-muted-foreground">没有可用的版本</div>
        ) : (
          <div className="max-h-80 space-y-1 overflow-y-auto">
            {versions.map((v) => (
              <div
                key={v.id}
                className={cn(
                  'flex items-center gap-2 rounded-lg px-3 py-2 text-sm transition-colors',
                  installing !== v.id && 'hover:bg-accent'
                )}
              >
                <span className="flex-1 truncate">{v.name}</span>
                <span className="text-xs text-muted-foreground">{v.versionNumber}</span>
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7 gap-1 text-xs"
                  onClick={() => handleInstall(v)}
                  disabled={installing !== null}
                >
                  {installing === v.id ? (
                    <><FontAwesomeIcon icon={faRotate} className="h-3 w-3 animate-spin" />下载中...</>
                  ) : (
                    <><FontAwesomeIcon icon={faDownload} className="h-3 w-3" />安装</>
                  )}
                </Button>
              </div>
            ))}
          </div>
        )}
      </DialogBody>
      <DialogFooter>
        <Button variant="outline" size="sm" onClick={onClose} disabled={installing !== null}>取消</Button>
      </DialogFooter>
    </Dialog>
  )
}
```

- [ ] **Step 2: 类型检查**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add src/components/VersionPickerDialog.tsx
git commit -m "feat: add VersionPickerDialog for mod version switching"
```

---

### Task 9: 重写 ModsTab 组件

**Files:**
- Modify: `src/pages/InstanceDetail.tsx`

**Interfaces:**
- Consumes: `ModMetadata` (Task 4); `getModsMetadata`, `batchEnableMods`, `batchDisableMods`, `batchDeleteMods` (Task 5); `ModCard` (Task 7); `VersionPickerDialog` (Task 8)
- Produces: 替换现有 `ModsTab` 函数

- [ ] **Step 1: 更新 imports**

在 InstanceDetail.tsx 顶部追加新 import：

```tsx
import { getModsMetadata, batchEnableMods, batchDisableMods, batchDeleteMods } from '../api/instance-files.ts'
import ModCard from '../components/ModCard.tsx'
import VersionPickerDialog from '../components/VersionPickerDialog.tsx'
import type { ModMetadata } from '../types/index.ts'
```

同时需要在原来的 import 行中，从 `getMods, deleteMod` 移除或保留 `deleteMod`（ModCard 内部使用，不再从 Tab 层调用）。将 import 行中的 `getMods` 替换为 `deleteMod` 仅保留给 ModCard 用（实际上 ModCard 通过 API 层调用，Tab 层不需要了）。但保留 `deleteMod` import 因为 ConfirmDialog 仍需要。

更简单的方式：从 instance-files.ts import 中移除 `getMods`, `deleteMod` 并只保留 Tab 层需要的 `getModsMetadata`, `batchEnableMods`, `batchDisableMods`, `batchDeleteMods`。ModCard 组件内部自己 import api 函数。

因此修改第 19 行 `import { ... } from '../api/instance-files.ts'` 为：

```tsx
import { getSaves, getScreenshots, getResourcePacks, getShaderPacks, getServers, deleteSave, copySave, deleteScreenshot, deleteResourcePack, deleteShaderPack, addServer, deleteServer, pingServer, getModsMetadata, batchEnableMods, batchDisableMods, batchDeleteMods } from '../api/instance-files.ts'
```

移除 `getMods, deleteMod`。

- [ ] **Step 2: 重写 ModsTab 函数**

找到 `function ModsTab({ instanceId, files, loading, onRefresh, gameVersion, loader }: { ... })` (约第 204 行) 并完整替换：

```tsx
function ModsTab({ instanceId, gameVersion, loader }: {
  instanceId: string
  gameVersion?: string
  loader?: string
}) {
  const navigate = useNavigate()
  const [search, setSearch] = useState('')
  const [mods, setMods] = useState<ModMetadata[]>([])
  const [loading, setLoading] = useState(true)
  const [versionDialogMod, setVersionDialogMod] = useState<ModMetadata | null>(null)

  // 多选模式
  const [batchMode, setBatchMode] = useState(false)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [batchConfirm, setBatchConfirm] = useState<{ type: 'enable' | 'disable' | 'delete' } | null>(null)
  const [batchProcessing, setBatchProcessing] = useState(false)

  const loadMods = useCallback(async () => {
    setLoading(true)
    try {
      const data = await getModsMetadata(instanceId)
      setMods(data)
    } catch { setMods([]) }
    setLoading(false)
  }, [instanceId])

  useEffect(() => {
    loadMods()
  }, [loadMods])

  const filtered = useMemo(() => {
    if (!search) return mods
    const q = search.toLowerCase()
    return mods.filter(m =>
      m.name.toLowerCase().includes(q) ||
      (m.chineseName && m.chineseName.includes(q)) ||
      m.fileName.toLowerCase().includes(q)
    )
  }, [mods, search])

  const toggleSelect = useCallback((fileName: string) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(fileName)) next.delete(fileName)
      else next.add(fileName)
      return next
    })
  }, [])

  const enterBatchMode = useCallback(() => {
    setBatchMode(true)
    setSelected(new Set())
  }, [])

  const exitBatchMode = useCallback(() => {
    setBatchMode(false)
    setSelected(new Set())
  }, [])

  const handleBatchAction = useCallback(async () => {
    if (!batchConfirm) return
    setBatchProcessing(true)
    const names = Array.from(selected)
    try {
      if (batchConfirm.type === 'enable') await batchEnableMods(instanceId, names)
      else if (batchConfirm.type === 'disable') await batchDisableMods(instanceId, names)
      else if (batchConfirm.type === 'delete') await batchDeleteMods(instanceId, names)
      await loadMods()
      exitBatchMode()
    } catch {}
    setBatchProcessing(false)
    setBatchConfirm(null)
  }, [batchConfirm, selected, instanceId, loadMods, exitBatchMode])

  if (!loader) {
    return (
      <Card>
        <CardContent className="p-5">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
              <FontAwesomeIcon icon={faCube} className="h-5 w-5" />
            </div>
            <div>
              <h3 className="text-sm font-medium">Mod 管理</h3>
              <p className="mt-0.5 text-xs text-muted-foreground">该实例不可使用 Mod，需要使用 Forge、Fabric 等加载器</p>
            </div>
          </div>
        </CardContent>
      </Card>
    )
  }

  return (
    <>
      <Card>
        <CardContent className="p-5">
          {/* 工具栏 */}
          <div className="mb-3 flex items-center justify-between gap-3">
            <h3 className="text-sm font-medium shrink-0">
              <FontAwesomeIcon icon={faCube} className="mr-2 h-4 w-4 text-primary" />Mod
              {mods.length > 0 && <span className="ml-1.5 text-xs font-normal text-muted-foreground">({mods.length})</span>}
            </h3>
            <div className="flex items-center gap-2 flex-1 max-w-sm">
              <div className="relative flex-1">
                <FontAwesomeIcon icon={faMagnifyingGlass} className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
                <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="搜索 Mod..." className="h-8 pl-8 text-xs" />
              </div>
            </div>
            <div className="flex items-center gap-1.5">
              {batchMode ? (
                <>
                  <Button size="sm" variant="outline" onClick={exitBatchMode} className="gap-1.5 h-7 text-xs">取消</Button>
                  <Button size="sm" variant="outline" onClick={() => setBatchConfirm({ type: 'enable' })} disabled={selected.size === 0} className="gap-1.5 h-7 text-xs">启用</Button>
                  <Button size="sm" variant="outline" onClick={() => setBatchConfirm({ type: 'disable' })} disabled={selected.size === 0} className="gap-1.5 h-7 text-xs">禁用</Button>
                  <Button size="sm" variant="outline" onClick={() => setBatchConfirm({ type: 'delete' })} disabled={selected.size === 0} className="gap-1.5 h-7 text-xs text-destructive hover:text-destructive">删除</Button>
                </>
              ) : (
                <>
                  <Button size="sm" variant="ghost" onClick={() => {/* open mods folder */}} className="gap-1.5 h-7 text-xs">
                    <FontAwesomeIcon icon={faFolderOpen} className="h-3.5 w-3.5" />打开文件夹
                  </Button>
                  <Button size="sm" onClick={() => {
                    const p = new URLSearchParams({ category: 'mod', source: 'modrinth' })
                    if (gameVersion) p.set('gameVersion', gameVersion)
                    if (loader) p.set('loader', loader.toLowerCase())
                    if (instanceId) p.set('instanceId', instanceId)
                    navigate(`/resource-center?${p.toString()}`)
                  }} className="gap-1.5 h-7 text-xs">
                    <FontAwesomeIcon icon={faDownload} className="h-3.5 w-3.5" />安装 Mod
                  </Button>
                </>
              )}
            </div>
          </div>

          {/* 列表 */}
          {loading ? (
            <div className="flex items-center justify-center gap-2 py-8 text-sm text-muted-foreground">
              <FontAwesomeIcon icon={faRotate} className="h-4 w-4 animate-spin" />加载中...
            </div>
          ) : filtered.length === 0 ? (
            <div className="py-8 text-center text-sm text-muted-foreground">
              {search ? '无匹配 Mod' : '暂无 Mod'}
            </div>
          ) : (
            <div className="flex flex-col gap-2">
              {filtered.map((mod) => (
                <ModCard
                  key={mod.fileName}
                  mod={mod}
                  instanceId={instanceId}
                  gameVersion={gameVersion}
                  loader={loader}
                  onRefresh={loadMods}
                  onChangeVersion={setVersionDialogMod}
                  batchMode={batchMode}
                  selected={selected.has(mod.fileName)}
                  onSelect={toggleSelect}
                />
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* 批量操作确认 */}
      <Dialog open={batchConfirm !== null} onClose={() => setBatchConfirm(null)}>
        <DialogHeader onClose={() => setBatchConfirm(null)}>
          <DialogTitle>
            {batchConfirm?.type === 'enable' ? '批量启用' : batchConfirm?.type === 'disable' ? '批量禁用' : '批量删除'}
          </DialogTitle>
        </DialogHeader>
        <DialogBody>
          <p className="text-sm text-muted-foreground">
            确定要
            {batchConfirm?.type === 'enable' ? '启用' : batchConfirm?.type === 'disable' ? '禁用' : '删除'}
            {selected.size} 个 Mod 吗？
          </p>
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" size="sm" onClick={() => setBatchConfirm(null)}>取消</Button>
          <Button size="sm" variant={batchConfirm?.type === 'delete' ? 'destructive' : 'default'} onClick={handleBatchAction} disabled={batchProcessing}>
            {batchProcessing ? '处理中...' : '确定'}
          </Button>
        </DialogFooter>
      </Dialog>

      {/* 版本更换弹窗 */}
      <VersionPickerDialog
        open={versionDialogMod !== null}
        onClose={() => setVersionDialogMod(null)}
        mod={versionDialogMod}
        instanceId={instanceId}
        gameVersion={gameVersion}
        loader={loader}
        onDone={loadMods}
      />
    </>
  )
}
```

- [ ] **Step 3: 更新 ModsTab 调用**

在 InstanceDetailPage 底部，第 975 行，将：

```tsx
{tab === 'mods' && <ModsTab instanceId={id!} files={fileData['mods'] as FileEntry[] | null} loading={fileLoading['mods']} onRefresh={() => loadFiles('mods')} gameVersion={instance.gameVersion} loader={instance.loader || undefined} />}
```

替换为：

```tsx
{tab === 'mods' && <ModsTab instanceId={id!} gameVersion={instance.gameVersion} loader={instance.loader || undefined} />}
```

- [ ] **Step 4: 清理不再使用的 ModsTab 相关代码**

由于新的 ModsTab 不再需要 `files`/`fileData['mods']`/`fileLoading['mods']`/`onRefresh`，可以将 InstanceDetailPage 中 `loadFiles('mods')` 相关的加载逻辑移除。但为了最小改动，保留 `loadFiles` 中对 mods 的处理（虽然不再有 mods key 的 effect 触发），这样做是安全的。或者更干净地移除：

在 `loadFiles` 函数（第 643-659 行）中，保留 `mods` 键保持兼容，不删除（因为 `fileData` 不再有 mods 的 effect 触发了）。实际上这是安全的，不做额外改动。

- [ ] **Step 5: 类型检查**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 6: Commit**

```bash
git add src/pages/InstanceDetail.tsx
git commit -m "feat: rewrite ModsTab with metadata cards, context menu, batch ops"
```

---

### Task 10: 验证 — 构建检查

- [ ] **Step 1: 后端编译**

Run: `dotnet build src-backend/Qomicex.Launcher.Backend/Qomicex.Launcher.Backend.csproj`
Expected: Build succeeded

- [ ] **Step 2: 前端类型检查**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 3: 前端构建**

Run: `npm run build`
Expected: Build succeeded
