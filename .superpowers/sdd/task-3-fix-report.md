# Task 3 Fix Report — Restore settings API persistence in Settings page

## Status: DONE_WITH_CONCERNS

## Commit
`4837f9f` — `fix: restore settings api persistence in settings page`
Branch: `feat/backend-trace-buffer`

## Verification
- `dotnet build src-backend/Qomicex.Launcher.Backend/Qomicex.Launcher.Backend.csproj --configuration Debug` → **0 errors**, 5 pre-existing warnings in `AccountController.cs` (unrelated).
- `npx tsc --noEmit` → **exit 0** (frontend TypeScript compiles cleanly).

## Changes made
### `src/api/settings.ts` (new)
- Created the settings API module (verbatim from main workspace) exporting `AppSettings`, `DEFAULT_SETTINGS`, `loadSettings`, `saveSettings`, plus `getSettings`/`isSettingsLoaded`/`onSettingsChange` cache plumbing.
- `loadSettings()` does `GET /settings` and merges over `DEFAULT_SETTINGS`; falls back to defaults on error.
- `saveSettings()` does `PUT /settings`; silently keeps the in-memory cache on error.
- Required because the module did not exist on this branch (see Concern 1).

### `src/pages/Settings.tsx` (modified)
- Removed the locally-defined `interface AppSettings`, `const DEFAULT_SETTINGS`, and the synchronous `function loadSettings()` (which read `localStorage`).
- Added imports:
  ```ts
  import { DEFAULT_SETTINGS, saveSettings as apiSaveSettings, loadSettings as apiLoadSettings } from '../api/settings.ts'
  import type { AppSettings } from '../api/settings.ts'
  ```
- `saveSettings()` wrapper now calls `apiSaveSettings(settings)` (was `localStorage.setItem('qomicex-settings', ...)`). Animation DOM side-effects preserved.
- Initial state changed from `useState<AppSettings>(loadSettings)` (sync localStorage read) to `useState<AppSettings>({ ...DEFAULT_SETTINGS })`.
- Added `loadedRef` + an async `useEffect` that calls `apiLoadSettings().then(s => { setSettings(s); loadedRef.current = true })`.
- Added `if (!loadedRef.current) return` guards to the two auto-memory effects (systemInfo refresh + memoryMode change) so they no longer overwrite/save defaults before the real settings load resolves.
- **No `localStorage` / `qomicex-settings` references remain in Settings.tsx.**

### Task 3 Java changes preserved (untouched)
- `import { getJavaList, addCustomJavaRuntime, removeCustomJavaRuntime } from '../api/java.ts'`
- `handleScan` → `getJavaList(mode)`
- `confirmAddJava` → `addCustomJavaRuntime(addPath)`
- `handleDelete` → `removeCustomJavaRuntime(path)` (with try/catch + `removingPath` state)
- `discoveredBy === 'Custom'` UI badges and the conditional delete button.

### Not touched (per instructions)
- `src/pages/Instances.tsx` localStorage usage — unchanged.

## Concerns

### Concern 1 (critical): No backend `/settings` endpoint exists on this branch
The branch has no `SettingsController.cs` / `/api/settings` route (confirmed by grep over `src-backend/**/*Setting*.cs` and `settings|Settings` in `*.cs`). `api/settings.ts` was never present on this branch either (`git log --all -- src/api/settings.ts` shows it was introduced in `bcd16df`, which is **not** an ancestor of `HEAD`).

Consequence: at runtime, `GET /settings` and `PUT /settings` will 404. `loadSettings` falls back to `DEFAULT_SETTINGS`; `saveSettings` silently fails (in-memory cache only). Settings will **not** actually persist across sessions until a backend `SettingsController` is added. The code is structurally correct and matches the main-workspace pattern, but persistence is not functional on this branch alone.

### Concern 2 (critical): `qomicex-settings` localStorage is shared with 3 other components
The `qomicex-settings` localStorage key is read/written by:
- `src/App.tsx:17` (reads on app init)
- `src/hooks/usePageAnimation.ts:9` (reads animation config)
- `src/pages/Instances.tsx:71,75` (reads **and** writes a partial merge)

Settings.tsx previously wrote this key and now no longer does. Those three components were **not** migrated to `api/settings.ts` (out of scope per task instructions; `Instances.tsx` was explicitly excluded). Result:
- `App.tsx` and `usePageAnimation.ts` will read stale (or empty) localStorage values for animation settings — they will not pick up changes made in Settings.tsx.
- `Instances.tsx` still does `setItem('qomicex-settings', { ...cur, ...s })` with `cur` read from localStorage, so it will write a partial/subset object to localStorage that is now disconnected from the Settings page.

A complete fix requires migrating `App.tsx`, `usePageAnimation.ts`, and `Instances.tsx` to the `api/settings.ts` module (e.g. via `getSettings`/`onSettingsChange`) — or adding the backend endpoint and letting the cache/listeners be the single source of truth. That is a larger, cross-component change outside this task's scope.

### Concern 3 (factual): Task 3 did not introduce the localStorage usage
The task framing states Task 3 changed persistence from backend API to localStorage. Git evidence shows otherwise: `git diff 07ff176 c223f25 -- src/pages/Settings.tsx` (the full Task 3 range) touches **only** Java-related code (imports, `handleScan`, `confirmAddJava`, `handleDelete`, `discoveredBy` UI, `removingPath`). The `localStorage`-based `loadSettings`/`saveSettings` and local `AppSettings`/`DEFAULT_SETTINGS` were already present at `07ff176` (the pre-Task-3 baseline). The branch predates the backend settings API entirely. This fix was applied anyway per the explicit instructions, but the regression attribution is inaccurate.
