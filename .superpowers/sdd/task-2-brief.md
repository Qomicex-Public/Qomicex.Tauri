### Task 2: 设置页新增下载配置

**Files:**
- Modify: `src/api/settings.ts:15-16,41-65` (types + defaults)
- Modify: `src/pages/Settings.tsx:646-665` (UI below downloadThreads)

**Interfaces:**
- Consumes: nothing
- Produces: `AppSettings.fileChunkThreads` (number, default 0), `AppSettings.maxConnectionsPerServer` (number, default 64)
- Backend reads from `settings.json` in Task 6 (InstallTask uses `fileChunkThreads`) and at startup

- [ ] **Step 1: Add new fields to AppSettings interface and DEFAULT_SETTINGS**

In `src/api/settings.ts`, add two fields after `downloadThreads`:

In the interface (after line 15):
```typescript
  fileChunkThreads: number
  maxConnectionsPerServer: number
```

In DEFAULT_SETTINGS (after line 43 `downloadThreads: 64,`):
```typescript
  fileChunkThreads: 0,
  maxConnectionsPerServer: 64,
```

- [ ] **Step 2: Add UI controls in Settings.tsx after downloadThreads section**

In `src/pages/Settings.tsx`, after the closing `</div>` of the downloadThreads section (after line 664), insert:

```tsx
                <div className="space-y-2">
                  <Label htmlFor="fileChunkThreads">分片线程数</Label>
                  <div className="flex items-center gap-2">
                    <Button variant="outline" size="icon" className="h-9 w-9 shrink-0" onClick={() => update('fileChunkThreads', Math.max(0, settings.fileChunkThreads - 1))} disabled={settings.fileChunkThreads <= 0}>
                      <FontAwesomeIcon icon={faMinus} className="h-3.5 w-3.5" />
                    </Button>
                    <Input
                      id="fileChunkThreads"
                      type="number"
                      min={0}
                      max={16}
                      value={settings.fileChunkThreads}
                      onChange={(e) => update('fileChunkThreads', Math.max(0, Math.min(16, parseInt(e.target.value) || 0)))}
                      className="w-20 text-center [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
                    />
                    <Button variant="outline" size="icon" className="h-9 w-9 shrink-0" onClick={() => update('fileChunkThreads', Math.min(16, settings.fileChunkThreads + 1))} disabled={settings.fileChunkThreads >= 16}>
                      <FontAwesomeIcon icon={faPlus} className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                  <p className="text-xs text-muted-foreground">单文件分片下载线程数（0=自动，最大 16），数值越大单文件下载越快</p>
                </div>

                <div className="space-y-2">
                  <Label htmlFor="maxConnectionsPerServer">最大连接数</Label>
                  <div className="flex items-center gap-2">
                    <Button variant="outline" size="icon" className="h-9 w-9 shrink-0" onClick={() => update('maxConnectionsPerServer', Math.max(8, settings.maxConnectionsPerServer - 8))} disabled={settings.maxConnectionsPerServer <= 8}>
                      <FontAwesomeIcon icon={faMinus} className="h-3.5 w-3.5" />
                    </Button>
                    <Input
                      id="maxConnectionsPerServer"
                      type="number"
                      min={8}
                      max={256}
                      step={8}
                      value={settings.maxConnectionsPerServer}
                      onChange={(e) => update('maxConnectionsPerServer', Math.max(8, Math.min(256, parseInt(e.target.value) || 8)))}
                      className="w-20 text-center [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
                    />
                    <Button variant="outline" size="icon" className="h-9 w-9 shrink-0" onClick={() => update('maxConnectionsPerServer', Math.min(256, settings.maxConnectionsPerServer + 8))} disabled={settings.maxConnectionsPerServer >= 256}>
                      <FontAwesomeIcon icon={faPlus} className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                  <p className="text-xs text-muted-foreground">每个服务器的最大连接数（8-256），重启后生效</p>
                </div>
```

- [ ] **Step 3: Initialize CoreConfig.MaxConnectionsPerServer in Program.cs startup**

In `src-backend/Qomicex.Launcher.Backend/Program.cs`, add after `var builder = WebApplication.CreateBuilder(args);`:

```csharp
// Initialize CoreConfig from settings.json
try
{
    var settingsPath = Path.Combine(AppPaths.BaseDir, "QML", "settings.json");
    if (File.Exists(settingsPath))
    {
        using var doc = JsonDocument.Parse(File.ReadAllText(settingsPath));
        if (doc.RootElement.TryGetProperty("maxConnectionsPerServer", out var maxConn))
            CoreConfig.MaxConnectionsPerServer = maxConn.GetInt32();
    }
}
catch { /* use default */ }
```

Add `using System.Text.Json;` to Program.cs imports.

- [ ] **Step 4: Verify TypeScript compilation**

Run: `npx tsc --noEmit`
Expected: No errors.

- [ ] **Step 5: Commit**

```bash
git add src/api/settings.ts src/pages/Settings.tsx src-backend/Qomicex.Launcher.Backend/Program.cs
git commit -m "feat(settings): add fileChunkThreads and maxConnectionsPerServer download settings"
```

---

