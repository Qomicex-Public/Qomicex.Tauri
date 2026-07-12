# Error Patterns Expansion Implementation Plan

**Goal:** Add ~17 new error patterns with detailed Chinese solutions to `error-patterns.json`, matching PCL's coverage.

**Architecture:** All changes are in `error-patterns.json` (embedded resource) — no backend code, no frontend changes. Each new pattern follows the existing JSON schema.

**Tech Stack:** JSON + C# embedded resources

## Global Constraints

- Follow existing `error-patterns.json` schema exactly
- Each pattern needs: id, category, severity, i18n (zh/en), regexPatterns, solutions
- Solutions with zh-CN detailed text (PCL-grade detail)
- Existing patterns must not be modified (only add new ones)

---

### Task 1: GPU driver patterns (5)

Add after `out-of-memory-native`:
- `gpu-intel-access-violation`
- `gpu-amd-access-violation`
- `gpu-nvidia-access-violation`
- `gpu-pixel-format`
- `gpu-opengl-not-supported`

### Task 2: OptiFine patterns (3)

Add after the GPU patterns:
- `optifine-forge-incompatible`
- `optifine-world-load`
- `shadersmod-optifine-conflict`

### Task 3: Forge + Java + other patterns (9)

Add after OptiFine patterns:
- `forge-incomplete-install`
- `forge-multiple-json`
- `forge-old-version-java`
- `java-openj9`
- `java-32bit`
- `java-mod-needs-11`
- `mod-extracted`
- `mod-id-limit`
- `mixin-bootstrap-missing`

### Task 4: Verify build

Run: `dotnet build` from `src-backend/Qomicex.Launcher.Backend`
Expected: 0 errors
