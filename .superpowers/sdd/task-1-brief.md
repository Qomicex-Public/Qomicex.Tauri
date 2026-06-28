### Task 1: Add Backend Java Runtime Store

**Files:**
- Create: `src-backend/Qomicex.Launcher.Backend/Services/JavaRuntimeStore.cs`
- Modify: `src-backend/Qomicex.Launcher.Backend/Program.cs`
- Test: `dotnet build src-backend/Qomicex.Launcher.Backend/Qomicex.Launcher.Backend.csproj`

**Interfaces:**
- Produces: `public sealed class JavaRuntimeStore`
- Produces: `Task<List<JavaHelper.JavaInfoExtended>> GetCustomAsync()`
- Produces: `Task<JavaHelper.JavaInfoExtended> AddCustomAsync(string path)`
- Produces: `Task RemoveCustomAsync(string path)`
- Produces: `Task<List<JavaHelper.JavaInfoExtended>> GetMergedAsync(JavaHelper.JavaSearchMode mode)`

- [ ] **Step 1: Write the failing test surrogate**

Document the backend behavior target:

```text
Given two custom Java entries with the same normalized path,
the store persists only one logical entry.

Given scanned and custom results with the same path,
GetMergedAsync returns one merged entry for that path.
```

- [ ] **Step 2: Verify the store does not exist yet**

Run:

```bash
rg "class JavaRuntimeStore|GetMergedAsync|AddCustomAsync" "K:\Deskep\Project\Rust\Qomicex.Tauri\src-backend\Qomicex.Launcher.Backend"
```

Expected: no matches.

- [ ] **Step 3: Write the minimal implementation**

Create `JavaRuntimeStore.cs` with responsibilities:

```csharp
namespace Qomicex.Launcher.Backend.Services;

public sealed class JavaRuntimeStore
{
    // Store file: AppContext.BaseDirectory/QML/java-runtimes.json
    // Normalize path with Path.GetFullPath and OrdinalIgnoreCase semantics on Windows.
    // AddCustomAsync validates via JavaController-compatible logic or shared helper logic.
    // GetMergedAsync merges SearchJava(mode) + stored custom runtimes by path.
}
```

Also register it in `Program.cs` as a singleton service.

- [ ] **Step 4: Run focused backend build verification**

Run:

```bash
dotnet build "src-backend/Qomicex.Launcher.Backend/Qomicex.Launcher.Backend.csproj" --configuration Debug
```

Expected: build succeeds, or only pre-existing warnings remain.

- [ ] **Step 5: Commit**

```bash
git add src-backend/Qomicex.Launcher.Backend/Services/JavaRuntimeStore.cs src-backend/Qomicex.Launcher.Backend/Program.cs
git commit -m "feat: add java runtime store"
```
