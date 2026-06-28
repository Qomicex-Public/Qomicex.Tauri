## Task 3 Report: Unify Frontend Java Runtime Consumption

### Behavior target

- After adding a custom Java runtime in Settings, refreshing Settings still shows it.
- Instance Detail now reads the same merged Java inventory as Settings.
- Dashboard now reads the same merged Java inventory as Settings.
- Quick and deep scan buttons now call different backend modes.

### Changes made

- `src/api/java.ts`
  - Added `JavaSearchMode`.
  - Added `searchJava(mode)` query support.
  - Added `getJavaList(mode)` for merged runtime inventory.
  - Added `getCustomJavaRuntimes()`, `addCustomJavaRuntime(path)`, `removeCustomJavaRuntime(path)`.
- `src/api/client.ts`
  - Extended `del()` to support DELETE requests with JSON body for `/api/java/custom`.
- `src/types/index.ts`
  - Added optional `discoveredBy` to `JavaRuntime` to match backend JSON.
- `src/pages/Settings.tsx`
  - Scan actions now call `getJavaList(mode)` and pass real `quick` / `deep` modes.
  - Manual add now uses `POST /api/java/custom`.
  - Manual delete now uses `DELETE /api/java/custom`.
  - Removed local-only Java inventory mutation path based on `validateJavaPath()`.
  - Only custom runtimes expose delete action.
- `src/pages/InstanceDetail.tsx`
  - Switched Java selector source from `searchJava()` to merged `getJavaList('quick')`.
- `src/pages/Dashboard.tsx`
  - Switched homepage Java summary source from `searchJava()` to merged `getJavaList('quick')`.

### Verification

- Ran `dotnet build "src-backend/Qomicex.Launcher.Backend/Qomicex.Launcher.Backend.csproj" --configuration Debug`
- Result: success, 0 warnings, 0 errors.

### Notes

- `Instances.tsx` was not modified, per task constraint.
- Java inventory is no longer persisted through frontend settings state.
