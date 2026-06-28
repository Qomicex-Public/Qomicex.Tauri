### Task 2: Extend Backend Java API

**Files:**
- Modify: `src-backend/Qomicex.Launcher.Backend/Controllers/JavaController.cs`
- Test: `dotnet build src-backend/Qomicex.Launcher.Backend/Qomicex.Launcher.Backend.csproj`

**Interfaces:**
- Consumes: `JavaRuntimeStore.GetCustomAsync()`
- Consumes: `JavaRuntimeStore.AddCustomAsync(string path)`
- Consumes: `JavaRuntimeStore.RemoveCustomAsync(string path)`
- Consumes: `JavaRuntimeStore.GetMergedAsync(JavaHelper.JavaSearchMode mode)`
- Produces: `GET /api/java/search?mode=quick|deep`
- Produces: `GET /api/java/custom`
- Produces: `POST /api/java/custom`
- Produces: `DELETE /api/java/custom`
- Produces: `GET /api/java/list?mode=quick|deep`

- [ ] **Step 1: Write the failing test surrogate**

Document the endpoint contract:

```text
GET /api/java/search?mode=deep must execute deep mode instead of quick mode.
GET /api/java/list must return scanned + custom runtimes.
POST /api/java/custom must persist a validated runtime.
DELETE /api/java/custom must remove that runtime.
```

- [ ] **Step 2: Verify current controller surface is too small**

Run:

```bash
rg "HttpGet\(\"search\"\)|HttpPost\(\"validate\"\)|HttpPost\(\"recommended\"\)|custom|list" "K:\Deskep\Project\Rust\Qomicex.Tauri\src-backend\Qomicex.Launcher.Backend\Controllers\JavaController.cs"
```

Expected: only the existing search, validate, and recommended endpoints are present.

- [ ] **Step 3: Write the minimal implementation**

Update `JavaController.cs` so it:

```csharp
// accepts mode query parameter for search/list
// maps mode string -> JavaHelper.JavaSearchMode
// injects JavaRuntimeStore
// keeps validate endpoint as the path validation primitive
// adds custom and list endpoints without changing unrelated controller behavior
```

Implementation decision for this task:

- invalid `mode` input should return `400` instead of silently falling back to quick mode

- [ ] **Step 4: Run focused backend build verification**

Run:

```bash
dotnet build "src-backend/Qomicex.Launcher.Backend/Qomicex.Launcher.Backend.csproj" --configuration Debug
```

Expected: build succeeds, or only pre-existing warnings remain.

- [ ] **Step 5: Commit**

```bash
git add src-backend/Qomicex.Launcher.Backend/Controllers/JavaController.cs
git commit -m "feat: expand java runtime api"
```
