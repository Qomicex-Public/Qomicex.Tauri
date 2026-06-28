### Task 3: Unify Frontend Java Runtime Consumption

**Files:**
- Modify: `src/types/index.ts`
- Modify: `src/api/java.ts`
- Modify: `src/pages/Settings.tsx`
- Modify: `src/pages/InstanceDetail.tsx`
- Modify: `src/pages/Dashboard.tsx`
- Test: `dotnet build src-backend/Qomicex.Launcher.Backend/Qomicex.Launcher.Backend.csproj`

**Interfaces:**
- Consumes: `GET /api/java/list?mode=quick|deep`
- Consumes: `POST /api/java/custom`
- Consumes: `DELETE /api/java/custom`
- Produces: settings and instance pages using one merged runtime inventory

- [ ] **Step 1: Write the failing test surrogate**

Document the frontend behavior target:

```text
After adding a custom Java runtime in Settings,
refreshing Settings still shows it,
and Instance Detail shows the same runtime in the Java select.

Quick and deep scan buttons must request different backend modes.
```

- [ ] **Step 2: Verify current pages read different sources**

Run:

```bash
rg "searchJava\(|customJavaRuntimes|validateJavaPath|GET /api/java/list" "K:\Deskep\Project\Rust\Qomicex.Tauri\src"
```

Expected: Settings relies on `customJavaRuntimes` and Instance Detail still calls `searchJava()` directly.

- [ ] **Step 3: Write the minimal implementation**

Update the frontend so that:

```ts
// src/api/java.ts
// adds searchJava(mode), getJavaList(mode), getCustomJavaRuntimes(), addCustomJavaRuntime(path), removeCustomJavaRuntime(path)

// Settings.tsx
// uses getJavaList(mode) for scan actions
// uses addCustomJavaRuntime/removeCustomJavaRuntime for manual add/delete
// no longer persists Java inventory through settings.customJavaRuntimes

// InstanceDetail.tsx and Dashboard.tsx
// switch to merged list endpoint where they should reflect user-managed Java inventory
```

If `JavaRuntime` typing needs an origin field, add it in `src/types/index.ts` and keep field names aligned with the backend JSON shape.

- [ ] **Step 4: Run focused verification**

Run backend build to ensure API shape changes still compile:

```bash
dotnet build "src-backend/Qomicex.Launcher.Backend/Qomicex.Launcher.Backend.csproj" --configuration Debug
```

Expected: build succeeds.

Then manual verification target for later handoff:

```text
1. Settings page quick scan updates status via quick mode.
2. Settings page deep scan takes the deep path.
3. Manual add survives refresh.
4. Instance Detail Java selector shows the same custom runtime.
```

- [ ] **Step 5: Commit**

```bash
git add src/types/index.ts src/api/java.ts src/pages/Settings.tsx src/pages/InstanceDetail.tsx src/pages/Dashboard.tsx
git commit -m "feat: unify frontend java runtime inventory"
```
