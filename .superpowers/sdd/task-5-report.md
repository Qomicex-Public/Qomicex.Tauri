## Task 5 Report: JavaDownloadController

### Scope
- Created `src-backend/Qomicex.Launcher.Backend/Controllers/JavaDownloadController.cs`
- Exposed four endpoints backed by `JavaDownloadService`:
  - `GET /api/java/download/catalog`
  - `POST /api/java/download/start`
  - `GET /api/java/download/progress/{taskId}`
  - `DELETE /api/java/download/{taskId}`

### Implementation Notes
- Matched the exact controller structure and route layout from `task-5-brief.md`
- Kept behavior minimal:
  - catalog/start return `200 OK`
  - progress returns `404 Not Found` when task is missing
  - cancel returns `204 No Content` on success, `404 Not Found` otherwise

### Verification
- Ran:
  - `dotnet build src-backend/Qomicex.Launcher.Backend/Qomicex.Launcher.Backend.csproj`
- Result:
  - Build succeeded
  - 0 errors
  - Existing warnings remain in unrelated files/dependencies:
    - `SharpCompress` `NU1902` vulnerability warning
    - nullable warnings in `Controllers/AccountController.cs`

### Self Review
- Confirmed change is limited to `src-backend/` plus this report file
- Confirmed controller uses existing DTOs and existing `JavaDownloadService` methods only
- Confirmed no shared submodule code was modified
- No additional concerns with the controller implementation itself

### Commit
- Intended commit message: `feat: add java download controller`
