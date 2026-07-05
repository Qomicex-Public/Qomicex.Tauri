# Task 2 Report: Frontend — Add npm Dependencies + Capabilities

## Status: ✅ Complete

## Steps

1. **Install npm packages** — `npm install @tauri-apps/plugin-updater @tauri-apps/plugin-process` (added 2 packages)
2. **Edit capabilities** — Added `"updater:default"` to `src-tauri/capabilities/default.json`
3. **Check lib.rs** — `tauri_plugin_updater` already registered in `setup()` (line 86). `tauri_plugin_process` is built-in (no Rust registration needed). No changes required.
4. **Build verification** — `npm run build` passes (tsc + vite build, no errors)

## Commits

- `9348df6` — feat(frontend): add updater plugin npm packages and capability

## Files Changed

- `package.json` — added `@tauri-apps/plugin-updater` and `@tauri-apps/plugin-process` to dependencies
- `package-lock.json` — auto-generated lockfile update
- `src-tauri/capabilities/default.json` — added `"updater:default"` to permissions array

## Concerns

- `@tauri-apps/plugin-process` is a Tauri v2 built-in plugin — it's available from JS via npm but requires no Rust-side `plugin()` registration. Verified this is correct.
- The updater plugin is conditionally registered (`#[cfg(desktop)]` guard in `setup()`), which is correct for cross-platform support.
- No breaking changes, no type errors introduced.

## Report Path

`.superpowers/sdd/task-2-report.md`
