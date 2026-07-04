### Task 3: JavaDownloadService 注入 IHttpClientFactory + GetAllActiveStates

**Files:**
- Modify: `src-backend/Qomicex.Launcher.Backend/Services/JavaDownloadService.cs:32-35,156-158`

**Interfaces:**
- Consumes: `IHttpClientFactory` (DI)
- Produces: `JavaDownloadService.GetAllActiveStates()` → `List<JavaDownloadProgressResponse>`

- [ ] **Step 1: Add IHttpClientFactory field and constructor parameter**

In `JavaDownloadService.cs`, add field after line 14:
```csharp
    private readonly HttpClient _httpClient;
```

Change constructor (line 32-35) to:
```csharp
    public JavaDownloadService(JavaRuntimeStore javaRuntimeStore, IHttpClientFactory httpClientFactory)
    {
        _javaRuntimeStore = javaRuntimeStore;
        _httpClient = httpClientFactory.CreateClient("default");
    }
```

- [ ] **Step 2: Replace using new HttpClient() with _httpClient**

In `ResolvePackageAsync` (line 156-158), replace:
```csharp
        using var http = new HttpClient();
```
with just using `_httpClient`. All `http.GetStringAsync(...)` calls remain the same but use the instance field.

Since `ResolvePackageAsync` is `static`, change it to instance method by removing `static` keyword. All callers call it on `this` already (it's called from `RunTaskAsync` which is an instance method).

Remove `static` from method signature on line 156:
```csharp
    private async Task<(string url, string fileName)> ResolvePackageAsync(JavaDownloadStartRequest request)
```

- [ ] **Step 3: Add GetAllActiveStates method**

Add to `JavaDownloadService.cs` (before the `GetBaseDir` method, after line 147):

```csharp
    public List<JavaDownloadProgressResponse> GetAllActiveStates()
    {
        return _tasks.Values
            .Where(t => t.Status is "queued" or "resolving" or "downloading" or "paused" or "extracting" or "registering")
            .Select(t => new JavaDownloadProgressResponse
            {
                TaskId = t.TaskId,
                Status = t.Status,
                Progress = t.Progress,
                Speed = t.Speed,
                FileName = t.FileName,
                TargetDir = t.TargetDir,
                Error = t.Error,
            })
            .ToList();
    }
```

- [ ] **Step 4: Verify build**

Run: `dotnet build src-backend/Qomicex.Launcher.Backend/Qomicex.Launcher.Backend.csproj`
Expected: Build succeeded.

- [ ] **Step 5: Commit**

```bash
git add src-backend/Qomicex.Launcher.Backend/Services/JavaDownloadService.cs
git commit -m "feat(java-download): inject IHttpClientFactory, add GetAllActiveStates"
```

---

