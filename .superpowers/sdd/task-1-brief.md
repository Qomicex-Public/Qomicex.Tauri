### Task 1: CoreConfig + HTTP 连接池

**Files:**
- Create: `Qomicex.Avalonia/Qomicex.Downloader/CoreConfig.cs`
- Modify: `Qomicex.Avalonia/Qomicex.Downloader/Core.cs:13`

**Interfaces:**
- Produces: `CoreConfig.MaxConnectionsPerServer` (static int, default 64)

- [ ] **Step 1: Create CoreConfig.cs**

```csharp
namespace Qomicex.Downloader;

public static class CoreConfig
{
    public static int MaxConnectionsPerServer { get; set; } = 64;
}
```

- [ ] **Step 2: Build Downloader project to verify new file compiles**

Run: `dotnet build Qomicex.Avalonia/Qomicex.Downloader/Qomicex.Downloader.csproj`
Expected: Build succeeded.

- [ ] **Step 3: Replace static HttpClient in Core.cs with Lazy<HttpClient> backed by SocketsHttpHandler**

In `Qomicex.Avalonia/Qomicex.Downloader/Core.cs`, replace line 13:
```csharp
private static readonly HttpClient _httpClient = new HttpClient();
```
with:
```csharp
private static readonly Lazy<HttpClient> _lazyHttpClient = new(() =>
{
    var handler = new SocketsHttpHandler
    {
        MaxConnectionsPerServer = CoreConfig.MaxConnectionsPerServer,
        PooledConnectionLifetime = TimeSpan.FromMinutes(5),
        EnableMultipleHttp2Connections = true
    };
    return new HttpClient(handler);
});

private static HttpClient SharedHttpClient => _lazyHttpClient.Value;
```

- [ ] **Step 4: Replace all `_httpClient` references with `SharedHttpClient`**

In Core.cs, find all occurrences of `_httpClient` and replace with `SharedHttpClient`. These appear in:
- `DownloadFileAsync` (line 54): `await _httpClient.SendAsync(headRequest, ...)`
- `CanUseRangeAsync` (line 109): `await _httpClient.SendAsync(probeRequest, ...)`
- `DownloadSingleStreamAsync` (line 132): `await _httpClient.SendAsync(request, ...)`
- `DownloadMultiPartAsync` (line 164): `await _httpClient.SendAsync(req, ...)`

- [ ] **Step 5: Verify compilation**

Run: `dotnet build Qomicex.Avalonia/Qomicex.Downloader/Qomicex.Downloader.csproj`
Expected: Build succeeded with no warnings.

- [ ] **Step 6: Verify backend still builds (references Downloader)**

Run: `dotnet build src-backend/Qomicex.Launcher.Backend/Qomicex.Launcher.Backend.csproj`
Expected: Build succeeded.

- [ ] **Step 7: Commit**

```bash
git add Qomicex.Avalonia/Qomicex.Downloader/CoreConfig.cs Qomicex.Avalonia/Qomicex.Downloader/Core.cs
git commit -m "feat(downloader): add CoreConfig for HTTP connection pool tuning"
```

---

