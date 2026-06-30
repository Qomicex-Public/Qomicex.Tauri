# Task 1 Report: McmodService extension — mcmod ID reading support

## What I implemented

- Added `int? Id` property to `McmodEntry` private class to deserialize the `id` field from `mcmod_data.json`
- Changed `_map` field type from `Dictionary<string, string>` to `Dictionary<string, (string CnName, int? Id)>` to store both Chinese name and mcmod ID per entry
- Updated constructor loading logic to store `(entry.CnName ?? entry.EnName ?? "", entry.Id)` tuples
- Updated `Lookup()` method: all `_map` value accesses (`TryGetValue`, `foreach` loops) now use `.CnName` on the tuple
- Updated `BatchLookup()` remains compatible (delegates to `Lookup`)
- Added new `BatchLookupWithIds(List<string>)` method returning `Dictionary<string, (string? CnName, int? Id)>` — direct exact-key lookup, returns `(null, null)` for unknown names

## Build results

```
dotnet build src-backend/Qomicex.Launcher.Backend/Qomicex.Launcher.Backend.csproj
```

Result: **Build succeeded** — 0 errors, 28 warnings (all pre-existing, none in McmodService.cs).

## Files changed

- `src-backend/Qomicex.Launcher.Backend/Services/McmodService.cs` (+20/-5)

## Commit

```
d6b2f7a feat: extend McmodService to read mcmod ID from data
```

## Self-review

- All 4 steps from the task brief implemented exactly as specified
- Backward compatible: `Lookup` and `BatchLookup` signatures unchanged, behavior preserved
- `BatchLookupWithIds` does exact-key lookup only (skips the fuzzy matching in `Lookup`) — as designed in the brief
- No new warnings introduced
