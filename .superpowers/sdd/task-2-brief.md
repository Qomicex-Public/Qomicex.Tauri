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
