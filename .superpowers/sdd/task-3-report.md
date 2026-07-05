# Task 3 Report: Frontend UI — Add Update Check in Settings > About

## Status: Done

## Changes
- **File:** `src/pages/Settings.tsx`
- **Commit:** `0a82380` — `feat(settings): add update check UI in About tab`

### What was added
1. **Imports:**
   - `faArrowUp, faCircleCheck` to existing `@fortawesome/free-solid-svg-icons` import
   - `check` from `@tauri-apps/plugin-updater`
   - `relaunch` from `@tauri-apps/plugin-process`

2. **State variables** in `AboutTab`:
   - `updateState` — tracks 7 states: `idle | checking | available | downloading | installing | uptodate | error`
   - `updateInfo` — stores version and body from the check result

3. **Functions:**
   - `checkForUpdate()` — calls `check()`, sets `uptodate` if no update, `available` with info if found, `error` on failure
   - `downloadAndInstall()` — calls `check()`, then `update.downloadAndInstall()`, then `relaunch()`

4. **UI Card** — placed between Version Info and Contributors cards:
   - Check button with spin animation during check
   - "Up to date" confirmation with check icon
   - Error message on failure
   - Available update panel: version diff, release notes, download button
   - Indeterminate progress bar during download
   - "Installing, restarting..." state

### Deviations from brief
- **Removed `progress` state** and percentage display: the `Progress` event from `@tauri-apps/plugin-updater` only exposes `chunkLength` (no `contentLength`), so real percentage calculation is impossible. Used an indeterminate `animate-pulse` bar instead. Add percentage tracking if/when the type provides total content length.

## Build
- `npm run build` — passes (tsc + vite, no errors)
- Only pre-existing warnings (large chunk size, unrelated dynamic imports)

## Concerns
- `update.downloadAndInstall()` callback is passed as empty arrow `() => {}` since we don't track progress. If the type requires the callback to process events, this is fine.
- The `@tauri-apps/plugin-updater` plugin must be registered in Tauri's `tauri.conf.json` capabilities for `check()` to work in production (already added by a sibling task).
